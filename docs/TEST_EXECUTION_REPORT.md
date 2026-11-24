# CineTrack — Test Execution & System Verification Report

**Project**: CineTrack  
**Date**: November 24, 2026  
**Auditor**: Principal Full-Stack Software Architect, Application Security & QA Automation Engineer  
**System Runtime Environment**:
- **Operating System**: Windows (tested natively on Windows x64 / PowerShell)
- **Node.js**: v24.16.0 LTS
- **npm**: v11.13.0
- **PostgreSQL**: v18.6 (x64)
- **Prisma ORM**: v7.10.1 (with `@prisma/adapter-pg` driver adapter)
- **TypeScript**: Server v7.0.2, Client v6.0.3
- **Vite**: v8.3.6
- **Vitest**: v5.1.0
- **Playwright**: v1.65.1

---

## 1. Test Suite Summary Table

| Category | Command | Target | Total Suites | Total Tests | Passed | Failed | Skipped | Status |
|---|---|---|---|---|---|---|---|---|
| **Server All Tests** | `npm --prefix server run test` | Full backend test suite | **28** | **381** | **381** | 0 | 0 | **PASS** |
| **Server Typecheck** | `npm --prefix server run typecheck` | Backend TypeScript (v7.0.2) | 1 | N/A | Clean (0 err) | 0 | 0 | **PASS** |
| **Client Typecheck** | `npm --prefix client run typecheck` | Frontend TypeScript (v6.0.3) | 1 | N/A | Clean (0 err) | 0 | 0 | **PASS** |
| **Client Lint** | `npm --prefix client run lint` | ESLint v10 flat config | 1 | N/A | Clean (0 err) | 0 | 0 | **PASS** |
| **Server Build** | `npm --prefix server run build` | `tsc` compilation (app + scripts) | 1 | N/A | Clean | 0 | 0 | **PASS** |
| **Client Build** | `npm --prefix client run build` | Vite production build | 1 | N/A | Clean (0 err) | 0 | 0 | **PASS** |
| **Browser E2E** | `npx playwright test` | Chromium headless E2E | 6 | 9 | 9 | 0 | 0 | **PASS** |
| **Live Backup Test** | `npm --prefix server run db:test-backup` | Native `pg_dump` & `pg_restore` (keyset pagination) | 1 | 1 | 1 | 0 | 0 | **PASS** |
| **Production Backup** | `npm --prefix server run backup:create` | Coordinated snapshot + AES-256-GCM dump | 1 | 1 | 1 | 0 | 0 | **PASS** |
| **Backup Validation** | `npm --prefix server run backup:validate`| Operational health preflight verification | 1 | 1 | 1 | 0 | 0 | **PASS** |
| **Live Preflight Test** | `npm --prefix server run prisma:preflight`| Live DB deep constraint/index check | 1 | 1 | 1 | 0 | 0 | **PASS** |
| **Live E2E 13-Stage Recovery** | `npm --prefix server run test:e2e-recovery` | 13-stage end-to-end recovery test | 1 | 13 | 13 | 0 | 0 | **PASS** |

*Status definitions: `PASS` (executed and passed), `FAIL` (executed and failed), `BLOCKED` (prevented by environment), `NOT RUN` (not executed).*

---

## 2. Server Unit & Integration Test Breakdown (375 Tests across 28 Test Files)

### 1. `tests/auth-refresh.test.ts` (14 tests) — PASS
- Validates secure JWT token refresh rotation, sliding expiration window, replay attack detection, token revocation on reuse, and cookie clearing.

### 2. `tests/auth.test.ts` (6 tests) — PASS
- Validates user registration, login with case-insensitive email/username, password hash verification, duplicate conflict prevention, and profile retrieval.

