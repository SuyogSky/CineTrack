import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('Personal Movie Watch Status', () => {
  it('keeps owner and collaborator watch statuses independent', async () => {
    // Register Alice.
    const aliceRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'alice_watch',
        email: 'alice_watch@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });

    expect(aliceRes.status).toBe(201);

    const aliceCookies = aliceRes.headers[
      'set-cookie'
    ] as unknown as string[];

    // Register Bob.
    const bobRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'bob_watch',
        email: 'bob_watch@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });

    expect(bobRes.status).toBe(201);

    const bobCookies = bobRes.headers[
      'set-cookie'
    ] as unknown as string[];

    // Alice creates a shared Marvel collection.
    const collectionRes = await request(app)
      .post('/api/collections')
      .set('Cookie', aliceCookies)
      .send({
        title: 'Marvel Movies',
      });

    expect(collectionRes.status).toBe(201);

    const collectionId =
      collectionRes.body.data.collection.id;

    // Alice adds Inception.
    const addRes = await request(app)
      .post(`/api/collections/${collectionId}/movies`)
      .set('Cookie', aliceCookies)
      .send({
        tmdbId: 27205,
        mediaType: 'movie',
      });

    expect(addRes.status).toBe(201);

    const entryId = addRes.body.data.entry.id;

    // Alice marks Inception as watched.
    const aliceWatched = await request(app)
      .patch(
        `/api/collections/${collectionId}/movies/${entryId}`
      )
      .set('Cookie', aliceCookies)
      .send({
        status: 'WATCHED',
      });

    expect(aliceWatched.status).toBe(200);
    expect(aliceWatched.body.data.entry.status).toBe('WATCHED');

    // Alice invites Bob.
    const invitationRes = await request(app)
      .post(`/api/collections/${collectionId}/invitations`)
      .set('Cookie', aliceCookies)
      .send({
        usernameOrEmail: 'bob_watch',
      });

    expect(invitationRes.status).toBe(201);

    const invitationId =
      invitationRes.body.data.invitation.id;

    // Bob accepts.
    const acceptRes = await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set('Cookie', bobCookies);

    expect(acceptRes.status).toBe(200);

    // Bob must initially see TO_WATCH.
    const bobCollectionBefore = await request(app)
      .get(`/api/collections/${collectionId}`)
      .set('Cookie', bobCookies);

    expect(
      bobCollectionBefore.body.data.collection.movies[0].status
    ).toBe('TO_WATCH');

    // Bob's dashboard must not inherit Alice's WATCHED status.
    const bobStatsBefore = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', bobCookies);

    expect(bobStatsBefore.status).toBe(200);
    expect(bobStatsBefore.body.data.totalWatched).toBe(0);
    expect(bobStatsBefore.body.data.totalToWatch).toBe(1);

    // Bob must be able to pick Inception in roulette.
    const bobRouletteBefore = await request(app)
      .get(`/api/collections/${collectionId}/random`)
      .set('Cookie', bobCookies);

    expect(bobRouletteBefore.status).toBe(200);
    expect(bobRouletteBefore.body.data.movie.tmdbId).toBe(27205);

    // Bob marks Inception as watched.
    const bobWatched = await request(app)
      .patch(
        `/api/collections/${collectionId}/movies/${entryId}`
      )
      .set('Cookie', bobCookies)
      .send({
        status: 'WATCHED',
      });

    expect(bobWatched.status).toBe(200);
    expect(bobWatched.body.data.entry.status).toBe('WATCHED');

    // Alice remains WATCHED.
    const aliceCollectionAfterBob = await request(app)
      .get(`/api/collections/${collectionId}`)
      .set('Cookie', aliceCookies);

    expect(
      aliceCollectionAfterBob.body.data.collection.movies[0].status
    ).toBe('WATCHED');

    // Bob's dashboard now shows WATCHED.
    const bobStatsAfter = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', bobCookies);

    expect(bobStatsAfter.body.data.totalWatched).toBe(1);
    expect(bobStatsAfter.body.data.totalToWatch).toBe(0);

    // Unwatched roulette should now return no movie.
    const bobRouletteAfter = await request(app)
      .get(`/api/collections/${collectionId}/random`)
      .set('Cookie', bobCookies);

    expect(bobRouletteAfter.body.data.entry).toBeNull();

    // But includeWatched=true must allow it.
    const bobRouletteIncludingWatched = await request(app)
      .post('/api/collections/roulette')
      .set('Cookie', bobCookies)
      .send({
        collectionIds: [collectionId],
        includeWatched: true,
      });

    expect(bobRouletteIncludingWatched.status).toBe(200);
    expect(
      bobRouletteIncludingWatched.body.data.movie.tmdbId
    ).toBe(27205);

    // Bob changes his status back to TO_WATCH.
    const bobUnwatched = await request(app)
      .patch(
        `/api/collections/${collectionId}/movies/${entryId}`
      )
      .set('Cookie', bobCookies)
      .send({
        status: 'TO_WATCH',
      });

    expect(bobUnwatched.status).toBe(200);
    expect(bobUnwatched.body.data.entry.status).toBe('TO_WATCH');

    // Alice must still remain WATCHED.
    const aliceFinalCollection = await request(app)
      .get(`/api/collections/${collectionId}`)
      .set('Cookie', aliceCookies);

    expect(
      aliceFinalCollection.body.data.collection.movies[0].status
    ).toBe('WATCHED');

    const aliceFinalStats = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', aliceCookies);

    expect(aliceFinalStats.body.data.totalWatched).toBe(1);
    expect(aliceFinalStats.body.data.totalToWatch).toBe(0);

    const bobFinalStats = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', bobCookies);

    expect(bobFinalStats.body.data.totalWatched).toBe(0);
    expect(bobFinalStats.body.data.totalToWatch).toBe(1);
  });

  it('uses the same personal status across multiple collections', async () => {
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'multi_collection_user',
        email: 'multi_collection_user@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });

    const cookies = registerRes.headers[
      'set-cookie'
    ] as unknown as string[];

    const first = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({
        title: 'Marvel',
      });

    const second = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({
        title: 'Favorite Movies',
      });

    const firstId = first.body.data.collection.id;
    const secondId = second.body.data.collection.id;

    const firstMovie = await request(app)
      .post(`/api/collections/${firstId}/movies`)
      .set('Cookie', cookies)
      .send({
        tmdbId: 27205,
        mediaType: 'movie',
      });

    const secondMovie = await request(app)
      .post(`/api/collections/${secondId}/movies`)
      .set('Cookie', cookies)
      .send({
        tmdbId: 27205,
        mediaType: 'movie',
      });

    const firstEntryId = firstMovie.body.data.entry.id;

    await request(app)
      .patch(`/api/collections/${firstId}/movies/${firstEntryId}`)
      .set('Cookie', cookies)
      .send({
        status: 'WATCHED',
      });

    const secondCollection = await request(app)
      .get(`/api/collections/${secondId}`)
      .set('Cookie', cookies);

    expect(
      secondCollection.body.data.collection.movies[0].status
    ).toBe('WATCHED');

    const stats = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', cookies);

    // Same movie in two collections must count only once.
    expect(stats.body.data.totalItems).toBe(1);
    expect(stats.body.data.totalMovies).toBe(1);
    expect(stats.body.data.totalWatched).toBe(1);
    expect(stats.body.data.totalToWatch).toBe(0);
  });
});