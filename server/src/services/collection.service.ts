import { prisma } from '../config/database';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';
import {
  CreateCollectionInput,
  UpdateCollectionInput,
} from '../validators/collection.validator';
import { generateShareToken, selectRandomElement } from '../utils/random';

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
    }

    return watchlist;
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
      return {
        ...collection,
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

    return {
      id: collection.id,
      title: collection.title,
      description: collection.description,
      ownerUsername: collection.owner.username,
      createdAt: collection.createdAt,
      movies: collection.movies.map((cm) => ({
        id: cm.id,
        movieId: cm.movieId,
        status: cm.status,
        watchedAt: cm.watchedAt,
        note: cm.note,
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
    const { role } = await this.checkCollectionAccess(collectionId, userId);

    if (role === 'NONE') {
      throw new ForbiddenError('You do not have access to this collection');
    }

    const unwatched = await prisma.collectionMovie.findMany({
      where: {
        collectionId,
        status: 'TO_WATCH',
      },
      include: {
        movie: true,
        collection: { select: { id: true, title: true } },
        adder: { select: { id: true, username: true } },
      },
    });

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
      sourceCollections: [{ id: picked.collection.id, title: picked.collection.title }],
    };
  }

  static async getAccountStats(userId: string) {
    // 1. Fetch all collections user has access to (owned + member)
    const owned = await prisma.collection.findMany({
      where: { ownerId: userId },
      select: { id: true, title: true },
    });

    const memberships = await prisma.collectionMember.findMany({
      where: { userId },
      select: { collectionId: true },
    });

    const ownedIds = owned.map((c) => c.id);
    const memberIds = memberships.map((m) => m.collectionId);
    const allAccessibleIds = Array.from(new Set([...ownedIds, ...memberIds]));

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

    // 2. Query all collection movies across accessible collections
    const collectionMovies = await prisma.collectionMovie.findMany({
      where: {
        collectionId: { in: allAccessibleIds },
      },
      select: {
        collectionId: true,
        status: true,
        movie: {
          select: {
            id: true,
            tmdbId: true,
            mediaType: true,
          },
        },
      },
    });

    // 3. Deduplicate across collections by unique media key `${mediaType}:${tmdbId}`
    interface MediaAggregate {
      mediaType: 'MOVIE' | 'TV';
      statuses: Set<'TO_WATCH' | 'WATCHED'>;
    }

    const mediaMap = new Map<string, MediaAggregate>();

    for (const cm of collectionMovies) {
      const mediaKey = `${cm.movie.mediaType}:${cm.movie.tmdbId}`;
      let agg = mediaMap.get(mediaKey);
      if (!agg) {
        agg = {
          mediaType: cm.movie.mediaType as 'MOVIE' | 'TV',
          statuses: new Set(),
        };
        mediaMap.set(mediaKey, agg);
      }
      agg.statuses.add(cm.status);
    }

    let totalMovies = 0;
    let totalTvSeries = 0;
    let totalWatched = 0;
    let totalToWatch = 0;

    for (const agg of mediaMap.values()) {
      if (agg.mediaType === 'MOVIE') {
        totalMovies++;
      } else {
        totalTvSeries++;
      }

      // Canonical rule: If marked WATCHED in any accessible collection, it counts as Watched
      if (agg.statuses.has('WATCHED')) {
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
    rng: () => number = Math.random,
    includeWatched: boolean = false
  ) {
    // 1. Resolve accessible collections
    const owned = await prisma.collection.findMany({
      where: { ownerId: userId },
      select: { id: true, title: true },
    });
    const memberships = await prisma.collectionMember.findMany({
      where: { userId },
      include: { collection: { select: { id: true, title: true } } },
    });

    const accessibleCollectionsMap = new Map<string, string>();
    for (const o of owned) {
      accessibleCollectionsMap.set(o.id, o.title);
    }
    for (const m of memberships) {
      accessibleCollectionsMap.set(m.collection.id, m.collection.title);
    }

    let targetCollectionIds: string[] = [];

    if (!requestedCollectionIds || requestedCollectionIds === 'ALL') {
      targetCollectionIds = Array.from(accessibleCollectionsMap.keys());
    } else {
      if (!Array.isArray(requestedCollectionIds) || requestedCollectionIds.length === 0) {
        targetCollectionIds = Array.from(accessibleCollectionsMap.keys());
      } else {
        // Validate access
        for (const cid of requestedCollectionIds) {
          if (!accessibleCollectionsMap.has(cid)) {
            throw new ForbiddenError(`You do not have access to collection ${cid}`);
          }
        }
        targetCollectionIds = requestedCollectionIds;
      }
    }

    if (targetCollectionIds.length === 0) {
      return null;
    }

    // 2. Query movies from target collections
    const statusFilter = includeWatched ? undefined : ('TO_WATCH' as const);
    const candidateEntries = await prisma.collectionMovie.findMany({
      where: {
        collectionId: { in: targetCollectionIds },
        ...(statusFilter ? { status: statusFilter } : {}),
      },
      include: {
        movie: true,
        collection: { select: { id: true, title: true } },
        adder: { select: { id: true, username: true } },
      },
    });

    if (candidateEntries.length === 0) {
      return null;
    }

    // 3. Deduplicate across collections by unique media: `${mediaType}:${tmdbId}`
    const movieCandidatesMap = new Map<
      string,
      {
        entries: typeof candidateEntries;
        movie: (typeof candidateEntries)[0]['movie'];
        sourceCollections: { id: string; title: string }[];
      }
    >();

    for (const entry of candidateEntries) {
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
      if (!group.sourceCollections.some((sc) => sc.id === entry.collectionId)) {
        group.sourceCollections.push({
          id: entry.collection.id,
          title: entry.collection.title,
        });
      }
    }

    const uniqueCandidates = Array.from(movieCandidatesMap.values());
    if (uniqueCandidates.length === 0) {
      return null;
    }

    const chosenGroup = selectRandomElement(uniqueCandidates, rng);
    if (!chosenGroup) {
      return null;
    }
    const primaryEntry = chosenGroup.entries[0];

    return {
      entry: primaryEntry,
      movie: chosenGroup.movie,
      sourceCollections: chosenGroup.sourceCollections,
      allEntries: chosenGroup.entries.map((e) => ({
        id: e.id,
        collectionId: e.collectionId,
        collectionTitle: e.collection.title,
        status: e.status,
      })),
    };
  }
}
