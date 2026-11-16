import { Request, Response, NextFunction } from 'express';
import { TmdbService } from '../services/tmdb.service';
import { movieSearchQuerySchema } from '../validators/movie.validator';
import { sendSuccess } from '../utils/response';
import { MovieService } from '../services/movie.service';
import { MediaType } from '../types';

export class MovieController {
  static async search(req: Request, res: Response, next: NextFunction) {
    try {
      const { q, page, type } = movieSearchQuerySchema.parse(req.query);
      const results = await TmdbService.search(q, type, page);
      sendSuccess(res, results);
    } catch (error) {
      next(error);
    }
  }

  static async getDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const tmdbIdParam = req.params.tmdbId as string;
      const tmdbId = parseInt(tmdbIdParam, 10);
      if (isNaN(tmdbId) || tmdbId <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid TMDb ID parameter',
          code: 'VALIDATION_ERROR',
        });
      }

      const mediaType: MediaType = req.query.type === 'tv' ? 'tv' : 'movie';
      const movie = await MovieService.getMovieByTmdbId(tmdbId, mediaType);
      sendSuccess(res, { movie });
    } catch (error) {
      next(error);
    }
  }
}
