import { prisma } from '../config/database';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';
import {
  CreateCollectionInput,
  UpdateCollectionInput,
} from '../validators/collection.validator';
import { generateShareToken, selectRandomElement } from '../utils/random';

type PersonalStatusEntry = {
  movieId: string;
  status: 'TO_WATCH' | 'WATCHED';
  watchedAt: Date | null;
};

async function withPersonalWatchStatuses<
  T extends { movies: PersonalStatusEntry[] }
>(
  userId: string,
  collection: T
): Promise<T> {
  const movieIds = [
    ...new Set(collection.movies.map((entry) => entry.movieId)),
  ];

  if (movieIds.length === 0) {
    return collection;
  }

  const statuses = await prisma.userMovieWatchStatus.findMany({
    where: {
      userId,
      movieId: {
        in: movieIds,
      },
    },
    select: {
      movieId: true,
      status: true,
      watchedAt: true,
    },
  });

  const statusByMovieId = new Map(
    statuses.map((status) => [status.movieId, status])
  );

  return {
    ...collection,
    movies: collection.movies.map((entry) => {
      const personalStatus = statusByMovieId.get(entry.movieId);

      return {
        ...entry,
        status: personalStatus?.status ?? 'TO_WATCH',
        watchedAt: personalStatus?.watchedAt ?? null,
      };
    }),
  } as T;
}

export type UserRoleInCollection = 'OWNER' | 'COLLABORATOR' | 'NONE';

export class CollectionService {
  static async checkCollectionAccess(
    collectionId: string,
    userId: string
  ): Promise<{ role: UserRoleInCollection; collection: any }> {
    const collection = await prisma.collection.findUnique({
      where: { id: collectionId },
      include: {
        owner: {
          select: { id: true, username: true, email: true },
        },
        members: {
          include: {
            user: {
              select: { id: true, username: true, email: true },
            },
          },
        },
      },
    });

    if (!collection) {
      throw new NotFoundError('Collection not found');
    }

    if (collection.ownerId === userId) {
      return { role: 'OWNER', collection };
    }

    const isMember = collection.members.some((m) => m.userId === userId);
    if (isMember) {
      return { role: 'COLLABORATOR', collection };
    }

    return { role: 'NONE', collection };
  }

