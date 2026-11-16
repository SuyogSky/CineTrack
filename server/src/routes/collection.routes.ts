import { Router } from 'express';
import { CollectionController } from '../controllers/collection.controller';
import { CollaborationController } from '../controllers/collaboration.controller';
import { authenticate, requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate, requireAuth);

// Watchlist shortcut
router.get('/default-watchlist', CollectionController.getDefaultWatchlist);

// Aggregate stats across all accessible collections
router.get('/stats', CollectionController.getAccountStats);

// Multi-collection Roulette / Pick for Us
router.get('/roulette', CollectionController.getMultiCollectionRoulette);
router.post('/roulette', CollectionController.getMultiCollectionRoulette);

// Collections CRUD
router.get('/', CollectionController.listCollections);
router.post('/', CollectionController.createCollection);
router.get('/:id', CollectionController.getCollection);
router.patch('/:id', CollectionController.updateCollection);
router.delete('/:id', CollectionController.deleteCollection);

// Collection movies
router.post('/:id/movies', CollectionController.addMovie);
router.patch('/:id/movies/:entryId', CollectionController.updateMovie);
router.delete('/:id/movies/:entryId', CollectionController.removeMovie);
router.post('/:id/movies/:entryId/move', CollectionController.moveMovie);

// Movie roulette
router.get('/:id/random', CollectionController.getRandomMovie);

// Public sharing controls
router.post('/:id/share', CollectionController.enableSharing);
router.delete('/:id/share', CollectionController.disableSharing);

// Collaborator management under collection
router.get('/:id/members', CollaborationController.listMembers);
router.post('/:id/invitations', CollaborationController.invite);
router.delete('/:id/members/:userId', CollaborationController.removeMember);

export default router;