### 3. `tests/backup-crypto.test.ts` (45 tests) — PASS
- Round-trip file encryption and decryption with SHA-256 byte digest matching.
- Large multi-megabyte binary dumps stream encryption without memory exhaustion.
- Rejection on incorrect passphrase (auth tag verification failure).
- Rejection on corrupted ciphertext bytes (single bit-flip detection).
- Rejection on tampered authentication tag, IV, or Salt.
- Rejection on corrupted or invalid magic header (`CTBK01` and `CTBK02`).
- Rejection on truncated files (< 50 bytes header).
- Rejection on empty or missing passphrase on encryption and decryption.
- Rejection on non-existent input files.
- Header inspection for valid metadata and PBKDF2 iteration verification (600,000 for CTBK02).
- Rejection on identical input and output paths.
- Prevention of destination overwrite (strict fail-closed no-overwrite enforcement, no overwrite option).
- Preservation of pre-existing destination file if decryption fails authentication.
- Atomic publication no-clobber guarantee (`atomicPublishNoClobber`) leveraging hardlink `fs.linkSync` and sibling staging preventing TOCTOU races.
- Strict enforcement of restrictive permissions (`0600` files, `0700` directories) across POSIX and Windows NTFS.
- Safe cleanup of incomplete temporary files upon cryptographic failure.
- Fail-closed publication state transitions: `STAGING_WRITTEN`, `STAGING_VERIFIED`, `RENAME_ATTEMPTED`, `PUBLISHED`, `ROLLBACK_INITIATED`, `ROLLED_BACK`, `POST_PUBLICATION_ROLLBACK_FAILED`.
- Native Windows NTFS ACL security (`icacls.exe`) purging unauthorized explicit ACEs (`Everyone`, `Users`, arbitrary accounts), stripping inheritance, and restricting FullControl to allowlist (`currentUser`, `SYSTEM`, `Administrators`).
- Test 35: Rejection of existing directory with inheritance disabled but explicit unauthorized allow ACE (`Everyone`).
- Test 36: Purging unauthorized existing access entries and applying explicit allowlist on Windows.
- Test 37: Fail-closed `POST_PUBLICATION_ROLLBACK_FAILED` error when post-publication verification fails and rollback unlinking also fails.
- Test 38: Preservation of pre-existing destination file and fail-closed rejection on `EEXIST` destination conflict without unlinking destination.
- Test 39: Fail-closed `PLAINTEXT_STAGING_CLEANUP_FAILED` error when decryption fails and plaintext staging cleanup unlinking fails.
- *(New in this remediation)* Test 40: Newly created output directory receives restrictive permissions during `decryptBackupFile`.
- *(New in this remediation)* Test 41: Safe permissions on pre-existing directory remain unchanged without modification during `decryptBackupFile`.
- *(New in this remediation)* Test 42: Insecure pre-existing output directory is rejected with `INSECURE_DIRECTORY` and not silently modified.
- *(New in this remediation)* Test 43: Surfaces `PLAINTEXT_STAGING_CLEANUP_FAILED` and identifies exact sibling staging path when cleanup fails in cross-volume fallback, preserving published destination.
- *(New in this remediation)* Test 44: Surfaces `PLAINTEXT_STAGING_CLEANUP_FAILED` and preserves original `EEXIST` error when destination exists concurrently and sibling cleanup fails.
- *(New in this remediation)* Test 45: Successfully cleans up both original and sibling staging files during normal cross-volume fallback.

