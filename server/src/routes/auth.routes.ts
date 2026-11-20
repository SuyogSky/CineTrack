import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { authenticate, requireAuth } from '../middleware/auth.middleware';
import { authRateLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/csrf', AuthController.getCsrfToken);
router.post('/register', authRateLimiter, AuthController.register);
router.post('/login', authRateLimiter, AuthController.login);
router.post('/refresh', AuthController.refresh);
router.post('/logout', AuthController.logout);
router.get('/me', authenticate, requireAuth, AuthController.getMe);

export default router;
