# CineTrack — Data Integrity, Relational Architecture & Migration Strategy

**Project**: CineTrack  
**Database**: PostgreSQL 18.6+  
**ORM**: Prisma 7.10.1 (`@prisma/adapter-pg`)  
**Architecture**: Relational Database as Primary Source of Truth  

---

## 1. Principles of Data Integrity

In CineTrack, application code is considered an unreliable guardian of data consistency. Concurrency races, horizontal scaling, parallel web workers, and network delays mean that application-level validations can and will be bypassed.

Therefore, **PostgreSQL is the authoritative source of truth for all business rules, relational guarantees, and uniqueness constraints.**

```
┌────────────────────────────────────────────────────────┐
│                   CineTrack Frontend                   │
│   (Client-side UX validations, optimistic mutations)   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│                   Express 5 Backend                    │
│      (Zod request schemas, route-level checks)         │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│               PostgreSQL 18 Database Engine            │
│   • Case-insensitive unique indexes: LOWER(email)      │
│   • Partial unique indexes: 1 default watchlist/user   │
│   • Compound uniqueness: (tmdbId, mediaType)           │
│   • Foreign key cascading constraints & delete rules   │
│   • ACID Transactions with row-level locks             │
└────────────────────────────────────────────────────────┘
```

---

## 2. Relational Uniqueness & Constraint Architecture

### 2.1 Case-Insensitive User Authentication (`LOWER(username)`, `LOWER(email)`)

Application-level `.toLowerCase()` transforms can be bypassed by direct database queries, script migrations, or concurrent registrations.

PostgreSQL enforces uniqueness at the storage layer via functional indexes:
```sql
CREATE UNIQUE INDEX "User_username_lower_key" ON "User"(LOWER("username"));
CREATE UNIQUE INDEX "User_email_lower_key" ON "User"(LOWER("email"));
```
This guarantees that registering `JohnDoe` when `johndoe` already exists fails with a native PostgreSQL unique constraint violation (`23505`), preventing duplicate user impersonation.

### 2.2 Exactly One Default Watchlist per User (Partial Unique Index)

Every user has exactly one master default watchlist. Having zero or more than one breaks application invariants.

PostgreSQL guarantees this rule via a partial unique index:
```sql
CREATE UNIQUE INDEX "Collection_owner_default_watchlist_key" 
ON "Collection"("ownerId") 
WHERE "isDefaultWatchlist" = true;
```
Any attempt (accidental or concurrent) to set `isDefaultWatchlist = true` on a second collection for the same user is rejected instantly at the database layer.

### 2.3 Collision-Free Movie & TV Series Identity `(tmdbId, mediaType)`

TMDb assigns integer IDs that can collide between movies and TV series (for example, TMDb ID `550` could represent both a feature film and a documentary series).

CineTrack enforces media uniqueness using a compound index:
```sql
CREATE UNIQUE INDEX "Movie_tmdbId_mediaType_key" ON "Movie"("tmdbId", "mediaType");
```
When querying or inserting cached media, the service always pairs `tmdbId` with `mediaType` (`MOVIE` or `TV`).

### 2.4 Duplicate Media Prevention per Collection

A movie or TV series can only appear once within any given collection.

```sql
CREATE UNIQUE INDEX "CollectionMovie_collectionId_movieId_key" 
ON "CollectionMovie"("collectionId", "movieId");
```

### 2.5 Relational Foreign Keys & Cascading Rules

All child tables reference parent records using PostgreSQL foreign key constraints with `ON DELETE CASCADE ON UPDATE CASCADE`:
- `Collection.ownerId` -> `User.id`
- `CollectionMovie.collectionId` -> `Collection.id`
- `CollectionMovie.movieId` -> `Movie.id`
- `CollectionMovie.addedBy` -> `User.id`
- `CollectionMember.collectionId` -> `Collection.id`
- `CollectionMember.userId` -> `User.id`
- `CollaborationInvitation.collectionId` -> `Collection.id`
- `Session.userId` -> `User.id`

Orphaned records are structurally impossible.

### 2.6 Watched Status and Timestamp Consistency (PostgreSQL CHECK Constraint)

To eliminate status desynchronization between `CollectionMovie.status` and `CollectionMovie.watchedAt`, PostgreSQL enforces a table-level `CHECK` constraint:

```sql
CONSTRAINT "CollectionMovie_status_watchedAt_check" CHECK (
  ("status" = 'WATCHED' AND "watchedAt" IS NOT NULL) OR 
  ("status" = 'TO_WATCH' AND "watchedAt" IS NULL)
);
```

This constraint guarantees:
1. Setting `status = 'WATCHED'` strictly requires a valid timestamp in `watchedAt`.
2. Setting `status = 'TO_WATCH'` strictly requires `watchedAt IS NULL`.
3. Any violating write or update is rejected immediately at the storage engine with error code `23514` (`check_violation`), preventing application race conditions or incomplete update queries from storing inconsistent state.

---

## 3. Transactional Multi-Step Operations (`prisma.$transaction`)

Multi-step database updates are wrapped in ACID transactions to ensure atomic commits or full rollbacks on failure:

1. **User Registration**:
   - Creates the `User` record with Argon2id password hash.
   - Automatically initializes the user's master default watchlist (`isDefaultWatchlist: true`).
   - If watchlist creation fails, the user record is rolled back.

2. **Moving Media Between Collections**:
   - Validates user permissions on both source and destination collections.
   - Checks destination for duplicate entry.
   - Atomically creates `CollectionMovie` in destination and deletes it from source.

