import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { verifyAccessToken } from '../utils/jwt';
import { sendError } from '../utils/response';
import { prisma } from '../config/database';

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
    if (!payload || !payload.sessionId) {
      req.user = undefined;
      return next();
    }

    try {
      // Mandatory database session validation: every authenticated request must verify active session
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

      req.user = payload;
      return next();
    } catch (err) {
      // Fail closed: Database outage or lookup error must NEVER authenticate the request
      console.error('Database error during session verification:', err);
      sendError(res, 'Internal authentication service error', 500, 'INTERNAL_SERVER_ERROR');
      return;
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
