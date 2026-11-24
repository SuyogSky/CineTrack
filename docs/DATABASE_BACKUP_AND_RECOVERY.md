# CineTrack — Database Backup, Disaster Recovery & Restoration Runbook

**Project**: CineTrack  
**Target Database**: PostgreSQL 18.6+  
**Classification**: Mission-Critical Production Runbook  

---

## 1. Overview & Disaster Recovery Objectives

CineTrack stores irreplaceable user data: accounts, hashed credentials, custom collections, watched/unwatched history, personal film notes, and multi-user collaboration mappings. 

This runbook outlines the production database backup strategy, offsite encrypted archiving, disaster recovery objectives, and step-by-step restoration procedures.

### Key Metrics
- **RPO (Recovery Point Objective)**: **< 24 Hours** (Daily full snapshots; optional point-in-time recovery via WAL archiving).
- **RTO (Recovery Time Objective)**: **< 15 Minutes** (Full database restoration and service resumption from warm binary dump).

---

## 2. Production Backup Strategy

### 2.1 Native PostgreSQL Custom-Format Dumps (`pg_dump -F c`)
CineTrack utilizes native PostgreSQL custom-format (`-F c`) binary dumps. Benefits include:
- Native zlib compression (reducing dump size by 70–80%).
- Schema and data flexibility (selective table restoration, schema-first or data-first loading).
- Strict integrity verification before restore execution.

### 2.2 Backup Retention Policy
Production environments must enforce the GFS (Grandfather-Father-Son) retention model:
- **Daily Snapshots**: Retained for **7 days**.
- **Weekly Snapshots**: Captured every Sunday; retained for **4 weeks**.
- **Monthly Snapshots**: Captured on the 1st of each month; retained for **12 months**.

---

## 3. Native Authenticated Backup Encryption (AES-256-GCM + PBKDF2)