### 4. `tests/backup-production.test.ts` (31 tests) — PASS
- `1. should execute a real production backup, creating encrypted archive and metadata manifest`
- `2. should reject execution when encryption passphrase is missing`
- `3. should correctly prune expired backups according to retention policy`
- `4. should NEVER prune the newest backup, even if older than retention window (last known good guarantee)`
- `5. should strictly ignore unrelated files during retention cleanup`
- `6. should ensure concurrent backups started in the same second produce distinct filenames without collision or overwriting`
- `7. should accurately compute streaming SHA-256 without whole-file reads on empty, small, and large binary files`
- `8. should verify production backup restorability by decrypting and restoring into a disposable database`
- `9. should record VERIFIED restore status in metadata manifest when verifyRestore option is enabled`
- `10. should safely handle retention policy prioritizing the newest successful backup even if failed backups exist`
- `11. should perform restore verification by default on production backups`
- `12. should explicitly record SKIPPED in manifest when verifyRestore is intentionally set to false`
- `13. should fail closed and preserve backup archive for investigation if restore verification fails`
- `14. should treat missing manifests as INVALID and never select them as last known-good backup`
- `15. should treat malformed JSON manifests as INVALID and preserve older valid backups`
- `16. should preserve at least minBackupsToKeep valid backups even if all are older than retention window`
- `17. should pass operational validation with valid database, configuration, and toolchains`
- `18. should fail operational validation when passphrase is missing or too short`
- `19. should fail operational validation when DATABASE_URL is missing or malformed`
- `20. should execute coordinated snapshot backup and verify comprehensive structural restorability`
- `21. should reject unsafe or root output directory path`
- `22. should reject invalid retention days or minBackupsToKeep`
- `23. should detect when target database name matches disposable verification prefix`
- `24. should stage plaintext dumps in dedicated .cinetrack_staging directory with no leftover files`
- `25. should fail closed with CRITICAL_SECURITY_FAILURE if plaintext dump cleanup fails`
- `26. should verify live probe database creation and drop capability in validateBackupEnvironment`
- `27. should reject symlink output directory fail-closed in validateBackupEnvironment`
- `28. should protect non-disposable databases during executeRestoreFromBackup without explicit confirmation`
- *(New in this remediation)* Test 29: Immediate abort on symlink detection in `validateBackupEnvironment` executing zero probe writes, chmods, or deletions.
- *(New in this remediation)* Test 30: Preserves permissions of pre-existing user-owned output directory without silent chmod in `validateBackupEnvironment`.
- *(New in this remediation)* Test 31: Fail-closed `RESTORE_CLEANUP_FAILED` error in `verifyBackupRestorability` with independent PostgreSQL verification if disposable database drop fails.

### 5. `tests/backup-restore-structural.test.ts` (36 tests) — PASS
- Deep catalog verification of all 8 application tables, column types, default expressions, foreign keys with cascade actions, unique indexes, CHECK constraints, and UNIQUE constraints.
- Foreign key integrity verification with zero orphan records across all relations.
- Semantic validation of `CollectionMovie_status_watchedAt_check` rejecting permissive or weakened expressions (`OR TRUE`).
- Comprehensive constraint and index mutation rejection tests.
- *(New in this remediation)* Test 29: Rejection of restored database schema containing unexpected additional CHECK constraints.
- *(New in this remediation)* Test 30: Rejection of restored database schema containing unexpected additional UNIQUE constraints.
- *(New in this remediation)* Test 31: Rejection of standalone unique index masquerading as a required UNIQUE constraint.

### 6. `tests/backup-restore.test.ts` (37 tests) — PASS
- Verifies fail-closed execution, strict immutable host allowlist (`localhost`, `127.0.0.1`, `::1`, `postgres`), strict immutable test database allowlist (`cinetrack_test`, `cinetrack_ci`, `cinetrack_e2e`), live server identity verification (`inet_server_addr()`, `current_database()`), keyset-chunked table hashing (`computeTableChunkedHash`), failure injection, and non-destructive cleanup.
- Verifies preservation of caller-owned custom dump files (`options.customDumpPath`) on disk after both successful and failed verification runs.
- Keyset-paginated hashing with single primary key and composite primary key without OFFSET degradation.
- Repeatable read transaction snapshot consistency across pagination during concurrent writes.

### 7. `tests/backup-snapshot-consistency.test.ts` (5 tests) — PASS
- Verifies export of coordinated PostgreSQL snapshot (`pg_export_snapshot()`) ensuring `sourceStats` row counts, table hashes, and `pg_dump` capture the exact same point-in-time state even under heavy concurrent write operations.

### 8. `tests/case-insensitive-auth.test.ts` (4 tests) — PASS
- Tests case-insensitive uniqueness indexes on User username and email (`LOWER(username)`, `LOWER(email)`), partial unique index on default watchlists, and database-level `CHECK` constraint on watched status and `watchedAt` timestamp.

### 9. `tests/collaboration.test.ts` (2 tests) — PASS
- Tests collection invitation creation, acceptance, decline, member listing, and permission enforcement for collaborators.

