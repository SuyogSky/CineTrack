import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { apiRateLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/error.middleware';
import { csrfProtection, getAllowedOrigins } from './middleware/csrf.middleware';
import { prisma } from './config/database';
import routes from './routes';
import { sendError, sendSuccess } from './utils/response';

export const app = express();

// Explicit reverse proxy trust configuration
if (env.TRUST_PROXY === 'true') {
  app.set('trust proxy', true);
} else if (env.TRUST_PROXY === 'false') {
  app.set('trust proxy', false);
} else if (!isNaN(Number(env.TRUST_PROXY))) {
  app.set('trust proxy', Number(env.TRUST_PROXY));
} else if (env.TRUST_PROXY) {
  app.set('trust proxy', env.TRUST_PROXY);
}

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
    crossOriginEmbedderPolicy: false,
  })
);

// CORS configuration supporting comma-separated production origins
const allowedOrigins = getAllowedOrigins();

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile native apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || env.NODE_ENV === 'test') {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS policy'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-CSRF-Token',
      'X-XSRF-TOKEN',
    ],
  })
);

// Body parsers & cookies
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// CSRF Protection (Double-Submit Cookie & Origin Validation)
app.use(csrfProtection);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  sendSuccess(res, { status: 'healthy', uptime: process.uptime() }, 'Service is healthy');
});
app.get('/api/health', (_req: Request, res: Response) => {
  sendSuccess(res, { status: 'healthy', uptime: process.uptime() }, 'Service is healthy');
});

// Readiness check endpoint (verifies database connectivity)
app.get('/api/ready', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    sendSuccess(res, { status: 'ready', database: 'connected' }, 'Service is ready');
  } catch {
    sendError(res, 'Database connection unavailable', 503, 'SERVICE_UNAVAILABLE');
  }
});

// API rate limiting
app.use('/api', apiRateLimiter);

// API routes
app.use('/api', routes);

// 404 handler
app.use((_req: Request, res: Response) => {
  sendError(res, 'The requested API route does not exist', 404, 'NOT_FOUND');
});

// Centralized error handler
app.use(errorHandler);

export default app;
