import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/config/database';
import { AuthService } from '../src/services/auth.service';
import { generateAccessToken, generateRefreshToken } from '../src/utils/jwt';
import crypto from 'crypto';

describe('Logout & Session Revocation Reliability Integration Tests', () => {
  async function createTestUserAndSession(prefix = 'lo') {
    const id = `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
    const testUser = {
      username: id.slice(0, 28),
      email: `${id}@example.com`,
      password: 'Password123!',
      confirmPassword: 'Password123!',
    };

    const regRes = await request(app)
      .post('/api/auth/register')
      .send(testUser);

    expect(regRes.status).toBe(201);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const user = regRes.body.data.user;

    return { user, cookies, testUser };
  }

  it('1. should successfully logout, clear cookies, and set revokedAt in the database', async () => {
    const { user, cookies } = await createTestUserAndSession('success');

    // Verify session is active before logout
    const activeSession = await prisma.session.findFirst({
      where: { userId: user.id },
    });
    expect(activeSession).toBeDefined();
    expect(activeSession?.revokedAt).toBeNull();

    // Perform logout
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    // Verify cookies are cleared (max-age=0 or expires in past)
    const setCookie = logoutRes.headers['set-cookie'] || [];
    expect(setCookie.some((c: string) => c.includes('access_token=;') || c.includes('access_token=deleted') || c.includes('Max-Age=0'))).toBe(true);
    expect(setCookie.some((c: string) => c.includes('refresh_token=;') || c.includes('refresh_token=deleted') || c.includes('Max-Age=0'))).toBe(true);

    // Verify session in database is now revoked
    const revokedSession = await prisma.session.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(revokedSession?.revokedAt).not.toBeNull();
  });

  it('2. should handle repeated logout safely and idempotently', async () => {
    const { cookies } = await createTestUserAndSession('repeat');

    // First logout
    const res1 = await request(app).post('/api/auth/logout').set('Cookie', cookies);
    expect(res1.status).toBe(200);

    // Repeated logout with the same (already revoked) session tokens
    const res2 = await request(app).post('/api/auth/logout').set('Cookie', cookies);
    expect(res2.status).toBe(200);
    expect(res2.body.success).toBe(true);
  });

  it('3. should reject refresh attempt using revoked session token', async () => {
    const { cookies } = await createTestUserAndSession('refresh_revoked');

    // Logout to revoke session
    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', cookies);
    expect(logoutRes.status).toBe(200);

    // Attempt refresh using the revoked session cookies
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies);

    expect(refreshRes.status).toBe(401);
  });

  it('4. should reject access token authentication after session has been revoked', async () => {
    const { cookies } = await createTestUserAndSession('access_revoked');

    // Verify access works before logout
    const meRes1 = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes1.status).toBe(200);

    // Logout
    await request(app).post('/api/auth/logout').set('Cookie', cookies);

    // Subsequent authenticated request using the access token must immediately fail
    const meRes2 = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(meRes2.status).toBe(401);
  });

  it('5. should handle logout with invalid or expired tokens safely and clear cookies', async () => {
    const badCookies = [
      'access_token=invalid.jwt.token; Path=/',
      'refresh_token=invalid.jwt.token; Path=/',
    ];

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', badCookies);

    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some((c: string) => c.includes('access_token='))).toBe(true);
    expect(setCookie.some((c: string) => c.includes('refresh_token='))).toBe(true);
  });

  it('6. should fail closed with HTTP 500 and clear cookies if database update throws during logout', async () => {
    const { cookies } = await createTestUserAndSession('db_failure');

    // Temporarily mock prisma.session.updateMany to simulate database connection/query outage
    const originalUpdateMany = prisma.session.updateMany;
    prisma.session.updateMany = (async () => {
      throw new Error('Database connection failure during session revocation');
    }) as any;

    try {
      const errorLogoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookies);

      // Must NOT report 200 OK when database failed!
      expect(errorLogoutRes.status).toBe(500);

      // Must still clear client cookies to prevent client from retaining stale auth
      const setCookie = errorLogoutRes.headers['set-cookie'] || [];
      expect(setCookie.some((c: string) => c.includes('access_token=;') || c.includes('access_token=deleted') || c.includes('Max-Age=0'))).toBe(true);
      expect(setCookie.some((c: string) => c.includes('refresh_token=;') || c.includes('refresh_token=deleted') || c.includes('Max-Age=0'))).toBe(true);
    } finally {
      // Restore original updateMany
      prisma.session.updateMany = originalUpdateMany;
    }
  });

  it('7. should handle AuthService.logout directly and report true/false accurately', async () => {
    const fakeSessionId = crypto.randomUUID();
    const fakePayload = { id: crypto.randomUUID(), username: 'fake', email: 'fake@example.com' };
    const fakeAccess = generateAccessToken(fakePayload, fakeSessionId);
    const fakeRefresh = generateRefreshToken(fakePayload, fakeSessionId);

    // Should return { revoked: false } for unknown session without throwing
    const resultUnknown = await AuthService.logout(fakeRefresh, fakeAccess);
    expect(resultUnknown.revoked).toBe(false);

    // Empty tokens also return { revoked: false }
    const resultEmpty = await AuthService.logout();
    expect(resultEmpty.revoked).toBe(false);
  });
});
