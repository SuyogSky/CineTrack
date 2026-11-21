import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export function sanitizeDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '[REDACTED_URL]';
  }
}

export function extractDatabaseName(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const dbPath = parsed.pathname.replace(/^\//, '').split('?')[0];
    return dbPath;
  } catch {
    return '';
  }
}

export interface OriginValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Parse an IPv4 string into 4 numbers [0..255] or return null if invalid.
 */
export function parseIPv4(ip: string): [number, number, number, number] | null {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const [_, aStr, bStr, cStr, dStr] = match;
  if (
    (aStr.length > 1 && aStr.startsWith('0')) ||
    (bStr.length > 1 && bStr.startsWith('0')) ||
    (cStr.length > 1 && cStr.startsWith('0')) ||
    (dStr.length > 1 && dStr.startsWith('0'))
  ) {
    return null;
  }
  const a = parseInt(aStr, 10);
  const b = parseInt(bStr, 10);
  const c = parseInt(cStr, 10);
  const d = parseInt(dStr, 10);
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return [a, b, c, d];
}

/**
 * Parse an IPv6 address string into an array of 8 16-bit integers, or null if invalid.
 * Handles :: shorthand and trailing IPv4-mapped notation (e.g., ::ffff:192.168.1.1).
 */
export function parseIPv6(ip: string): number[] | null {
  const clean = ip.toLowerCase().trim();
  if (!clean.includes(':')) return null;

  // Check for dual/mapped IPv4 notation at the end: e.g. ::ffff:192.168.1.1 or 64:ff9b::192.0.2.33
  const lastColonIdx = clean.lastIndexOf(':');
  const tail = clean.slice(lastColonIdx + 1);
  let head = clean.slice(0, lastColonIdx + 1);

  let hexTailParts: string[] = [];
  if (tail.includes('.')) {
    const ipv4 = parseIPv4(tail);
    if (!ipv4) return null;
    const [b0, b1, b2, b3] = ipv4;
    const g6 = ((b0 << 8) | b1).toString(16);
    const g7 = ((b2 << 8) | b3).toString(16);
    hexTailParts = [g6, g7];
  } else if (tail.length > 0) {
    hexTailParts = [tail];
  }

  let mainStr = head;
  if (mainStr.endsWith(':') && !mainStr.endsWith('::')) {
    mainStr = mainStr.slice(0, -1);
  }

  const doubleColonCount = (mainStr.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  const totalGroups: number[] = [];
  if (doubleColonCount === 1) {
    const [leftStr, rightStr] = mainStr.split('::');
    const leftParts = leftStr ? leftStr.split(':') : [];
    const rightParts = rightStr ? rightStr.split(':') : [];
    const allRightParts = [...rightParts, ...hexTailParts];

    const totalExplicit = leftParts.length + allRightParts.length;
    if (totalExplicit > 7) return null;
    const missingZeros = 8 - totalExplicit;

    const parts = [
      ...leftParts,
      ...Array(missingZeros).fill('0'),
      ...allRightParts,
    ];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
      totalGroups.push(parseInt(p, 16));
    }
  } else {
    const parts = [...(mainStr ? mainStr.split(':') : []), ...hexTailParts];
    if (parts.length !== 8) return null;
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
      totalGroups.push(parseInt(p, 16));
    }
  }

  return totalGroups.length === 8 ? totalGroups : null;
}

/**
 * Classify an IPv4 address and reject private, loopback, link-local, CGNAT, or reserved addresses.
 */
export function classifyIPv4(
  octets: [number, number, number, number],
  displayStr: string
): { valid: boolean; error?: string } {
  const [a, b, c, d] = octets;

  // Zero address 0.0.0.0/8
  if (a === 0) {
    return {
      valid: false,
      error: `Production origin cannot point to IPv4 zero network: "${displayStr}"`,
    };
  }

  // Loopback 127.0.0.0/8
  if (a === 127) {
    return {
      valid: false,
      error: `Production origin cannot point to IPv4 loopback address: "${displayStr}"`,
    };
  }

  // Private 10.0.0.0/8
  if (a === 10) {
    return {
      valid: false,
      error: `Production origin cannot point to private IPv4 address (10.0.0.0/8): "${displayStr}"`,
    };
  }

  // Carrier-Grade NAT (CGNAT) 100.64.0.0/10 (100.64.0.0 - 100.127.255.255) RFC 6598
  if (a === 100 && b >= 64 && b <= 127) {
    return {
      valid: false,
      error: `Production origin cannot point to Carrier-Grade NAT address (100.64.0.0/10): "${displayStr}"`,
    };
  }

  // Link-local 169.254.0.0/16
  if (a === 169 && b === 254) {
    return {
      valid: false,
      error: `Production origin cannot point to IPv4 link-local address: "${displayStr}"`,
    };
  }

  // Private 172.16.0.0/12 (172.16 - 172.31)
  if (a === 172 && b >= 16 && b <= 31) {
    return {
      valid: false,
      error: `Production origin cannot point to private IPv4 address (172.16.0.0/12): "${displayStr}"`,
    };
  }

  // Private 192.168.0.0/16
  if (a === 192 && b === 168) {
    return {
      valid: false,
      error: `Production origin cannot point to private IPv4 address (192.168.0.0/16): "${displayStr}"`,
    };
  }

  // Multicast 224.0.0.0/4 (224 - 239)
  if (a >= 224 && a <= 239) {
    return {
      valid: false,
      error: `Production origin cannot point to multicast IPv4 address: "${displayStr}"`,
    };
  }

  // Reserved / Broadcast 240.0.0.0/4 (240 - 255)
  if (a >= 240) {
    return {
      valid: false,
      error: `Production origin cannot point to reserved/broadcast IPv4 address: "${displayStr}"`,
    };
  }

  return { valid: true };
}

