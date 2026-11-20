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
});
