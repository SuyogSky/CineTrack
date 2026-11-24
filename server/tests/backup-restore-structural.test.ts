import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import {
  executeProductionBackup,
  verifyBackupRestorability,
  auditRestoredDatabaseSchema,
} from '../scripts/backup_production';
import { parsePostgresUrl } from '../scripts/test_backup_restore';
import { CINETRACK_SCHEMA_MANIFEST } from '../scripts/schema_manifest';
import { setRestrictiveDirMode } from '../src/utils/backup_crypto';

describe('Priority 1: Comprehensive Structural Schema Verification & Corruption Tests', { timeout: 120000 }, () => {
  const testBackupDir = path.resolve(__dirname, 'temp_structural_backups');
  const testDbUrl =
    process.env.BACKUP_TEST_SOURCE_URL ||
    process.env.TEST_DATABASE_URL ||
    'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public';
  const passphrase = 'StructuralVerificationKey2026!';
  let validBackupPath: string;
  let testClient: Client;
  const ALL_EXPECTED_TABLES = Object.keys(CINETRACK_SCHEMA_MANIFEST.tables);

  beforeAll(async () => {
    const conn = parsePostgresUrl(testDbUrl);
    testClient = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl: conn.ssl,
    });
    await testClient.connect();

    if (!fs.existsSync(testBackupDir)) {
      fs.mkdirSync(testBackupDir, { recursive: true, mode: 0o700 });
      setRestrictiveDirMode(testBackupDir, 0o700);
    }
    // Take a base valid backup once for the suite
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
      verifyRestore: false,
    });
    validBackupPath = meta.archivePath;
  });

  afterAll(async () => {
    if (testClient) {
      await testClient.end();
    }
    if (fs.existsSync(testBackupDir)) {
      try {
        fs.rmSync(testBackupDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // Base Positive Test
  it('0. should successfully verify restorability for a structurally complete and valid backup', async () => {
    const res = await verifyBackupRestorability(validBackupPath, passphrase, {
      databaseUrl: testDbUrl,
    });
    expect(res.verified).toBe(true);
    expect(res.verifiedTablesCount).toBe(ALL_EXPECTED_TABLES.length);
  });

  // 1. Missing required table
  it('1. should reject when an expected application table is missing', async () => {
    const partialTables = ALL_EXPECTED_TABLES.filter((t) => t !== 'Session');
    await expect(
      auditRestoredDatabaseSchema(testClient, partialTables)
    ).rejects.toThrow(/missing expected table "Session"/);
  });

  // 2. Missing required column
  it('2. should reject when a required column is missing from an application table', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "User" DROP COLUMN "username" CASCADE;`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/missing required column "username"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 3. Unexpected column
  it('3. should reject when an unexpected column is added to a table (schema drift)', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "User" ADD COLUMN "unauthorized_extra_col" TEXT;`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/contains unexpected extra column "unauthorized_extra_col"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 4. Changed column type
  it('4. should reject when a column data type is changed', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Movie" ALTER COLUMN "tmdbId" TYPE BIGINT;`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/data type mismatch: got "bigint", expected "integer"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 5. Changed column nullability
  it('5. should reject when column nullability is changed (nullable -> NOT NULL or vice versa)', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Collection" ALTER COLUMN "description" SET NOT NULL;`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/nullability mismatch: got false, expected true/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 6. Changed column default
  it('6. should reject when column default expression is changed', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Collection" ALTER COLUMN "isDefaultWatchlist" SET DEFAULT true;`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/default expression mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 7. Missing primary key
  it('7. should reject when a primary key is missing from a table', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Session" DROP CONSTRAINT "Session_pkey" CASCADE;`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/missing a PRIMARY KEY constraint/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 8. Primary key with altered column order or definition
  it('8. should reject when primary key has altered columns or composite definition', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Session" DROP CONSTRAINT "Session_pkey" CASCADE;`);
      await testClient.query(`ALTER TABLE "Session" ADD CONSTRAINT "Session_pkey" PRIMARY KEY ("id", "userId");`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/PRIMARY KEY columns mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 9. Missing foreign key
  it('9. should reject when an expected foreign key is missing', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Collection" DROP CONSTRAINT "Collection_ownerId_fkey";`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/missing required foreign key "Collection_ownerId_fkey"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 10. Foreign key with changed referenced table or columns
  it('10. should reject when a foreign key references the wrong column or table', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Collection" DROP CONSTRAINT "Collection_ownerId_fkey";`);
      await testClient.query(`
        ALTER TABLE "Collection" ADD CONSTRAINT "Collection_ownerId_fkey" 
        FOREIGN KEY ("ownerId") REFERENCES "User"("email") ON DELETE CASCADE ON UPDATE CASCADE;
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/foreign columns mismatch: got \[email\], expected \[id\]/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 11. Foreign key with changed ON DELETE or ON UPDATE behavior
  it('11. should reject when foreign key ON DELETE action is altered from CASCADE', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Collection" DROP CONSTRAINT "Collection_ownerId_fkey";`);
      await testClient.query(`
        ALTER TABLE "Collection" ADD CONSTRAINT "Collection_ownerId_fkey" 
        FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/delete action is "r" \(expected "c"\)/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 12. Missing UNIQUE constraint / index
  it('12. should reject when a required unique index is missing', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "Movie_tmdbId_mediaType_key";`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/missing required index "Movie_tmdbId_mediaType_key"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 13. Missing CHECK constraint
  it('13. should reject when required check constraint is missing', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_status_watchedAt_check";`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/missing required check constraint "CollectionMovie_status_watchedAt_check"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 14. CHECK constraint with weakened logic
  it('14. should reject when check constraint logic is weakened or incomplete', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_status_watchedAt_check";`);
      await testClient.query(`
        ALTER TABLE "CollectionMovie" ADD CONSTRAINT "CollectionMovie_status_watchedAt_check" 
        CHECK (status IN ('WATCHED'::"WatchStatus", 'TO_WATCH'::"WatchStatus"));
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/definition failed semantic validation/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 15. CHECK constraint containing the exact weakened logic from independent audit
  it('15. should reject when check constraint contains weakened logic (e.g. OR status = \'WATCHED\')', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_status_watchedAt_check";`);
      await testClient.query(`
        ALTER TABLE "CollectionMovie" ADD CONSTRAINT "CollectionMovie_status_watchedAt_check" 
        CHECK (
          (status = 'WATCHED'::"WatchStatus" AND "watchedAt" IS NOT NULL)
          OR
          (status = 'TO_WATCH'::"WatchStatus" AND "watchedAt" IS NULL)
          OR
          status = 'WATCHED'::"WatchStatus"
        );
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/definition failed semantic validation/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 15b. CHECK constraint containing permissive bypass (e.g. OR TRUE)
  it('15b. should reject when check constraint contains permissive bypass (e.g. OR TRUE)', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_status_watchedAt_check";`);
      await testClient.query(`
        ALTER TABLE "CollectionMovie" ADD CONSTRAINT "CollectionMovie_status_watchedAt_check" 
        CHECK ((("status" = 'WATCHED'::"WatchStatus" AND "watchedAt" IS NOT NULL) OR ("status" = 'TO_WATCH'::"WatchStatus" AND "watchedAt" IS NULL)) OR TRUE);
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/definition failed semantic validation/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 16. Missing required index
  it('16. should reject when an expected regular index is missing', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "Movie_mediaType_idx";`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/missing required index "Movie_mediaType_idx"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 17. Index with changed uniqueness
  it('17. should reject when unique index is replaced with non-unique index', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "User_email_key";`);
      await testClient.query(`CREATE INDEX "User_email_key" ON "User"(email);`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/uniqueness mismatch: got false, expected true/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 18. Index with changed column order
  it('18. should reject when composite index column order is inverted', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "Movie_tmdbId_mediaType_key";`);
      await testClient.query(`CREATE UNIQUE INDEX "Movie_tmdbId_mediaType_key" ON "Movie"("mediaType", "tmdbId");`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/columns or order mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 19. Index with changed sort direction
  it('19. should reject when index sort direction is changed (ASC -> DESC)', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "User_username_idx";`);
      await testClient.query(`CREATE INDEX "User_username_idx" ON "User"(username DESC);`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/sort direction mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 20. Index with changed operator class
  it('20. should reject when index operator class is changed', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "User_email_idx";`);
      await testClient.query(`CREATE INDEX "User_email_idx" ON "User"(email varchar_pattern_ops);`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/operator classes mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 21. Index with changed included columns (real PostgreSQL INCLUDE index)
  it('21. should reject when index composition is altered via an unauthorized INCLUDE clause', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "User_username_idx";`);
      await testClient.query(`CREATE INDEX "User_username_idx" ON "User"(username) INCLUDE (email);`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/included columns mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 22. Index with changed partial predicate
  it('22. should reject when partial index predicate is altered', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "Collection_owner_default_watchlist_key";`);
      await testClient.query(`CREATE UNIQUE INDEX "Collection_owner_default_watchlist_key" ON "Collection"("ownerId") WHERE ("isDefaultWatchlist" = false);`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/partial predicate mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 23. Index with changed expression
  it('23. should reject when functional expression in index is changed', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`DROP INDEX "User_username_lower_key";`);
      await testClient.query(`CREATE UNIQUE INDEX "User_username_lower_key" ON "User"(upper(username));`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/columns or order mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 24. Missing or inconsistent Prisma migration metadata
  it('24. should reject when migration metadata has a rolled back migration', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`
        UPDATE "_prisma_migrations" 
        SET rolled_back_at = now() 
        WHERE migration_name = '20261123120000_watched_status_check_constraint';
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/is marked rolled back/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  it('25. should reject when migration metadata is missing a required migration', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`
        DELETE FROM "_prisma_migrations" 
        WHERE migration_name = '20261123120000_watched_status_check_constraint';
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/missing expected applied migration "20261123120000_watched_status_check_constraint"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  it('26. should reject when migration metadata is unfinished (finished_at is null)', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`
        UPDATE "_prisma_migrations" 
        SET finished_at = NULL 
        WHERE migration_name = '20261123120000_watched_status_check_constraint';
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/is in an unfinished or failed state/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 26b. Migration checksum tampering
  it('26b. should reject when migration checksum is altered or tampered with', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`
        UPDATE "_prisma_migrations" 
        SET checksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' 
        WHERE migration_name = '20261123120000_watched_status_check_constraint';
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/checksum mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 26c. Unexpected migration in database history
  it('26c. should reject when an unexpected migration appears in database history', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`
        INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
        VALUES ('extra-mig-id', '0000000000000000000000000000000000000000000000000000000000000000', now(), '20990101000000_rogue_migration', null, null, now(), 1);
      `);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/migration count mismatch|unexpected migration/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // 26d. Column numeric precision alteration
  it('26d. should reject when column numeric precision is altered', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Movie" ALTER COLUMN "tmdbId" TYPE bigint;`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/data type mismatch|numeric precision mismatch/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  // Data Integrity & Checksum Comparisons
  it('27. should reject when restored row count does not match expected sourceStats', async () => {
    const bogusStats = {
      tables: ALL_EXPECTED_TABLES,
      rowCounts: { User: 999999 },
      tableHashes: {},
      totalRows: 999999,
    };
    await expect(
      auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES, { sourceStats: bogusStats })
    ).rejects.toThrow(/Restored row count mismatch on table "User"/);
  });

  it('28. should reject when restored table checksum does not match expected sourceStats hash', async () => {
    const bogusStats = {
      tables: ALL_EXPECTED_TABLES,
      rowCounts: {},
      tableHashes: { User: '0000000000000000000000000000000000000000000000000000000000000000' },
      totalRows: 0,
    };
    await expect(
      auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES, { sourceStats: bogusStats })
    ).rejects.toThrow(/Restored table checksum mismatch on table "User"/);
  });

  it('29. should reject unexpected additional CHECK constraint on application table', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "Movie" ADD CONSTRAINT "Movie_rogue_check" CHECK ("popularity" >= 0);`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/unexpected check constraint "Movie_rogue_check"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  it('30. should reject unexpected additional UNIQUE constraint (contype = u)', async () => {
    await testClient.query('BEGIN;');
    try {
      await testClient.query(`ALTER TABLE "User" ADD CONSTRAINT "User_rogue_unique_constraint" UNIQUE ("createdAt");`);
      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/unexpected unique constraint "User_rogue_unique_constraint"/);
    } finally {
      await testClient.query('ROLLBACK;');
    }
  });

  it('31. should reject when standalone unique index is used in place of required table UNIQUE constraint', async () => {
    // Inject expectation of a table unique constraint (which only exists as a standalone unique index)
    const originalUnique = CINETRACK_SCHEMA_MANIFEST.uniqueConstraints;
    try {
      (CINETRACK_SCHEMA_MANIFEST as any).uniqueConstraints = [
        {
          name: 'User_username_key',
          table: 'User',
          columns: ['username'],
          isDeferrable: false,
          isInitiallyDeferred: false,
          isValidated: true,
        },
      ];

      await expect(
        auditRestoredDatabaseSchema(testClient, ALL_EXPECTED_TABLES)
      ).rejects.toThrow(/missing required unique constraint "User_username_key".*standalone unique index cannot substitute/);
    } finally {
      (CINETRACK_SCHEMA_MANIFEST as any).uniqueConstraints = originalUnique;
    }
  });
});