/**
 * Classify an IPv6 address and reject loopback, link-local, unique local, multicast, or mapped private IPv4.
 */
export function classifyIPv6(
  groups: number[],
  displayStr: string
): { valid: boolean; error?: string } {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // Unspecified :: (all zeros)
  if (groups.every((g) => g === 0)) {
    return {
      valid: false,
      error: `Production origin cannot point to IPv6 unspecified address: "${displayStr}"`,
    };
  }

  // Loopback ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return {
      valid: false,
      error: `Production origin cannot point to IPv6 loopback address: "${displayStr}"`,
    };
  }

  // IPv4-mapped IPv6 ::ffff:0:0/96, IPv4-compatible ::0:0/96, or NAT64 64:ff9b::/96
  const isIpv4Mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const isIpv4Compatible = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && (g6 !== 0 || g7 > 1);
  const isNat64 = g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;

  if (isIpv4Mapped || isIpv4Compatible || isNat64) {
    const b0 = (g6 >> 8) & 0xff;
    const b1 = g6 & 0xff;
    const b2 = (g7 >> 8) & 0xff;
    const b3 = g7 & 0xff;
    const mappedRes = classifyIPv4([b0, b1, b2, b3], displayStr);
    if (!mappedRes.valid) {
      return mappedRes;
    }
  }

  // Link-local fe80::/10 (fe80 to febf)
  if ((g0 & 0xffc0) === 0xfe80) {
    return {
      valid: false,
      error: `Production origin cannot point to IPv6 link-local address (fe80::/10): "${displayStr}"`,
    };
  }

  // Unique local fc00::/7 (fc00 to fdff)
  if ((g0 & 0xfe00) === 0xfc00) {
    return {
      valid: false,
      error: `Production origin cannot point to private IPv6 address (fc00::/7): "${displayStr}"`,
    };
  }

  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) {
    return {
      valid: false,
      error: `Production origin cannot point to multicast IPv6 address (ff00::/8): "${displayStr}"`,
    };
  }

  return { valid: true };
}