CineTrack incorporates an authenticated backup encryption engine implemented in [backup_crypto.ts](file:///c:/Users/Administrator/Desktop/Projects/CineTrack/server/src/utils/backup_crypto.ts).

### 3.1 Cryptographic Architecture
- **Algorithm**: Authenticated AES-256-GCM (Galois/Counter Mode).
- **Key Derivation Function (KDF)**: PBKDF2-HMAC-SHA256 with **600,000 iterations** (OWASP recommendation) for current format `CTBK02`, with backward-compatible support for legacy format `CTBK01` (100,000 iterations). Key derivation utilizes a 16-byte cryptographically secure pseudorandom salt (`crypto.randomBytes(16)`).
- **Initialization Vector (IV)**: 12-byte cryptographically secure random IV generated per backup snapshot.
- **Authentication Tag**: 16-byte GCM authentication tag.
- **Binary Header Format**:
  - `Offset 0..6` (6 bytes): Magic ASCII header identifier `CTBK02` (or `CTBK01` for legacy).
  - `Offset 6..22` (16 bytes): Random PBKDF2 salt.
  - `Offset 22..34` (12 bytes): Unique AES-GCM IV.
  - `Offset 34..50` (16 bytes): AES-GCM authentication tag.
  - `Offset 50..EOF` (N bytes): Authenticated ciphertext stream.

### 3.2 Security Guarantees
- **Data Confidentiality**: 256-bit symmetric encryption protects all schema and relational user data at rest.
- **Tamper Evidence**: Any bit-flip or modification of either the ciphertext, the IV, the salt, or the authentication tag causes the cryptographic decipher engine to fail closed immediately (`authentication tag verification failed`).
- **Passphrase Verification**: Supplying an incorrect passphrase immediately fails tag verification, preventing corrupted or incomplete plaintext from ever being written to disk.

---

## 4. Automated Production Backup Workflow

Production backups are executed via CineTrack's production backup orchestrator (`server/scripts/backup_production.ts`), which completely eliminates manual, unencrypted intermediate plaintext dumps on disk.

```bash
# Execute production backup with coordinated transaction snapshot, authenticated encryption (CTBK02),
# automated disposable restore verification, and retention policy enforcement:
npm --prefix server run backup:create
```

For scheduled cron execution, use the following production wrapper:

```bash
#!/usr/bin/env bash
set -euo pipefail

# CineTrack Automated Backup Job
export NODE_ENV="production"
export DATABASE_URL="postgresql://cinetrack_user:SECURE_PASSWORD@localhost:5432/cinetrack"
export BACKUP_ENCRYPTION_KEY="YOUR_SECURE_PASSPHRASE_MIN_16_CHARS"
export BACKUP_OUTPUT_DIR="/var/backups/cinetrack"
export BACKUP_RETENTION_DAYS="30"
export BACKUP_MIN_KEEP="3"
export BACKUP_VERIFY_RESTORE="true"

cd /opt/cinetrack
node server/dist/scripts/backup_production.js --action=backup

echo "☁️ [$(date)] Syncing encrypted archives to offsite object storage..."
aws s3 sync /var/backups/cinetrack s3://cinetrack-backups-secure/daily/ \
  --exclude "*" --include "*.dump.enc" --include "*.meta.json"
```

---

## 5. Disaster Recovery & Restoration Procedures

### 5.1 CLI Restoration Runbook (Production Disaster Recovery)

When recovering an environment or restoring from a snapshot into a new server:

```bash
# Step 1: Download the encrypted snapshot and companion manifest from offsite storage
aws s3 cp s3://cinetrack-backups-secure/daily/cinetrack_20261124_083000_a1b2c3d4.dump.enc ./restore.dump.enc
aws s3 cp s3://cinetrack-backups-secure/daily/cinetrack_20261124_083000_a1b2c3d4.dump.enc.meta.json ./restore.dump.enc.meta.json

# Step 2: Restore snapshot into target database with cryptographic authenticity verification,
# safe staging permissions, and pre-restore database safeguards:
export BACKUP_ENCRYPTION_KEY="YOUR_SECURE_PASSPHRASE_MIN_16_CHARS"
node server/dist/scripts/backup_production.js \
  --action=restore \
  --backup=./restore.dump.enc \
  --target-db="postgresql://cinetrack_user:SECURE_PASSWORD@localhost:5432/cinetrack" \
  --confirm-target-db="cinetrack"
```

# Step 3: Create a fresh target recovery database (Non-Destructive Best Practice)
# Rather than dropping your existing database in place, restore to a fresh database first:
psql -U postgres -h localhost -c "CREATE DATABASE cinetrack_recovery OWNER cinetrack;"

# Step 4: Execute pg_restore into the recovery database
pg_restore \
  -h localhost \
  -p 5432 \
  -U cinetrack \
  -d cinetrack_recovery \
  -v \
  ./restore.dump

# Step 5: Clean up decrypted dump from local disk
rm -f ./restore.dump ./restore.dump.enc

# Step 6: Validate migration preflight against recovered database
cd /var/www/cinetrack/server
TARGET_DATABASE_URL="postgresql://cinetrack:password@localhost:5432/cinetrack_recovery?schema=public" npm run prisma:preflight

# Step 7: Atomic Promotion or Configuration Switch
# Option A: Switch connection string in server/.env to point to cinetrack_recovery and restart:
# DATABASE_URL="postgresql://cinetrack:password@localhost:5432/cinetrack_recovery?schema=public"
# systemctl restart cinetrack
#
# Option B: Atomic database rename during scheduled maintenance:
# psql -U postgres -h localhost -c "ALTER DATABASE cinetrack RENAME TO cinetrack_corrupted_backup;"
# psql -U postgres -h localhost -c "ALTER DATABASE cinetrack_recovery RENAME TO cinetrack;"
# systemctl restart cinetrack
```

---

## 6. Key Rotation Runbook for Encrypted Backups

When rotating the backup encryption key (`BACKUP_ENCRYPTION_KEY`):

1. **Generate New Key**: Generate a new high-entropy passphrase (minimum 32 characters with alphanumeric and special characters).
2. **Re-encrypt Existing Archives**: Run the re-encryption pipeline to re-wrap stored snapshots:
   ```bash
   # Download old snapshot
   aws s3 cp s3://cinetrack-backups-secure/daily/snapshot.dump.enc ./snapshot.dump.enc
   
   # Decrypt with OLD key
   node -e "
     const { decryptBackupFile, encryptBackupFile } = require('./server/dist/utils/backup_crypto');
     decryptBackupFile('./snapshot.dump.enc', './temp.dump', process.env.OLD_BACKUP_KEY)
       .then(() => encryptBackupFile('./temp.dump', './snapshot_new.dump.enc', process.env.NEW_BACKUP_KEY))
       .then(() => console.log('✅ Re-encryption successful.'))
       .catch(console.error);
   "
   
   # Upload new snapshot
   aws s3 cp ./snapshot_new.dump.enc s3://cinetrack-backups-secure/daily/snapshot.dump.enc
   rm -f ./snapshot.dump.enc ./temp.dump ./snapshot_new.dump.enc
   ```
3. **Update Server Secrets**: Update `BACKUP_ENCRYPTION_KEY` in production secrets manager (AWS Secrets Manager, GCP Secret Manager, or HashiCorp Vault).

---

## 7. Non-Destructive Automated Backup & Restore Verification

CineTrack provides an automated, non-destructive verification tool ([test_backup_restore.ts](file:///c:/Users/Administrator/Desktop/Projects/CineTrack/server/scripts/test_backup_restore.ts)) to prove backup and restore integrity without risking production data.

### 7.1 Verification Workflow

```mermaid
flowchart TD
    A["Dedicated Source Test DB<br>(BACKUP_TEST_SOURCE_URL)"] --> B["Validate Database Name & Host<br>(assertApprovedHost)"]
    B --> C["Verify Live Connection Identity<br>(current_database(), current_user)"]
    C --> D["Execute pg_dump -F c<br>(Generate binary snapshot)"]
    D --> E["Create Disposable Restore DB<br>(cinetrack_restore_*)"]
    E --> F["Execute pg_restore<br>(Load snapshot)"]
    F --> G["Deep Bidirectional Comparison<br>(Tables, Columns, Constraints, Indexes, Enums, SHA-256 Data)"]
    G --> H["Relational Usability Query<br>(Smoke test query engine)"]
    H --> I["Guaranteed Cleanup<br>(Drop temp DB & unlink dump file)"]
```

### 7.2 Deep Catalog Comparison Vectors

The verification script inspects and validates the following PostgreSQL catalogs bidirectionally between source and restored database:
1. **Tables**: Exact match across all 8 tables (`User`, `Collection`, `Movie`, `CollectionMovie`, `CollectionMember`, `CollaborationInvitation`, `Session`, `_prisma_migrations`).
2. **Columns**: Compares all 73 columns for name, data type, nullability (`is_nullable`), and default value expressions.
3. **Constraints**: Compares 69 primary keys, foreign keys (referencing tables, cascade delete/update actions), unique constraints, and check constraints (including the `CollectionMovie_status_watchedAt_check` status consistency constraint).
4. **Indexes**: Compares 35 B-tree, partial unique, and lower-cased unique indexes (`indexname` and `indexdef`).
5. **Enums**: Compares all 12 enum labels across `CollectionVisibility`, `MediaType`, `WatchStatus`, `MemberRole`, and `InvitationStatus`.
6. **Data Integrity (True Keyset Pagination)**: Compares row counts and computes deterministic SHA-256 table hashes using dynamic primary key discovery and composite row-value comparison `(pk1, pk2) > ($1, $2)` in a `REPEATABLE READ READ ONLY` transaction snapshot (chunk size = 500 rows) with streaming incremental hashing in Node.js, completely eliminating `OFFSET` and memory exhaustion:
   ```sql
   -- Single PK Keyset Query:
   SELECT "id", encode(sha256(to_jsonb(t)::text::bytea), 'hex') AS row_hash
   FROM (
     SELECT * FROM "tableName"
     WHERE "id" > $1
     ORDER BY "id" ASC
     LIMIT $2
   ) t;

   -- Composite PK Keyset Query:
   SELECT "pk1", "pk2", encode(sha256(to_jsonb(t)::text::bytea), 'hex') AS row_hash
   FROM (
     SELECT * FROM "tableName"
     WHERE ("pk1", "pk2") > ($1, $2)
     ORDER BY "pk1" ASC, "pk2" ASC
     LIMIT $3
   ) t;
   ```

### 7.3 Custom Dump Path Preservation
When `options.customDumpPath` is provided to `runBackupRestoreVerification`, the verification engine treats the dump file as caller-owned:
- It will NOT delete the custom dump file during verification or cleanup.
- It only deletes temporary dump files generated internally by the test runner itself (`isGeneratedDump = !options.customDumpPath`).

### 7.4 Executing Verification Locally or in CI

```bash
# 1. Run automated verification suite
npm --prefix server run db:test-backup
```

---

## 8. Automated Production Backup Strategy (`backup_production.ts`)

CineTrack includes a dedicated production backup orchestration engine implemented in [backup_production.ts](file:///c:/Users/Administrator/Desktop/Projects/CineTrack/server/scripts/backup_production.ts):

### 8.1 Execution Scripts
- **On-Demand Snapshot**: `npm --prefix server run backup:create`
- **Automated Retention Worker**: `npm --prefix server run backup:worker`
- **Operational Health Validation**: `npm --prefix server run backup:validate`

### 8.2 Production Safeguards
1. **Coordinated PostgreSQL Exported Snapshot (`Fix 1`)**:
   - Rather than taking source table statistics and dumps in separate uncoordinated operations, CineTrack establishes a single `REPEATABLE READ READ ONLY` transaction in PostgreSQL:
     ```sql
     BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
     SELECT pg_export_snapshot() AS snapshot_id;
     ```
   - Passes `--snapshot=${snapshotId}` directly to `pg_dump`, guaranteeing that the binary dump and source statistics (row counts and keyset-chunked deterministic SHA-256 table hashes) capture the exact same snapshot in time.
   - Eliminates false-positive hash and row-count mismatches caused by concurrent background writes during backup generation.
2. **Comprehensive Database Structure Verification (`Fix 2`)**:
   - After restoring the encrypted snapshot into a disposable verification database (`cinetrack_restore_verify_*`), the backup orchestrator performs deep structural and referential verification before certifying the backup as `VERIFIED`:
     - **All 8 Tables Verified**: `User`, `Movie`, `Collection`, `CollectionMovie`, `CollectionMember`, `CollaborationInvitation`, `Session`, `_prisma_migrations`.
     - **Columns**: Verifies column names, PostgreSQL data types, nullability, and default expressions, rejecting unexpected schema drift or extra columns.
     - **Primary Keys**: Enforces primary key constraints on all 8 tables.
     - **Foreign Keys**: Enforces all 10 foreign key relationships with `delete_action = 'c'` (CASCADE), `update_action = 'c'` (CASCADE), `condeferrable = false` (IMMEDIATE), and `convalidated = true`.
     - **Referential Integrity (Zero Orphans)**: Executes query checks across all 10 foreign key relationships, proving zero orphaned records exist in the restored dataset.
     - **Check Constraints**: Verifies the canonical semantic definition of `CollectionMovie_status_watchedAt_check` ensuring `((status = 'WATCHED' AND watchedAt IS NOT NULL) OR (status = 'TO_WATCH' AND watchedAt IS NULL))`.
     - **Unique Indexes**: Verifies all 9 unique indexes are valid (`indisvalid = true`), ready (`indisready = true`), use `btree`, and possess the exact required column lists in strict order.
3. **Collision-Resistant Naming**: Formats archive names as `cinetrack_<TIMESTAMP>_<RANDOM_HEX>[.pre_migration].dump.enc` using `crypto.randomBytes(4).toString('hex')`, preventing collisions between concurrent backup jobs or backups taken within the same second.
4. **Mandatory Authenticated Encryption**: Backups are encrypted with AES-256-GCM + PBKDF2 (600,000 iterations for `CTBK02`, with backward compatibility for `CTBK01` 100k). Fails closed immediately if `BACKUP_ENCRYPTION_PASSPHRASE` (or `BACKUP_ENCRYPTION_KEY`) is not set.
5. **Atomic No-Clobber Staging & Strict No Overwrite (`Fix 5 & Fix 6`)**:
   - `encryptBackupFile` and `decryptBackupFile` strictly reject overwriting existing destination files; any destination that already exists causes an immediate fail-closed error.
   - `atomicPublishNoClobber()` writes to a staging file with restrictive `0600` permissions and calls `fs.fsyncSync()` before publication.
   - Leverages atomic hardlinking (`fs.linkSync(staging, final)`) which fails atomically with `EEXIST` if the final destination file already exists.
   - If a cross-device boundary (`EXDEV`) is encountered, creates a sibling staging file in the target directory, syncs to disk, and publishes atomically. The final destination file is never left in a partial, corrupted, or truncated state.
6. **Restrictive File and Directory Modes**: Temporary plaintext dumps and final encrypted backups enforce `0600` permissions (`setRestrictiveFileMode`), while backup output directories enforce `0700` (`setRestrictiveDirMode`) to prevent unauthorized local reading.
7. **Streaming Bounded SHA-256**: Checksums are computed using Node.js streaming I/O (`calculateFileSha256`) with a 64KB highWaterMark, completely eliminating `fs.readFileSync` whole-file memory exhaustion.
8. **Restore Verification by Default**: Automated backups enable restore verification by default (`verifyRestore: true`). Can only be disabled explicitly via `--no-verify-restore`, `--skip-verify-restore`, or `BACKUP_VERIFY_RESTORE=false`. Decrypts the archive, restores into a disposable test database (`cinetrack_restore_verify_*`), validates all 8 application tables, primary keys, foreign keys with CASCADE, partial unique indexes, check constraints (`CollectionMovie_status_watchedAt_check`), referential integrity (zero orphaned records), and verifies row counts and deterministic table hashes against pre-backup source stats.
9. **Structured Manifests (`.meta.json`)**: Every archive produces a metadata companion recording database identity, streaming SHA-256 checksums, durations, archive status (`SUCCESS` or `FAILED`), and restorability verification records (`VERIFIED`, `SKIPPED`, or `FAILED`). Missing or malformed manifests are treated as `INVALID`.
10. **Retention with Last-Known-Good & Minimum Keep Protection**:
    - `applyBackupRetention` treats missing or malformed `.meta.json` manifests as `INVALID` and never selects them as the newest valid backup.
    - **Last Known Good Guarantee**: NEVER prunes the newest valid backup, even if older than the retention period.
    - **Minimum Keep Guarantee**: Preserves at least `minBackupsToKeep` (default: 3) valid backups regardless of age.
11. **Operational Health Validation (`--validate` / `Fix 8`)**:
    - Executes comprehensive validation via `npm --prefix server run backup:validate`:
      - Validates presence and non-emptiness of `DATABASE_URL` and `BACKUP_ENCRYPTION_PASSPHRASE`.
      - Validates output directory write, read, and `0700` permission configuration.
      - Connects to PostgreSQL, introspects live identity, and proves snapshot export capability (`SELECT pg_export_snapshot()`).
      - Validates presence and version compatibility of native tools (`pg_dump` and `pg_restore` v18+).
      - Returns exit code `0` on success and `1` on failure with detailed diagnostic JSON.
12. **Operational Scripts Compilation**: A dedicated TypeScript configuration (`tsconfig.scripts.json`) and build target (`npm run build:scripts`) compiles `server/scripts/backup_production.ts` to `server/dist/scripts/backup_production.js`, ensuring the systemd backup unit succeeds without missing-file errors.
13. **Webhook Alerts**: Optional `BACKUP_NOTIFICATION_WEBHOOK` posts JSON notifications on backup success or failure.

### 8.3 Systemd Service & Timer Configuration

CineTrack provides production systemd units in `deployment/systemd/`:
- [cinetrack-backup.service](file:///c:/Users/Administrator/Desktop/Projects/CineTrack/deployment/systemd/cinetrack-backup.service) (Configured with `--verify-restore` and `Environment=BACKUP_VERIFY_RESTORE=true`)
- [cinetrack-backup.timer](file:///c:/Users/Administrator/Desktop/Projects/CineTrack/deployment/systemd/cinetrack-backup.timer) (Daily 03:00 UTC schedule)

---

## 9. Production Safety Safeguards in Test Runners & Seed Scripts

1. **No URL Fallbacks**: `server/scripts/test_backup_restore.ts` will **never** fall back to `DATABASE_URL` or `TEST_DATABASE_URL`. It requires explicit CLI arguments or `BACKUP_TEST_SOURCE_URL`.
2. **Immutable Test Host & Database Allowlists**: 
   - Approved test hosts: strictly limited to `localhost`, `127.0.0.1`, `::1`, `postgres`, `host.docker.internal`.
   - Approved test databases: strictly limited to `cinetrack_test`, `cinetrack_ci`, `cinetrack_e2e`.
   - Environment variables cannot expand these strict allowlists.
   - Broad prefixes (e.g. `cinetrack_production_test`, `contest`) are strictly rejected.
3. **Fail-Closed Live Socket Identity Verification**: Connections strictly verify `current_database()` and `inet_server_addr()` across source, admin, and restored connections without conditional skipping. Distinguishes local Unix domain sockets from TCP safely, and fails closed if socket identity cannot be verified or server address mismatches.
4. **Process-Owned Disposable Database Tracking**: The test runner strictly tracks the exact disposable database created by the running process (`processOwnedRestoreDatabase`), guaranteeing that cleanup can only drop the database created by that specific test execution.
5. **Guaranteed Cleanup**: Temporary database dropping and dump file deletion are wrapped in structured `try/finally` blocks. Active connections to the temporary restore database are terminated prior to dropping.
6. **Fail-Closed Seed Safety Assertion (`assertSeedAllowed` / `Fix 7`)**: Database seeding (`server/prisma/seed.ts`):
   - Queries PostgreSQL live connection identity: `SELECT current_database(), current_user, inet_server_addr(), inet_server_port();`. Fails closed immediately if query fails or returns empty rows (no fallback to configured database URL).
   - Validates live server address against `DEFAULT_ALLOWED_SEED_HOSTS` (`['localhost', '127.0.0.1', '::1']`), strictly preventing execution against remote host environments.
   - Strictly forbids seeding on production databases (`cinetrack`, `prod`, `production`, `live`, `main`, `postgres`) regardless of `NODE_ENV`.
   - Strictly forbids seeding when `NODE_ENV === 'production'`.
   - Requires explicit opt-in `ALLOW_DEMO_SEED=true`.
   - Limits target databases strictly to `ALLOWED_SEED_DATABASES` (`['cinetrack_dev', 'cinetrack_test', 'cinetrack_local']`).
   - Aborts seeding if any non-demo real user accounts exist (failing closed immediately if the user count query fails).
