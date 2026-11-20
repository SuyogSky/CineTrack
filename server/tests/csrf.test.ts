import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { app } from '../src/app';
import { generateSignedCsrfToken, verifySignedCsrfToken } from '../src/middleware/csrf.middleware';

describe('P0 Cryptographic CSRF & Strict Origin Validation Test Suite', () => {
  const testUser = {
    username: 'csrftester',
    email: 'csrftester@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
  };

  it('1. should issue a cryptographically signed XSRF-TOKEN cookie on safe GET requests', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toBeDefined();
    const xsrfCookie = cookies.find((c) => c.startsWith('XSRF-TOKEN='));
    expect(xsrfCookie).toBeDefined();

    const tokenVal = xsrfCookie!.split(';')[0].split('=')[1];
    expect(verifySignedCsrfToken(tokenVal)).toBe(true);
    expect(tokenVal).toContain('.');
    expect(tokenVal.split('.')[1].length).toBe(64);
  });

  it('2. should provide GET /api/auth/csrf endpoint returning valid signed token and cookie', async () => {
    const res = await request(app).get('/api/auth/csrf');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.csrfToken).toBeDefined();

    const token = res.body.data.csrfToken;
    expect(verifySignedCsrfToken(token)).toBe(true);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const xsrfCookie = cookies.find((c) => c.startsWith('XSRF-TOKEN='));
    expect(xsrfCookie).toBeDefined();
    expect(xsrfCookie).toContain(token);
  });

  it('3. should reject cookie-authenticated state-changing requests when CSRF token is missing', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    expect(regRes.status).toBe(201);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('X-Enforce-CSRF', 'true')
      .send({ title: 'My Protected Collection' });

    expect(postRes.status).toBe(403);
    expect(postRes.body.success).toBe(false);
    expect(postRes.body.code).toBe('CSRF_ERROR');
  });

  it('4. should reject requests from disallowed external origins with 403', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const xsrfCookieStr = cookies.find((c) => c.startsWith('XSRF-TOKEN=')) || '';
    const xsrfToken = xsrfCookieStr.split(';')[0].split('=')[1];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('Origin', 'https://malicious-phishing-site.com')
      .set('X-CSRF-Token', xsrfToken)
      .send({ title: 'Exploit Collection' });

    expect(postRes.status).toBe(403);
    expect(postRes.body.code).toBe('CSRF_ERROR');
  });

  it('5. should reject requests from attacker subdomain pretending to be allowed', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const xsrfCookieStr = cookies.find((c) => c.startsWith('XSRF-TOKEN=')) || '';
    const xsrfToken = xsrfCookieStr.split(';')[0].split('=')[1];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173.attacker.com')
      .set('X-CSRF-Token', xsrfToken)
      .send({ title: 'Exploit Collection' });

    expect(postRes.status).toBe(403);
    expect(postRes.body.code).toBe('CSRF_ERROR');
  });

  it('6. should reject requests with malformed Referer header', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const xsrfCookieStr = cookies.find((c) => c.startsWith('XSRF-TOKEN=')) || '';
    const xsrfToken = xsrfCookieStr.split(';')[0].split('=')[1];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('Referer', 'not-a-valid-url-///')
      .set('X-CSRF-Token', xsrfToken)
      .send({ title: 'Exploit Collection' });

    expect(postRes.status).toBe(403);
    expect(postRes.body.code).toBe('CSRF_ERROR');
  });

  it('7. should reject requests with foreign Referer header', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const xsrfCookieStr = cookies.find((c) => c.startsWith('XSRF-TOKEN=')) || '';
    const xsrfToken = xsrfCookieStr.split(';')[0].split('=')[1];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('Referer', 'https://attacker.com/evil-csrf-page')
      .set('X-CSRF-Token', xsrfToken)
      .send({ title: 'Exploit Collection' });

    expect(postRes.status).toBe(403);
    expect(postRes.body.code).toBe('CSRF_ERROR');
  });

  it('8. should reject cookie-authenticated state-changing requests when CSRF token is mismatched', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', 'invalid_forged_csrf_token_12345')
      .send({ title: 'My Protected Collection' });

    expect(postRes.status).toBe(403);
    expect(postRes.body.success).toBe(false);
    expect(postRes.body.code).toBe('CSRF_ERROR');
  });

  it('9. should reject requests with forged/tampered HMAC signature', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const xsrfCookieStr = cookies.find((c) => c.startsWith('XSRF-TOKEN=')) || '';
    const xsrfToken = xsrfCookieStr.split(';')[0].split('=')[1];

    // Tamper with the HMAC signature part of the token
    const parts = xsrfToken.split('.');
    const tamperedToken = `${parts[0]}.${'a'.repeat(64)}`;

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', [`access_token=dummy`, `XSRF-TOKEN=${tamperedToken}`])
      .set('X-CSRF-Token', tamperedToken)
      .send({ title: 'Tampered Token Collection' });

    expect(postRes.status).toBe(403);
    expect(postRes.body.code).toBe('CSRF_ERROR');
  });

  it('10. should reject requests with raw unsigned token even if cookie and header match', async () => {
    const rawUnsigned = crypto.randomBytes(32).toString('hex');

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', [`access_token=dummy`, `XSRF-TOKEN=${rawUnsigned}`])
      .set('X-CSRF-Token', rawUnsigned)
      .send({ title: 'Raw Token Collection' });

    expect(postRes.status).toBe(403);
    expect(postRes.body.code).toBe('CSRF_ERROR');
  });

  it('11. should accept state-changing requests when valid signed X-CSRF-Token header matches cookie', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const xsrfCookieStr = cookies.find((c) => c.startsWith('XSRF-TOKEN=')) || '';
    const xsrfToken = xsrfCookieStr.split(';')[0].split('=')[1];
    expect(xsrfToken).toBeDefined();

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', xsrfToken)
      .send({ title: 'My Safe Validated Collection' });

    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.data.collection.title).toBe('My Safe Validated Collection');
  });

  it('12. should accept state-changing requests using X-XSRF-TOKEN alias header', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const xsrfCookieStr = cookies.find((c) => c.startsWith('XSRF-TOKEN=')) || '';
    const xsrfToken = xsrfCookieStr.split(';')[0].split('=')[1];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('X-XSRF-TOKEN', xsrfToken)
      .send({ title: 'Alias Header Collection' });

    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
  });

  it('13. should allow safe GET requests without any CSRF token', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const getRes = await request(app).get('/api/collections').set('Cookie', cookies);
    expect(getRes.status).toBe(200);
    expect(getRes.body.success).toBe(true);
  });

  it('14. should allow pure Bearer authenticated requests without CSRF token', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const accessCookie = cookies.find((c) => c.startsWith('access_token=')) || '';
    const accessToken = accessCookie.split(';')[0].split('=')[1];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Pure Bearer Collection' });

    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
  });

  it('15. should accept state-changing requests with matching Origin from configured allowlist', async () => {
    const regRes = await request(app).post('/api/auth/register').send(testUser);
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const xsrfCookieStr = cookies.find((c) => c.startsWith('XSRF-TOKEN=')) || '';
    const xsrfToken = xsrfCookieStr.split(';')[0].split('=')[1];

    const postRes = await request(app)
      .post('/api/collections')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', xsrfToken)
      .send({ title: 'Origin Verified Collection' });

    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
  });

  it('16. should verify that CSRF tokens are signed with CSRF_SECRET and not JWT_ACCESS_SECRET', async () => {
    const tokenVal = crypto.randomBytes(32).toString('hex');
    // Forged token signed with JWT_ACCESS_SECRET
    const badSig = crypto
      .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'test-access-secret-32-chars-long-min!!')
      .update(tokenVal)
      .digest('hex');
    const forgedWithJwtSecret = `${tokenVal}.${badSig}`;

    // Valid token signed with dedicated CSRF_SECRET
    const validSig = crypto
      .createHmac('sha256', process.env.CSRF_SECRET || 'test-csrf-secret-32-chars-long-min!!!!')
      .update(tokenVal)
      .digest('hex');
    const validWithCsrfSecret = `${tokenVal}.${validSig}`;

    expect(verifySignedCsrfToken(forgedWithJwtSecret)).toBe(false);
    expect(verifySignedCsrfToken(validWithCsrfSecret)).toBe(true);
  });
});