export function validateProductionOrigin(rawOrigin: string): OriginValidationResult {
  if (!rawOrigin || typeof rawOrigin !== 'string' || rawOrigin.trim() === '') {
    return { valid: false, error: 'Origin cannot be empty' };
  }

  const trimmed = rawOrigin.trim();

  if (trimmed === '*') {
    return {
      valid: false,
      error: 'Wildcard origin "*" is strictly forbidden when credentials/cookies are enabled',
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { valid: false, error: `Malformed origin URL: "${trimmed}"` };
  }

  // 1. Must use HTTPS
  if (url.protocol !== 'https:') {
    return {
      valid: false,
      error: `Production origin must use HTTPS scheme. Received: "${url.protocol}" in "${trimmed}"`,
    };
  }

  // 2. Reject path (must be empty or strictly '/')
  if (url.pathname && url.pathname !== '/') {
    return {
      valid: false,
      error: `Origin must not include a path component ("${url.pathname}"). An origin consists only of scheme, host, and optional port`,
    };
  }

  // 3. Reject query parameters
  if (url.search) {
    return {
      valid: false,
      error: `Origin must not include a query string ("${url.search}")`,
    };
  }

  // 4. Reject hash fragment
  if (url.hash) {
    return {
      valid: false,
      error: `Origin must not include a hash fragment ("${url.hash}")`,
    };
  }

  // 5. Reject embedded credentials
  if (url.username || url.password) {
    return { valid: false, error: 'Origin must not contain embedded user credentials' };
  }

  const hostname = url.hostname.toLowerCase();
  const cleanHost = hostname.replace(/^\[|\]$/g, '');

  // 6. Reject localhost and local names
  if (
    cleanHost === 'localhost' ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local')
  ) {
    return {
      valid: false,
      error: `Production origin cannot point to localhost/local domain: "${cleanHost}"`,
    };
  }

  // 7. Check IPv4 addresses
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipv4Match = cleanHost.match(ipv4Regex);
  if (ipv4Match) {
    const ipv4 = parseIPv4(cleanHost);
    if (!ipv4) {
      return { valid: false, error: `Invalid IPv4 address in origin: "${cleanHost}"` };
    }
    const ipv4Result = classifyIPv4(ipv4, cleanHost);
    if (!ipv4Result.valid) {
      return ipv4Result;
    }
  }

  // 8. Check IPv6 addresses
  if (cleanHost.includes(':')) {
    const ipv6Groups = parseIPv6(cleanHost);
    if (!ipv6Groups) {
      return { valid: false, error: `Invalid IPv6 address in origin: "${cleanHost}"` };
    }
    const ipv6Result = classifyIPv6(ipv6Groups, cleanHost);
    if (!ipv6Result.valid) {
      return ipv6Result;
    }
  }

  return { valid: true };
}

const WEAK_SECRET_PATTERNS = [
  'replace_with',
  'secret',
  'password',
  '123456',
  'cinetrack_dev',
  'test-access-secret',
  'test-refresh-secret',
  'test-csrf-secret',
];

export const envSchema = z
  .object({
    PORT: z.coerce.number().default(5000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    TEST_DATABASE_URL: z.string().optional(),
    EXPECTED_TEST_DATABASE_NAME: z.string().default('cinetrack_test'),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters'),
    CORS_ORIGIN: z.string().optional(),
    ALLOWED_ORIGINS: z.string().optional(),
    TRUST_PROXY: z.string().default('false'),
    COOKIE_DOMAIN: z.string().optional().default(''),
    COOKIE_SAMESITE: z.enum(['lax', 'none', 'strict']).default('lax'),
    TMDB_API_KEY: z.string().optional().default(''),
    TMDB_BASE_URL: z.string().default('https://api.themoviedb.org/3'),
  })
  .transform((data) => {
    // Reconcile CORS_ORIGIN and ALLOWED_ORIGINS into a canonical CORS_ORIGIN string
    const corsValue =
      data.CORS_ORIGIN ||
      data.ALLOWED_ORIGINS ||
      (data.NODE_ENV === 'production' ? '' : 'http://localhost:5173');
    return {
      ...data,
      CORS_ORIGIN: corsValue,
      ALLOWED_ORIGINS: corsValue,
    };
  })
  .superRefine((data, ctx) => {
    // 1. Production validations (Fail-closed)
    if (data.NODE_ENV === 'production') {
      if (!data.CORS_ORIGIN || data.CORS_ORIGIN.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: 'CORS_ORIGIN (or ALLOWED_ORIGINS) is strictly required in production mode',
        });
      } else {
        const origins = data.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
        if (origins.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CORS_ORIGIN'],
            message: 'At least one valid origin must be provided in CORS_ORIGIN',
          });
        }
        for (const origin of origins) {
          const res = validateProductionOrigin(origin);
          if (!res.valid) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['CORS_ORIGIN'],
              message: res.error || 'Invalid production CORS origin',
            });
          }
        }
      }

      // Check for weak or placeholder secrets in production
      const checkSecret = (val: string, name: string) => {
        const lower = val.toLowerCase();
        if (WEAK_SECRET_PATTERNS.some((p) => lower.includes(p))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} contains a known weak or placeholder value which is forbidden in production`,
          });
        }
      };

      checkSecret(data.JWT_ACCESS_SECRET, 'JWT_ACCESS_SECRET');
      checkSecret(data.JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET');
      checkSecret(data.CSRF_SECRET, 'CSRF_SECRET');

      // Enforce pairwise distinct secrets in production
      const normAccess = data.JWT_ACCESS_SECRET.trim().toLowerCase();
      const normRefresh = data.JWT_REFRESH_SECRET.trim().toLowerCase();
      const normCsrf = data.CSRF_SECRET.trim().toLowerCase();

      if (normAccess === normRefresh) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_REFRESH_SECRET'],
          message: 'JWT_REFRESH_SECRET must be distinct from JWT_ACCESS_SECRET in production mode',
        });
      }

      if (normAccess === normCsrf) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CSRF_SECRET'],
          message: 'CSRF_SECRET must be distinct from JWT_ACCESS_SECRET in production mode',
        });
      }

      if (normRefresh === normCsrf) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CSRF_SECRET'],
          message: 'CSRF_SECRET must be distinct from JWT_REFRESH_SECRET in production mode',
        });
      }
    }

    // 2. Test mode database isolation validations
    if (data.NODE_ENV === 'test') {
      if (!data.TEST_DATABASE_URL || data.TEST_DATABASE_URL.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TEST_DATABASE_URL'],
          message: 'TEST_DATABASE_URL is strictly required when NODE_ENV=test',
        });
      } else {
        const dbName = extractDatabaseName(data.TEST_DATABASE_URL);
        const expected = data.EXPECTED_TEST_DATABASE_NAME.toLowerCase();
        if (dbName.toLowerCase() !== expected) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TEST_DATABASE_URL'],
            message: `TEST_DATABASE_URL must target exact test database "${expected}". Received: "${dbName}"`,
          });
        }
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
