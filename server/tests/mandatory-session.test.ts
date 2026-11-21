import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { app } from '../src/app';
import { prisma } from '../src/config/database';
import { env } from '../src/config/env';
import { generateAccessToken } from '../src/utils/jwt';

describe('Phase 2: Mandatory Access-Token Session Validation Tests', () => {
  const user1 = {
    username: 'sessiontester1',
    email: 'sessiontester1@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  const user2 = {
    username: 'sessiontester2',
    email: 'sessiontester2@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  it('1. valid token with active session succeeds', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    expect(regRes.status).toBe(201);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const meRes = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe(user1.email.toLowerCase());
  });

  it('2. missing session ID is rejected', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const user = regRes.body.data.user;

    // Generate legacy token without sessionId using raw jwt.sign
    const legacyToken = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' }
    );

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`access_token=${legacyToken}`]);

    expect(meRes.status).toBe(401);
    expect(meRes.body.message).toMatch(/Authentication required/i);
  });

  it('3. empty session ID is rejected', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const user = regRes.body.data.user;

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, sessionId: '' },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' }
    );

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`access_token=${token}`]);

    expect(meRes.status).toBe(401);
  });

  it('4. malformed session ID is rejected', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const user = regRes.body.data.user;

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, sessionId: 'malformed-not-a-uuid-string-12345' },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '15m' }
    );

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`access_token=${token}`]);

    expect(meRes.status).toBe(401);
  });

  it('5. unknown session ID is rejected', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const user = regRes.body.data.user;

    const randomSessionId = crypto.randomUUID();
    const token = generateAccessToken(user, randomSessionId);

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`access_token=${token}`]);

    expect(meRes.status).toBe(401);
  });

  it('6. revoked session is rejected immediately', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Mark session as revoked in DB
    await prisma.session.updateMany({
      where: { user: { email: user1.email.toLowerCase() } },
      data: { revokedAt: new Date() },
    });

    const meRes = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes.status).toBe(401);
  });

  it('7. expired session is rejected', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Set expiresAt to the past
    await prisma.session.updateMany({
      where: { user: { email: user1.email.toLowerCase() } },
      data: { expiresAt: new Date(Date.now() - 3600000) },
    });

    const meRes = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes.status).toBe(401);
  });

  it('8. session belonging to another user is rejected', async () => {
    const reg1 = await request(app).post('/api/auth/register').send(user1);
    const reg2 = await request(app).post('/api/auth/register').send(user2);

    const user1Data = reg1.body.data.user;
    const session2 = await prisma.session.findFirst({
      where: { user: { email: user2.email.toLowerCase() } },
    });
    expect(session2).toBeDefined();

    // Create token with user1's identity but user2's sessionId
    const spoofedToken = generateAccessToken(user1Data, session2!.id);

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`access_token=${spoofedToken}`]);

    expect(meRes.status).toBe(401);
  });

  it('9. expired access token is rejected', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const user = regRes.body.data.user;
    const session = await prisma.session.findFirst({
      where: { user: { email: user1.email.toLowerCase() } },
    });

    const expiredToken = jwt.sign(
      { id: user.id, username: user.username, email: user.email, sessionId: session!.id },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '-1s' }
    );

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`access_token=${expiredToken}`]);

    expect(meRes.status).toBe(401);
  });

  it('10. invalid token signature is rejected', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const user = regRes.body.data.user;
    const session = await prisma.session.findFirst({
      where: { user: { email: user1.email.toLowerCase() } },
    });

    const forgedToken = jwt.sign(
      { id: user.id, username: user.username, email: user.email, sessionId: session!.id },
      'wrong-secret-key-32-chars-minimum-length-invalid!',
      { expiresIn: '15m' }
    );

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`access_token=${forgedToken}`]);

    expect(meRes.status).toBe(401);
  });

  it('11. database lookup failure fails closed (500 error, never authenticates)', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Mock prisma.session.findUnique to simulate a database outage
    const findUniqueSpy = vi.spyOn(prisma.session, 'findUnique').mockRejectedValueOnce(
      new Error('Connection terminated unexpectedly')
    );

    const meRes = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes.status).toBe(500);
    expect(meRes.body.message).toMatch(/Internal authentication service error/i);

    findUniqueSpy.mockRestore();
  });

  it('12. logout immediately prevents subsequent authenticated requests using that session', async () => {
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Verify initial access
    const meRes1 = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes1.status).toBe(200);

    // Logout
    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', cookies);
    expect(logoutRes.status).toBe(200);

    // Subsequent authenticated request using the same access token must immediately fail
    const meRes2 = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes2.status).toBe(401);
  });

  it('13. revoking one session does not incorrectly revoke unrelated active sessions', async () => {
    // User 1 logs in twice (e.g. desktop and mobile)
    const regRes = await request(app).post('/api/auth/register').send(user1);
    const desktopCookies = regRes.headers['set-cookie'] as unknown as string[];

    const loginRes = await request(app).post('/api/auth/login').send({
      identifier: user1.username,
      password: user1.password,
    });
    const mobileCookies = loginRes.headers['set-cookie'] as unknown as string[];

    // Both sessions should be active
    const meDesktop1 = await request(app).get('/api/auth/me').set('Cookie', desktopCookies);
    expect(meDesktop1.status).toBe(200);
    const meMobile1 = await request(app).get('/api/auth/me').set('Cookie', mobileCookies);
    expect(meMobile1.status).toBe(200);

    // Logout desktop session only
    await request(app).post('/api/auth/logout').set('Cookie', desktopCookies);

    // Desktop session is revoked
    const meDesktop2 = await request(app).get('/api/auth/me').set('Cookie', desktopCookies);
    expect(meDesktop2.status).toBe(401);

    // Mobile session remains active and valid
    const meMobile2 = await request(app).get('/api/auth/me').set('Cookie', mobileCookies);
    expect(meMobile2.status).toBe(200);
    expect(meMobile2.body.data.user.email).toBe(user1.email.toLowerCase());
  });
});
