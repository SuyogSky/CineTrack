import { prisma } from '../config/database';
import { TmdbService } from './tmdb.service';
import { NotFoundError } from '../utils/errors';
import { MediaType } from '../types';

export class MovieService {
  static async getOrCreateMovie(tmdbId: number, mediaType: MediaType = 'movie') {
    const prismaMediaType = mediaType === 'tv' ? 'TV' : 'MOVIE';

    // 1. Check existing
    let movie = await prisma.movie.findUnique({
      where: {
        tmdbId_mediaType: {
          tmdbId,
          mediaType: prismaMediaType,
        },
      },
    });

    if (movie) {
      return movie;
    }

    // 2. Fetch metadata from TMDb service
    const metadata = await TmdbService.getMediaDetails(tmdbId, mediaType);
    if (!metadata) {
      // Try search if direct get fails
      const searchRes = await TmdbService.search(String(tmdbId), mediaType);
      const match = searchRes.items.find(
        (m) => m.tmdbId === tmdbId && m.mediaType === mediaType
      );
      if (!match) {
        throw new NotFoundError(
          `${mediaType === 'tv' ? 'TV Series' : 'Movie'} with TMDb ID ${tmdbId} not found`
        );
      }
      try {
        movie = await prisma.movie.create({
          data: {
            tmdbId: match.tmdbId,
            mediaType: prismaMediaType,
            title: match.title,
            originalTitle: match.originalTitle,
            overview: match.overview,
            posterPath: match.posterPath,
            backdropPath: match.backdropPath,
            releaseDate: match.releaseDate,
            releaseYear: match.releaseYear,
            originalLanguage: match.originalLanguage,
            popularity: match.popularity,
            voteAverage: match.voteAverage,
            genres: match.genres,
          },
        });
        return movie;
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code === 'P2002') {
          const existing = await prisma.movie.findUnique({
            where: {
              tmdbId_mediaType: {
                tmdbId,
                mediaType: prismaMediaType,
              },
            },
          });
          if (existing) return existing;
        }
        throw err;
      }
    }

    try {
      movie = await prisma.movie.create({
        data: {
          tmdbId: metadata.tmdbId,
          mediaType: prismaMediaType,
          title: metadata.title,
          originalTitle: metadata.originalTitle,
          overview: metadata.overview,
          posterPath: metadata.posterPath,
          backdropPath: metadata.backdropPath,
          releaseDate: metadata.releaseDate,
          releaseYear: metadata.releaseYear,
          originalLanguage: metadata.originalLanguage,
          popularity: metadata.popularity,
          voteAverage: metadata.voteAverage,
          genres: metadata.genres,
        },
      });
      return movie;
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error?.code === 'P2002') {
        const existing = await prisma.movie.findUnique({
          where: {
            tmdbId_mediaType: {
              tmdbId,
              mediaType: prismaMediaType,
            },
          },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  static async getMovieById(id: string) {
    const movie = await prisma.movie.findUnique({
      where: { id },
    });
    if (!movie) {
      throw new NotFoundError('Movie/TV item not found');
    }
    return movie;
  }

  static async getMovieByTmdbId(tmdbId: number, mediaType: MediaType = 'movie') {
    const prismaMediaType = mediaType === 'tv' ? 'TV' : 'MOVIE';
    let movie = await prisma.movie.findUnique({
      where: {
        tmdbId_mediaType: {
          tmdbId,
          mediaType: prismaMediaType,
        },
      },
    });
    if (!movie) {
      movie = await this.getOrCreateMovie(tmdbId, mediaType);
    }
    return movie;
  }
}
