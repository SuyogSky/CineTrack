import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { apiRateLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/error.middleware';
import routes from './routes';
import { sendError, sendSuccess } from './utils/response';

export const app = express();

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
    crossOriginEmbedderPolicy: false,
  })
);

// CORS configuration
const allowedOrigins = [
  env.CORS_ORIGIN,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1 || env.NODE_ENV === 'test') {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS policy'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

// Body parsers & cookies
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  sendSuccess(res, { status: 'healthy', uptime: process.uptime() }, 'Service is healthy');
});
app.get('/api/health', (_req: Request, res: Response) => {
  sendSuccess(res, { status: 'healthy', uptime: process.uptime() }, 'Service is healthy');
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
