# CineTrack — Production Deployment, Architecture & Runbook Guide

**Project**: CineTrack  
**Version**: 1.0.0 Production Ready  
**Date**: November 21, 2026  

---

## 1. System & Infrastructure Prerequisites

CineTrack is designed for high reliability, data preservation, and secure multi-user collaboration. Ensure your hosting infrastructure meets the following baseline requirements:

| Component | Minimum Supported | Verified & Recommended | Notes |
|---|---|---|---|
| **Node.js** | v20.0.0+ | **v24.16.0 LTS** | Required for ES module support, crypto primitives, and Express 5 compatibility |
| **npm** | v10.0.0+ | **v11.13.0+** | Lockfile v3 compatibility |
| **PostgreSQL** | v14.0+ | **v18.6+** | Relational foreign keys with cascading deletions, partial unique indexes, and JSONB queries |
| **Reverse Proxy** | Any | **Nginx, Caddy, Cloudflare, or AWS ALB** | SSL/TLS termination, HTTP/2 or HTTP/3, compression, static asset caching |
| **RAM / CPU** | 512 MB / 1 vCPU | **1 GB / 1-2 vCPUs** | Minimum allocation for production Node.js process and connection pool |

---

## 2. Production Environment Variables & Secret Generation

CineTrack strictly enforces fail-closed validation on startup (`server/src/config/env.ts`). In production (`NODE_ENV=production`), the application refuses to boot if secrets are weak, shared, or placeholder values.

### Generating Cryptographically Strong Secrets

Run the following command three separate times to generate pairwise distinct 256-bit hexadecimal secrets:

- **Linux / macOS / Bash**:
  ```bash
  openssl rand -hex 32
  ```
- **Windows PowerShell**:
  ```powershell
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

### Complete Production Environment Template (`server/.env`)

```env
# Server Runtime
PORT=5000
NODE_ENV=production

# Database Connection (Managed PostgreSQL: AWS RDS, Supabase, Neon, Cloud SQL)
DATABASE_URL="postgresql://cinetrack_app:SUPER_STRONG_DB_PASS@db.production.internal:5432/cinetrack?schema=public&sslmode=require"

# Pairwise Distinct 32+ Character Secrets (Never reuse values across primitives)
JWT_ACCESS_SECRET="7f8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b"
JWT_REFRESH_SECRET="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"
CSRF_SECRET="f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8"

# Reverse Proxy Trust (Set to "1" or proxy hop count behind Cloudflare, Nginx, ALB)
TRUST_PROXY="1"

# CORS Origin Whitelist (Must be explicit public HTTPS origin; NO wildcards, NO http://)
CORS_ORIGIN="https://cinetrack.example.com"
ALLOWED_ORIGINS="https://cinetrack.example.com"

# Cookie Configuration
# COOKIE_SAMESITE: 'lax' (recommended for same-domain or reverse-proxy setups) or 'none' (for cross-domain setups)
COOKIE_SAMESITE="lax"
COOKIE_DOMAIN=""

# External TMDb API (Optional: omitted key triggers curated offline catalog)
TMDB_API_KEY="your_production_tmdb_api_key_v3"
TMDB_BASE_URL="https://api.themoviedb.org/3"
```

---

## 3. Recommended Deployment Architectures

### Topology A: Same-Site Reverse Proxy (Strongly Recommended)

In Topology A, a single domain (e.g. `https://cinetrack.example.com`) serves both the static frontend SPA and proxies `/api` calls to the Node.js backend.

```
                    Internet (HTTPS)
                           │
                           ▼
                 ┌───────────────────┐
                 │ Reverse Proxy     │
                 │ (Nginx / Caddy)   │
                 └─────────┬─────────┘
          ┌────────────────┴────────────────┐
          ▼                                 ▼
   Path: /api/*                      Path: /* (SPA)
┌──────────────────────┐          ┌──────────────────────┐
│ Node.js / Express 5  │          │ Static Files         │
│ (Port 5000)          │          │ (client/dist)        │
└──────────┬───────────┘          └──────────────────────┘
           │
           ▼
┌──────────────────────┐
│ PostgreSQL 18 DB     │
└──────────────────────┘
```

