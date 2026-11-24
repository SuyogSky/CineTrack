import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/config/database';

describe('P0 Case-Insensitive Auth Uniqueness & Default Watchlist Integrity Tests', () => {
  const initialUser = {
    username: 'AlexRider',
    email: 'Alex.Rider@Example.COM',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  it('should reject registration with case-variant username or email with 409 Conflict', async () => {
    // 1. Initial registration
    const regRes = await request(app).post('/api/auth/register').send(initialUser);
    expect(regRes.status).toBe(201);
    expect(regRes.body.data.user.username).toBe('AlexRider');
    expect(regRes.body.data.user.email).toBe('alex.rider@example.com');

    // 2. Attempt duplicate with lowercase username
    const dupUsernameRes = await request(app).post('/api/auth/register').send({
      username: 'alexrider',
      email: 'unique_email@example.com',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    expect(dupUsernameRes.status).toBe(409);
    expect(dupUsernameRes.body.code).toBe('CONFLICT');

    // 3. Attempt duplicate with uppercase email
    const dupEmailRes = await request(app).post('/api/auth/register').send({
      username: 'DifferentUser',
      email: 'ALEX.RIDER@EXAMPLE.COM',
      password: 'Password123!',
      confirmPassword: 'Password123!',
    });
    expect(dupEmailRes.status).toBe(409);
    expect(dupEmailRes.body.code).toBe('CONFLICT');
  });

  it('should authenticate user regardless of username or email casing', async () => {
    await request(app).post('/api/auth/register').send(initialUser);

    // Login with all lowercase username
    const lowerUserRes = await request(app).post('/api/auth/login').send({
      identifier: 'alexrider',
      password: initialUser.password,
    });
    expect(lowerUserRes.status).toBe(200);

    // Login with all uppercase username
    const upperUserRes = await request(app).post('/api/auth/login').send({
      identifier: 'ALEXRIDER',
      password: initialUser.password,
    });
    expect(upperUserRes.status).toBe(200);

    // Login with mixed case email
    const emailLoginRes = await request(app).post('/api/auth/login').send({
      identifier: 'ALEX.rider@EXAMPLE.com',
      password: initialUser.password,
    });
    expect(emailLoginRes.status).toBe(200);
  });

  it('should prevent creating a second default watchlist for the same user via partial unique constraint', async () => {
    const regRes = await request(app).post('/api/auth/register').send(initialUser);
    const userId = regRes.body.data.user.id;

    // Verify exactly one default watchlist was created
    const defaults = await prisma.collection.findMany({
      where: { ownerId: userId, isDefaultWatchlist: true },
    });
    expect(defaults.length).toBe(1);

    // Attempt direct database insert of a second default watchlist
    await expect(
      prisma.collection.create({
        data: {
          ownerId: userId,
          title: 'Illegal Second Default Watchlist',
          isDefaultWatchlist: true,
          visibility: 'PRIVATE',
        },
      })
    ).rejects.toThrow();
  });

  it('should enforce watched status and watchedAt timestamp consistency at the database level via CHECK constraint', async () => {
    const regRes = await request(app).post('/api/auth/register').send(initialUser);
    const userId = regRes.body.data.user.id;

    const collection = await prisma.collection.findFirst({
      where: { ownerId: userId, isDefaultWatchlist: true },
    });
    expect(collection).toBeDefined();

    const movie = await prisma.movie.create({
      data: {
        tmdbId: 999999,
        mediaType: 'MOVIE',
        title: 'Check Constraint Test Movie',
      },
    });

    // 1. Valid: TO_WATCH with watchedAt = null
    const validToWatch = await prisma.collectionMovie.create({
      data: {
        collectionId: collection!.id,
        movieId: movie.id,
        addedBy: userId,
        status: 'TO_WATCH',
        watchedAt: null,
      },
    });
    expect(validToWatch.status).toBe('TO_WATCH');
    expect(validToWatch.watchedAt).toBeNull();

    // 2. Invalid: Update to WATCHED while keeping watchedAt = null -> must be rejected by PostgreSQL CHECK constraint
    await expect(
      prisma.collectionMovie.update({
        where: { id: validToWatch.id },
        data: {
          status: 'WATCHED',
          watchedAt: null,
        },
      })
    ).rejects.toThrow();

    // 3. Valid: Update to WATCHED with non-null watchedAt
    const validWatched = await prisma.collectionMovie.update({
      where: { id: validToWatch.id },
      data: {
        status: 'WATCHED',
        watchedAt: new Date(),
      },
    });
    expect(validWatched.status).toBe('WATCHED');
    expect(validWatched.watchedAt).not.toBeNull();

    // 4. Invalid: Update to TO_WATCH with non-null watchedAt -> must be rejected by PostgreSQL CHECK constraint
    await expect(
      prisma.collectionMovie.update({
        where: { id: validToWatch.id },
        data: {
          status: 'TO_WATCH',
          watchedAt: new Date(),
        },
      })
    ).rejects.toThrow();
  });
});
