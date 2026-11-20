import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('Public View-Only Collection Sharing Integration Tests', () => {
  let authCookie: string[];
  let collectionId: string;

  beforeEach(async () => {
    const user = await request(app).post('/api/auth/register').send({
      username: 'curator',
      email: 'curator@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    authCookie = user.headers['set-cookie'] as unknown as string[];

    const col = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({
        title: 'Cinematic Masterpieces',
        description: 'Greatest films ever made',
      });
    collectionId = col.body.data.collection.id;

    // Add a movie
    await request(app)
      .post(`/api/collections/${collectionId}/movies`)
      .set('Cookie', authCookie)
      .send({ tmdbId: 155, note: 'Iconic performance by Heath Ledger' });
  });

  it('should enable public sharing and allow unauthenticated visitors to view', async () => {
    // 1. Enable sharing
    const shareRes = await request(app)
      .post(`/api/collections/${collectionId}/share`)
      .set('Cookie', authCookie);

    expect(shareRes.status).toBe(200);
    expect(shareRes.body.data.visibility).toBe('PUBLIC_LINK');
    expect(shareRes.body.data.shareToken).toBeDefined();
    const shareToken = shareRes.body.data.shareToken;

    // 2. Open public collection without authentication / cookies
    const publicRes = await request(app).get(`/api/public/collections/${shareToken}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.data.collection.title).toBe('Cinematic Masterpieces');
    expect(publicRes.body.data.collection.ownerUsername).toBe('curator');
    expect(publicRes.body.data.collection.movies.length).toBe(1);
    expect(publicRes.body.data.collection.movies[0].movie.title).toBe('The Dark Knight');
    // Privacy protection: personal notes are omitted from public view
    expect(publicRes.body.data.collection.movies[0].note).toBeUndefined();
  });

  it('should immediately revoke access when public sharing is disabled', async () => {
    // Enable sharing first
    const shareRes = await request(app)
      .post(`/api/collections/${collectionId}/share`)
      .set('Cookie', authCookie);
    const shareToken = shareRes.body.data.shareToken;

    // Disable sharing
    const disableRes = await request(app)
      .delete(`/api/collections/${collectionId}/share`)
      .set('Cookie', authCookie);
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.data.visibility).toBe('PRIVATE');

    // Public visitor request must now return 404
    const publicRes = await request(app).get(`/api/public/collections/${shareToken}`);
    expect(publicRes.status).toBe(404);
  });
});
