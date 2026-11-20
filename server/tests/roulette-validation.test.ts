import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('P0 Pick for Us Validation & Dashboard Consistency Integration Tests', () => {
  const testUser = {
    username: 'roulettevaluser',
    email: 'roulettevaluser@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  it('should reject empty array [] for collectionIds with validation error', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const res = await request(app)
      .post('/api/collections/roulette')
      .set('Cookie', cookies)
      .send({
        collectionIds: [],
        includeWatched: false,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('should correctly parse string "false" for includeWatched without coercing to true', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Inception (27205) added to default watchlist and marked WATCHED
    const wlRes = await request(app).get('/api/collections/default-watchlist').set('Cookie', cookies);
    const watchlistId = wlRes.body.data.collection.id;

    const addRes = await request(app)
      .post(`/api/collections/${watchlistId}/movies`)
      .set('Cookie', cookies)
      .send({ tmdbId: 27205, mediaType: 'movie' });
    const entryId = addRes.body.data.entry.id;

    await request(app)
      .patch(`/api/collections/${watchlistId}/movies/${entryId}`)
      .set('Cookie', cookies)
      .send({ status: 'WATCHED' });

    // Roulette with includeWatched="false" query parameter
    const rouletteRes = await request(app)
      .get(`/api/collections/roulette?collectionIds=ALL&includeWatched=false`)
      .set('Cookie', cookies);

    expect(rouletteRes.status).toBe(200);
    // Since only 1 movie exists and it is WATCHED, unwatched roulette pool must return null entry
    expect(rouletteRes.body.data.entry).toBeNull();
  });

  it('should exclude media that is marked WATCHED in any accessible collection when includeWatched is false', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // 1. Get default watchlist
    const wlRes = await request(app).get('/api/collections/default-watchlist').set('Cookie', cookies);
    const watchlistId = wlRes.body.data.collection.id;

    // 2. Create custom collection
    const customColRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({ title: 'SciFi Masterpieces' });
    const customColId = customColRes.body.data.collection.id;

    // 3. Add Inception (tmdbId: 27205) to default watchlist as TO_WATCH
    await request(app)
      .post(`/api/collections/${watchlistId}/movies`)
      .set('Cookie', cookies)
      .send({ tmdbId: 27205, mediaType: 'movie' });

    // 4. Add Inception (tmdbId: 27205) to custom collection as WATCHED
    const customEntryRes = await request(app)
      .post(`/api/collections/${customColId}/movies`)
      .set('Cookie', cookies)
      .send({ tmdbId: 27205, mediaType: 'movie' });
    const customEntryId = customEntryRes.body.data.entry.id;

    await request(app)
      .patch(`/api/collections/${customColId}/movies/${customEntryId}`)
      .set('Cookie', cookies)
      .send({ status: 'WATCHED' });

    // 5. Verify account stats: Inception is canonically WATCHED
    const statsRes = await request(app).get('/api/collections/stats').set('Cookie', cookies);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.data.totalToWatch).toBe(0);
    expect(statsRes.body.data.totalWatched).toBe(1);

    // 6. Roulette targeting default watchlist only (where Inception was marked TO_WATCH):
    // Because Inception is WATCHED in an accessible collection, the canonical rule
    // must exclude it from the unwatched candidate pool!
    const rouletteRes = await request(app)
      .post('/api/collections/roulette')
      .set('Cookie', cookies)
      .send({
        collectionIds: [watchlistId],
        includeWatched: false,
      });

    expect(rouletteRes.status).toBe(200);
    expect(rouletteRes.body.data.entry).toBeNull();
  });
});
