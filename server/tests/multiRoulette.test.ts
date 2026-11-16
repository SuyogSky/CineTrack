import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('Multi-Collection Roulette / Pick for Us Integration Tests', () => {
  it('should pool candidates from multiple selected collections and deduplicate identical films', async () => {
    // 1. Register User
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'roulette_user',
        email: 'roulette@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // 2. Create Collection 1 and Collection 2
    const col1Res = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({ title: 'Collection Alpha' });
    const col1Id = col1Res.body.data.collection.id;

    const col2Res = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({ title: 'Collection Beta' });
    const col2Id = col2Res.body.data.collection.id;

    // Add Movie A (Inception, 27205) to BOTH Collection 1 and Collection 2
    await request(app)
      .post(`/api/collections/${col1Id}/movies`)
      .set('Cookie', cookies)
      .send({ tmdbId: 27205, mediaType: 'movie' });

    await request(app)
      .post(`/api/collections/${col2Id}/movies`)
      .set('Cookie', cookies)
      .send({ tmdbId: 27205, mediaType: 'movie' });

    // Add Movie B (Interstellar, 157336) only to Collection 2
    await request(app)
      .post(`/api/collections/${col2Id}/movies`)
      .set('Cookie', cookies)
      .send({ tmdbId: 157336, mediaType: 'movie' });

    // 3. Test Multi-Collection Roulette selecting both [col1Id, col2Id]
    const rouletteRes = await request(app)
      .post('/api/collections/roulette')
      .set('Cookie', cookies)
      .send({ collectionIds: [col1Id, col2Id] });

    expect(rouletteRes.status).toBe(200);
    expect(rouletteRes.body.data.movie).toBeDefined();
    const chosenMovie = rouletteRes.body.data.movie;
    expect([27205, 157336]).toContain(chosenMovie.tmdbId);

    // If Inception was chosen, sourceCollections should include both collections!
    if (chosenMovie.tmdbId === 27205) {
      expect(rouletteRes.body.data.sourceCollections.length).toBe(2);
      const titles = rouletteRes.body.data.sourceCollections.map((c: any) => c.title);
      expect(titles).toContain('Collection Alpha');
      expect(titles).toContain('Collection Beta');
    }
  });

  it('should support "ALL" collections keyword', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'all_user',
        email: 'all@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const colRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({ title: 'Collection Gamma' });
    const colId = colRes.body.data.collection.id;

    // Add TV Series Loki (84958)
    await request(app)
      .post(`/api/collections/${colId}/movies`)
      .set('Cookie', cookies)
      .send({ tmdbId: 84958, mediaType: 'tv' });

    const rouletteRes = await request(app)
      .post('/api/collections/roulette')
      .set('Cookie', cookies)
      .send({ collectionIds: 'ALL' });

    expect(rouletteRes.status).toBe(200);
    expect(rouletteRes.body.data.movie).toBeDefined();
    expect(rouletteRes.body.data.movie.tmdbId).toBe(84958);
    expect(rouletteRes.body.data.movie.mediaType).toBe('TV');
  });

  it('should reject requests targeting collections the user does not have permission to access', async () => {
    // User A
    const u1 = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'user_a',
        email: 'usera@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const u1Cookies = u1.headers['set-cookie'] as unknown as string[];

    // User B
    const u2 = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'user_b',
        email: 'userb@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const u2Cookies = u2.headers['set-cookie'] as unknown as string[];

    // User A creates private collection
    const colRes = await request(app)
      .post('/api/collections')
      .set('Cookie', u1Cookies)
      .send({ title: 'User A Secret' });
    const privateColId = colRes.body.data.collection.id;

    // User B attempts to run roulette targeting User A's private collection
    const forbiddenRes = await request(app)
      .post('/api/collections/roulette')
      .set('Cookie', u2Cookies)
      .send({ collectionIds: [privateColId] });

    expect(forbiddenRes.status).toBe(403);
  });
});
