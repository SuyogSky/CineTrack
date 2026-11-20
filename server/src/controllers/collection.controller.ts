import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { CollectionService } from '../services/collection.service';
import { CollectionMovieService } from '../services/collectionMovie.service';
import {
  createCollectionSchema,
  updateCollectionSchema,
  addMovieToCollectionSchema,
  updateCollectionMovieSchema,
  moveMovieSchema,
  multiCollectionRouletteSchema,
} from '../validators/collection.validator';
import { sendSuccess } from '../utils/response';

export class CollectionController {
  static async getDefaultWatchlist(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const watchlist = await CollectionService.getUserDefaultWatchlist(req.user!.id);
      sendSuccess(res, { collection: watchlist });
    } catch (error) {
      next(error);
    }
  }

  static async listCollections(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const collections = await CollectionService.listUserCollections(req.user!.id);
      sendSuccess(res, collections);
    } catch (error) {
      next(error);
    }
  }

  static async createCollection(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const input = createCollectionSchema.parse(req.body);
      const collection = await CollectionService.createCollection(req.user!.id, input);
      sendSuccess(res, { collection }, 'Collection created successfully', 201);
    } catch (error) {
      next(error);
    }
  }

  static async getCollection(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const collection = await CollectionService.getCollectionById(id, req.user!.id);
      sendSuccess(res, { collection });
    } catch (error) {
      next(error);
    }
  }

  static async updateCollection(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const input = updateCollectionSchema.parse(req.body);
      const collection = await CollectionService.updateCollection(id, req.user!.id, input);
      sendSuccess(res, { collection }, 'Collection updated successfully');
    } catch (error) {
      next(error);
    }
  }

  static async deleteCollection(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const result = await CollectionService.deleteCollection(id, req.user!.id);
      sendSuccess(res, result, 'Collection deleted successfully');
    } catch (error) {
      next(error);
    }
  }

  static async addMovie(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const input = addMovieToCollectionSchema.parse(req.body);
      const entry = await CollectionMovieService.addMovie(id, req.user!.id, input);
      sendSuccess(res, { entry }, 'Movie added to collection', 201);
    } catch (error) {
      next(error);
    }
  }

  static async updateMovie(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const entryId = req.params.entryId as string;
      const input = updateCollectionMovieSchema.parse(req.body);
      const entry = await CollectionMovieService.updateMovie(
        id,
        entryId,
        req.user!.id,
        input
      );
      sendSuccess(res, { entry }, 'Movie entry updated');
    } catch (error) {
      next(error);
    }
  }

  static async removeMovie(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const entryId = req.params.entryId as string;
      const result = await CollectionMovieService.removeMovie(id, entryId, req.user!.id);
      sendSuccess(res, result, 'Movie removed from collection');
    } catch (error) {
      next(error);
    }
  }

  static async moveMovie(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const entryId = req.params.entryId as string;
      const input = moveMovieSchema.parse(req.body);
      const entry = await CollectionMovieService.moveMovie(
        id,
        entryId,
        req.user!.id,
        input
      );
      sendSuccess(res, { entry }, 'Movie moved successfully');
    } catch (error) {
      next(error);
    }
  }

  static async getAccountStats(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const stats = await CollectionService.getAccountStats(req.user!.id);
      sendSuccess(res, stats);
    } catch (error) {
      next(error);
    }
  }

  static async getMultiCollectionRoulette(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const rawInput = req.method === 'POST' ? req.body : req.query;
      const validated = multiCollectionRouletteSchema.parse(rawInput);

      const result = await CollectionService.getRandomMovieFromCollections(
        req.user!.id,
        validated.collectionIds,
        undefined,
        validated.includeWatched
      );

      sendSuccess(res, result || { entry: null, movie: null, sourceCollections: [] });
    } catch (error) {
      next(error);
    }
  }

  static async getRandomMovie(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const result = await CollectionService.getRandomMovieFromCollections(
        req.user!.id,
        [id],
        undefined,
        false
      );
      sendSuccess(res, result || { entry: null, movie: null, sourceCollections: [] });
    } catch (error) {
      next(error);
    }
  }

  static async enableSharing(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const result = await CollectionService.enablePublicSharing(id, req.user!.id);
      sendSuccess(res, result, 'Public sharing enabled');
    } catch (error) {
      next(error);
    }
  }

  static async disableSharing(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const id = req.params.id as string;
      const result = await CollectionService.disablePublicSharing(id, req.user!.id);
      sendSuccess(res, result, 'Public sharing disabled');
    } catch (error) {
      next(error);
    }
  }
}
