import { Router } from 'express';
import { CollaborationController } from '../controllers/collaboration.controller';
import { authenticate, requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate, requireAuth);

router.get('/', CollaborationController.listInvitations);
router.post('/:id/accept', CollaborationController.accept);
router.post('/:id/decline', CollaborationController.decline);
router.delete('/:id', CollaborationController.revoke);

export default router;
