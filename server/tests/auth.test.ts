import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('Authentication & User Management Integration Tests', () => {
  const testUser = {
    username: 'moviefan',
    email: 'moviefan@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  it('should register a new user and create their default watchlist', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(testUser);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(testUser.email.toLowerCase());
    expect(res.body.data.user.username).toBe(testUser.username);
    expect(res.headers['set-cookie']).toBeDefined();

    // Verify access to default-watchlist
    const cookies = res.headers['set-cookie'];
    const watchlistRes = await request(app)
      .get('/api/collections/default-watchlist')
      .set('Cookie', cookies);

    expect(watchlistRes.status).toBe(200);
    expect(watchlistRes.body.data.collection.title).toBe('My Watchlist');
    expect(watchlistRes.body.data.collection.isDefaultWatchlist).toBe(true);
  });

  it('should reject registration if passwords do not match', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        ...testUser,
        confirmPassword: 'MismatchPassword123!',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('should reject duplicate email or username registration', async () => {
    await request(app).post('/api/auth/register').send(testUser);

    const dupEmail = await request(app).post('/api/auth/register').send({
      ...testUser,
      username: 'othername',
    });
    expect(dupEmail.status).toBe(409);

    const dupUser = await request(app).post('/api/auth/register').send({
      ...testUser,
      email: 'other@example.com',
    });
    expect(dupUser.status).toBe(409);
  });

  it('should login with valid email or username', async () => {
    await request(app).post('/api/auth/register').send(testUser);

    // Login with email
    const emailLogin = await request(app).post('/api/auth/login').send({
      identifier: testUser.email,
      password: testUser.password,
    });
    expect(emailLogin.status).toBe(200);
    expect(emailLogin.body.data.user.username).toBe(testUser.username);

    // Login with username
    const usernameLogin = await request(app).post('/api/auth/login').send({
      identifier: testUser.username,
      password: testUser.password,
    });
    expect(usernameLogin.status).toBe(200);
    expect(usernameLogin.body.data.user.email).toBe(testUser.email.toLowerCase());
  });

  it('should reject login with wrong password', async () => {
    await request(app).post('/api/auth/register').send(testUser);

    const res = await request(app).post('/api/auth/login').send({
      identifier: testUser.email,
      password: 'WrongPassword999!',
    });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('should retrieve current user profile and logout successfully', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'];

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe(testUser.email.toLowerCase());

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies);
    expect(logoutRes.status).toBe(200);

    // After clearing cookies, unauthenticated request should fail
    const postLogoutRes = await request(app).get('/api/auth/me');
    expect(postLogoutRes.status).toBe(401);

    // Immediate session revocation: even if client attempts to send old access_token cookie,
    // the request is rejected immediately with 401 because the session in DB was revoked at logout
    const revokedAccessRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies);
    expect(revokedAccessRes.status).toBe(401);
  });
});
