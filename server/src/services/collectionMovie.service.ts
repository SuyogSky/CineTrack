import { prisma } from '../config/database';
import { CollectionService } from './collection.service';
import { MovieService } from './movie.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';
import {
  AddMovieToCollectionInput,
  MoveMovieInput,
  UpdateCollectionMovieInput,
} from '../validators/collection.validator';

export class CollectionMovieService {
  static async addMovie(
    collectionId: string,
    userId: string,
    input: AddMovieToCollectionInput
  ) {
    const { role } = await CollectionService.checkCollectionAccess(collectionId, userId);
    if (role === 'NONE') {
      throw new ForbiddenError('You do not have access to this collection');
    }

    // 1. Get or create canonical Movie
    const movie = await MovieService.getOrCreateMovie(
      input.tmdbId,
      input.mediaType || 'movie'
    );

    // 2. Check if already in collection
    const existing = await prisma.collectionMovie.findUnique({
      where: {
        collectionId_movieId: {
          collectionId,
          movieId: movie.id,
        },
      },
    });

    if (existing) {
      throw new ConflictError('This movie is already in this collection');
    }

    // 3. Create entry
    return prisma.collectionMovie.create({
      data: {
        collectionId,
        movieId: movie.id,
        addedBy: userId,
        status: 'TO_WATCH',
        watchedAt: null,
        note: input.note || null,
      },
      include: {
        movie: true,
        adder: { select: { id: true, username: true } },
      },
    });
  }

  static async updateMovie(
    collectionId: string,
    entryId: string,
    userId: string,
    input: UpdateCollectionMovieInput
  ) {
    const { role } = await CollectionService.checkCollectionAccess(collectionId, userId);
    if (role === 'NONE') {
      throw new ForbiddenError('You do not have access to this collection');
    }

    const entry = await prisma.collectionMovie.findFirst({
      where: { id: entryId, collectionId },
    });

    if (!entry) {
      throw new NotFoundError('Movie entry not found in this collection');
    }

    let watchedAt = entry.watchedAt;
    if (input.status) {
      if (input.status === 'WATCHED' && entry.status !== 'WATCHED') {
        watchedAt = new Date();
      } else if (input.status === 'TO_WATCH') {
        watchedAt = null;
      }
    }

    return prisma.collectionMovie.update({
      where: { id: entryId },
      data: {
        ...(input.status !== undefined ? { status: input.status, watchedAt } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      include: {
        movie: true,
        adder: { select: { id: true, username: true } },
      },
    });
  }

  static async removeMovie(collectionId: string, entryId: string, userId: string) {
    const { role } = await CollectionService.checkCollectionAccess(collectionId, userId);
    if (role === 'NONE') {
      throw new ForbiddenError('You do not have access to this collection');
    }

    const entry = await prisma.collectionMovie.findFirst({
      where: { id: entryId, collectionId },
    });

    if (!entry) {
      throw new NotFoundError('Movie entry not found in this collection');
    }

    await prisma.collectionMovie.delete({
      where: { id: entryId },
    });

    return { id: entryId, deleted: true };
  }

  static async moveMovie(
    sourceCollectionId: string,
    entryId: string,
    userId: string,
    input: MoveMovieInput
  ) {
    const destinationCollectionId = input.destinationCollectionId;

    if (sourceCollectionId === destinationCollectionId) {
      throw new ConflictError('Source and destination collections cannot be the same');
    }

    // Verify access to both collections
    const [sourceAccess, destAccess] = await Promise.all([
      CollectionService.checkCollectionAccess(sourceCollectionId, userId),
      CollectionService.checkCollectionAccess(destinationCollectionId, userId),
    ]);

    if (sourceAccess.role === 'NONE') {
      throw new ForbiddenError('You do not have access to the source collection');
    }
    if (destAccess.role === 'NONE') {
      throw new ForbiddenError('You do not have access to the destination collection');
    }

    const entry = await prisma.collectionMovie.findFirst({
      where: { id: entryId, collectionId: sourceCollectionId },
      include: { movie: true },
    });

    if (!entry) {
      throw new NotFoundError('Movie entry not found in the source collection');
    }

    // Check if destination already contains this movie
    const alreadyInDest = await prisma.collectionMovie.findUnique({
      where: {
        collectionId_movieId: {
          collectionId: destinationCollectionId,
          movieId: entry.movieId,
        },
      },
    });

    if (alreadyInDest) {
      throw new ConflictError('Movie already exists in the destination collection');
    }

    // Move atomically in a transaction
    return prisma.$transaction(async (tx) => {
      await tx.collectionMovie.delete({
        where: { id: entryId },
      });

      return tx.collectionMovie.create({
        data: {
          collectionId: destinationCollectionId,
          movieId: entry.movieId,
          addedBy: userId,
          status: entry.status,
          watchedAt: entry.watchedAt,
          note: entry.note,
        },
        include: {
          movie: true,
          adder: { select: { id: true, username: true } },
        },
      });
    });
  }
}
