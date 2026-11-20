import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { verifyAccessToken } from '../utils/jwt';
import { sendError } from '../utils/response';
import { prisma } from '../config/database';

export async function authenticate(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  let accessToken: string | undefined = req.cookies?.access_token;

  if (!accessToken && req.headers.authorization?.startsWith('Bearer ')) {
    accessToken = req.headers.authorization.split(' ')[1];
  }

  if (accessToken) {
    const payload = verifyAccessToken(accessToken);
    if (payload) {
      if (payload.sessionId) {
        // Immediate session revocation check: verify active session in DB
        const session = await prisma.session.findUnique({
          where: { id: payload.sessionId },
          select: { id: true, revokedAt: true, expiresAt: true, userId: true },
        });

        if (
          !session ||
          session.revokedAt !== null ||
          new Date(session.expiresAt) < new Date() ||
          session.userId !== payload.id
        ) {
          req.user = undefined;
          return next();
        }
      }
      req.user = payload;
      return next();
    }
  }

  return next();
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
