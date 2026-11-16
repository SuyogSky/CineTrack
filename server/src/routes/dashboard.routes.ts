import { Router } from 'express';
import { CollectionController } from '../controllers/collection.controller';
import { authenticate, requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate, requireAuth);

router.get('/stats', CollectionController.getAccountStats);

export default router;
