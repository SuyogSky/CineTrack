import { Router } from 'express';
import { PublicController } from '../controllers/public.controller';

const router = Router();

// Public view-only route - no authentication required
router.get('/collections/:shareToken', PublicController.getPublicCollection);

export default router;
