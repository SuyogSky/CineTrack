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

const envSchema = z
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
    TMDB_API_KEY: z.string().optional().default(''),
    TMDB_BASE_URL: z.string().default('https://api.themoviedb.org/3'),
  })
  .transform((data) => {
    // Reconcile CORS_ORIGIN and ALLOWED_ORIGINS into a canonical CORS_ORIGIN string
    const corsValue = data.CORS_ORIGIN || data.ALLOWED_ORIGINS || (data.NODE_ENV === 'production' ? '' : 'http://localhost:5173');
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
      } else if (
        data.CORS_ORIGIN.includes('localhost') ||
        data.CORS_ORIGIN.includes('127.0.0.1')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: 'CORS_ORIGIN cannot point to localhost/127.0.0.1 in production mode',
        });
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
