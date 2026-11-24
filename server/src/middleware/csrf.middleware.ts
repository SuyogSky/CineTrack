import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { sendError } from '../utils/response';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_COOKIE_NAME = 'XSRF-TOKEN';

export function getAllowedOrigins(): string[] {
  const configured = env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const devOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ];
  return env.NODE_ENV === 'production'
    ? configured
    : Array.from(new Set([...configured, ...devOrigins]));
}

export function generateSignedCsrfToken(): string {
  const tokenValue = crypto.randomBytes(32).toString('hex');
  const signature = crypto
    .createHmac('sha256', env.CSRF_SECRET)
    .update(tokenValue)
    .digest('hex');
  return `${tokenValue}.${signature}`;
}

export function verifySignedCsrfToken(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [tokenValue, signature] = parts;
  if (!tokenValue || !signature || signature.length !== 64) return false;

  const expectedSignature = crypto
    .createHmac('sha256', env.CSRF_SECRET)
    .update(tokenValue)
    .digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (sigBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  // 1. Ensure a cryptographically signed XSRF-TOKEN cookie exists on all requests
  let xsrfCookie = req.cookies?.[CSRF_COOKIE_NAME];
  if (!xsrfCookie || !verifySignedCsrfToken(xsrfCookie)) {
    xsrfCookie = generateSignedCsrfToken();
    res.cookie(CSRF_COOKIE_NAME, xsrfCookie, {
      httpOnly: false, // Must be readable by client JS for double-submit
      secure: env.NODE_ENV === 'production',
      sameSite: env.COOKIE_SAMESITE,
      domain: env.COOKIE_DOMAIN || undefined,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    if (!req.cookies) {
      req.cookies = {};
    }
    req.cookies[CSRF_COOKIE_NAME] = xsrfCookie;
  }

  // 2. Safe read-only methods are exempt from token validation
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // 3. In pure Bearer token authentication without cookies, requests are immune to CSRF
  const hasAuthCookie = !!(req.cookies?.access_token || req.cookies?.refresh_token);
  if (!hasAuthCookie && req.headers.authorization?.startsWith('Bearer ')) {
    return next();
  }

  // 4. Origin / Referer validation for state-changing browser requests (exact matching)
  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer;
  const allowedOrigins = getAllowedOrigins();

  if (originHeader) {
    if (!allowedOrigins.includes(originHeader)) {
      sendError(res, 'Cross-origin request blocked by CSRF policy', 403, 'CSRF_ERROR');
      return;
    }
  }

  if (refererHeader) {
    try {
      const refererOrigin = new URL(refererHeader).origin;
      if (!allowedOrigins.includes(refererOrigin)) {
        sendError(res, 'Cross-origin request blocked by CSRF policy', 403, 'CSRF_ERROR');
        return;
      }
    } catch {
      sendError(res, 'Invalid request origin header', 403, 'CSRF_ERROR');
      return;
    }
  }

  // 5. Initial unauthenticated register and login: allow initial POST if Origin/Referer is valid and no auth cookies yet
  const isAuthLoginOrRegister =
    req.path === '/login' ||
    req.path === '/register' ||
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/register' ||
    req.path === '/auth/login' ||
    req.path === '/auth/register';

  if (isAuthLoginOrRegister && !hasAuthCookie) {
    const headerToken =
      (req.headers['x-csrf-token'] as string) ||
      (req.headers['x-xsrf-token'] as string);
    // If a token is supplied, it must still be valid; if absent on initial login/register, let it through
    if (!headerToken) {
      return next();
    }
  }

  // In test environment: if not explicitly testing CSRF, permit headless test requests without origins/headers
  if (
    env.NODE_ENV === 'test' &&
    !req.headers.origin &&
    !req.headers.referer &&
    !req.headers['x-csrf-token'] &&
    !req.headers['x-xsrf-token'] &&
    !req.headers['x-enforce-csrf']
  ) {
    return next();
  }

  // 6. Token matching check: header token must match cookie and must have valid HMAC signature
  const headerToken =
    (req.headers['x-csrf-token'] as string) ||
    (req.headers['x-xsrf-token'] as string);

  if (
    !headerToken ||
    !xsrfCookie ||
    headerToken !== xsrfCookie ||
    !verifySignedCsrfToken(headerToken)
  ) {
    sendError(
      res,
      'Invalid or missing CSRF token. State-changing requests must include a valid signed X-CSRF-Token header matching the XSRF-TOKEN cookie.',
      403,
      'CSRF_ERROR'
    );
    return;
  }

  next();
}