3. **Refresh Token Rotation & Reuse Detection**:
   - Queries session using row-level locks (`SELECT ... FOR UPDATE`).
   - Checks incoming refresh token against `tokenHash`, `previousTokenHash`, and `historicalTokenHashes`.
   - Rotates hashes or revokes the entire token family if reuse is detected.

4. **Collaboration Lifecycle**:
   - Accepting an invitation updates `CollaborationInvitation` status to `ACCEPTED` and atomically inserts a `CollectionMember` record with role `MEMBER`.

---

## 4. Migration Preflight 4-State Machine (`scripts/migration_preflight.ts`)

Before deploying Prisma migrations in CI or production, CineTrack executes a preflight diagnostic script to classify the target database into one of four deterministic states:

```mermaid
stateDiagram-v2
    [*] --> EMPTY: 0 Tables & 0 Views & 0 Matviews & 0 Sequences & 0 Types & 0 Routines
    [*] --> VALID: 7 App Tables + Clean Migrations + 0 Column Drift + 0 Defaults Drift
    [*] --> PARTIAL: 1-6 Tables OR Missing Migrations OR Column/Default Drift
    [*] --> INCONSISTENT: Unrelated Tables OR Leftover Objects OR Migration Inconsistency OR Data Conflict

    EMPTY --> Ready: Deploy Initial Migrations
    VALID --> Ready: Deploy Pending Migrations / Boot App
    PARTIAL --> Halted: Abort! Run Targeted Remediation
    INCONSISTENT --> Halted: Abort! Resolve Schema/Data Conflicts
```

### Diagnostic States

| State | Condition | Preflight Action | Production Action |
|---|---|---|---|
| **`EMPTY`** | 0 tables, 0 views, 0 materialized views, 0 sequences, 0 custom types, and 0 routines in `public` schema | `success: true` | Safe for fresh deployment (`prisma migrate deploy`) |
| **`VALID`** | All 7 tables exist, all disk migrations applied in `_prisma_migrations`, all columns, types, defaults, and enums match canonical schema, deep constraint specifications (primary keys, foreign columns, CASCADE update and delete actions, non-deferrable, validated status) match, strict canonical check constraint parser validation passes, all indexes (valid, ready, unique, access method `btree`, exact required column names and strict column ordering, exact partial predicate `("isDefaultWatchlist" = true)`) match, 0 data conflicts | `success: true` | Safe to start server or deploy newly appended migrations |
| **`PARTIAL`** | 1 to 6 tables exist, or `_prisma_migrations` is missing, or failed migrations exist, or column types/defaults drift or extra unexpected columns exist | `success: false` (Fail Closed) | **Halt deployment.** Requires manual schema inspection or roll-forward repair |
| **`INCONSISTENT`** | Leftover views/matviews/sequences/routines in empty database, unrelated tables exist, migration history exists with 0 tables, unknown migrations exist, index column name or column ordering mismatch, missing or wrong partial index predicates (e.g. inverted `isDefaultWatchlist = false`), invalid/not-ready indexes (`indisvalid = false`), index access method mismatch (e.g. `hash` instead of `btree`), foreign key action mismatches (e.g. `NO ACTION` instead of `CASCADE` on delete or update), foreign key columns mismatch, primary key columns mismatch, invalid check constraint definitions, or data integrity checks fail (duplicate lower-case emails, multiple default watchlists, orphans) | `success: false` (Fail Closed) | **Halt deployment.** Target database contains conflicting data or schema contamination |

### 4.1 Index Column Names & Strict Ordering (`Fix 3`)

Preflight defines exact expected columns for all 9 required unique and functional indexes in `requiredIndexes`. The runner:
- Introspects `pg_attribute` via `pg_index.indkey` to extract the exact list and order of indexed columns.
- Enforces an exact match between `expectedColumns` and `actual.indexed_columns`. Any missing columns, extra columns, or inverted column ordering (e.g., `["mediaType", "tmdbId"]` instead of `["tmdbId", "mediaType"]`) causes preflight to fail closed immediately under State D (`INCONSISTENT`).
- Rejects any rule definition missing `expectedColumns`, preventing unverified indexes.

### 4.2 Strict Check Constraint Parser (`Fix 4`)

To guarantee that the watched status constraint cannot be bypassed by permissive expressions or logical inversions (such as `OR TRUE` or inverted `IS NULL` checks), `validateWatchedStatusCheckConstraint` employs a dedicated deterministic parser:
- Normalizes PostgreSQL typecasts (`::"WatchStatus"`, `::character varying`) and redundant whitespace.
- Strictly parses the canonical disjunctive form:
  $$\left(\text{status} = \text{'WATCHED'} \land \text{watchedAt IS NOT NULL}\right) \lor \left(\text{status} = \text{'TO\_WATCH'} \land \text{watchedAt IS NULL}\right)$$
- Rejects tautologies (`OR TRUE`, `OR 1=1`), permissive clauses, swapped operators, or missing status branches.

### Running Migration Preflight

```bash
# Run against default or target database
TARGET_DATABASE_URL="postgresql://cinetrack:password@localhost:5432/cinetrack" \
  npm --prefix server run prisma:preflight
```

### Zero-Downtime Migration Guidelines

1. **Additive Changes First**: Add new nullable columns or default values before updating application code.
2. **Backfill & Dual-Write**: Backfill data while the application runs.
3. **Add Constraints**: Add non-null or unique constraints once backfills are complete.
4. **Remove Unused**: Drop columns only after new code has completely ceased referencing them.
