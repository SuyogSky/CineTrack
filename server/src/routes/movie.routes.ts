import { Router } from 'express';
import { MovieController } from '../controllers/movie.controller';
import { authenticate, requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate, requireAuth);

router.get('/search', MovieController.search);
router.get('/:tmdbId', MovieController.getDetails);

export default router;