### 10. `tests/collections.test.ts` (5 tests) — PASS
- Tests CRUD operations on collections, default watchlist creation, permission checks, duplicate movie prevention, and atomic watch status toggling.

### 11. `tests/concurrency.test.ts` (4 tests) — PASS
- Tests concurrent `MovieService.getOrCreateMovie` calls without unique constraint crash.
- Tests concurrent `CollectionMovieService.addMovie` calls with exactly one success and others `ConflictError`.
- Tests concurrent `getUserDefaultWatchlist` requests without duplicate watchlist creation.
- Tests isolated independent watched statuses across multiple collections for the same movie.

### 12. `tests/cors-validation.test.ts` (19 tests) — PASS
- Validates explicit HTTPS origins, comma-separated lists, and fails closed on HTTP schemes, wildcards, localhost, private IPv4/IPv6 ranges, paths, queries, and hash fragments in production.

### 13. `tests/csrf.test.ts` (16 tests) — PASS
- Validates double-submit cookie pattern, timing-safe equality comparison, method exemption (GET/HEAD/OPTIONS), origin/referer verification in production, and rejection of tampered tokens.

### 14. `tests/db-isolation.test.ts` (18 tests) — PASS
- Validates prevention of `TARGET_DATABASE_URL` override in application database connection resolution.
- Validates strict immutable allowlist of approved test databases (`cinetrack_test`, `cinetrack_ci`, `cinetrack_e2e`) and approved hosts (`localhost`, `127.0.0.1`, `::1`, `postgres`).
- Proves that environment variables cannot expand the immutable allowlist.
- Validates that connected live server identity verification (`inet_server_addr()`, `current_database()`) fails closed on mismatches.
- Validates rejection of production database names in test mode and test database names in production mode.

### 15. `tests/logout-reliability.test.ts` (7 tests) — PASS
- Tests successful logout, database session revocation (`revokedAt = NOW()`), idempotent repeated logout, rejection of revoked tokens, invalid token handling, fail-closed HTTP 500 error propagation on database failure, and cookie clearing.

### 16. `tests/mandatory-session.test.ts` (13 tests) — PASS
- Tests mandatory database session lookup for all protected API requests, session revocation enforcement, and immediate rejection of orphaned JWTs.

### 17. `tests/migration-preflight-states.test.ts` (51 tests) — PASS
- Comprehensive tests for migration preflight engine covering all 4 database states:
  - State A (EMPTY): completely clean, ready for initial migration deploy.
  - State B (VALID): fully initialized canonical schema with clean relational data.
  - State C (PARTIAL): partial application schema missing tables, columns, or migration history, fail closed.
  - State D (INCONSISTENT): schema mismatch, foreign key corruption, duplicate migration rows, altered migration checksums, failed/rolled-back migrations, or orphaned relations.

### 18. `tests/multiRoulette.test.ts` (3 tests) — PASS
- Tests multi-collection roulette selection across multiple watchlists, unwatched item filtering, and weighted random selection.

### 19. `tests/public-privacy.test.ts` (1 test) — PASS
- Tests exclusion of private personal notes, collaborator emails, and internal metadata from public collection responses.

### 20. `tests/roulette-validation.test.ts` (3 tests) — PASS
- Tests input validation, empty collection handling, and parameter bounds for roulette endpoints.

### 21. `tests/roulette.test.ts` (2 tests) — PASS
- Tests single-collection roulette and unwatched item filtering.

### 22. `tests/secrets-validation.test.ts` (12 tests) — PASS
- Validates pairwise distinct secrets in production, minimum 32-character requirement, and rejection of weak/placeholder strings (`replace_with`, `password`, `cinetrack_dev`).

### 23. `tests/security-guards.test.ts` (3 tests) — PASS
- Tests database preflight diagnostics, test environment guards, and production seeding locks.

