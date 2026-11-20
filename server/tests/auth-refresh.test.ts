import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/config/database';

describe('P0 Refresh-Token Rotation, Concurrency & Security Test Suite', () => {
  const testUser = {
    username: 'refreshtester',
    email: 'refreshtester@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  it('1. should issue tokens, rotate refresh token atomically, and update DB hashes & history', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    expect(regRes.status).toBe(201);

    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    expect(cookies).toBeDefined();

    const initialRefreshCookie = cookies.find((c) => c.startsWith('refresh_token='));
    expect(initialRefreshCookie).toBeDefined();

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies);

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.success).toBe(true);
    expect(refreshRes.body.data.user.email).toBe(testUser.email.toLowerCase());
    expect(refreshRes.body.data.accessToken).toBeUndefined();

    const rotatedCookies = refreshRes.headers['set-cookie'] as unknown as string[];
    expect(rotatedCookies).toBeDefined();

    const newRefreshCookie = rotatedCookies.find((c) => c.startsWith('refresh_token='));
    const newAccessCookie = rotatedCookies.find((c) => c.startsWith('access_token='));
    expect(newRefreshCookie).toBeDefined();
    expect(newAccessCookie).toBeDefined();
    expect(newRefreshCookie).not.toBe(initialRefreshCookie);

    const sessions = await prisma.session.findMany({
      where: { user: { email: testUser.email.toLowerCase() } },
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0].previousTokenHash).toBeDefined();
    expect(sessions[0].previousTokenHash).not.toBeNull();
    expect(sessions[0].historicalTokenHashes.length).toBeGreaterThan(0);
    expect(sessions[0].rotatedAt).toBeDefined();
    expect(sessions[0].rotatedAt).not.toBeNull();
    expect(sessions[0].revokedAt).toBeNull();
  });

  it('2. should allow concurrent requests within grace period without invalidating session', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const firstRefreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies);
    expect(firstRefreshRes.status).toBe(200);

    const replayRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies);

    expect(replayRes.status).toBe(200);
    expect(replayRes.body.success).toBe(true);

    const replayCookies = replayRes.headers['set-cookie'] as unknown as string[];
    const accessCookie = replayCookies.find((c) => c.startsWith('access_token='));
    expect(accessCookie).toBeDefined();

    const session = await prisma.session.findFirst({
      where: { user: { email: testUser.email.toLowerCase() } },
    });
    expect(session?.revokedAt).toBeNull();
  });

  it('3. should detect reuse after grace period, revoke entire session, and reject subsequent calls', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const firstRefreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies);
    expect(firstRefreshRes.status).toBe(200);

    // Age rotatedAt beyond 10s grace period
    const pastDate = new Date(Date.now() - 30000);
    await prisma.session.updateMany({
      where: { user: { email: testUser.email.toLowerCase() } },
      data: { rotatedAt: pastDate },
    });

    const reuseRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies);

    expect(reuseRes.status).toBe(401);
    expect(reuseRes.body.success).toBe(false);
    expect(reuseRes.body.message).toContain('reuse detected');

    const session = await prisma.session.findFirst({
      where: { user: { email: testUser.email.toLowerCase() } },
    });
    expect(session?.revokedAt).not.toBeNull();

    // Subsequent call with newest token fails because session was revoked
    const newestCookies = firstRefreshRes.headers['set-cookie'] as unknown as string[];
    const subsequentRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', newestCookies);

    expect(subsequentRes.status).toBe(401);
  });

  it('4. should detect historical token reuse (lineage older than previousTokenHash) and revoke session', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const initialCookies = regRes.headers['set-cookie'] as unknown as string[];

    // 1st rotation
    const rot1 = await request(app).post('/api/auth/refresh').set('Cookie', initialCookies);
    expect(rot1.status).toBe(200);
    const token1Cookies = rot1.headers['set-cookie'] as unknown as string[];

    // 2nd rotation
    const rot2 = await request(app).post('/api/auth/refresh').set('Cookie', token1Cookies);
    expect(rot2.status).toBe(200);

    // Initial token is now in historicalTokenHashes
    const ancientRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies);

    expect(ancientRes.status).toBe(401);
    expect(ancientRes.body.message).toContain('reuse detected');

    const session = await prisma.session.findFirst({
      where: { user: { email: testUser.email.toLowerCase() } },
    });
    expect(session?.revokedAt).not.toBeNull();
  });

  it('5. should handle simultaneous concurrent refresh requests with Promise.all without race conditions', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const responses = await Promise.all([
      request(app).post('/api/auth/refresh').set('Cookie', cookies),
      request(app).post('/api/auth/refresh').set('Cookie', cookies),
      request(app).post('/api/auth/refresh').set('Cookie', cookies),
    ]);

    const statuses = responses.map((r) => r.status);
    expect(statuses).toEqual([200, 200, 200]);

    const session = await prisma.session.findFirst({
      where: { user: { email: testUser.email.toLowerCase() } },
    });
    expect(session?.revokedAt).toBeNull();
  });

  it('6. should reject refresh on a logged out / revoked session', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', cookies);
    expect(logoutRes.status).toBe(200);

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', cookies);
    expect(refreshRes.status).toBe(401);
  });

  it('7. should reject refresh when session has expired', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Expire session in DB
    await prisma.session.updateMany({
      where: { user: { email: testUser.email.toLowerCase() } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', cookies);
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.message).toContain('expired or been revoked');
  });

  it('8. should reject refresh when no refresh token cookie is provided', async () => {
    const refreshRes = await request(app).post('/api/auth/refresh');
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.message).toMatch(/Refresh token/i);
  });

  it('9. should reject refresh with malformed or tampered token', async () => {
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', ['refresh_token=malformed.tampered.token; Path=/; HttpOnly']);
    expect(refreshRes.status).toBe(401);
  });

  it('10. should reject refresh when session ID was deleted from database', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Delete session from DB
    await prisma.session.deleteMany();

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', cookies);
    expect(refreshRes.status).toBe(401);
  });

  it('11. should enforce strictly cookie-only delivery on refresh (no accessToken in json body)', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies);

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.data.accessToken).toBeUndefined();
    expect(refreshRes.body.data.refreshToken).toBeUndefined();
    expect(refreshRes.body.data.user).toBeDefined();

    const setCookieHeaders = refreshRes.headers['set-cookie'] as unknown as string[];
    expect(setCookieHeaders.some((c) => c.startsWith('access_token='))).toBe(true);
  });

  it('12. should handle concurrent logout and refresh safely without unhandled errors', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Fire logout and refresh simultaneously
    const [logoutRes, refreshRes] = await Promise.all([
      request(app).post('/api/auth/logout').set('Cookie', cookies),
      request(app).post('/api/auth/refresh').set('Cookie', cookies),
    ]);

    expect(logoutRes.status).toBe(200);
    // Refresh might succeed right before logout or fail with 401 if logout executed first
    expect([200, 401]).toContain(refreshRes.status);

    // If we call refresh again now, it must definitely be 401
    const postLogoutRefresh = await request(app).post('/api/auth/refresh').set('Cookie', cookies);
    expect(postLogoutRefresh.status).toBe(401);
  });

  it('13. should reject refresh attempts via request body or Bearer header when cookie is missing', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const rawRefresh = cookies.find((c) => c.startsWith('refresh_token='))?.split(';')[0]?.replace('refresh_token=', '');

    // Attempt refresh via request body
    const bodyRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawRefresh });
    expect(bodyRes.status).toBe(401);
    expect(bodyRes.body.message).toMatch(/Refresh token cookie is missing/i);

    // Attempt refresh via Bearer authorization header
    const headerRes = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${rawRefresh}`);
    expect(headerRes.status).toBe(401);
    expect(headerRes.body.message).toMatch(/Refresh token cookie is missing/i);
  });

  it('14. should immediately invalidate access token when session is revoked', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    // Verify access works initially
    const meRes1 = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes1.status).toBe(200);

    // Logout
    await request(app).post('/api/auth/logout').set('Cookie', cookies);

    // Immediate session revocation: access token is immediately rejected
    const meRes2 = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes2.status).toBe(401);
  });
});
