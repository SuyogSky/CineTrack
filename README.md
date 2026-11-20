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

- **Node.js**: v20 or higher (v24 recommended)
- **npm**: v10 or higher
- **PostgreSQL**: v14 or higher (v18 supported)

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

> **Note on Environment Variables & Production Hardening**:
> - `CSRF_SECRET`: Dedicated HMAC key (>= 32 chars) isolated from `JWT_ACCESS_SECRET` to prevent cross-primitive cryptographic reuse.
> - `TRUST_PROXY`: Set to `"1"` (or proxy hop count / `"true"`) when running behind reverse proxies (Nginx, Cloudflare, Fly.io, Railway, Render) so `req.ip` correctly resolves client IPs for rate-limiting.
> - `CORS_ORIGIN` / `ALLOWED_ORIGINS`: In production, must be explicitly specified (non-empty) and cannot contain `localhost` or `127.0.0.1`.
> - `TMDB_API_KEY`: If left blank, CineTrack automatically falls back to a curated offline catalog of real films with accurate TMDb IDs, synopsis, genres, and poster paths. When an API key is provided, CineTrack seamlessly proxies live searches to the official TMDb API.

---

## 8. Database Setup & Migrations

1. **Preflight Migration Diagnostics (Recommended for Staging & Production)**:
   ```bash
   npm --prefix server run prisma:preflight
   ```
   *Runs non-destructive diagnostic SQL queries verifying that zero case-insensitive duplicate usernames/emails exist, zero users have multiple default watchlists, and zero orphaned records exist.*

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
Runs **80 test cases across 16 suites** covering:
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
- **Public Collection Privacy**: Masking of private personal notes on public share links
- **CSRF Token Verification**: Dedicated HMAC signing secret and invalid token rejection
- **Cookie-Only Refresh Tokens**: Rejection of body/bearer tokens on refresh; immediate session revocation on logout
- **Database Isolation & Safety**: Production seed blocking and non-destructive preflight diagnostics

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
Verifies live `pg_dump` binary snapshot generation, temporary database restoration via `pg_restore`, schema and table count integrity checks, and clean teardown.

---

## 11. API Reference & Authorization Rules

All API routes are prefixed with `/api`.

### Authentication (`/api/auth`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/auth/csrf` | Public | Generates and sets a cryptographically signed HMAC CSRF token in an HttpOnly cookie and response body |
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

### 1. Database Backup (PostgreSQL)
Run `pg_dump` to create a binary custom-format backup of the CineTrack production database:
```bash
pg_dump -U cinetrack -h localhost -p 5432 -F c -b -v -f cinetrack_backup_$(date +%Y%m%d_%H%M%S).dump cinetrack
```

### 2. Database Restoration
To restore a snapshot into a new or existing target database:
```bash
# 1. Ensure target database exists
createdb -U cinetrack -h localhost -p 5432 cinetrack

# 2. Restore schema and data
pg_restore -U cinetrack -h localhost -p 5432 -d cinetrack -v cinetrack_backup_YYYYMMDD_HHMMSS.dump

# 3. Apply any subsequent pending migrations
npm --prefix server run prisma:deploy
```

### 3. Automated Backup & Restore Verification
To verify the backup and restore procedures non-destructively:
```bash
npm --prefix server run db:test-backup
```

### 4. Permanent Production Seeding Safeguard
The database seed script (`server/prisma/seed.ts`) is strictly disabled in production environments (`NODE_ENV === 'production'`). No environment variable bypass or override exists, eliminating any possibility of accidental test data overwrites in live production.

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
This generates `CineTrack-Production-Ready.zip` using strict POSIX forward-slash paths (`/`), verified with zero backslashes, zero `.env` files, zero nested ZIPs, and full extraction integrity.

### 4. Production Deployment Notes
- **Reverse Proxy**: Use Nginx, Caddy, Cloudflare, or AWS ALB to serve the frontend SPA from `client/dist` and proxy `/api` requests to the Node.js backend. Set `TRUST_PROXY="1"` (or appropriate hop count) in the backend `.env`.
- **SSL / HTTPS**: Ensure production uses HTTPS so cookies are transmitted securely with `Secure=true` and `SameSite=lax` (or `none` for cross-site deployments).
- **PostgreSQL Connection**: In production, supply a managed PostgreSQL URL (e.g., Supabase, Neon, AWS RDS, Cloud SQL) in `DATABASE_URL` and run `npm --prefix server run prisma:preflight` followed by `npm run prisma:deploy` during deployment.
To package a clean, leak-free deployment archive:
```bash
node scratch/package_zip.js
```
This generates `cinetrack-final-production-candidate.zip` preserving full relative directory hierarchy with zero `.env` files, zero nested ZIPs, and zero repository artifacts.

### 4. Production Deployment Notes
- **Reverse Proxy**: Use Nginx, Caddy, or Cloudflare to serve the frontend SPA from `client/dist` and proxy `/api` requests to the Node.js backend.
- **SSL / HTTPS**: Ensure production uses HTTPS so cookies are transmitted securely with `Secure=true` and `SameSite=lax` (or `none` for cross-site deployments).
- **PostgreSQL Connection**: In production, supply a managed PostgreSQL URL (e.g., Supabase, Neon, AWS RDS, Cloud SQL) in `DATABASE_URL` and run `npm run prisma:deploy` during deployment.