**Benefits**:
- Zero cross-site cookie blocking by modern browsers (Safari ITP, Chrome Privacy Sandbox).
- `COOKIE_SAMESITE="lax"` provides native CSRF defense for top-level navigations.
- No cross-origin preflight (`OPTIONS`) request overhead on simple requests.

#### Sample Nginx Configuration Block:
```nginx
server {
    listen 443 ssl http2;
    server_name cinetrack.example.com;

    ssl_certificate /etc/letsencrypt/live/cinetrack.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cinetrack.example.com/privkey.pem;

    # Frontend SPA Root
    root /var/www/cinetrack/client/dist;
    index index.html;

    # Static Assets with Long-Term Cache
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API Proxy to Backend
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health Check Proxy
    location /health {
        proxy_pass http://127.0.0.1:5000/health;
    }

    # SPA Fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Topology B: Split Origin Deployment (Vercel Frontend + Railway/Render Backend)

If hosting the frontend on a CDN/edge service (e.g. `https://cinetrack-app.vercel.app`) and backend on a platform (e.g. `https://cinetrack-api.up.railway.app`):
1. Both domains **must use HTTPS**.
2. Set `CORS_ORIGIN="https://cinetrack-app.vercel.app"`.
3. Set `COOKIE_SAMESITE="none"` in `server/.env`.
4. Ensure `Secure=true` is enabled on all cookies.

---

## 4. Database Setup & Migration Deployment Runbook

Never apply raw unreviewed SQL to production. Use the standardized, non-destructive CineTrack migration runbook:

### Step 1: Run Preflight Diagnostics
Before executing migrations or booting the application, run the automated preflight checker:
```bash
npm --prefix server run prisma:preflight
```
The preflight script validates:
- Target database connectivity and user identity.
- Database state classification (`EMPTY` vs `VALID` vs `PARTIAL` vs `INCONSISTENT`).
- Complete column definitions across all 7 core tables.
- Verification of applied migration names against `server/prisma/migrations/`.
- Detection of data integrity conflicts (duplicate usernames/emails, multiple default watchlists, orphaned records).

**Fails closed** with actionable remediation SQL if conflicts exist.

### Step 2: Deploy Versioned Migrations
Once preflight confirms State A (`EMPTY`) or State B (`VALID`):
```bash
npm --prefix server run prisma:deploy
```
*Note: `prisma migrate deploy` executes only version-controlled SQL files from `server/prisma/migrations/`. It never prompts interactively and never resets the database.*

### Step 3: Verify Post-Migration Readiness
Confirm active connectivity and database readiness:
```bash
curl -I http://localhost:5000/api/ready
```
Returns `HTTP/1.1 200 OK` when the database connection pool is healthy.

---

## 5. Cookie Security & CSRF Protection Architecture

CineTrack implements a strict distinction between authentication cookies and CSRF protection tokens:

| Cookie Name | Scope | `HttpOnly` | `Secure` (Prod) | `SameSite` | Purpose |
|---|---|---|---|---|---|
| `access_token` | Path `/` | **`true`** | **`true`** | `lax` (or `none`) | Short-lived JWT (15 mins) for authenticating API requests. Inaccessible to client JavaScript. |
| `refresh_token` | Path `/` | **`true`** | **`true`** | `lax` (or `none`) | Long-lived token (7 days) for rotating access tokens. Inaccessible to client JavaScript. |
| `csrf_token` | Path `/` | **`false`** | **`true`** | `lax` (or `none`) | Double-submit CSRF cookie. JavaScript reads this value and transmits it in the `x-csrf-token` header. |

### How CSRF Double-Submit Protection Operates:
1. When a client visits the application, it fetches `/api/auth/csrf`.
2. The server sets an HMAC-SHA256 signed `csrf_token` cookie and returns the token in the response body.
3. On every state-changing request (`POST`, `PATCH`, `DELETE`, `PUT`), the frontend Axios client attaches the header:
   ```http
   x-csrf-token: <token>
   ```
4. Middleware `csrfProtection` cryptographically verifies the token signature against `CSRF_SECRET` and ensures it matches the cookie value.

---

## 6. Health Checks, Probes & Observability

