# CineTrack — Test Execution & System Verification Report

**Project**: CineTrack  
**Date**: November 21, 2026  
**Auditor**: Principal Full-Stack Software Architect, QA Automation Engineer  
**System Runtime Environment**:
- **Operating System**: Windows (tested in standard POSIX-compatible runner / PowerShell)
- **Node.js**: v24.16.0 LTS
- **npm**: v11.13.0
- **PostgreSQL**: v18.6 (x64)
- **Prisma ORM**: v7.10.1 (with `@prisma/adapter-pg` driver adapter)
- **TypeScript**: Server v7.0.2, Client v6.0.3
- **Vite**: v8.3.8
- **Vitest**: v5.1.0
- **Playwright**: v1.58.0

---

## 1. Test Suite Summary Table

| Category | Command | Target | Total Suites | Total Tests | Passed | Failed | Skipped | Status |
|---|---|---|---|---|---|---|---|---|
| **Server All Tests** | `npm --prefix server run test` | Full backend test suite | 22 | 164 | 164 | 0 | 0 | **PASSED** |
| **Server Typecheck** | `npm --prefix server run typecheck` | Backend TypeScript (v7.0.2) | 1 | N/A | Clean | 0 | 0 | **PASSED** |
| **Client Typecheck** | `npm --prefix client run typecheck` | Frontend TypeScript (v6.0.3) | 1 | N/A | Clean | 0 | 0 | **PASSED** |
| **Client Lint** | `npm --prefix client run lint` | ESLint v10 flat config | 1 | N/A | Clean (0 err) | 0 | 0 | **PASSED** |
| **Server Build** | `npm --prefix server run build` | `tsc` compilation | 1 | N/A | Clean | 0 | 0 | **PASSED** |
| **Client Build** | `npm --prefix client run build` | Vite production build | 1 | N/A | Clean (0 warn)| 0 | 0 | **PASSED** |
| **Browser E2E** | `npx playwright test` | Chromium headless E2E | 6 | 9 | 9 | 0 | 0 | **PASSED** |
| **Live Backup Test** | `npm --prefix server run db:test-backup` | Native `pg_dump` & `pg_restore` | 1 | 1 | 1 | 0 | 0 | **PASSED** |
| **Live Preflight Test** | `npm --prefix server run prisma:preflight`| Live DB diagnostics | 1 | 1 | 1 | 0 | 0 | **PASSED** |

---

## 2. Server Unit & Integration Test Breakdown (164 Tests across 22 Test Files)

### 1. `tests/migration-preflight-states.test.ts` (22 tests) — PASSED
- `1. should classify completely empty database as State A (EMPTY) and pass`
- `2. should classify fully initialized schema with clean data as State B (VALID) and pass`
- `3. should classify database with unrelated tables and 0 application tables as State D (INCONSISTENT)`
- `4. should classify database with unrelated tables alongside application tables as State D (INCONSISTENT)`
- `5. should fail closed on partial schema missing User table with State C (PARTIAL)`
- `6. should fail closed on partial schema missing Collection table with State C (PARTIAL)`
- `7. should fail closed on partial schema missing CollectionMovie table with State C (PARTIAL)`
- `8. should fail closed on database containing only some application tables with State C (PARTIAL)`
- `9. should fail closed on application tables existing without _prisma_migrations with State C (PARTIAL)`
- `10. should fail closed on database with missing required columns on core tables with State C (PARTIAL)`
- `11. should fail closed on inconsistent migration history (migrations table exists but 0 app tables) with State D (INCONSISTENT)`
- `12. should fail closed on failed migration recorded in _prisma_migrations with State C (PARTIAL)`
- `13. should fail closed on unknown migration recorded in DB history with State D (INCONSISTENT)`
- `14. should detect case-insensitive duplicate usernames as State D (INCONSISTENT)`
- `15. should detect case-insensitive duplicate emails as State D (INCONSISTENT)`
- `16. should detect multiple default watchlists per user as State D (INCONSISTENT)`
- `17. should detect orphaned CollectionMovie-to-Collection references as State D (INCONSISTENT)`
- `18. should detect orphaned Session-to-User references as State D (INCONSISTENT)`
- `19. should detect orphaned CollaborationInvitation references as State D (INCONSISTENT)`
- `20. should pass with clean valid relational data as State B (VALID)`
- `21. should detect missing columns on CollectionMember table as State C (PARTIAL)`
- `22. should detect missing columns on CollaborationInvitation table as State C (PARTIAL)`

### 2. `tests/cors-validation.test.ts` (19 tests) — PASSED
- Validates explicit HTTPS origins, comma-separated lists, and fails closed on HTTP schemes, wildcards, localhost, private IPv4/IPv6 ranges, paths, queries, and hash fragments in production.

