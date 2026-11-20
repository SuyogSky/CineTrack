import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { registerSchema, loginSchema } from '../validators/auth.validator';
import { sendSuccess, sendError } from '../utils/response';
import { env } from '../config/env';
import { AuthenticatedRequest } from '../types';
import {
  CSRF_COOKIE_NAME,
  generateSignedCsrfToken,
  verifySignedCsrfToken,
} from '../middleware/csrf.middleware';

export class AuthController {
  static async getCsrfToken(req: Request, res: Response) {
    let token = req.cookies?.[CSRF_COOKIE_NAME];
    if (!token || !verifySignedCsrfToken(token)) {
      token = generateSignedCsrfToken();
      res.cookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN || undefined,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
      });
    }
    sendSuccess(res, { csrfToken: token }, 'CSRF token retrieved');
  }
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const input = registerSchema.parse(req.body);
      const userAgent = req.headers['user-agent'];
      const ipAddress = req.ip || req.socket.remoteAddress;

      const result = await AuthService.register(input, userAgent, ipAddress);

      // Set cookies
      res.cookie('access_token', result.accessToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN || undefined,
        maxAge: 15 * 60 * 1000, // 15 mins
      });

      res.cookie('refresh_token', result.refreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN || undefined,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      sendSuccess(
        res,
        { user: result.user },
        'Account registered successfully',
        201
      );
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const input = loginSchema.parse(req.body);
      const userAgent = req.headers['user-agent'];
      const ipAddress = req.ip || req.socket.remoteAddress;

      const result = await AuthService.login(input, userAgent, ipAddress);

      res.cookie('access_token', result.accessToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN || undefined,
        maxAge: 15 * 60 * 1000,
      });

      res.cookie('refresh_token', result.refreshToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN || undefined,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      sendSuccess(res, { user: result.user }, 'Logged in successfully');
    } catch (error) {
      next(error);
    }
  }

  static async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      // Refresh tokens are accepted strictly from secure HttpOnly cookies
      const refreshToken = req.cookies?.refresh_token;
      if (!refreshToken) {
        return sendError(
          res,
          'Refresh token cookie is missing',
          401,
          'UNAUTHORIZED'
        );
      }

      const userAgent = req.headers['user-agent'];
      const ipAddress = req.ip || req.socket.remoteAddress;

      const result = await AuthService.rotateRefreshToken(
        refreshToken,
        userAgent,
        ipAddress
      );

      res.cookie('access_token', result.accessToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN || undefined,
        maxAge: 15 * 60 * 1000,
      });

      if (result.refreshToken) {
        res.cookie('refresh_token', result.refreshToken, {
          httpOnly: true,
          secure: env.NODE_ENV === 'production',
          sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
          domain: env.COOKIE_DOMAIN || undefined,
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });
      }

      sendSuccess(
        res,
        {
          user: result.user,
        },
        'Token refreshed successfully'
      );
    } catch (error) {
      next(error);
    }
  }

  static async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const refreshToken = req.cookies?.refresh_token;
      const accessToken =
        req.cookies?.access_token ||
        (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.split(' ')[1]
          : undefined);
      await AuthService.logout(refreshToken, accessToken);

      res.clearCookie('access_token', {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN || undefined,
      });

      res.clearCookie('refresh_token', {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        domain: env.COOKIE_DOMAIN || undefined,
      });

      sendSuccess(res, null, 'Logged out successfully');
    } catch (error) {
      next(error);
    }
  }

  static async getMe(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const user = await AuthService.getCurrentUser(req.user!.id);
      sendSuccess(res, { user });
    } catch (error) {
      next(error);
    }
  }
}
