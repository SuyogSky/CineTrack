# CineTrack — Comprehensive Application Security Architecture & Hardening Guide

**Project**: CineTrack  
**Security Classification**: Production Hardened  
**Target Environment**: Node.js 24 LTS & PostgreSQL 18.6+  

---

## 1. Threat Model & Security Posture

CineTrack is built according to **defense-in-depth** and **fail-closed** principles. The application assumes that clients are untrusted, network intermediaries can attempt tampering, and third-party APIs can experience downtime or abuse.

```
                    ┌────────────────────────────────────────────────────────┐
                    │                    Untrusted Client                    │
                    └───────────────────────────┬────────────────────────────┘
                                                │ HTTPS Only
                                                ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Edge / Reverse Proxy (Nginx / Cloudflare)                                                  │
│   • SSL/TLS Termination (TLS 1.3)                                                          │
│   • Security Headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options)                   │
│   • WAF / DDoS & Bot Protection                                                            │
└───────────────────────────────────────────────┬────────────────────────────────────────────┘
                                                │ Proxy Forwarding (X-Forwarded-For)
                                                ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Express 5 Application Layer                                                                │
│   • Helmet HTTP Security Headers                                                           │
│   • Strict CORS Origin Validation (HTTPS allowlist, no wildcards, no private IPs)          │
│   • Rate Limiting (Brute-force protection on auth endpoints)                               │
│   • CSRF Protection (Double-Submit HMAC-SHA256 Cookie & Header)                            │
│   • Zod Schema Input Validation (Rejects unexpected properties)                            │
│   • Argon2id Password Hashing (64 MB memory cost)                                          │
│   • Dual-Token JWT with Token Family Rotation & Mandatory PostgreSQL Session Validation    │
│   • TMDb Header Authentication (Bearer tokens never in URLs)                               │
│   • Sanitized Production Error Responses (No stack traces)                                 │
└───────────────────────────────────────────────┬────────────────────────────────────────────┘
                                                │ Parameterized SQL via Prisma Adapter
                                                ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL 18 Database Layer                                                               │
│   • Relational ACID Constraints & Functional Unique Indexes (LOWER(username), LOWER(email))│
│   • Row-Level Locking (SELECT ... FOR UPDATE during token rotation)                         │
│   • Fail-Closed Session Revocation (revokedAt = NOW())                                     │
│   • Production Seeding Safeguard (Hard lock prevents test data overwrite)                  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Authentication & Credential Storage

### 2.1 Password Hashing with Argon2id
User passwords are never stored in plaintext or with deprecated algorithms (MD5, SHA, bcrypt). CineTrack utilizes **Argon2id** (the winner of the Password Hashing Competition):
- **Memory Cost**: `65,536 KiB` (64 MB) — provides resistance against GPU-accelerated brute-force attacks.
- **Time Cost**: `3` iterations.
- **Parallelism**: `4` threads.
- **Timing Safety**: Password comparison is executed in constant time by the Argon2 native binding, preventing timing-attack user enumeration.

### 2.2 Case-Insensitive Identity Uniqueness
User registration enforces case-insensitive uniqueness at both application and database layers:
```sql
CREATE UNIQUE INDEX "User_username_lower_key" ON "User"(LOWER("username"));
CREATE UNIQUE INDEX "User_email_lower_key" ON "User"(LOWER("email"));
```
Login accepts either `username` or `email` and performs case-insensitive normalization before verifying the password.

---

## 3. Session Management & Token Rotation

### 3.1 Dual-Token Architecture
1. **Access Token**:
   - Short lifespan: **15 minutes**.
   - Contains payload `{ userId, sessionId }`.
   - Delivered via `HttpOnly`, `SameSite`, `Secure` cookie `access_token`.
2. **Refresh Token**:
   - Long lifespan: **7 days**.
   - Raw token is never stored in PostgreSQL; only a SHA-256 hash is persisted.
   - Delivered via `HttpOnly`, `SameSite`, `Secure` cookie `refresh_token`.

### 3.2 Mandatory PostgreSQL Session Binding
Unlike stateless JWT configurations where revoked tokens remain valid until expiration, CineTrack enforces **mandatory session validation** on every authenticated request:
- The `authenticate` middleware extracts `sessionId` from the access token and checks PostgreSQL:
  ```sql
  SELECT id, "userId", "expiresAt", "revokedAt" 
  FROM "Session" 
  WHERE id = $1 AND "revokedAt" IS NULL AND "expiresAt" > NOW();
  ```
- If the session was revoked or expired, the request is rejected immediately with HTTP 401.
- If PostgreSQL is unreachable, the check fails closed with HTTP 500 (never silently passing unverified tokens).

### 3.3 Refresh Token Family Rotation & Reuse Detection
When the client calls `/api/auth/refresh`:
1. The request must supply the `refresh_token` in cookies (body/bearer tokens are rejected).
2. The transaction acquires a row lock (`FOR UPDATE`) on the session record.
3. The incoming token hash is compared:
   - **Current Token Match**: Session rotates immediately. The old hash moves to `previousTokenHash` and `historicalTokenHashes`, and a fresh access and refresh token pair is issued.
   - **Previous Token Match within Grace Period (10s)**: Handled safely as a concurrent retry caused by network latency.
   - **Historical Token Match (Token Reuse Detected)**: The session is **immediately revoked** (`revokedAt = NOW()`), invalidating all active tokens for that user. This mitigates compromised refresh tokens.

### 3.4 Fail-Closed Logout
When `/api/auth/logout` is invoked:
- The server clears client authentication cookies (`access_token`, `refresh_token`, `XSRF-TOKEN`).
- It executes `UPDATE "Session" SET "revokedAt" = NOW() WHERE id = $sessionId;`.
- If the database query fails, the error is propagated to `next(err)` and returns HTTP 500, ensuring revocation failures are not reported as successful.

---

## 4. Cookie Policy & CSRF Defense

### 4.1 Cookie Flags & SameSite Policy
Authentication cookies are configured strictly:
- `httpOnly: true`: Inaccessible to JavaScript, defending against cross-site scripting (XSS) token theft.
- `secure: true`: Transmitted only over HTTPS connections (in production).
- `path: '/'`: Scoped to entire domain.
- `sameSite: env.COOKIE_SAMESITE`: Configurable via environment variable:
  - `'lax'` (Default & Recommended): Optimal for same-domain or reverse-proxy deployments. Protects against CSRF on top-level navigations.
  - `'none'`: Permitted only when `NODE_ENV === 'production'` and HTTPS is enabled for split-origin deployments.

### 4.2 Double-Submit Cookie CSRF Defense
To protect state-changing requests (`POST`, `PATCH`, `DELETE`, `PUT`), CineTrack implements the double-submit cookie pattern:
1. When any request is made to the server, `csrfMiddleware` checks for the `XSRF-TOKEN` cookie.
2. If absent, an HMAC-SHA256 signed token (`CSRF_SECRET`) is generated and set as `XSRF-TOKEN` (`httpOnly: false`).
3. For state-changing operations, the frontend reads the token and sends it in the `x-csrf-token` header.
4. The server validates that:
   - The token exists in both cookie and header.
   - Both values match exactly.
   - The token has a valid HMAC signature and has not expired.
5. All public authentication endpoints (`/register`, `/login`, `/refresh`, `/logout`) are protected by CSRF verification.

---

## 5. Network & Origin Hardening (CORS & Proxy)

### 5.1 Strict CORS Allowlist
In production mode (`NODE_ENV=production`), `server/src/middleware/cors.middleware.ts` rejects unsafe configurations:
- Wildcards (`*`) are prohibited when credentials are used.
- HTTP origins (`http://...`) are rejected.
- Localhost domains (`localhost`, `.local`, `.localhost`) are rejected.
- Private IPv4 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and loopbacks (`127.0.0.0/8`, `::1`) are rejected.
- URLs with path names, search queries, or userinfo are rejected.