### 3. `tests/csrf.test.ts` (16 tests) — PASSED
- Validates HMAC token generation, double-submit cookie verification, header matching, safe GET requests, rejection of missing tokens, expired tokens, invalid signatures, and protected state-changing routes.

### 4. `tests/auth-refresh.test.ts` (14 tests) — PASSED
- Validates refresh token rotation, cookie-only acceptance, rejection of body/bearer tokens, atomic `FOR UPDATE` lock, token reuse detection, 10s grace period, and user profile loading.

### 5. `tests/mandatory-session.test.ts` (13 tests) — PASSED
- Validates mandatory `sessionId` claim in access tokens, database session lookup on each request, session expiry enforcement, revoked session rejection, and fail-closed behavior on database error.

### 6. `tests/secrets-validation.test.ts` (12 tests) — PASSED
- Validates pairwise distinct secrets in production, minimum 32-character requirement, and rejection of weak/placeholder strings (`replace_with`, `password`, `cinetrack_dev`).

### 7. `tests/backup-restore.test.ts` (11 tests) — PASSED
- Validates strict database name allowlist (`cinetrack_test`), substring rejection (`contest`, `contest_db`, `protest`, `latest_movies`), production name rejection (`prod`, `production`, `live`, `main`), unapproved restore target rejection, corrupt dump rejection, guaranteed cleanup in `finally`, and full backup/restore verification.

### 8. `tests/unit/utils.test.ts` (10 tests) — PASSED
- Tests Argon2id password hashing, verification, invalid hash handling, JWT creation, JWT verification, and response helpers.

### 9. `tests/logout-reliability.test.ts` (7 tests) — PASSED
- Tests successful logout, database session revocation (`revokedAt = NOW()`), idempotent repeated logout, rejection of revoked tokens, invalid token handling, fail-closed HTTP 500 error propagation on database failure, and cookie clearing.

### 10. `tests/auth.test.ts` (6 tests) — PASSED
- Tests user registration, password hashing, login with email or username, duplicate username rejection, invalid password rejection, and session persistence.

### 11. `tests/collections.test.ts` (5 tests) — PASSED
- Tests creation of custom collections, default watchlist retrieval, collection updates, and collection deletion safeguards.

### 12. `tests/db-isolation.test.ts` (5 tests) — PASSED
- Tests test database isolation, verifying operations only run against `EXPECTED_TEST_DATABASE_NAME`.

### 13. `tests/roulette-validation.test.ts` (3 tests) — PASSED
- Tests Pick for Us validation, string boolean parsing (`includeWatched="false"` not coerced to true), and candidate filtering.

### 14. `tests/case-insensitive-auth.test.ts` (3 tests) — PASSED
- Tests case-insensitive uniqueness for usernames and emails, and partial unique constraint for default watchlist.

### 15. `tests/multiRoulette.test.ts` (3 tests) — PASSED
- Tests multi-collection candidate pooling, deduplication of duplicate titles, and "ALL" keyword semantics.

### 16. `tests/tmdb.test.ts` (3 tests) — PASSED
- Tests TMDb movie & TV series search, media type filters, TV series lifecycle (add, mark watched, note, move, remove), and numeric ID collision safety.

### 17. `tests/security-guards.test.ts` (3 tests) — PASSED
- Tests migration preflight integration, test database safety gates, and production seed script deactivation.

### 18. `tests/stats.test.ts` (2 tests) — PASSED
- Tests collection-aware dashboard statistics, deduplication across owned, shared, and default collections, and movie vs TV counts.

### 19. `tests/collaboration.test.ts` (2 tests) — PASSED
- Tests multi-user invitation lifecycle (send, pending, accept, decline), collaborator permission checks, and immediate removal revocation.

### 20. `tests/sharing.test.ts` (2 tests) — PASSED
- Tests public view-only link sharing generation, access verification for guests, and one-click share revocation.

### 21. `tests/roulette.test.ts` (2 tests) — PASSED
- Tests single-collection Movie Night Roulette, unwatched selection filter, and deterministic RNG.

### 22. `tests/public-privacy.test.ts` (1 test) — PASSED
- Tests public link privacy, verifying that private personal notes (`note`) are strictly masked and omitted from public responses.

---

## 3. Frontend Production Build & Bundle Breakdown

**Command**: `npm --prefix client run build`  
**Result**: Build succeeded in 660ms with **0 errors and 0 warnings**.

