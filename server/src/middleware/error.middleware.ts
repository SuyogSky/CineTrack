import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { sendError } from '../utils/response';
import { env } from '../config/env';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    sendError(res, err.message, err.statusCode, err.code, err.errors);
    return;
  }

  if (err instanceof ZodError) {
    const formatted = err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    sendError(res, 'Validation error', 400, 'VALIDATION_ERROR', formatted);
    return;
  }

  // Prisma known errors
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const prismaErr = err as { code: string; meta?: { target?: string[] } };
    if (prismaErr.code === 'P2002') {
      const field = prismaErr.meta?.target ? prismaErr.meta.target.join(', ') : 'field';
      sendError(res, `A record with this ${field} already exists`, 409, 'CONFLICT');
      return;
    }
    if (prismaErr.code === 'P2025') {
      sendError(res, 'Record not found', 404, 'NOT_FOUND');
      return;
    }
  }

  if (env.NODE_ENV !== 'test') {
    console.error('Unhandled Server Error:', err);
  }

  const message =
    env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err instanceof Error
      ? err.message
      : 'Internal Server Error';

  sendError(res, message, 500, 'INTERNAL_SERVER_ERROR');
}
