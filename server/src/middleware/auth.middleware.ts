import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import {
  verifyAccessToken,
  verifyRefreshToken,
  generateAccessToken,
  hashToken,
} from '../utils/jwt';
import { prisma } from '../config/database';
import { sendError } from '../utils/response';
import { env } from '../config/env';

export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  let accessToken: string | undefined = req.cookies?.access_token;

  if (!accessToken && req.headers.authorization?.startsWith('Bearer ')) {
    accessToken = req.headers.authorization.split(' ')[1];
  }

  if (accessToken) {
    const payload = verifyAccessToken(accessToken);
    if (payload) {
      req.user = payload;
      return next();
    }
  }

  // Attempt refresh token rotation if access token is missing or expired
  const refreshToken: string | undefined = req.cookies?.refresh_token;
  if (!refreshToken) {
    return next();
  }

  try {
    const decodedRefresh = verifyRefreshToken(refreshToken);
    if (!decodedRefresh || !decodedRefresh.sessionId) {
      return next();
    }

    const hashed = hashToken(refreshToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashed },
      include: { user: true },
    });

    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt < new Date() ||
      session.userId !== decodedRefresh.id
    ) {
      return next();
    }

    const userPayload = {
      id: session.user.id,
      username: session.user.username,
      email: session.user.email,
    };

    const newAccessToken = generateAccessToken(userPayload);
    res.cookie('access_token', newAccessToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
      domain: env.COOKIE_DOMAIN || undefined,
      maxAge: 15 * 60 * 1000,
    });

    req.user = userPayload;
    return next();
  } catch {
    return next();
  }
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    sendError(res, 'Authentication required', 401, 'UNAUTHORIZED');
    return;
  }
  next();
}