### Chunk Breakdown:
- `dist/assets/vendor-react-BoarQlTy.js`: 210.53 kB (gzip: 65.70 kB) — React, ReactDOM, React Router
- `dist/assets/index-CbJBHCZ4.js`: 145.10 kB (gzip: 47.30 kB) — Core application shell, layout, contexts
- `dist/assets/vendor-query-D3ml_3l5.js`: 35.54 kB (gzip: 10.51 kB) — TanStack Query
- `dist/assets/CollectionDetailPage-DwzpcWet.js`: 24.73 kB (gzip: 5.54 kB) — Lazy-loaded detail view
- `dist/assets/vendor-icons-AxeZ3-Ef.js`: 23.62 kB (gzip: 8.70 kB) — Lucide cinematic icons
- `dist/assets/MovieModal-fjLfZNve.js`: 14.09 kB (gzip: 3.97 kB) — Movie details modal
- `dist/assets/PublicCollectionPage-Cdb1-9jw.js`: 9.58 kB (gzip: 2.80 kB) — Lazy-loaded public view
- `dist/assets/WatchlistPage-BrgFMdcP.js`: 9.56 kB (gzip: 2.78 kB) — Lazy-loaded watchlist
- `dist/assets/DashboardPage-hmsbq6I3.js`: 9.55 kB (gzip: 2.26 kB) — Lazy-loaded dashboard
- `dist/assets/LandingPage-BF4OPsfP.js`: 6.23 kB (gzip: 1.83 kB) — Lazy-loaded landing page
- `dist/assets/InvitationsPage-5bSinpOw.js`: 5.07 kB (gzip: 1.61 kB) — Lazy-loaded invitations
- `dist/assets/RegisterPage-DirnmyGV.js`: 4.99 kB (gzip: 1.60 kB) — Lazy-loaded register
- `dist/assets/LoginPage-Dn1xgwXj.js`: 3.92 kB (gzip: 1.49 kB) — Lazy-loaded login
- `dist/assets/SettingsPage-BYpvvMRb.js`: 3.24 kB (gzip: 1.03 kB) — Lazy-loaded settings
- `dist/assets/CollectionsListPage-cS4eNDnp.js`: 2.73 kB (gzip: 1.02 kB) — Lazy-loaded collection list
- `dist/assets/SharedWithMePage-CdCdo7Li.js`: 2.51 kB (gzip: 0.98 kB) — Lazy-loaded shared list
- `dist/assets/NotFoundPage-C4CsdOQK.js`: 1.17 kB (gzip: 0.60 kB) — 404 page
- `dist/assets/index-CAb5BkAH.css`: 66.01 kB (gzip: 10.77 kB) — Tailwind CSS v4 styling

---

## 4. Playwright End-to-End Browser Workflows (9/9 Passed in 41.3s)

**Command**: `npx playwright test`  
**Browser**: Chromium (headless) with real Node.js backend and real Vite dev server.

1. `e2e/auth-and-watchlist.spec.ts`: User registration, TMDb catalog search, adding to watchlist, and toggling watched status (3.0s).
2. `e2e/collaboration-and-sharing.spec.ts`: Public collection sharing and multi-user collaboration lifecycle (6.0s).
3. `e2e/collection-stats-and-tv.spec.ts`: TV series search, library addition, dashboard statistics aggregation, and multi-collection roulette (4.6s).
4. `e2e/collections-and-roulette.spec.ts`: Custom collection creation, movie addition, roulette spin, and movie transfer between collections (4.1s).
5. `e2e/mobile-layout.spec.ts`: Responsive mobile viewport rendering and navigation drawer operation (1.0s).
6. `e2e/state-sync-and-theme.spec.ts (Part 1 & 2)`: Modal close button, backdrop dismissal, and instantaneous watched/unwatched cache sync (3.4s).
7. `e2e/state-sync-and-theme.spec.ts (Part 3)`: Pick for Us "All Collections" semantics, custom checkboxes, and dropdown outside click (2.9s).
8. `e2e/state-sync-and-theme.spec.ts (Part 6)`: Theme system toggle and localStorage dark/light persistence (1.8s).
9. `e2e/state-sync-and-theme.spec.ts (Part 5)`: Mobile-first responsive layouts tested across 320px, 375px, 390px, and 430px viewports (11.8s).

---

## 5. Summary of Verification Results

- **Total Server Unit & Integration Tests**: 164 passed, 0 failed, 0 skipped.
- **Total Browser E2E Tests**: 9 passed, 0 failed, 0 skipped.
- **Total Static Quality Gates**: 4 passed (Server TypeScript, Client TypeScript, Client ESLint, Prisma validation).
- **Total Production Builds**: 2 passed (Server `tsc`, Client Vite).
- **Disaster Recovery**: Live backup, restoration, catalog equivalence, and MD5 data comparison verified.
- **Overall System Quality Gate**: **100% PASSED**.
