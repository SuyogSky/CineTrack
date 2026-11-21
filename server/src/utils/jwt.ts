import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';
import { AuthUserPayload } from '../types';

export interface TokenPayload extends AuthUserPayload {
  sessionId: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && UUID_REGEX.test(sessionId);
}

export function generateAccessToken(payload: AuthUserPayload, sessionId: string): string {
  if (!sessionId || !isValidSessionId(sessionId)) {
    throw new Error('Invalid or missing sessionId: sessionId must be a valid UUID');
  }
  return jwt.sign(
    {
      ...payload,
      sessionId,
    },
    env.JWT_ACCESS_SECRET,
    {
      expiresIn: '15m',
    }
  );
}

export function generateRefreshToken(payload: AuthUserPayload, sessionId: string): string {
  return jwt.sign(
    {
      ...payload,
      sessionId,
      jti: crypto.randomUUID(),
    },
    env.JWT_REFRESH_SECRET,
    {
      expiresIn: '7d',
    }
  );
}

export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as any;
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      typeof decoded.id !== 'string' ||
      typeof decoded.username !== 'string' ||
      typeof decoded.email !== 'string' ||
      !isValidSessionId(decoded.sessionId)
    ) {
      return null;
    }
    return {
      id: decoded.id,
      username: decoded.username,
      email: decoded.email,
      sessionId: decoded.sessionId,
    };
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
