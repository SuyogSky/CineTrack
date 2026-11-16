# CineTrack 🎬

**CineTrack** is a production-grade, full-stack movie watchlist and collaborative collection management platform built with the **PERN stack (PostgreSQL, Express.js, React, Node.js) and TypeScript**.

CineTrack allows film enthusiasts to discover movies through TMDb, manage personalized watchlists, track completion dates atomically, build themed custom collections, share view-only links publicly, invite friends to collaborate with granular permissions, and decide what to watch next with **Movie Night Roulette**.

---

## Table of Contents

1. [Features](#features)
2. [Technology Stack](#technology-stack)
3. [Architecture & Design Principles](#architecture--design-principles)
4. [Database Design & Mermaid ER Diagram](#database-design--mermaid-er-diagram)
5. [Project Folder Structure](#project-folder-structure)
6. [Prerequisites](#prerequisites)
7. [Installation & Setup](#installation--setup)
8. [Environment Variables](#environment-variables)
9. [Database Setup & Migrations](#database-setup--migrations)
10. [Running the Application](#running-the-application)
11. [Testing Suite (Unit, Integration, E2E)](#testing-suite)
12. [API Reference & Authorization Rules](#api-reference--authorization-rules)
13. [Production Build & Deployment](#production-build--deployment)

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
CORS_ORIGIN="http://localhost:5173"
COOKIE_DOMAIN=""
TMDB_API_KEY=""
TMDB_BASE_URL="https://api.themoviedb.org/3"
```

> **Note on TMDb API Key**: If `TMDB_API_KEY` is left blank, CineTrack automatically uses a curated offline catalog of real films with accurate TMDb IDs, synopsis, genres, and poster paths. When an API key is provided, CineTrack seamlessly proxies live searches to the official TMDb API.

---

## 8. Database Setup & Migrations

1. **Run Prisma Migrations**:
   ```bash
   npm run prisma:migrate
   ```

2. **Deploy to Test Database (for running tests)**:
   ```bash
   npm --prefix server run prisma:deploy
   ```

3. **Seed Development Data**:
   ```bash
   npm run prisma:seed
   ```
   *Creates a demo user: `cinephile_demo` (`demo@cinetrack.local` / `CineTrackDemo2026!`) with sample collections and films.*

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
Runs 35 test cases across 9 suites covering:
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

### 2. Browser E2E Tests (Playwright)
```bash
npm run test:e2e
```
Runs 5 full end-to-end browser workflows in Chromium:
- User registration & auto-created default watchlist
- Real-time movie search & adding to watchlist
- Toggling watched status and verifying reload persistence
- Custom collection creation and Movie Night Roulette selection
- Multi-context collaboration: User 1 invites User 2; User 2 accepts; User 2 manages shared list
- Logged-out guest viewing public collection link without edit permissions
- Collection-aware dashboard metrics updates across collections
- TV series search, adding to library with TV badge, and multi-collection roulette
- Mobile-first bottom navigation bar and mobile drawer navigation on phone viewports

---

## 11. API Reference & Authorization Rules

All API routes are prefixed with `/api`.

### Authentication (`/api/auth`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | Public | Register a new user + creates default watchlist |
| POST | `/api/auth/login` | Public | Authenticates user and issues HttpOnly JWT cookies |
| POST | `/api/auth/logout` | Authenticated | Revokes active session and clears cookies |
| GET | `/api/auth/me` | Authenticated | Returns current authenticated user and counters |

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
|---|---|---|---|
| GET | `/api/movies/search?q=&page=` | Authenticated | Live TMDb search with server caching |
| GET | `/api/movies/:tmdbId` | Authenticated | Retrieves canonical movie metadata |

### Collections (`/api/collections`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/collections/default-watchlist` | Authenticated | Retrieves user's master watchlist |
| GET | `/api/collections` | Authenticated | Lists user's owned and shared collections |
| POST | `/api/collections` | Authenticated | Creates a new custom collection |
| GET | `/api/collections/:id` | Authenticated | Gets collection details (Owner or Collaborator) |
| PATCH | `/api/collections/:id` | Owner | Updates collection title/description |
| DELETE | `/api/collections/:id` | Owner | Deletes custom collection (default watchlist cannot be deleted) |
| POST | `/api/collections/:id/movies` | Member | Adds a movie to the collection |
| PATCH | `/api/collections/:id/movies/:entryId` | Member | Updates status (`TO_WATCH` / `WATCHED`) or note |
| DELETE | `/api/collections/:id/movies/:entryId` | Member | Removes movie from collection |
| POST | `/api/collections/:id/movies/:entryId/move` | Member | Moves movie to another collection transactionally |
| GET | `/api/collections/:id/random` | Member | **Movie Night Roulette**: selects random unwatched movie |
| POST | `/api/collections/:id/share` | Owner | Enables public view-only link |
| DELETE | `/api/collections/:id/share` | Owner | Revokes public link |
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
| GET | `/api/public/collections/:shareToken` | Public | View-only collection access for visitors |

---

## 12. Production Build & Deployment

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

### 3. Production Deployment Notes
- **Reverse Proxy**: Use Nginx, Caddy, or Cloudflare to serve the frontend SPA from `client/dist` and proxy `/api` requests to the Node.js backend.
- **SSL / HTTPS**: Ensure production uses HTTPS so cookies are transmitted securely with `Secure=true` and `SameSite=lax` (or `none` for cross-site deployments).
- **PostgreSQL Connection**: In production, supply a managed PostgreSQL URL (e.g., Supabase, Neon, AWS RDS, Cloud SQL) in `DATABASE_URL` and run `npm run prisma:deploy` during deployment.