### 5.2 Reverse Proxy IP Attribution (`TRUST_PROXY`)
When running behind Nginx, Caddy, or Cloudflare, set `TRUST_PROXY=1` so `express-rate-limit` accurately reads the real client IP from `X-Forwarded-For` rather than the reverse proxy's internal address.

---

## 6. Input Validation, SQL Injection & XSS Defense

### 6.1 Zod Request Validation
All controller endpoints validate incoming parameters, queries, and bodies against strict Zod schemas:
- Unexpected or unknown fields are stripped.
- String lengths, email formats, and UUID structures are enforced.
- Prevents mass-assignment vulnerabilities.

### 6.2 SQL Injection Prevention
CineTrack exclusively uses Prisma 7 ORM with parameterized queries. Raw unparameterized SQL strings are prohibited across the application.

### 6.3 Content Security Policy & XSS Defense
- **Helmet**: Adds security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`).
- **React 19**: Automatically escapes strings before DOM insertion.
- **Masked Public Responses**: Public collection routes (`/api/public/collections/:shareToken`) explicitly strip private fields (`note`, member lists) before responding.

---

## 7. Rate Limiting

To prevent credential stuffing and brute-force attacks:
- **Authentication Routes** (`/api/auth/login`, `/api/auth/register`):
  - Limit: **5 requests per 15 minutes** per IP.
- **General API Routes** (`/api/*`):
  - Limit: **100 requests per 15 minutes** per IP.
- Rate-limited responses return HTTP 429 (`Too many requests`).

---

## 8. Database Connection Security & Isolation

- **Test Database Isolation**: When `NODE_ENV === 'test'`, application connection resolution strictly requires `TEST_DATABASE_URL` and rejects any production database names (`cinetrack`, `prod`, `live`, etc.). Any attempt to run tests against production fails closed immediately.
- **Production Safety Guards**: In production mode (`NODE_ENV === 'production'`), connections to test databases (`_test`, `_ci`, `_e2e`) are forbidden.
- **Immunity to `TARGET_DATABASE_URL` Hijacking**: Application database resolution explicitly ignores `TARGET_DATABASE_URL` (which is reserved exclusively for CLI diagnostic scripts like `prisma:preflight`).
- **Server Identity Verification**: Connection setup inspects `current_database()`, `current_user`, `inet_server_addr()`, and `inet_server_port()` to confirm loopback or explicitly approved host identity before performing any test cleanup or queries.
