import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('Movie Night Roulette Integration Tests', () => {
  let authCookie: string[];
  let collectionId: string;

  beforeEach(async () => {
    const user = await request(app).post('/api/auth/register').send({
      username: 'roulette_tester',
      email: 'roulette@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    authCookie = user.headers['set-cookie'] as unknown as string[];

    const col = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({ title: 'Weekend Watch' });
    collectionId = col.body.data.collection.id;
  });

  it('should return null entry when collection is empty', async () => {
    const res = await request(app)
      .get(`/api/collections/${collectionId}/random`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.entry).toBeNull();
  });

  it('should select only from unwatched movies and ignore watched movies', async () => {
    // Add Inception (tmdbId: 27205) and mark as WATCHED
    const movie1 = await request(app)
      .post(`/api/collections/${collectionId}/movies`)
      .set('Cookie', authCookie)
      .send({ tmdbId: 27205 });
    const entryId1 = movie1.body.data.entry.id;

    await request(app)
      .patch(`/api/collections/${collectionId}/movies/${entryId1}`)
      .set('Cookie', authCookie)
      .send({ status: 'WATCHED' });

    // Add Dune (tmdbId: 438631) as TO_WATCH
    await request(app)
      .post(`/api/collections/${collectionId}/movies`)
      .set('Cookie', authCookie)
      .send({ tmdbId: 438631 });

    // Roulette should select Dune
    const res = await request(app)
      .get(`/api/collections/${collectionId}/random`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.entry).not.toBeNull();
    expect(res.body.data.entry.movie.title).toBe('Dune');
    expect(res.body.data.entry.status).toBe('TO_WATCH');
  });
});