CineTrack provides three dedicated health check endpoints for Kubernetes, Docker Swarm, AWS ECS, or uptime monitors:

| Endpoint | Type | Expected Status | Description |
|---|---|---|---|
| `GET /health` | Liveness | `200 OK` | Fast in-memory process liveness probe. Returns uptime and service timestamp. |
| `GET /api/health` | Liveness | `200 OK` | API router liveness check. |
| `GET /api/ready` | Readiness | `200 OK` / `503 Unavailable` | Executes `SELECT 1` on PostgreSQL connection pool. Returns 503 if database is unreachable. |

---

## 7. Backup, Restoration & Disaster Recovery Runbook

### Routine Snapshot Creation
Create a compressed, binary custom-format snapshot using PostgreSQL's native `pg_dump`:
```bash
pg_dump -h <HOST> -p 5432 -U cinetrack -F c -b -v -f /backups/cinetrack_$(date +%Y%m%d_%H%M%S).dump cinetrack
```

### Complete Disaster Restoration Runbook
To restore into a fresh database instance (e.g. following hardware replacement):

```bash
# 1. Create fresh target database
createdb -h <HOST> -p 5432 -U cinetrack cinetrack_production

# 2. Restore schema and data from binary dump
pg_restore -h <HOST> -p 5432 -U cinetrack -d cinetrack_production -v /backups/cinetrack_YYYYMMDD_HHMMSS.dump

# 3. Apply any subsequent migrations deployed since snapshot
DATABASE_URL="postgresql://cinetrack:PASS@HOST:5432/cinetrack_production?schema=public" npm --prefix server run prisma:deploy

# 4. Verify preflight state
TARGET_DATABASE_URL="postgresql://cinetrack:PASS@HOST:5432/cinetrack_production?schema=public" npm --prefix server run prisma:preflight
```

### Automated Backup/Restore Verification Command
To verify the entire backup and restore toolchain without manual intervention:
```bash
BACKUP_TEST_SOURCE_URL="postgresql://cinetrack:PASS@localhost:5432/cinetrack_test?schema=public" npm --prefix server run db:test-backup
```
This script dumps the database, restores to a disposable database, verifies 8 tables, 73 columns, 68 constraints, 35 indexes, 12 enums, and deterministic MD5 row-level checksums, and guarantees teardown.

---

## 8. Rollback Procedure

If a deployment must be rolled back due to application regression:

1. **Revert Frontend**: Re-deploy the previously built `client/dist` bundle or switch the reverse proxy root to the previous release folder.
2. **Revert Backend**: Stop the new Node.js process and restart the previous stable version.
3. **Database Considerations**:
   - CineTrack migrations are strictly additive. Rolling back backend code to a previous compatible version does not require down-migrations if columns remain backward-compatible.
   - If a rollback database restore is required, follow the Disaster Restoration Runbook using the pre-deployment snapshot.

---

## 9. Common Deployment Issues & Troubleshooting

| Symptom | Probable Cause | Corrective Action |
|---|---|---|
| `MIGRATION PREFLIGHT ABORTED [State: INCONSISTENT]` | Unrelated tables detected or case-insensitive duplicate username/email in database | Review diagnostic output printed to console; execute the suggested `resolutionHint` SQL commands or target a clean database. |
| `JWT_REFRESH_SECRET must be distinct from JWT_ACCESS_SECRET` | Placeholder or identical secrets in `.env` | Generate distinct 32-character hexadecimal strings using `openssl rand -hex 32` for each secret. |
| `Production origin must use HTTPS scheme` | `CORS_ORIGIN` contains `http://` or wildcard `*` | Configure explicit public `https://` URLs in `CORS_ORIGIN`. |
| `403 Forbidden: Invalid or missing CSRF token` | Request header `x-csrf-token` is missing or cookie was blocked | Ensure frontend requests include `withCredentials: true` and that client fetches `/api/auth/csrf` on application startup. |
| `Refresh token cookie is missing (401)` | Cookie blocked due to SameSite/Secure mismatch | Ensure site is accessed over HTTPS. If frontend and API are on different domains, set `COOKIE_SAMESITE="none"` and `COOKIE_DOMAIN=".yourdomain.com"`. |