### 24. `tests/seed-safety.test.ts` (27 tests) — PASS
- Fails closed and strictly forbids database seeding on production database `cinetrack` when `NODE_ENV=production`.
- Fails closed and strictly forbids database seeding on `cinetrack` even when `NODE_ENV=development` and `ALLOW_DEMO_SEED=true`.
- Rejects any database name containing `prod`, `production`, `live`, `main`, or root database `postgres`.
- Rejects seeding in production mode regardless of database name.
- Fails closed when `ALLOW_DEMO_SEED` is unset or false.
- Rejects arbitrary or unapproved databases not in `ALLOWED_SEED_DATABASES`.
- Aborts seeding if any non-demo real user accounts exist (`nonDemoUserCount > 0`).
- Permits seeding on approved development databases (`cinetrack_dev`, `cinetrack_test`, `cinetrack_local`) only when all conditions are satisfied.
- Fails closed when live database connection identity cannot be determined or query fails.
- Fails closed when live server address does not match approved local seed hosts (`localhost`, `127.0.0.1`, `::1`).
- Fails closed when user count query fails (no swallowed exceptions).

### 25. `tests/sharing.test.ts` (2 tests) — PASS
- Tests public collection share link generation, revocation, and unauthenticated read-only access.

### 26. `tests/stats.test.ts` (2 tests) — PASS
- Tests collection-aware dashboard statistics, watched hours calculation, TV episode tracking, and genre distribution calculations.

### 27. `tests/tmdb.test.ts` (3 tests) — PASS
- Tests movie search, TV search, details retrieval, caching, rate limiting, and fallback behavior.

### 28. `tests/unit/utils.test.ts` (10 tests) — PASS
- Tests Argon2id password hashing, verification, invalid hash handling, JWT creation, JWT verification, and response helpers.

---

## 3. Frontend End-to-End Test Breakdown (9 Tests across 6 Files)

All Playwright tests executed against the live application with real Vite client and Express server on Chromium.

| Spec File | Test Case | Duration | Status |
|---|---|---|---|
| `e2e/auth-and-watchlist.spec.ts` | Register, search TMDb, add movie to watchlist, and toggle watch status | 3.8s | **PASS** |
| `e2e/collaboration-and-sharing.spec.ts` | Public collection sharing and multi-user collaboration end-to-end | 7.2s | **PASS** |
| `e2e/collection-stats-and-tv.spec.ts` | Search and add TV series, aggregate dashboard statistics, multi-collection roulette | 4.5s | **PASS** |
| `e2e/collections-and-roulette.spec.ts` | Create custom collection, add movie, spin roulette, and move movie | 4.1s | **PASS** |
| `e2e/mobile-layout.spec.ts` | Responsive mobile experience: layout and navigation drawer | 1.0s | **PASS** |
| `e2e/state-sync-and-theme.spec.ts` | Part 1 & 2: Modal close button, dismissal, and instantaneous watched/unwatched sync | 3.5s | **PASS** |
| `e2e/state-sync-and-theme.spec.ts` | Part 3: Pick for Us "All Collections" semantics, custom checkboxes, dropdown outside click | 2.4s | **PASS** |
| `e2e/state-sync-and-theme.spec.ts` | Part 6: Theme system toggle and persistence (Dark/Light) | 1.7s | **PASS** |
| `e2e/state-sync-and-theme.spec.ts` | Part 5: Mobile-first responsive layouts across 320px, 375px, 390px, 430px | 11.8s | **PASS** |

---

## 4. Overall Verification Outcome

```
================================================================================
  CineTrack Production Readiness Verification Result: 100% SUCCESS
================================================================================
  Total Backend Vitest Tests:       381 PASSED (0 failed, 0 skipped, 28 files)
  Total Frontend Playwright Tests:    9 PASSED (0 failed, 0 skipped, 6 files)
  Database Migration Preflight:     PASS [State: VALID]
  Database Backup & Restore:        PASS [100% Keyset-Paginated Match]
  Server TypeScript Check:          PASS [0 errors]
  Client TypeScript Check:          PASS [0 errors]
  Client ESLint Check:              PASS [0 errors]
  Server Production Build:          PASS [Clean build including scripts]
  Client Production Build:          PASS [Clean build]
  E2E 13-Stage Recovery Test:       PASS [13/13 stages validated]
================================================================================
```
