import { Response } from 'express';
import { ApiResponse } from '../types';

export function sendSuccess<T>(
  res: Response,
  data?: T,
  message: string = 'Operation completed successfully',
  statusCode: number = 200
): Response {
  const payload: ApiResponse<T> = {
    success: true,
    data,
    message,
  };
  return res.status(statusCode).json(payload);
}

export function sendError(
  res: Response,
  message: string,
  statusCode: number = 400,
  code: string = 'BAD_REQUEST',
  errors?: unknown
): Response {
  const payload: ApiResponse = {
    success: false,
    message,
    code,
    ...(errors !== undefined ? { errors } : {}),
  };
  return res.status(statusCode).json(payload);
}
