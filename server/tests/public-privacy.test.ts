import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('P1 Public Collection Privacy Integration Tests', () => {
  const testUser = {
    username: 'privacytester',
    email: 'privacytester@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  it('should exclude private personal notes from public collection responses', async () => {
    // 1. Register user
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // 2. Create custom collection
    const colRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({ title: 'Curated Favorites', description: 'Curated public list' });
    const colId = colRes.body.data.collection.id;

    // 3. Add movie with confidential private note
    const movieRes = await request(app)
      .post(`/api/collections/${colId}/movies`)
      .set('Cookie', cookies)
      .send({
        tmdbId: 27205,
        mediaType: 'movie',
        note: 'CONFIDENTIAL: Watched with Sarah on anniversary. Loved the spinning top ending.',
      });
    expect(movieRes.status).toBe(201);
    expect(movieRes.body.data.entry.note).toContain('CONFIDENTIAL');

    // 4. Enable public sharing
    const shareRes = await request(app)
      .post(`/api/collections/${colId}/share`)
      .set('Cookie', cookies);
    expect(shareRes.status).toBe(200);
    const shareToken = shareRes.body.data.shareToken;
    expect(shareToken).toBeDefined();

    // 5. Query public collection as unauthenticated visitor
    const publicRes = await request(app).get(`/api/public/collections/${shareToken}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.success).toBe(true);

    const publicCollection = publicRes.body.data.collection;
    expect(publicCollection.title).toBe('Curated Favorites');
    expect(publicCollection.movies.length).toBe(1);

    // CRITICAL PRIVACY ASSERTION: The note must NOT exist in public response
    const publicMovieEntry = publicCollection.movies[0];
    expect(publicMovieEntry.note).toBeUndefined();
    expect(JSON.stringify(publicRes.body)).not.toContain('CONFIDENTIAL');
  });
});
