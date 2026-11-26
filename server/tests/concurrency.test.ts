import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/config/database';
import { MovieService } from '../src/services/movie.service';
import { CollectionService } from '../src/services/collection.service';
import { CollectionMovieService } from '../src/services/collectionMovie.service';
import { ConflictError } from '../src/utils/errors';

describe('Phase 5: Concurrency Safety, Race Condition Handling & Multi-Collection Status Semantics', () => {
  let userId: string;
  let authCookie: string[];

  beforeEach(async () => {
    const regRes = await request(app).post('/api/auth/register').send({
      username: 'concurrency_user',
      email: 'concurrency@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    authCookie = regRes.headers['set-cookie'] as unknown as string[];
    userId = regRes.body.data.user.id;
  });

  it('1. should safely handle concurrent MovieService.getOrCreateMovie calls without unique constraint crash', async () => {
    // 550 is Fight Club on TMDb
    const tmdbId = 550;
    const mediaType = 'movie';

    // Verify movie does not exist initially
    await prisma.movie.deleteMany({
      where: { tmdbId, mediaType: 'MOVIE' },
    });

    // Fire 5 concurrent calls simultaneously
    const promises = Array.from({ length: 5 }, () =>
      MovieService.getOrCreateMovie(tmdbId, mediaType)
    );

    const results = await Promise.all(promises);

    // All 5 should resolve successfully
    expect(results).toHaveLength(5);
    const firstId = results[0].id;
    for (const movie of results) {
      expect(movie.id).toBe(firstId);
      expect(movie.tmdbId).toBe(tmdbId);
      expect(movie.title).toBeTruthy();
    }

    // Verify database only contains exactly 1 record
    const count = await prisma.movie.count({
      where: { tmdbId, mediaType: 'MOVIE' },
    });
    expect(count).toBe(1);
  });

  it('2. should safely handle concurrent CollectionMovieService.addMovie calls with exactly one success and others ConflictError', async () => {
    const collection = await CollectionService.createCollection(userId, {
      title: 'Race Condition Test Collection',
    });

    const movieInput = {
      tmdbId: 680, // Pulp Fiction
      mediaType: 'movie' as const,
      note: 'Added during race test',
    };

    // Pre-create the movie to isolate the CollectionMovie creation race
    await MovieService.getOrCreateMovie(movieInput.tmdbId, movieInput.mediaType);

    // Fire 4 simultaneous add requests to the same collection
    const promises = Array.from({ length: 4 }, () =>
      CollectionMovieService.addMovie(
        collection.id,
        userId,
        movieInput
      )
    );

    const outcomes = await Promise.allSettled(promises);

    const successes = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled'
    );

    const conflicts = outcomes.filter(
      (outcome) =>
        outcome.status === 'rejected' &&
        outcome.reason instanceof ConflictError
    );

    // Exactly one must succeed, others must be ConflictError
    expect(successes).toHaveLength(1);
    expect(conflicts.length).toBe(3);

    // Verify database contains exactly one collectionMovie entry
    const count = await prisma.collectionMovie.count({
      where: { collectionId: collection.id },
    });
    expect(count).toBe(1);
  });

  it('3. should safely handle concurrent getUserDefaultWatchlist requests without duplicate watchlist creation', async () => {
    // Delete existing watchlist for user to test race on initialization
    await prisma.collection.deleteMany({
      where: { ownerId: userId, isDefaultWatchlist: true },
    });

    // Fire 6 simultaneous calls
    const promises = Array.from({ length: 6 }, () =>
      CollectionService.getUserDefaultWatchlist(userId)
    );

    const results = await Promise.all(promises);

    expect(results).toHaveLength(6);
    const firstId = results[0].id;
    for (const wl of results) {
      expect(wl.id).toBe(firstId);
      expect(wl.isDefaultWatchlist).toBe(true);
    }

    const count = await prisma.collection.count({
      where: { ownerId: userId, isDefaultWatchlist: true },
    });
    expect(count).toBe(1);
  });


  it('4. should keep the same user movie status consistent across multiple collections', async () => {
    const colA = await CollectionService.createCollection(userId, {
      title: 'Collection A - Sci-Fi',
    });

    const colB = await CollectionService.createCollection(userId, {
      title: 'Collection B - Favorites',
    });

    const tmdbId = 27205;
    const mediaType = 'movie' as const;

    const entryA = await CollectionMovieService.addMovie(
      colA.id,
      userId,
      { tmdbId, mediaType }
    );

    const entryB = await CollectionMovieService.addMovie(
      colB.id,
      userId,
      { tmdbId, mediaType }
    );

    expect(entryA.status).toBe('TO_WATCH');
    expect(entryB.status).toBe('TO_WATCH');

    // Mark the movie as watched from Collection A.
    const updatedA = await CollectionMovieService.updateMovie(
      colA.id,
      entryA.id,
      userId,
      { status: 'WATCHED' }
    );

    expect(updatedA.status).toBe('WATCHED');
    expect(updatedA.watchedAt).not.toBeNull();

    // Read Collection B through the actual user-facing service.
    const freshCollectionB = await CollectionService.getCollectionById(
      colB.id,
      userId
    );

    const entryInB = freshCollectionB.movies.find(
      (entry: typeof entryB) => entry.id === entryB.id
    );

    expect(entryInB).toBeDefined();
    expect(entryInB?.status).toBe('WATCHED');
    expect(entryInB?.watchedAt).not.toBeNull();

    // Remove the movie from Collection A.
    await CollectionMovieService.removeMovie(
      colA.id,
      entryA.id,
      userId
    );

    // Collection B and the user's personal status must remain intact.
    const collectionBAfterRemoval =
      await CollectionService.getCollectionById(colB.id, userId);

    const remainingEntry = collectionBAfterRemoval.movies.find(
      (entry: typeof entryB) => entry.id === entryB.id
    );

    expect(remainingEntry).toBeDefined();
    expect(remainingEntry?.status).toBe('WATCHED');
  });

});