  static async getUserDefaultWatchlist(userId: string) {
    let watchlist = await prisma.collection.findFirst({
      where: { ownerId: userId, isDefaultWatchlist: true },
      include: {
        movies: {
          include: {
            movie: true,
            adder: { select: { id: true, username: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { movies: true } },
      },
    });

    if (!watchlist) {
      try {
        watchlist = await prisma.collection.create({
          data: {
            ownerId: userId,
            title: 'My Watchlist',
            description: 'Personal master watchlist for movies to watch.',
            visibility: 'PRIVATE',
            isDefaultWatchlist: true,
          },
          include: {
            movies: {
              include: {
                movie: true,
                adder: { select: { id: true, username: true } },
              },
              orderBy: { createdAt: 'desc' },
            },
            _count: { select: { movies: true } },
          },
        });
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code === 'P2002') {
          // Concurrent request created default watchlist first; fetch it
          watchlist = await prisma.collection.findFirst({
            where: { ownerId: userId, isDefaultWatchlist: true },
            include: {
              movies: {
                include: {
                  movie: true,
                  adder: { select: { id: true, username: true } },
                },
                orderBy: { createdAt: 'desc' },
              },
              _count: { select: { movies: true } },
            },
          });
          if (!watchlist) throw err;
        } else {
          throw err;
        }
      }
    }

    return watchlist
      ? await withPersonalWatchStatuses(userId, watchlist)
      : watchlist;
  }

  static async listUserCollections(userId: string) {
    const owned = await prisma.collection.findMany({
      where: { ownerId: userId },
      include: {
        owner: { select: { id: true, username: true } },
        _count: { select: { movies: true, members: true } },
      },
      orderBy: [{ isDefaultWatchlist: 'desc' }, { createdAt: 'desc' }],
    });

    const shared = await prisma.collection.findMany({
      where: {
        members: { some: { userId } },
      },
      include: {
        owner: { select: { id: true, username: true } },
        _count: { select: { movies: true, members: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { owned, shared };
  }

  static async getCollectionById(collectionId: string, userId?: string) {
    const collection = await prisma.collection.findUnique({
      where: { id: collectionId },
      include: {
        owner: { select: { id: true, username: true } },
        members: {
          include: {
            user: { select: { id: true, username: true } },
          },
        },
        movies: {
          include: {
            movie: true,
            adder: { select: { id: true, username: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { movies: true, members: true } },
      },
    });

    if (!collection) {
      throw new NotFoundError('Collection not found');
    }

    // If userId provided, check authorization
    if (userId) {
      const isOwner = collection.ownerId === userId;
      const isMember = collection.members.some((m) => m.userId === userId);
      if (!isOwner && !isMember) {
        throw new ForbiddenError('You do not have access to this collection');
      }
      const personalizedCollection = await withPersonalWatchStatuses(
        userId,
        collection
      );

      return {
        ...personalizedCollection,
        userRole: isOwner ? 'OWNER' : 'COLLABORATOR',
      };
    }

    return collection;
  }

  static async createCollection(userId: string, input: CreateCollectionInput) {
    return prisma.collection.create({
      data: {
        ownerId: userId,
        title: input.title,
        description: input.description,
        visibility: 'PRIVATE',
      },
      include: {
        owner: { select: { id: true, username: true } },
        _count: { select: { movies: true, members: true } },
      },
    });
  }

  static async updateCollection(
    collectionId: string,
    userId: string,
    input: UpdateCollectionInput
  ) {
    const { role, collection } = await this.checkCollectionAccess(collectionId, userId);

    if (role !== 'OWNER') {
      throw new ForbiddenError('Only the collection owner can modify collection details');
    }

    return prisma.collection.update({
      where: { id: collectionId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      include: {
        owner: { select: { id: true, username: true } },
        _count: { select: { movies: true, members: true } },
      },
    });
  }

  static async deleteCollection(collectionId: string, userId: string) {
    const { role, collection } = await this.checkCollectionAccess(collectionId, userId);

    if (role !== 'OWNER') {
      throw new ForbiddenError('Only the collection owner can delete the collection');
    }

    if (collection.isDefaultWatchlist) {
      throw new ForbiddenError('Cannot delete your default master watchlist');
    }

    await prisma.collection.delete({
      where: { id: collectionId },
    });

    return { id: collectionId, deleted: true };
  }

  static async enablePublicSharing(collectionId: string, userId: string) {
    const { role } = await this.checkCollectionAccess(collectionId, userId);

    if (role !== 'OWNER') {
      throw new ForbiddenError('Only the collection owner can manage sharing settings');
    }

    const shareToken = generateShareToken();

    return prisma.collection.update({
      where: { id: collectionId },
      data: {
        visibility: 'PUBLIC_LINK',
        shareToken,
      },
      select: {
        id: true,
        title: true,
        visibility: true,
        shareToken: true,
      },
    });
  }

  static async disablePublicSharing(collectionId: string, userId: string) {
    const { role } = await this.checkCollectionAccess(collectionId, userId);

    if (role !== 'OWNER') {
      throw new ForbiddenError('Only the collection owner can manage sharing settings');
    }

    return prisma.collection.update({
      where: { id: collectionId },
      data: {
        visibility: 'PRIVATE',
        shareToken: null,
      },
      select: {
        id: true,
        title: true,
        visibility: true,
        shareToken: true,
      },
    });
  }

  static async getPublicCollectionByToken(shareToken: string) {
    if (!shareToken || shareToken.trim() === '') {
      throw new NotFoundError('Invalid share link');
    }

    const collection = await prisma.collection.findUnique({
      where: { shareToken },
      include: {
        owner: { select: { username: true } },
        movies: {
          include: {
            movie: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { movies: true } },
      },
    });

    if (!collection || collection.visibility !== 'PUBLIC_LINK') {
      throw new NotFoundError('Collection is not available or public sharing has been revoked');
    }

    const personalizedCollection = await withPersonalWatchStatuses(
      collection.ownerId,
      collection
    );

    return {
      id: collection.id,
      title: collection.title,
      description: collection.description,
      ownerUsername: collection.owner.username,
      createdAt: collection.createdAt,
      movies: personalizedCollection.movies.map((cm) => ({
        id: cm.id,
        movieId: cm.movieId,
        status: cm.status,
        watchedAt: cm.watchedAt,
        createdAt: cm.createdAt,
        movie: cm.movie,
      })),
      totalMovies: collection._count.movies,
    };
  }

  static async getRandomUnwatchedMovie(
    collectionId: string,
    userId: string,
    rng: () => number = Math.random
  ) {
    const { role } = await this.checkCollectionAccess(
      collectionId,
      userId
    );

    if (role === 'NONE') {
      throw new ForbiddenError(
        'You do not have access to this collection'
      );
    }

    const entries = await prisma.collectionMovie.findMany({
      where: {
        collectionId,
      },
      include: {
        movie: true,
        collection: {
          select: {
            id: true,
            title: true,
          },
        },
        adder: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });

    const movieIds = [...new Set(entries.map((entry) => entry.movieId))];

    const statuses = movieIds.length
      ? await prisma.userMovieWatchStatus.findMany({
        where: {
          userId,
          movieId: {
            in: movieIds,
          },
        },
      })
      : [];

    const statusMap = new Map(
      statuses.map((status) => [status.movieId, status])
    );

    const unwatched = entries
      .map((entry) => {
        const personalStatus = statusMap.get(entry.movieId);

        return {
          ...entry,
          status: personalStatus?.status ?? 'TO_WATCH',
          watchedAt: personalStatus?.watchedAt ?? null,
        };
      })
      .filter((entry) => entry.status === 'TO_WATCH');

    if (unwatched.length === 0) {
      return null;
    }

    const picked = selectRandomElement(unwatched, rng);

    if (!picked) {
      return null;
    }

    return {
      entry: picked,
      movie: picked.movie,
      sourceCollections: [
        {
          id: picked.collection.id,
          title: picked.collection.title,
        },
      ],
    };
  }

  static async getAccountStats(userId: string) {
    const owned = await prisma.collection.findMany({
      where: {
        ownerId: userId,
      },
      select: {
        id: true,
      },
    });

    const memberships = await prisma.collectionMember.findMany({
      where: {
        userId,
      },
      select: {
        collectionId: true,
      },
    });

    const ownedIds = owned.map((collection) => collection.id);
    const memberIds = memberships.map((member) => member.collectionId);

    const allAccessibleIds = [
      ...new Set([...ownedIds, ...memberIds]),
    ];

    if (allAccessibleIds.length === 0) {
      return {
        totalMovies: 0,
        totalTvSeries: 0,
        totalItems: 0,
        totalToWatch: 0,
        totalWatched: 0,
        totalCollections: 0,
        ownedCollectionsCount: 0,
        sharedCollectionsCount: 0,
      };
    }

    const collectionMovies = await prisma.collectionMovie.findMany({
      where: {
        collectionId: {
          in: allAccessibleIds,
        },
      },
      select: {
        movieId: true,
        movie: {
          select: {
            id: true,
            tmdbId: true,
            mediaType: true,
          },
        },
      },
    });

    const movieIds = [
      ...new Set(collectionMovies.map((entry) => entry.movieId)),
    ];

    const personalStatuses = movieIds.length
      ? await prisma.userMovieWatchStatus.findMany({
        where: {
          userId,
          movieId: {
            in: movieIds,
          },
        },
        select: {
          movieId: true,
          status: true,
        },
      })
      : [];

    const statusByMovieId = new Map(
      personalStatuses.map((status) => [
        status.movieId,
        status.status,
      ])
    );

    // Deduplicate movies across collections.
    const mediaMap = new Map<
      string,
      {
        mediaType: 'MOVIE' | 'TV';
        movieId: string;
      }
    >();

    for (const entry of collectionMovies) {
      const key = `${entry.movie.mediaType}:${entry.movie.tmdbId}`;

      if (!mediaMap.has(key)) {
        mediaMap.set(key, {
          mediaType: entry.movie.mediaType as 'MOVIE' | 'TV',
          movieId: entry.movieId,
        });
      }
    }

    let totalMovies = 0;
    let totalTvSeries = 0;
    let totalWatched = 0;
    let totalToWatch = 0;

    for (const media of mediaMap.values()) {
      if (media.mediaType === 'MOVIE') {
        totalMovies++;
      } else {
        totalTvSeries++;
      }

      const status = statusByMovieId.get(media.movieId);

      if (status === 'WATCHED') {
        totalWatched++;
      } else {
        totalToWatch++;
      }
    }

    return {
      totalMovies,
      totalTvSeries,
      totalItems: mediaMap.size,
      totalToWatch,
      totalWatched,
      totalCollections: allAccessibleIds.length,
      ownedCollectionsCount: ownedIds.length,
      sharedCollectionsCount: memberIds.length,
    };
  }

  static async getRandomMovieFromCollections(
    userId: string,
    requestedCollectionIds?: string[] | 'ALL',
    rng?: () => number,
    includeWatched: boolean = false
  ) {
    // Resolve collections accessible to this user.
    const owned = await prisma.collection.findMany({
      where: {
        ownerId: userId,
      },
      select: {
        id: true,
        title: true,
      },
    });

    const memberships = await prisma.collectionMember.findMany({
      where: {
        userId,
      },
      include: {
        collection: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    const accessibleCollectionsMap = new Map<string, string>();

    for (const collection of owned) {
      accessibleCollectionsMap.set(
        collection.id,
        collection.title
      );
    }

    for (const membership of memberships) {
      accessibleCollectionsMap.set(
        membership.collection.id,
        membership.collection.title
      );
    }

    let targetCollectionIds: string[];

    if (!requestedCollectionIds || requestedCollectionIds === 'ALL') {
      targetCollectionIds = Array.from(
        accessibleCollectionsMap.keys()
      );
    } else if (Array.isArray(requestedCollectionIds)) {
      if (requestedCollectionIds.length === 0) {
        throw new BadRequestError(
          'At least one collection ID must be specified'
        );
      }

      for (const collectionId of requestedCollectionIds) {
        if (!accessibleCollectionsMap.has(collectionId)) {
          throw new ForbiddenError(
            `You do not have access to collection ${collectionId}`
          );
        }
      }

      targetCollectionIds = [
        ...new Set(requestedCollectionIds),
      ];
    } else {
      throw new BadRequestError(
        'Invalid collection IDs parameter'
      );
    }

    if (targetCollectionIds.length === 0) {
      return null;
    }

    // Fetch all entries in the selected collections.
    const candidateEntries = await prisma.collectionMovie.findMany({
      where: {
        collectionId: {
          in: targetCollectionIds,
        },
      },
      include: {
        movie: true,
        collection: {
          select: {
            id: true,
            title: true,
          },
        },
        adder: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });

    if (candidateEntries.length === 0) {
      return null;
    }

    // Retrieve this user's personal status for these movies.
    const movieIds = [
      ...new Set(candidateEntries.map((entry) => entry.movieId)),
    ];

    const personalStatuses = await prisma.userMovieWatchStatus.findMany({
      where: {
        userId,
        movieId: {
          in: movieIds,
        },
      },
    });

    const statusMap = new Map(
      personalStatuses.map((status) => [
        status.movieId,
        status,
      ])
    );

    const personalizedEntries = candidateEntries.map((entry) => {
      const personalStatus = statusMap.get(entry.movieId);

      return {
        ...entry,
        status: personalStatus?.status ?? 'TO_WATCH',
        watchedAt: personalStatus?.watchedAt ?? null,
      };
    });

    // Filter using the requesting user's status.
    const eligibleEntries = personalizedEntries.filter(
      (entry) =>
        includeWatched || entry.status !== 'WATCHED'
    );

    if (eligibleEntries.length === 0) {
      return null;
    }

    // Deduplicate the same movie across selected collections.
    const movieCandidatesMap = new Map<
      string,
      {
        entries: typeof personalizedEntries;
        movie: (typeof candidateEntries)[number]['movie'];
        sourceCollections: {
          id: string;
          title: string;
        }[];
      }
    >();

    for (const entry of eligibleEntries) {
      const key = `${entry.movie.mediaType}:${entry.movie.tmdbId}`;

      let group = movieCandidatesMap.get(key);

      if (!group) {
        group = {
          entries: [],
          movie: entry.movie,
          sourceCollections: [],
        };

        movieCandidatesMap.set(key, group);
      }

      group.entries.push(entry);

      if (
        !group.sourceCollections.some(
          (collection) => collection.id === entry.collectionId
        )
      ) {
        group.sourceCollections.push({
          id: entry.collection.id,
          title: entry.collection.title,
        });
      }
    }

    const uniqueCandidates = Array.from(
      movieCandidatesMap.values()
    );

    if (uniqueCandidates.length === 0) {
      return null;
    }

    const chosenGroup = selectRandomElement(
      uniqueCandidates,
      rng
    );

    if (!chosenGroup) {
      return null;
    }

    const primaryEntry = chosenGroup.entries[0];

    return {
      entry: primaryEntry,
      movie: chosenGroup.movie,
      sourceCollections: chosenGroup.sourceCollections,

      allEntries: chosenGroup.entries.map((entry) => ({
        id: entry.id,
        collectionId: entry.collectionId,
        collectionTitle: entry.collection.title,
        status: entry.status,
      })),
    };
  }
}
