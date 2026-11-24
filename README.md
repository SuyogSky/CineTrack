# CineTrack 🎬

**CineTrack** is a production-grade, full-stack movie watchlist and collaborative collection management platform built with the **PERN stack (PostgreSQL, Express.js, React, Node.js) and TypeScript**.

CineTrack allows film enthusiasts to discover movies through TMDb, manage personalized watchlists, track completion dates atomically, build themed custom collections, share view-only links publicly, invite friends to collaborate with granular permissions, and decide what to watch next with **Movie Night Roulette**.

---

## Table of Contents

1. [Features](#1-features)
2. [Technology Stack](#2-technology-stack)
3. [Database Design & Mermaid ER Diagram](#3-database-design--mermaid-er-diagram)
4. [Project Folder Structure](#4-project-folder-structure)
5. [Prerequisites](#5-prerequisites)
6. [Installation & Setup](#6-installation--setup)
7. [Environment Variables](#7-environment-variables)
8. [Database Setup & Migrations](#8-database-setup--migrations)
9. [Running the Application](#9-running-the-application)
10. [Testing Suite](#10-testing-suite)
11. [API Reference & Authorization Rules](#11-api-reference--authorization-rules)
12. [Backup, Restore, and Disaster Recovery Procedures](#12-backup-restore-and-disaster-recovery-procedures)
13. [Production Build & Deployment](#13-production-build--deployment)
14. [Architecture & Production Documentation](#14-architecture--production-documentation)

---

## 1. Features

- **TMDb Movie & TV Series Search & Cataloging**: Search millions of movies and TV series (e.g. *Inception*, *Loki*, *WandaVision*, *Kurukshetra*) with segmented filters (`All`, `Movies`, `TV Series`). Canonical media metadata is normalized and cached centrally in PostgreSQL with collision-free composite unique identifiers `(tmdbId, mediaType)`.
- **Collection-Aware Aggregate Dashboard Statistics**: Account-wide metrics aggregated across all accessible collections (default watchlist, custom collections, and collaborated shared collections). Strictly deduplicates identical titles appearing in multiple collections, cleanly distinguishing distinct Movies count, TV Series count, To Watch, Watched, and Total Collections.
- **Multi-Collection Pick for Us (Roulette)**: Multi-collection lottery pool allowing selection across multiple collections with a master "All Accessible Collections" toggle. Fair deduplication guarantees equal probability per unique title without double-weighting.
- **Mobile-First PWA Experience**: Web App Manifest (`manifest.json`), service worker offline shell fallback (`sw.js`), standalone mobile display mode, safe-area padding, and fixed bottom navigation bar (`Home`, `Search`, `Pick for Us`, `Collections`, `Profile`).
- **Default Master Watchlist**: Every user receives an instant, personal master watchlist upon registration (`/watchlist`) that persists across sessions.
- **Atomic Watch Status Tracking**: Mark films and series as `TO_WATCH` or `WATCHED`. Completion timestamps (`watchedAt`) are managed atomically on the backend, preventing inconsistent database states.
- **Personal Film Notes**: Add private review notes, streaming location details, or friend recommendations to any film or TV series in a collection.
- **Custom Collections**: Create unlimited themed collections (e.g. *Sci-Fi Marathons*, *Marvel Series*, *Studio Ghibli*, *Oscar Winners*).
- **Safe Transactional Movie Moving**: Transfer titles seamlessly between collections with atomic database transactions and duplicate collision prevention.
- **Public View-Only Link Sharing**: Generate cryptographically unguessable share links (`/c/:shareToken`) allowing visitors to browse a collection without creating an account or logging in. Immediate one-click revocation disables public access.
- **Multi-User Collaboration**:
  - Invite registered users by username or email.
  - Review pending invitations on the dashboard or invitations panel.
  - Granular role-based permissions: Collaborators can add/remove movies, edit notes, and toggle watch status, but cannot delete collections, invite other members, or alter ownership.
  - Instant collaborator removal with immediate access revocation.
- **Dark Cinematic Design System**: Deep charcoal backgrounds, gold/amber accents, responsive typography, and mobile drawer navigation.

---

## 2. Technology Stack

### Frontend
- **React 19** with **TypeScript**
- **Vite 8**
- **Tailwind CSS v4** with `@tailwindcss/vite`
- **React Router 7**
- **TanStack Query v5** (cache invalidation, optimistic updates, stale-while-revalidate)
- **Axios** with HttpOnly cookie support
- **Lucide React** cinematic icons

### Backend
- **Node.js 24** & **Express.js 5** with **TypeScript**
- **Prisma ORM 7** with `@prisma/adapter-pg` driver adapter
- **Argon2id** password hashing (`memoryCost: 64MB, timeCost: 3`)
- **JWT Authentication** with dual access & refresh tokens delivered via secure `HttpOnly`, `SameSite` cookies
- **Helmet** security headers
- **CORS** strict whitelist
- **Express Rate Limiting** for authentication and API endpoints
- **Zod** request validation

### Database
- **PostgreSQL 18**
- Relational foreign keys with cascading deletions, unique compound indexes, and ACID transactions.

### Testing
- **Vitest** for backend unit and integration tests
- **Supertest** for HTTP API integration testing
- **Playwright** for real browser cross-browser and mobile E2E automation

---

## 3. Database Design & Mermaid ER Diagram

```mermaid
erDiagram
    USER ||--o{ COLLECTION : owns
    USER ||--o{ COLLECTION_MEMBER : joins
    USER ||--o{ COLLABORATION_INVITATION : sends
    USER ||--o{ COLLABORATION_INVITATION : receives
    USER ||--o{ SESSION : authenticates
    USER ||--o{ COLLECTION_MOVIE : adds

    COLLECTION ||--o{ COLLECTION_MOVIE : contains
    COLLECTION ||--o{ COLLECTION_MEMBER : has_members
    COLLECTION ||--o{ COLLABORATION_INVITATION : invites

    MOVIE ||--o{ COLLECTION_MOVIE : referenced_in

    USER {
        uuid id PK
        string username UK
        string email UK
        string passwordHash
        datetime createdAt
        datetime updatedAt
    }

    MOVIE {
        uuid id PK
        int tmdbId
        enum mediaType "MOVIE, TV"
        string title
        string originalTitle
        string overview
        string posterPath
        string backdropPath
        string releaseDate
        int releaseYear
        string originalLanguage
        float popularity
        float voteAverage
        json genres
        datetime createdAt
        datetime updatedAt
    }

    COLLECTION {
        uuid id PK
        uuid ownerId FK
        string title
        string description
        enum visibility "PRIVATE, PUBLIC_LINK"
        string shareToken UK
        boolean isDefaultWatchlist
        datetime createdAt
        datetime updatedAt
    }

    COLLECTION_MOVIE {
        uuid id PK
        uuid collectionId FK
        uuid movieId FK
        uuid addedBy FK
        enum status "TO_WATCH, WATCHED"
        datetime watchedAt
        string note
        datetime createdAt
        datetime updatedAt
    }

    COLLECTION_MEMBER {
        uuid id PK
        uuid collectionId FK
        uuid userId FK
        enum role "MEMBER, ADMIN"
        datetime joinedAt
    }

    COLLABORATION_INVITATION {
        uuid id PK
        uuid collectionId FK
        uuid inviterId FK
        uuid inviteeId FK
        enum status "PENDING, ACCEPTED, DECLINED, REVOKED"
        datetime createdAt
        datetime respondedAt
        datetime updatedAt
    }

    SESSION {
        uuid id PK
        uuid userId FK
        string tokenHash UK
        string userAgent
        string ipAddress
        datetime expiresAt
        datetime revokedAt
        datetime createdAt
        datetime updatedAt
    }
```

---

## 4. Project Folder Structure

```
CineTrack/
├── client/                      # React 19 + TypeScript + Vite frontend
│   ├── public/                  # Static assets & favicon
│   ├── src/
│   │   ├── api/                 # Axios client with withCredentials
│   │   ├── components/
│   │   │   ├── collections/     # CollectionCard, Create/Edit/Share/Collaborator dialogs
│   │   │   ├── common/          # Navbar, Footer, Modal, Badge
│   │   │   ├── layout/          # AppLayout, ProtectedRoute
│   │   │   └── movies/          # MovieCard, SearchModal, RouletteModal, MovieModal, MoveDialog
│   │   ├── context/             # AuthContext (persistent session state)
│   │   ├── pages/               # Landing, Login, Register, Dashboard, Watchlist, Collections, Detail, Shared, Invitations, Public, Settings, 404
│   │   ├── services/            # Frontend API callers (auth, movie, collection, collaboration, public)
│   │   ├── types/               # Shared TypeScript domain models
│   │   ├── App.tsx              # Router & TanStack Query configuration
│   │   ├── index.css            # Tailwind CSS v4 styling & dark cinematic tokens
│   │   └── main.tsx             # React entrypoint
│   ├── package.json
│   ├── tsconfig.app.json
│   └── vite.config.ts
│
├── server/                      # Node.js + Express + TypeScript backend
│   ├── prisma/
│   │   ├── migrations/          # Version-controlled SQL migrations
│   │   ├── schema.prisma        # Prisma 7 PostgreSQL schema
│   │   └── seed.ts              # Database seed script for development
│   ├── src/
│   │   ├── config/              # env.ts (Zod validation), database.ts (PG pool + Prisma adapter)
│   │   ├── controllers/         # Thin HTTP controllers (auth, movie, collection, collaboration, public)
│   │   ├── middleware/          # auth.middleware, error.middleware, rateLimiter
│   │   ├── routes/              # Express routers
│   │   ├── services/            # Core business logic (auth, tmdb, movie, collection, roulette, collaboration)
│   │   ├── types/               # Backend interfaces & Express extensions
│   │   ├── utils/               # Argon2id, JWT, responses, random tokens
│   │   ├── validators/          # Zod validation schemas
│   │   ├── app.ts               # Express application setup
│   │   └── server.ts            # Server entrypoint with graceful shutdown
│   ├── tests/                   # Vitest unit & integration test suites
│   ├── prisma.config.ts         # Prisma 7 configuration file
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
│
├── e2e/                         # Playwright end-to-end browser tests
│   ├── auth-and-watchlist.spec.ts
│   ├── collections-and-roulette.spec.ts
│   ├── collaboration-and-sharing.spec.ts
│   └── mobile-layout.spec.ts
│
├── playwright.config.ts         # Playwright test configuration
├── package.json                 # Root monorepo workspace scripts
└── README.md
```

---

## 5. Prerequisites

- **Node.js**: v20 or higher (v24.16.0 verified and recommended)
- **npm**: v10 or higher (v11.13.0 verified)
- **PostgreSQL**: v14 or higher (v18.6 verified and recommended)
- **TypeScript**: Server TypeScript 7.0.2, Client TypeScript 6.0.3 (both verified)

---

## 6. Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone <repo-url> CineTrack
   cd CineTrack
   ```

2. **Install all dependencies (Root, Server, Client)**:
   ```bash
   npm install
   cd server && npm install
   cd ../client && npm install
   cd ..
   ```

3. **Install Playwright Browsers (for E2E tests)**:
   ```bash
   npx playwright install chromium
   ```

---

## 7. Environment Variables

Create `.env` in `server/`:

```env
PORT=5000
NODE_ENV=development
DATABASE_URL="postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack?schema=public"
TEST_DATABASE_URL="postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public"
EXPECTED_TEST_DATABASE_NAME="cinetrack_test"
JWT_ACCESS_SECRET="cinetrack_dev_access_secret_key_32_chars_min_length_2026!"
JWT_REFRESH_SECRET="cinetrack_dev_refresh_secret_key_32_chars_min_length_2026!"
CSRF_SECRET="cinetrack_dev_csrf_secret_key_32_chars_min_length_2026!"
CORS_ORIGIN="http://localhost:5173"
ALLOWED_ORIGINS="http://localhost:5173"
TRUST_PROXY="false"
COOKIE_DOMAIN=""
TMDB_API_KEY=""
TMDB_BASE_URL="https://api.themoviedb.org/3"
```

### Production Security Secrets & Configuration Rules
In production (`NODE_ENV=production`), the application enforces strict startup validation:
1. **Pairwise Distinct Secrets**: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `CSRF_SECRET` must each be at least 32 characters long, cryptographically strong, and **strictly distinct from one another**. Shared secrets across primitives are rejected on startup.
2. **Secret Generation Commands**:
   - **PowerShell (Windows)**:
     ```powershell
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - **Bash / Unix**:
     ```bash
     openssl rand -hex 32
     ```
3. **Strict Production CORS Validation**:
   - Origins must be explicit public HTTPS URLs (e.g. `https://cinetrack.example.com`).
   - Multiple origins may be supplied as a comma-separated list (`https://app.cinetrack.com, https://admin.cinetrack.com`).
   - Wildcards (`*`), HTTP schemes, localhost, loopbacks (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), and private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`) are strictly rejected in production.
   - Origins must not contain paths, query parameters, or hash fragments.
4. **Reverse Proxy Trust**: Set `TRUST_PROXY="1"` (or appropriate proxy hop count) when operating behind Nginx, Cloudflare, AWS ALB, Render, or Fly.io so Express correctly attributes client IP addresses for rate limiting.
5. **Cookie Security & SameSite Policy**:
   - **Authentication Cookies (`access_token`, `refresh_token`)**: Always `HttpOnly=true` (inaccessible to JavaScript), `path='/'`, with `Secure=true` in production.
   - **SameSite Configuration (`COOKIE_SAMESITE`)**: Defaults to `lax` (strongly recommended for same-domain or reverse-proxy architectures such as `https://cinetrack.example.com` and `https://cinetrack.example.com/api`). When deploying across separate origins (e.g. `https://cinetrack.vercel.app` and `https://api.railway.app`), set `COOKIE_SAMESITE=none` (strictly requires HTTPS and `Secure=true`).
   - **CSRF Token Cookie (`XSRF-TOKEN`)**: Intentionally uses `HttpOnly=false` for the double-submit cookie pattern so frontend JavaScript can read the token and transmit it via the `x-csrf-token` HTTP header on state-changing requests (`POST`, `PATCH`, `DELETE`). The cookie is HMAC-signed on the server using `CSRF_SECRET` to prevent tampering.
6. **TMDb Integration**: If `TMDB_API_KEY` is omitted, CineTrack operates seamlessly using its curated local offline catalog. Supplying a valid TMDb v3 API key enables real-time search proxies.

---

## 8. Database Setup & Migrations

1. **Preflight Migration Diagnostics (Mandatory for Staging & Production)**:
   ```bash
   npm --prefix server run prisma:preflight
   ```
   *The preflight runner classifies the target database into one of four distinct states:*
   - **State A (`EMPTY`)**: 0 tables in the public schema. Verified clean for initial migration deployment.
   - **State B (`VALID`)**: Complete application schema present (all 7 core tables: `User`, `Collection`, `Movie`, `CollectionMovie`, `CollectionMember`, `CollaborationInvitation`, `Session`), Prisma migration metadata table matches disk migrations, all column definitions and enums valid, and zero data integrity conflicts.
   - **State C (`PARTIAL`)**: Partially initialized schema (1 to 6 tables), application tables exist without `_prisma_migrations`, pending unapplied disk migrations, failed migrations recorded in history, or missing required columns. **Fails closed immediately** with actionable remediation steps.
   - **State D (`INCONSISTENT`)**: Unrelated tables detected in schema (e.g., `contest_entries`), migration history present with 0 application tables, unknown foreign migrations in database history, or data integrity violations (duplicate usernames/emails, multiple default watchlists, orphaned foreign keys). **Fails closed immediately**.

2. **Run Prisma Migrations**:
   ```bash
   npm run prisma:migrate
   ```

3. **Deploy to Test Database (for running tests)**:
   ```bash
   npm --prefix server run prisma:deploy
   ```

4. **Seed Development Data**:
   ```bash
   npm run prisma:seed
   ```
   *Generates dynamic test/dev users with secure random passwords. Strictly disabled when `NODE_ENV === 'production'` to prevent accidental data wipes.*

---

## 9. Running the Application

### Development Mode

Run both the server and client concurrently:

- **Terminal 1 (Backend)**:
  ```bash
  npm run dev:server
  ```
  *Server starts at `http://localhost:5000`.*

- **Terminal 2 (Frontend)**:
  ```bash
  npm run dev:client
  ```
  *Vite client starts at `http://localhost:5173`.*

---

## 10. Testing Suite

CineTrack includes an automated test pyramid with **100% test pass rates**:

### 1. Backend Unit & Integration Tests (Vitest)
```bash
npm run test:server
```
Runs **300 test cases across 28 test suites** covering:
- Argon2id password hashing and JWT token verification
- Zod validation schemas
- User registration, login, session revocation
- Watch status transitions and timestamp atomicity
- Transactional movie transfers between collections
- Public sharing link generation and instant revocation
- Multi-user collaboration invitation, acceptance, and access revocation
- Movie Night Roulette random selection with deterministic RNG
- **Collection-Aware Dashboard Statistics**: Deduplication across default, custom, and collaborated collections, distinct movies vs TV series counts
- **Multi-Collection Roulette**: Candidate pooling across collections, deduplication, "ALL" collections keyword, and IDOR protection
- **TMDb Movie & TV Series**: Filtered search (`all`, `movie`, `tv`), collision prevention for identical numeric IDs, TV series lifecycle
- **Case-Insensitive Auth Uniqueness**: Normalization of email and username, rejection of case-variant duplicates
- **Default Watchlist Constraints**: Partial unique index enforcing strictly one default watchlist per user
- **Watched Status Consistency**: PostgreSQL CHECK constraint ensuring watched items strictly possess watchedAt timestamps and unwatched items strictly have null watchedAt
- **Public Collection Privacy**: Masking of private personal notes on public share links
- **CSRF Token Verification**: Dedicated HMAC signing secret and invalid token rejection
- **Cookie-Only Refresh Tokens**: Rejection of body/bearer tokens on refresh; immediate session revocation on logout
- **Mandatory Session Validation**: Access tokens strictly require valid `sessionId`; middleware validates active database session on every authenticated request; fails closed on database lookup errors
- **Database Connection Safety & Isolation**: Rejection of TARGET_DATABASE_URL override in application code, strict TEST_DATABASE_URL requirement in test mode, rejection of production databases in test mode and test databases in production mode, and server identity verification
- **Migration Preflight 4-State Machine (50 tests)**: Real PostgreSQL integration tests covering all states (Empty, Valid, Missing tables, Missing columns, Column data type mismatches, Inconsistent migrations, Checksum mismatches, Missing FK/CHECK/unique constraints, Exact index column names & ordering, Missing enums, Unexpected enum values, Duplicates, and Orphaned records)
- **Distinct Production Secrets**: Rejection of shared, weak, placeholder, or identical secrets
- **Hardened CORS Validation**: Rejection of HTTP, localhost, loopbacks, private IPv4/IPv6, and malformed origins in production
- **Authenticated Backup Encryption (23 tests)**: Authenticated AES-256-GCM + PBKDF2 (100k rounds), atomic no-clobber staging via hardlink `fs.linkSync`, corrupt header rejection, bit-flip detection, strict no-overwrite enforcement
- **Production Backup Orchestration (20 tests)**: Automated retention policy, collision-resistant naming, Last-Known-Good preservation, Minimum Keep guarantee, and `--validate` operational environment health verification
- **Coordinated Snapshot Consistency**: Single PostgreSQL exported transaction snapshot (`SELECT pg_export_snapshot()`) coordinated with `pg_dump --snapshot`, eliminating phantom hash mismatches under concurrent writes
- **Full Database Structure Verification**: Deep validation of all 8 tables, columns, 10 foreign keys with cascade and zero orphans, unique indexes, and canonical status check constraints
- **Database Seeding Safety (18 tests)**: `assertSeedAllowed` with live socket identity (`inet_server_addr`, `inet_server_port`), rejection of non-local hosts, production databases, and populated databases
- **Backup & Restore Integration**: Positive and negative backup tests, corrupt dump rejection, collision safety, and guaranteed cleanup

### 2. Browser E2E Tests (Playwright)
```bash
npm run test:e2e
```
Runs **9 comprehensive end-to-end browser workflows** in Chromium:
- User registration & auto-created default watchlist
- Real-time movie search & adding to watchlist
- Toggling watched status and verifying reload persistence
- Custom collection creation and Movie Night Roulette selection
- Multi-context collaboration: User 1 invites User 2; User 2 accepts; User 2 manages shared list
- Logged-out guest viewing public collection link without edit permissions
- Collection-aware dashboard metrics updates across collections
- TV series search, adding to library with TV badge, and multi-collection roulette
- Modal close button, backdrop dismissal, and instantaneous watched/unwatched sync
- Pick for Us "All Collections" semantics, custom checkboxes, and outside click dropdown dismissal
- Theme system toggle and dark/light persistence
- Mobile-first responsive layouts across 320px, 375px, 390px, and 430px viewports with bottom navigation bar

### 3. Automated Database Backup & Restore Verification
```bash
npm --prefix server run db:test-backup
```
Verifies live `pg_dump` binary snapshot generation, temporary database restoration via `pg_restore`, schema and table count integrity checks, row-level checksum comparison, relational query usability, and guaranteed `finally` teardown.

---

## 11. API Reference & Authorization Rules

All API routes are prefixed with `/api`.

### Authentication (`/api/auth`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/auth/csrf` | Public | Generates and sets a cryptographically signed HMAC CSRF token in a double-submit cookie (`httpOnly: false`) and response payload |
| POST | `/api/auth/register` | Public | Registers a new user, hashes password with Argon2id, and creates default master watchlist |
| POST | `/api/auth/login` | Public | Authenticates user (case-insensitively) and issues HttpOnly JWT cookies |
| POST | `/api/auth/refresh` | Public (Cookie) | Rotates refresh token strictly from HttpOnly cookie with PostgreSQL transaction `FOR UPDATE` row lock, token reuse detection, and 10s grace period |
| POST | `/api/auth/logout` | Authenticated | Revokes active session immediately in database and clears cookies |
| GET | `/api/auth/me` | Authenticated | Returns current authenticated user profile after verifying active session in database |

### System & Health (`/health`, `/api/health`, `/api/ready`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/health` | Public | Liveness probe returning process uptime and healthy status |
| GET | `/api/health` | Public | API liveness probe |
| GET | `/api/ready` | Public | Readiness probe verifying active PostgreSQL database connectivity |

### Dashboard (`/api/dashboard`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/dashboard/stats` | Authenticated | Aggregate deduplicated statistics across all accessible collections |

### Movies (`/api/movies`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/movies/search?q=&type=&page=` | Authenticated | Search movies and TV series (`type: all \| movie \| tv`) |
| GET | `/api/movies/:tmdbId?type=` | Authenticated | Get detailed metadata for a movie or TV show |

### Collections (`/api/collections`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/collections/default-watchlist` | Authenticated | Fetch or create user's default master watchlist |
| GET | `/api/collections/stats` | Authenticated | Fetch collection-aware deduplicated statistics |
| GET/POST | `/api/collections/roulette` | Authenticated | Multi-collection roulette candidate pool selection |
| GET | `/api/collections` | Authenticated | List owned and shared collections |
| POST | `/api/collections` | Authenticated | Create a new custom collection |
| GET | `/api/collections/:id` | Authenticated | Fetch collection details and movies |
| PATCH | `/api/collections/:id` | Owner | Update collection title/description |
| DELETE | `/api/collections/:id` | Owner | Delete collection (default watchlist cannot be deleted) |
| POST | `/api/collections/:id/movies` | Collaborator+ | Add movie or TV series (`tmdbId`, `mediaType`, `note`) |
| PATCH | `/api/collections/:id/movies/:entryId` | Collaborator+ | Update watch status (`TO_WATCH` / `WATCHED`) or note |
| DELETE | `/api/collections/:id/movies/:entryId` | Collaborator+ | Remove media entry from collection |
| POST | `/api/collections/:id/movies/:entryId/move` | Collaborator+ | Move media entry transactionally to another collection |
| GET | `/api/collections/:id/random` | Collaborator+ | Pick a random unwatched title from this collection |
| POST | `/api/collections/:id/share` | Owner | Enable view-only public link sharing |
| DELETE | `/api/collections/:id/share` | Owner | Disable view-only public link sharing |
| GET | `/api/collections/:id/members` | Member | Lists collaborators and pending invitations |
| POST | `/api/collections/:id/invitations` | Owner | Invites registered user by username/email |
| DELETE | `/api/collections/:id/members/:userId` | Owner | Removes collaborator immediately |

### Invitations (`/api/invitations`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/invitations` | Authenticated | Lists current user's pending invitations |
| POST | `/api/invitations/:id/accept` | Invitee | Accepts invitation; grants collection membership |
| POST | `/api/invitations/:id/decline` | Invitee | Declines invitation |
| DELETE | `/api/invitations/:id` | Inviter/Owner| Revokes invitation |

### Public Collections (`/api/public`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/public/collections/:shareToken` | Public | View-only collection access for visitors (personal notes omitted) |

---

## 12. Backup, Restore, and Disaster Recovery Procedures

### 1. Production Backup Creation & Verification
Run the production backup pipeline to export a coordinated PostgreSQL snapshot, encrypt with authenticated AES-256-GCM, and automatically verify restorability:
```bash
npm --prefix server run backup:create
```

### 2. Operational Environment Health Check (`--validate`)
Verify that the backup directory is writable (`0700`), the database connection and live server identity support exported snapshots, and native PostgreSQL tools (`pg_dump` and `pg_restore` v18+) are operational:
```bash
npm --prefix server run backup:validate
```

### 3. Database Restoration
To restore an encrypted snapshot into a target database with cryptographic validation and database safeguards:
```bash
npm --prefix server run backup:restore -- --backup=./backups/cinetrack_YYYYMMDD_HHMMSS_xxxx.dump.enc --target-db="postgresql://cinetrack_user:pass@localhost:5432/cinetrack_recovery" --confirm-target-db="cinetrack_recovery"
```

# 3. Apply any subsequent pending migrations
npm --prefix server run prisma:deploy
```

### 4. Non-Destructive Backup & Restore Verification Suite
To verify the backup and restore procedures non-destructively against an isolated test database:
```bash
npm --prefix server run db:test-backup
```

### 5. Multi-Tenant Seed Safety & Host Guard
The database seed script (`server/prisma/seed.ts`) executes strict live host verification (`inet_server_addr`, `inet_server_port`) against `DEFAULT_ALLOWED_SEED_HOSTS` (`['localhost', '127.0.0.1', '::1']`). Seeding is strictly forbidden on production databases (`cinetrack`, `prod`, `production`), requires `ALLOW_DEMO_SEED=true`, and refuses to seed if existing non-demo user data is present.

---

## 13. Production Build & Deployment

### 1. Build Both Applications
```bash
npm run build
```
- Compiles backend TypeScript to `./server/dist`.
- Builds optimized frontend production bundle to `./client/dist`.

### 2. Production Startup
```bash
cd server
NODE_ENV=production npm start
```

### 3. Packaging Production Distribution Archive
To package a clean, leak-free deployment archive:
```bash
node scratch/package_zip.js
```
This generates `CineTrack-Production-Ready-Final.zip` using strict POSIX forward-slash paths (`/`), verified with zero backslashes, zero `.env` files, zero nested ZIPs, and full extraction integrity.

### 4. Production Deployment & Architecture Notes
- **Deployment Topology**:
  - **Preferred (Same-Site Reverse Proxy)**: Serve the frontend SPA and backend API under the same site origin (e.g., frontend at `https://cinetrack.example.com` and API at `https://cinetrack.example.com/api`). Configure Nginx, Caddy, Cloudflare, or AWS ALB to proxy `/api` requests to Express. This provides maximum cookie compatibility (`SameSite=lax`), avoids third-party cookie restrictions, and streamlines CSRF defense.
  - **Separate Frontend & API Domains**: If frontend and backend are hosted on different domains (e.g. `https://app.cinetrack.com` and `https://api.cinetrack.com`), ensure both domains use HTTPS, set `COOKIE_DOMAIN=".cinetrack.com"`, configure `CORS_ORIGIN="https://app.cinetrack.com"`, and set `COOKIE_SAMESITE="none"` (requires `Secure=true`).
- **Reverse Proxy IP Attribution**: Set `TRUST_PROXY="1"` (or appropriate hop count) in the backend environment so `req.ip` correctly resolves client IPs for rate-limiting.
- **SSL / HTTPS**: Production must use HTTPS so cookies are transmitted securely with `Secure=true`.
- **Database Deployment Sequence**:
  1. Run preflight diagnostics: `npm --prefix server run prisma:preflight`
  2. Deploy versioned migrations: `npm --prefix server run prisma:deploy`
  3. Start Node.js service: `NODE_ENV=production npm start`
- **PostgreSQL Connection**: In production, supply a managed PostgreSQL URL (e.g., Supabase, Neon, AWS RDS, Cloud SQL) in `DATABASE_URL` and run `npm --prefix server run prisma:deploy` during deployment.

---

## 14. Architecture & Production Documentation

Complete engineering, operations, and audit documentation is available under `docs/`:

1. **[Production Readiness Audit](docs/PRODUCTION_READINESS_AUDIT.md)**: Matrix of all 16 audit items, fixes, exact verified test counts, and security review.
2. **[Production Deployment Guide](docs/PRODUCTION_DEPLOYMENT_GUIDE.md)**: Deployment topologies, secret generation, Nginx reverse proxy, cookie policies, split-origin setups, and health checks.
3. **[Database Backup & Recovery Runbook](docs/DATABASE_BACKUP_AND_RECOVERY.md)**: Native `pg_dump` strategies, encrypted offsite storage, automated verification, and disaster recovery procedures.
4. **[Data Integrity & Migration Strategy](docs/DATA_INTEGRITY_AND_MIGRATION.md)**: PostgreSQL source of truth principles, functional uniqueness indexes, partial indexes, and migration preflight diagnostics.
5. **[Automated Testing Guide](docs/TESTING.md)**: Vitest unit & integration test suites, Playwright E2E workflows, failure injection, and test execution matrix.
6. **[Application Security Architecture](docs/SECURITY.md)**: Argon2id hashing, token family rotation, double-submit CSRF cookies, strict CORS allowlisting, and rate limiting.
