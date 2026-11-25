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
    try {
      const entry = await prisma.collectionMovie.create({
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

      const personalStatus = await prisma.userMovieWatchStatus.findUnique({
        where: {
          userId_movieId: {
            userId,
            movieId: movie.id,
          }
        }
      });

      return {
        ...entry,
        status: personalStatus?.status ?? 'TO_WATCH',
        watchedAt: personalStatus?.watchedAt ?? null,
      }
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error?.code === 'P2002') {
        throw new ConflictError('This movie is already in this collection');
      }
      throw err;
    }
  }

  static async updateMovie(
    collectionId: string,
    entryId: string,
    userId: string,
    input: UpdateCollectionMovieInput
  ) {
    const { role } = await CollectionService.checkCollectionAccess(
      collectionId,
      userId
    );

    if (role === 'NONE') {
      throw new ForbiddenError('You do not have access to this collection');
    }

    const entry = await prisma.collectionMovie.findFirst({
      where: {
        id: entryId,
        collectionId,
      },
    });

    if (!entry) {
      throw new NotFoundError('Movie entry not found in this collection');
    }

    return prisma.$transaction(async (tx) => {
      // Notes belong to the collection entry and remain shared.
      const updatedEntry =
        input.note !== undefined
          ? await tx.collectionMovie.update({
            where: { id: entryId },
            data: { note: input.note },
            include: {
              movie: true,
              adder: {
                select: {
                  id: true,
                  username: true,
                },
              },
            },
          })
          : await tx.collectionMovie.findUnique({
            where: { id: entryId },
            include: {
              movie: true,
              adder: {
                select: {
                  id: true,
                  username: true,
                },
              },
            },
          });

      if (!updatedEntry) {
        throw new NotFoundError('Movie entry no longer exists');
      }

      const statusKey = {
        userId_movieId: {
          userId,
          movieId: entry.movieId,
        },
      };

      let personalStatus = await tx.userMovieWatchStatus.findUnique({
        where: statusKey,
      });

      // Watched status belongs to the requesting user, not the collection.
      if (input.status !== undefined) {
        const watchedAt =
          input.status === 'WATCHED'
            ? personalStatus?.status === 'WATCHED'
              ? personalStatus.watchedAt ?? new Date()
              : new Date()
            : null;

        personalStatus = await tx.userMovieWatchStatus.upsert({
          where: statusKey,

          create: {
            userId,
            movieId: entry.movieId,
            status: input.status,
            watchedAt,
          },

          update: {
            status: input.status,
            watchedAt,
          },
        });
      }

      return {
        ...updatedEntry,
        status: personalStatus?.status ?? 'TO_WATCH',
        watchedAt: personalStatus?.watchedAt ?? null,
      };
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

      try {
        const movedEntry = await tx.collectionMovie.create({
          data: {
            collectionId: destinationCollectionId,
            movieId: entry.movieId,
            addedBy: userId,

            // Personal status is stored separately.
            status: 'TO_WATCH',
            watchedAt: null,

            note: entry.note,
          },
          include: {
            movie: true,
            adder: {
              select: {
                id: true,
                username: true,
              },
            },
          },
        });

        const personalStatus = await tx.userMovieWatchStatus.findUnique({
          where: {
            userId_movieId: {
              userId,
              movieId: entry.movieId,
            },
          },
        });

        return {
          ...movedEntry,
          status: personalStatus?.status ?? 'TO_WATCH',
          watchedAt: personalStatus?.watchedAt ?? null,
        };
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code === 'P2002') {
          throw new ConflictError('Movie already exists in the destination collection');
        }
        throw err;
      }
    });
  }
}
