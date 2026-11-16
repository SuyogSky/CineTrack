import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/config/database';

describe('TMDb Movie & TV Series Search & Media Type Lifecycle Tests', () => {
  it('should search for movies and TV series with type filters', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'searcher',
        email: 'searcher@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // 1. Search with type=movie
    const movieRes = await request(app)
      .get('/api/movies/search?q=Inception&type=movie')
      .set('Cookie', cookies);
    expect(movieRes.status).toBe(200);
    expect(movieRes.body.data.items.length).toBeGreaterThan(0);
    expect(movieRes.body.data.items[0].mediaType).toBe('movie');
    expect(movieRes.body.data.items[0].title).toBe('Inception');

    // 2. Search with type=tv for Loki
    const tvRes = await request(app)
      .get('/api/movies/search?q=Loki&type=tv')
      .set('Cookie', cookies);
    expect(tvRes.status).toBe(200);
    expect(tvRes.body.data.items.length).toBeGreaterThan(0);
    expect(tvRes.body.data.items[0].mediaType).toBe('tv');
    expect(tvRes.body.data.items[0].title).toBe('Loki');

    // 3. Search with type=tv for Kurukshetra
    const kuruRes = await request(app)
      .get('/api/movies/search?q=Kurukshetra&type=tv')
      .set('Cookie', cookies);
    expect(kuruRes.status).toBe(200);
    expect(kuruRes.body.data.items.length).toBeGreaterThan(0);
    expect(kuruRes.body.data.items[0].title).toContain('Kurukshetra');
    expect(kuruRes.body.data.items[0].mediaType).toBe('tv');

    // 4. Search with type=all for WandaVision
    const allRes = await request(app)
      .get('/api/movies/search?q=WandaVision&type=all')
      .set('Cookie', cookies);
    expect(allRes.status).toBe(200);
    expect(allRes.body.data.items.length).toBeGreaterThan(0);
    expect(allRes.body.data.items[0].title).toBe('WandaVision');
    expect(allRes.body.data.items[0].mediaType).toBe('tv');
  });

  it('should allow movies and TV series with identical numeric TMDb IDs to coexist without conflict', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'coexist_user',
        email: 'coexist@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const colRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({ title: 'Shared ID Showcase' });
    const colId = colRes.body.data.collection.id;

    // Suppose TMDb ID 99999 exists as both a movie and a TV series
    const sharedTmdbId = 99999;

    // Create Movie 99999 directly
    const movieRecord = await prisma.movie.create({
      data: {
        tmdbId: sharedTmdbId,
        mediaType: 'MOVIE',
        title: 'Collision-Proof Movie',
        releaseYear: 2024,
      },
    });

    // Create TV 99999 directly
    const tvRecord = await prisma.movie.create({
      data: {
        tmdbId: sharedTmdbId,
        mediaType: 'TV',
        title: 'Collision-Proof TV Series',
        releaseYear: 2024,
      },
    });

    expect(movieRecord.id).not.toBe(tvRecord.id);
    expect(movieRecord.mediaType).toBe('MOVIE');
    expect(tvRecord.mediaType).toBe('TV');

    // Add both to the same collection without any error
    const addMovieRes = await prisma.collectionMovie.create({
      data: {
        collectionId: colId,
        movieId: movieRecord.id,
        addedBy: regRes.body.data.user.id,
      },
    });

    const addTvRes = await prisma.collectionMovie.create({
      data: {
        collectionId: colId,
        movieId: tvRecord.id,
        addedBy: regRes.body.data.user.id,
      },
    });

    expect(addMovieRes.id).toBeDefined();
    expect(addTvRes.id).toBeDefined();

    // Query collection to confirm both are present
    const colFetch = await request(app)
      .get(`/api/collections/${colId}`)
      .set('Cookie', cookies);

    expect(colFetch.status).toBe(200);
    expect(colFetch.body.data.collection.movies.length).toBe(2);
    const mediaTypes = colFetch.body.data.collection.movies.map((m: any) => m.movie.mediaType);
    expect(mediaTypes).toContain('MOVIE');
    expect(mediaTypes).toContain('TV');
  });

  it('should support full lifecycle for TV series: add, mark watched, note, move, and remove', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'tv_user',
        email: 'tv@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const col1 = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({ title: 'TV Watchlist' });
    const col1Id = col1.body.data.collection.id;

    const col2 = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .send({ title: 'Completed TV' });
    const col2Id = col2.body.data.collection.id;

    // 1. Add Loki (84958, tv)
    const addRes = await request(app)
      .post(`/api/collections/${col1Id}/movies`)
      .set('Cookie', cookies)
      .send({ tmdbId: 84958, mediaType: 'tv', note: 'Start season 1' });
    expect(addRes.status).toBe(201);
    const entryId = addRes.body.data.entry.id;
    expect(addRes.body.data.entry.movie.title).toBe('Loki');
    expect(addRes.body.data.entry.movie.mediaType).toBe('TV');

    // 2. Mark watched with updated note
    const updateRes = await request(app)
      .patch(`/api/collections/${col1Id}/movies/${entryId}`)
      .set('Cookie', cookies)
      .send({ status: 'WATCHED', note: 'Season 1 finished, fantastic finale!' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.entry.status).toBe('WATCHED');
    expect(updateRes.body.data.entry.note).toBe('Season 1 finished, fantastic finale!');

    // 3. Move to completed collection
    const moveRes = await request(app)
      .post(`/api/collections/${col1Id}/movies/${entryId}/move`)
      .set('Cookie', cookies)
      .send({ destinationCollectionId: col2Id });
    expect(moveRes.status).toBe(200);

    // 4. Verify presence in col2 and absence in col1
    const col1Check = await request(app).get(`/api/collections/${col1Id}`).set('Cookie', cookies);
    expect(col1Check.body.data.collection.movies.length).toBe(0);

    const col2Check = await request(app).get(`/api/collections/${col2Id}`).set('Cookie', cookies);
    expect(col2Check.body.data.collection.movies.length).toBe(1);
    expect(col2Check.body.data.collection.movies[0].movie.title).toBe('Loki');
  });
});
