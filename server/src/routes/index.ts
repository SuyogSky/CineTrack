import { Router } from 'express';
import authRoutes from './auth.routes';
import movieRoutes from './movie.routes';
import collectionRoutes from './collection.routes';
import invitationRoutes from './invitation.routes';
import publicRoutes from './public.routes';
import dashboardRoutes from './dashboard.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/movies', movieRoutes);
router.use('/collections', collectionRoutes);
router.use('/invitations', invitationRoutes);
router.use('/public', publicRoutes);

export default router;
