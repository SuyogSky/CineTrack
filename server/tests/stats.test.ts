import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('Collection-Aware Dashboard Statistics Integration Tests', () => {
  it('should compute deduplicated aggregate statistics across default, custom, and collaborated collections', async () => {
    // 1. Create User 1 (primary) and User 2 (collaborator)
    const user1Res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'alice',
        email: 'alice@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const aliceCookies = user1Res.headers['set-cookie'] as unknown as string[];

    const user2Res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'bob',
        email: 'bob@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const bobCookies = user2Res.headers['set-cookie'] as unknown as string[];

    // Get Alice's default watchlist
    const defRes = await request(app)
      .get('/api/collections/default-watchlist')
      .set('Cookie', aliceCookies);
    const aliceDefaultColId = defRes.body.data.collection.id;

    // Create Alice's custom collection "Sci-Fi"
    const scifiRes = await request(app)
      .post('/api/collections')
      .set('Cookie', aliceCookies)
      .send({ title: 'Sci-Fi Classics', description: 'Top sci-fi movies' });
    const scifiColId = scifiRes.body.data.collection.id;

    // Create Bob's custom collection "Marvel Series" and share with Alice
    const marvelRes = await request(app)
      .post('/api/collections')
      .set('Cookie', bobCookies)
      .send({ title: 'Marvel Series', description: 'MCU shows and films' });
    const marvelColId = marvelRes.body.data.collection.id;

    // Bob invites Alice to Marvel Series
    const inviteRes = await request(app)
      .post(`/api/collections/${marvelColId}/invitations`)
      .set('Cookie', bobCookies)
      .send({ usernameOrEmail: 'alice' });
    expect(inviteRes.status).toBe(201);
    const invitationId = inviteRes.body.data.invitation.id;

    // Alice accepts the invitation
    await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set('Cookie', aliceCookies);

    // 2. Add movies and TV series across collections
    // Movie 1: Inception (27205, movie) -> In Alice Default Watchlist (TO_WATCH) AND Sci-Fi (WATCHED)
    const incDefault = await request(app)
      .post(`/api/collections/${aliceDefaultColId}/movies`)
      .set('Cookie', aliceCookies)
      .send({ tmdbId: 27205, mediaType: 'movie' });
    expect(incDefault.status).toBe(201);

    const incScifi = await request(app)
      .post(`/api/collections/${scifiColId}/movies`)
      .set('Cookie', aliceCookies)
      .send({ tmdbId: 27205, mediaType: 'movie' });
    expect(incScifi.status).toBe(201);

    // Mark Inception as WATCHED in Sci-Fi collection
    await request(app)
      .patch(`/api/collections/${scifiColId}/movies/${incScifi.body.data.entry.id}`)
      .set('Cookie', aliceCookies)
      .send({ status: 'WATCHED' });

    // Movie 2: Interstellar (157336, movie) -> In Sci-Fi (TO_WATCH)
    await request(app)
      .post(`/api/collections/${scifiColId}/movies`)
      .set('Cookie', aliceCookies)
      .send({ tmdbId: 157336, mediaType: 'movie' });

    // TV Series 1: Loki (84958, tv) -> In Marvel Series (TO_WATCH)
    await request(app)
      .post(`/api/collections/${marvelColId}/movies`)
      .set('Cookie', aliceCookies)
      .send({ tmdbId: 84958, mediaType: 'tv' });

    // TV Series 2: WandaVision (85271, tv) -> In Marvel Series (WATCHED by Bob)
    const wvEntry = await request(app)
      .post(`/api/collections/${marvelColId}/movies`)
      .set('Cookie', bobCookies)
      .send({ tmdbId: 85271, mediaType: 'tv' });
    await request(app)
      .patch(`/api/collections/${marvelColId}/movies/${wvEntry.body.data.entry.id}`)
      .set('Cookie', bobCookies)
      .send({ status: 'WATCHED' });

    // 3. Query Alice's dashboard stats
    const statsRes = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', aliceCookies);

    expect(statsRes.status).toBe(200);
    const stats = statsRes.body.data;

    // Deduplicated statistics:
    // Movies: Inception, Interstellar => 2 distinct movies
    expect(stats.totalMovies).toBe(2);
    // TV Series: Loki, WandaVision => 2 distinct TV series
    expect(stats.totalTvSeries).toBe(2);
    // Total unique items: Inception, Interstellar, Loki, WandaVision => 4
    expect(stats.totalItems).toBe(4);
    // Watched: Inception (watched in Sci-Fi), WandaVision (watched in Marvel) => 2
    expect(stats.totalWatched).toBe(1);
    // To Watch: Interstellar (unwatched), Loki (unwatched) => 2
    expect(stats.totalToWatch).toBe(3);
    // Total Collections accessible to Alice: Default + Sci-Fi + Marvel => 3
    expect(stats.totalCollections).toBe(3);
    expect(stats.ownedCollectionsCount).toBe(2);
    expect(stats.sharedCollectionsCount).toBe(1);
  });

  it('should isolate private statistics between users and not leak unshared collections', async () => {
    // User 1
    const u1 = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'user1',
        email: 'user1@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const u1Cookies = u1.headers['set-cookie'] as unknown as string[];

    // User 2
    const u2 = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'user2',
        email: 'user2@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const u2Cookies = u2.headers['set-cookie'] as unknown as string[];

    // User 1 creates private collection with 2 movies
    const col1 = await request(app)
      .post('/api/collections')
      .set('Cookie', u1Cookies)
      .send({ title: 'Top Secret' });
    const col1Id = col1.body.data.collection.id;

    await request(app)
      .post(`/api/collections/${col1Id}/movies`)
      .set('Cookie', u1Cookies)
      .send({ tmdbId: 27205, mediaType: 'movie' });
    await request(app)
      .post(`/api/collections/${col1Id}/movies`)
      .set('Cookie', u1Cookies)
      .send({ tmdbId: 157336, mediaType: 'movie' });

    // User 2 stats should be empty / 0 (only their empty default watchlist)
    const u2Stats = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', u2Cookies);

    expect(u2Stats.status).toBe(200);
    expect(u2Stats.body.data.totalItems).toBe(0);
    expect(u2Stats.body.data.totalMovies).toBe(0);
    expect(u2Stats.body.data.totalTvSeries).toBe(0);
  });
});
