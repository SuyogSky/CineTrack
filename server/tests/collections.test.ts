import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('Collections & Watchlist Integration Tests', () => {
  let authCookie: string[];
  let secondUserCookie: string[];

  beforeEach(async () => {
    const user1 = await request(app).post('/api/auth/register').send({
      username: 'alice',
      email: 'alice@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    authCookie = user1.headers['set-cookie'] as unknown as string[];

    const user2 = await request(app).post('/api/auth/register').send({
      username: 'bob',
      email: 'bob@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    secondUserCookie = user2.headers['set-cookie'] as unknown as string[];
  });

  it('should create, list, and update a custom collection', async () => {
    // 1. Create collection
    const createRes = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({
        title: 'Horror Classics',
        description: 'Spooky movies to watch in October',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.collection.title).toBe('Horror Classics');
    const collectionId = createRes.body.data.collection.id;

    // 2. List collections
    const listRes = await request(app)
      .get('/api/collections')
      .set('Cookie', authCookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.owned.some((c: any) => c.id === collectionId)).toBe(true);

    // 3. Update collection
    const updateRes = await request(app)
      .patch(`/api/collections/${collectionId}`)
      .set('Cookie', authCookie)
      .send({
        title: 'Sci-Fi & Horror Classics',
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.collection.title).toBe('Sci-Fi & Horror Classics');
  });

  it('should add movies, reject duplicates, and toggle watch status atomically', async () => {
    const createRes = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({ title: 'Favorites' });
    const colId = createRes.body.data.collection.id;

    // Add Inception (tmdbId: 27205)
    const addRes = await request(app)
      .post(`/api/collections/${colId}/movies`)
      .set('Cookie', authCookie)
      .send({ tmdbId: 27205, note: 'Must watch soon' });

    expect(addRes.status).toBe(201);
    expect(addRes.body.data.entry.movie.title).toBe('Inception');
    expect(addRes.body.data.entry.status).toBe('TO_WATCH');
    expect(addRes.body.data.entry.watchedAt).toBeNull();
    const entryId = addRes.body.data.entry.id;

    // Duplicate add should be rejected
    const dupRes = await request(app)
      .post(`/api/collections/${colId}/movies`)
      .set('Cookie', authCookie)
      .send({ tmdbId: 27205 });
    expect(dupRes.status).toBe(409);

    // Mark as WATCHED
    const markWatchedRes = await request(app)
      .patch(`/api/collections/${colId}/movies/${entryId}`)
      .set('Cookie', authCookie)
      .send({ status: 'WATCHED' });
    expect(markWatchedRes.status).toBe(200);
    expect(markWatchedRes.body.data.entry.status).toBe('WATCHED');
    expect(markWatchedRes.body.data.entry.watchedAt).not.toBeNull();

    // Mark back to TO_WATCH -> watchedAt must be cleared
    const markUnwatchedRes = await request(app)
      .patch(`/api/collections/${colId}/movies/${entryId}`)
      .set('Cookie', authCookie)
      .send({ status: 'TO_WATCH' });
    expect(markUnwatchedRes.status).toBe(200);
    expect(markUnwatchedRes.body.data.entry.status).toBe('TO_WATCH');
    expect(markUnwatchedRes.body.data.entry.watchedAt).toBeNull();
  });

  it('should safely move a movie between collections transactionally', async () => {
    // Create source and dest collections
    const sourceCol = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({ title: 'Source Collection' });
    const destCol = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({ title: 'Destination Collection' });

    const sourceId = sourceCol.body.data.collection.id;
    const destId = destCol.body.data.collection.id;

    // Add movie to source
    const addRes = await request(app)
      .post(`/api/collections/${sourceId}/movies`)
      .set('Cookie', authCookie)
      .send({ tmdbId: 157336, note: 'Interstellar note' });
    const entryId = addRes.body.data.entry.id;

    // Move to destination
    const moveRes = await request(app)
      .post(`/api/collections/${sourceId}/movies/${entryId}/move`)
      .set('Cookie', authCookie)
      .send({ destinationCollectionId: destId });

    expect(moveRes.status).toBe(200);
    expect(moveRes.body.data.entry.collectionId).toBe(destId);

    // Verify source no longer contains movie
    const getSource = await request(app)
      .get(`/api/collections/${sourceId}`)
      .set('Cookie', authCookie);
    expect(getSource.body.data.collection.movies.length).toBe(0);

    // Verify destination now contains movie
    const getDest = await request(app)
      .get(`/api/collections/${destId}`)
      .set('Cookie', authCookie);
    expect(getDest.body.data.collection.movies.length).toBe(1);
    expect(getDest.body.data.collection.movies[0].movie.title).toBe('Interstellar');
  });

  it('should prevent deleting the default master watchlist', async () => {
    const watchlistRes = await request(app)
      .get('/api/collections/default-watchlist')
      .set('Cookie', authCookie);
    const watchlistId = watchlistRes.body.data.collection.id;

    const deleteRes = await request(app)
      .delete(`/api/collections/${watchlistId}`)
      .set('Cookie', authCookie);

    expect(deleteRes.status).toBe(403);
  });

  it('should prevent an unrelated user from accessing a private collection', async () => {
    const col = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({ title: 'Alice Secret Vault' });
    const colId = col.body.data.collection.id;

    // Bob attempts to get Alice's collection
    const unauthorizedGet = await request(app)
      .get(`/api/collections/${colId}`)
      .set('Cookie', secondUserCookie);

    expect(unauthorizedGet.status).toBe(403);
  });

  it('should reject duplicate collection titles regardless of case or surrounding spaces', async () => {
    const firstResponse = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({ title: 'DC Movies' });

    expect(firstResponse.status).toBe(201);

    const duplicateResponse = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({ title: ' dc movies ' });

    expect(duplicateResponse.status).toBe(409);

    const otherCollectionResponse = await request(app)
      .post('/api/collections')
      .set('Cookie', authCookie)
      .send({ title: 'Action Movies' });
    expect(otherCollectionResponse.status).toBe(201);

    const duplicateRenameResponse = await request(app)
      .patch(`/api/collections/${otherCollectionResponse.body.data.collection.id}`)
      .set('Cookie', authCookie)
      .send({ title: '  dC mOvIeS  ' });
    expect(duplicateRenameResponse.status).toBe(409);
  });
});
