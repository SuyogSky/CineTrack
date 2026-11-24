import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { Client } from 'pg';
import {
  runMigrationPreflight,
  getDiskMigrations,
  getValidatedDiskMigrations,
  validateWatchedStatusCheckConstraint,
} from '../scripts/migration_preflight';

describe('Phase 4: Migration Preflight 4-State Machine & Deep Integrity Tests', { timeout: 60000 }, () => {
  const baseAdminUrl =
    process.env.TEST_DATABASE_URL ||
    'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public';

  async function withDisposableDb(
    fn: (testDbUrl: string, client: Client) => Promise<void>
  ): Promise<void> {
    const randomHex = crypto.randomBytes(4).toString('hex');
    const dbName = `cinetrack_preflight_${Date.now()}_${randomHex}`;

    const parsed = new URL(baseAdminUrl);
    parsed.pathname = `/${dbName}`;
    const testDbUrl = parsed.toString();

    // 1. Create temporary disposable database
    const adminClient = new Client({ connectionString: baseAdminUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${dbName}";`);
    await adminClient.end();

    const dbClient = new Client({ connectionString: testDbUrl });
    await dbClient.connect();

    try {
      await fn(testDbUrl, dbClient);
    } finally {
      try {
        await dbClient.end();
      } catch {
        // Ignore if already ended
      }

      const cleanupClient = new Client({ connectionString: baseAdminUrl });
      await cleanupClient.connect();
      try {
        await cleanupClient.query(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = '${dbName}' AND pid <> pg_backend_pid();
        `);
        await cleanupClient.query(`DROP DATABASE IF EXISTS "${dbName}";`);
      } finally {
        await cleanupClient.end();
      }
    }
  }

  // Canonical schema generation: executes every checked-in migration in prisma/migrations/
  async function applyRealDiskMigrations(client: Client) {
    await client.query(`
      CREATE TABLE "_prisma_migrations" (
        id VARCHAR(36) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        finished_at TIMESTAMPTZ DEFAULT NOW(),
        migration_name VARCHAR(255) NOT NULL,
        logs TEXT,
        rolled_back_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        applied_steps_count INT DEFAULT 1
      );
    `);

    const diskMigrations = getValidatedDiskMigrations();
    for (let i = 0; i < diskMigrations.length; i++) {
      const mig = diskMigrations[i];
      await client.query(mig.sqlContent);
      await client.query(
        `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, applied_steps_count, finished_at, started_at)
         VALUES ($1, $2, $3, 1, NOW(), NOW());`,
        [`mig_${i + 1}`, mig.checksum, mig.name]
      );
    }
  }

  // createFullyValidSchema is derived from the real canonical migrations
  const createFullyValidSchema = applyRealDiskMigrations;

  it('1. should classify completely empty database as State A (EMPTY) and pass', async () => {
    await withDisposableDb(async (testDbUrl) => {
      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(true);
      expect(result.state).toBe('EMPTY');
      expect(result.conflicts).toHaveLength(0);
    });
  });

  it('2. should fail closed when target database has leftover views without tables with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      // Create a standalone view without base tables
      await client.query('CREATE VIEW "temp_view" AS SELECT 1 AS num;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Leftover Views'))).toBe(true);
    });
  });

  it('3. should classify fully initialized schema with clean data as State B (VALID) and pass', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(true);
      expect(result.state).toBe('VALID');
      expect(result.conflicts).toHaveLength(0);
    });
  });

  it('4. should classify database with unrelated tables and 0 application tables as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await client.query(`
        CREATE TABLE "contest_entries" (
          id SERIAL PRIMARY KEY,
          contest_name VARCHAR(100) NOT NULL
        );
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Unrelated User Tables'))).toBe(true);
    });
  });

  it('5. should classify database with unrelated tables alongside application tables as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query(`
        CREATE TABLE "legacy_billing" (
          id SERIAL PRIMARY KEY,
          amount INT NOT NULL
        );
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Unexpected/Unrelated Tables'))).toBe(true);
    });
  });

  it('6. should fail closed on partial schema missing User table with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP TABLE "User" CASCADE;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Partial Application Schema'))).toBe(true);
    });
  });

  it('7. should fail closed on partial schema missing Collection table with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP TABLE "Collection" CASCADE;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Partial Application Schema'))).toBe(true);
    });
  });

  it('8. should fail closed on partial schema missing CollectionMovie table with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP TABLE "CollectionMovie" CASCADE;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Partial Application Schema'))).toBe(true);
    });
  });

  it('9. should fail closed on application tables existing without _prisma_migrations with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP TABLE "_prisma_migrations";');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Missing Prisma Migration Metadata Table'))).toBe(true);
    });
  });

  it('10. should fail closed on database with missing required columns on core tables with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "User" DROP COLUMN "passwordHash";');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Missing Required Columns'))).toBe(true);
    });
  });

  it('11. should fail closed on column data type mismatch with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      // Alter Movie.tmdbId from integer to text
      await client.query('ALTER TABLE "Movie" ALTER COLUMN "tmdbId" TYPE text USING "tmdbId"::text;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Column Data Type Mismatch'))).toBe(true);
    });
  });

  it('12. should fail closed on inconsistent migration history (migrations table exists but 0 app tables) with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await client.query(`
        CREATE TABLE "_prisma_migrations" (
          id VARCHAR(36) PRIMARY KEY,
          checksum VARCHAR(64) NOT NULL,
          finished_at TIMESTAMPTZ DEFAULT NOW(),
          migration_name VARCHAR(255) NOT NULL,
          logs TEXT,
          rolled_back_at TIMESTAMPTZ,
          started_at TIMESTAMPTZ DEFAULT NOW(),
          applied_steps_count INT DEFAULT 1
        );
        INSERT INTO "_prisma_migrations" (id, checksum, migration_name)
        VALUES ('1', 'abc', '20261117_initial_migration');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Inconsistent Migration History'))).toBe(true);
    });
  });

  it('13. should fail closed on duplicate migration history rows with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const diskMigrations = getValidatedDiskMigrations();
      await client.query(`
        INSERT INTO "_prisma_migrations" (id, checksum, migration_name)
        VALUES ('duplicate_id', 'fake_checksum', '${diskMigrations[0].name}');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Duplicate Migration History Records'))).toBe(true);
    });
  });

  it('14. should fail closed on migration checksum mismatch (altered migration SQL) with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const diskMigrations = getValidatedDiskMigrations();
      await client.query(`
        UPDATE "_prisma_migrations" 
        SET checksum = 'tampered_checksum_1234567890' 
        WHERE migration_name = '${diskMigrations[0].name}';
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Migration Checksum Mismatch'))).toBe(true);
    });
  });

  it('15. should fail closed on incomplete migration execution (applied_steps_count < 1) with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const diskMigrations = getValidatedDiskMigrations();
      await client.query(`
        UPDATE "_prisma_migrations" 
        SET applied_steps_count = 0 
        WHERE migration_name = '${diskMigrations[0].name}';
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Incomplete Migration Execution'))).toBe(true);
    });
  });

  it('16. should fail closed on failed migration recorded in _prisma_migrations with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query(`
        INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
        VALUES ('failed_id', 'abc', NULL, '20261199_failed_migration', 0);
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Failed Prisma Migrations in History'))).toBe(true);
    });
  });

  it('17. should fail closed on rolled back migration in _prisma_migrations with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query(`
        INSERT INTO "_prisma_migrations" (id, checksum, finished_at, rolled_back_at, migration_name, applied_steps_count)
        VALUES ('rb_id', 'abc', NOW(), NOW(), '20261199_rolled_back_migration', 1);
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Failed Prisma Migrations in History'))).toBe(true);
    });
  });

  it('18. should fail closed on unknown migration recorded in DB history with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query(`
        INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
        VALUES ('unknown_id', 'abc', NOW(), '20999999_future_unknown_migration', 1);
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Unknown Migrations Recorded'))).toBe(true);
    });
  });

  it('19. should fail closed on pending migrations on disk not in DB with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const diskMigrations = getValidatedDiskMigrations();
      // Remove the latest migration record from DB to simulate pending migration
      await client.query(`
        DELETE FROM "_prisma_migrations" 
        WHERE migration_name = '${diskMigrations[diskMigrations.length - 1].name}';
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Pending/Unapplied Migrations'))).toBe(true);
    });
  });

  it('20. should fail closed on missing required foreign key with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_movieId_fkey";');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Missing Required Database Constraint'))).toBe(true);
    });
  });

  it('21. should fail closed on missing CollectionMovie status/watchedAt CHECK constraint with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_status_watchedAt_check";');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.details.some((d: any) => d.constraintName === 'CollectionMovie_status_watchedAt_check'))).toBe(true);
    });
  });

  it('22. should fail closed on missing required unique index with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "User_username_lower_key";');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Missing Required Database Index'))).toBe(true);
    });
  });

  it('23. should fail closed on missing enum type with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP TYPE "CollectionVisibility" CASCADE;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Missing Expected Enum Type'))).toBe(true);
    });
  });

  it('24. should fail closed on unexpected enum values with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query("ALTER TYPE \"WatchStatus\" ADD VALUE 'IN_PROGRESS';");

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Unexpected Enum Values'))).toBe(true);
    });
  });

  it('25. should detect case-insensitive duplicate usernames as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      // Temporarily drop index to inject violating duplicate
      await client.query('DROP INDEX "User_username_lower_key";');
      await client.query(`
        INSERT INTO "User" (id, username, email, "passwordHash", "updatedAt") VALUES
        ('u1', 'CinePhile', 'cine1@example.com', 'hash', NOW()),
        ('u2', 'cinephile', 'cine2@example.com', 'hash', NOW());
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Duplicate Usernames'))).toBe(true);
    });
  });

  it('26. should detect case-insensitive duplicate emails as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "User_email_lower_key";');
      await client.query(`
        INSERT INTO "User" (id, username, email, "passwordHash", "updatedAt") VALUES
        ('u1', 'userOne', 'Shared@Example.COM', 'hash', NOW()),
        ('u2', 'userTwo', 'shared@example.com', 'hash', NOW());
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Duplicate Emails'))).toBe(true);
    });
  });

  it('27. should detect multiple default watchlists per user as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "Collection_owner_default_watchlist_key";');
      await client.query(`
        INSERT INTO "User" (id, username, email, "passwordHash", "updatedAt") VALUES
        ('u1', 'watchlistuser', 'wl@example.com', 'hash', NOW());
        INSERT INTO "Collection" (id, "ownerId", title, "isDefaultWatchlist", "updatedAt") VALUES
        ('c1', 'u1', 'Watchlist 1', true, NOW()),
        ('c2', 'u1', 'Watchlist 2', true, NOW());
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Multiple Default Watchlists'))).toBe(true);
    });
  });

  it('28. should detect orphaned foreign keys as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_collectionId_fkey";');
      await client.query(`
        INSERT INTO "User" (id, username, email, "passwordHash", "updatedAt") VALUES
        ('u1', 'validuser', 'vu@example.com', 'hash', NOW());
        INSERT INTO "Movie" (id, "tmdbId", "mediaType", title, "updatedAt") VALUES
        ('m1', 1234, 'MOVIE', 'Orphan Test Movie', NOW());
        INSERT INTO "CollectionMovie" (id, "collectionId", "movieId", "addedBy", "updatedAt") VALUES
        ('cm1', 'nonexistent_collection_id', 'm1', 'u1', NOW());
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Orphaned CollectionMovie-to-Collection'))).toBe(true);
    });
  });

  it('29. should detect missing migration directory with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl) => {
      const nonExistentDir = path.join(os.tmpdir(), `nonexistent_migrations_${Date.now()}`);
      const result = await runMigrationPreflight(testDbUrl, { migrationsDir: nonExistentDir });
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Invalid or Missing Disk Migrations'))).toBe(true);
    });
  });

  it('30. should detect empty migration directory with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl) => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty_mig_'));
      try {
        const result = await runMigrationPreflight(testDbUrl, { migrationsDir: emptyDir });
        expect(result.success).toBe(false);
        expect(result.state).toBe('INCONSISTENT');
        expect(result.conflicts.some((c) => c.category.includes('Invalid or Missing Disk Migrations'))).toBe(true);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  it('31. should detect migration directory missing migration.sql with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing_sql_mig_'));
      const subDir = path.join(tempDir, '20261101_init');
      fs.mkdirSync(subDir);
      try {
        const result = await runMigrationPreflight(testDbUrl, { migrationsDir: tempDir });
        expect(result.success).toBe(false);
        expect(result.state).toBe('INCONSISTENT');
        expect(result.conflicts.some((c) => c.category.includes('Invalid or Missing Disk Migrations'))).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('32. should pass with clean valid relational data as State B (VALID)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const userRes = await client.query(`
        INSERT INTO "User" (id, username, email, "passwordHash", "updatedAt") VALUES
        ('u_valid', 'validuser', 'validuser@example.com', 'hashedpass', NOW()) RETURNING id;
      `);
      const userId = userRes.rows[0].id;

      const colRes = await client.query(`
        INSERT INTO "Collection" (id, "ownerId", title, "isDefaultWatchlist", "updatedAt") VALUES
        ('col_valid', '${userId}', 'My Watchlist', true, NOW()) RETURNING id;
      `);
      const colId = colRes.rows[0].id;

      const movieRes = await client.query(`
        INSERT INTO "Movie" (id, "tmdbId", "mediaType", title, "updatedAt") VALUES
        ('mov_valid', 550, 'MOVIE', 'Fight Club', NOW()) RETURNING id;
      `);
      const movieId = movieRes.rows[0].id;

      await client.query(`
        INSERT INTO "CollectionMovie" (id, "collectionId", "movieId", "addedBy", status, "watchedAt", "updatedAt") VALUES
        ('cm_valid', '${colId}', '${movieId}', '${userId}', 'WATCHED', NOW(), NOW());
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(true);
      expect(result.state).toBe('VALID');
      expect(result.conflicts).toHaveLength(0);
    });
  });

  it('33. should fail closed on leftover materialized views without tables with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await client.query('CREATE MATERIALIZED VIEW "leftover_matview" AS SELECT 1 AS id;');
      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Leftover') || c.category.includes('Artifacts'))).toBe(true);
    });
  });

  it('34. should fail closed on leftover sequences without tables with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await client.query('CREATE SEQUENCE "leftover_seq";');
      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Leftover') || c.category.includes('Artifacts'))).toBe(true);
    });
  });

  it('35. should fail closed on leftover custom enum/type without tables with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await client.query("CREATE TYPE \"leftover_type\" AS ENUM ('ALPHA', 'BETA');");
      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Leftover') || c.category.includes('Artifacts'))).toBe(true);
    });
  });

  it('36. should fail closed on leftover user routines/functions without tables with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await client.query(`
        CREATE FUNCTION leftover_func() RETURNS integer AS $$
        BEGIN
          RETURN 42;
        END;
        $$ LANGUAGE plpgsql;
      `);
      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Leftover') || c.category.includes('Artifacts'))).toBe(true);
    });
  });

  it('37. should fail closed on column default expression mismatch with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      // Alter Collection.isDefaultWatchlist default from false to true
      await client.query('ALTER TABLE "Collection" ALTER COLUMN "isDefaultWatchlist" SET DEFAULT true;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Column Default Mismatch'))).toBe(true);
    });
  });

  it('38. should fail closed on missing partial index predicate with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "Collection_owner_default_watchlist_key";');
      // Create without the partial predicate WHERE ("isDefaultWatchlist" = true)
      await client.query('CREATE UNIQUE INDEX "Collection_owner_default_watchlist_key" ON "Collection" ("ownerId");');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Invalid Partial Predicate'))).toBe(true);
    });
  });

  it('39. should fail closed on unexpected extra columns with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "User" ADD COLUMN "unexpected_column" text;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Unexpected Extra Column'))).toBe(true);
    });
  });

  it('40. should fail closed on foreign key delete action mismatch with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "Collection" DROP CONSTRAINT "Collection_ownerId_fkey";');
      // Re-add without CASCADE (defaults to NO ACTION / RESTRICT)
      await client.query(
        'ALTER TABLE "Collection" ADD CONSTRAINT "Collection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE NO ACTION;'
      );

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Foreign Key Delete Action Mismatch'))).toBe(true);
    });
  });

  it('41. should fail closed on invalid check constraint definition with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_status_watchedAt_check";');
      // Re-add with broken/invalid check definition (e.g. always true)
      await client.query(
        'ALTER TABLE "CollectionMovie" ADD CONSTRAINT "CollectionMovie_status_watchedAt_check" CHECK (1 = 1);'
      );

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Invalid Check Constraint Definition'))).toBe(true);
    });
  });

  it('42. should fail closed when Collection_owner_default_watchlist_key has an inverted partial predicate (isDefaultWatchlist = false) with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "Collection_owner_default_watchlist_key";');
      // Create with inverted predicate (isDefaultWatchlist = false)
      await client.query(
        'CREATE UNIQUE INDEX "Collection_owner_default_watchlist_key" ON "Collection" ("ownerId") WHERE "isDefaultWatchlist" = false;'
      );

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Invalid Partial Predicate'))).toBe(true);
    });
  });

  it('43. should fail closed when an application index is marked invalid (indisvalid = false) with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      // Mark an index invalid in pg_index directly (simulating aborted CONCURRENTLY creation)
      await client.query(`
        UPDATE pg_index
        SET indisvalid = false
        WHERE indexrelid = (SELECT oid FROM pg_class WHERE relname = 'User_username_lower_key' AND relnamespace = 'public'::regnamespace);
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Invalid Database Index'))).toBe(true);
    });
  });

  it('44. should fail closed on foreign key update action mismatch with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "Collection" DROP CONSTRAINT "Collection_ownerId_fkey";');
      // Re-add with NO ACTION for ON UPDATE (canonical requires CASCADE)
      await client.query(
        'ALTER TABLE "Collection" ADD CONSTRAINT "Collection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;'
      );

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Foreign Key Update Action Mismatch'))).toBe(true);
    });
  });

  it('45. should fail closed on primary key column mismatch with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      // Drop User_pkey and recreate on username instead of id
      await client.query('ALTER TABLE "User" DROP CONSTRAINT "User_pkey" CASCADE;');
      await client.query('ALTER TABLE "User" ADD CONSTRAINT "User_pkey" PRIMARY KEY ("username");');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Constraint Columns Mismatch'))).toBe(true);
    });
  });

  it('46. should fail closed on index access method mismatch (hash instead of btree) with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "User_username_lower_key";');
      // Recreate using hash access method instead of btree (hash doesn't support UNIQUE in PostgreSQL)
      await client.query('CREATE INDEX "User_username_lower_key" ON "User" USING hash (LOWER(username));');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Index Access Method Mismatch'))).toBe(true);
    });
  });

  it('47. should fail closed on index column ordering mismatch with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "CollectionMovie_collectionId_movieId_key";');
      // Recreate with inverted column ordering: ("movieId", "collectionId") instead of canonical ("collectionId", "movieId")
      await client.query('CREATE UNIQUE INDEX "CollectionMovie_collectionId_movieId_key" ON "CollectionMovie" ("movieId", "collectionId");');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Index Columns or Column Ordering Mismatch'))).toBe(true);
    });
  });

  it('48. should fail closed on index missing required column with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "Movie_tmdbId_mediaType_key";');
      // Recreate covering only "tmdbId", omitting "mediaType"
      await client.query('CREATE UNIQUE INDEX "Movie_tmdbId_mediaType_key" ON "Movie" ("tmdbId");');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Index Columns or Column Ordering Mismatch'))).toBe(true);
    });
  });

  it('49. should fail closed when a required unique index is changed into a non-unique index with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP INDEX "Movie_tmdbId_mediaType_key";');
      // Recreate as non-unique index
      await client.query('CREATE INDEX "Movie_tmdbId_mediaType_key" ON "Movie" ("tmdbId", "mediaType");');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Index Uniqueness Mismatch'))).toBe(true);
    });
  });

  it('50. should fail closed when CollectionMovie_status_watchedAt_check has permissive condition OR TRUE', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "CollectionMovie" DROP CONSTRAINT "CollectionMovie_status_watchedAt_check";');
      // Permissive definition with OR TRUE
      await client.query(
        'ALTER TABLE "CollectionMovie" ADD CONSTRAINT "CollectionMovie_status_watchedAt_check" CHECK (("status" = \'WATCHED\' AND "watchedAt" IS NOT NULL) OR ("status" = \'TO_WATCH\' AND "watchedAt" IS NULL) OR TRUE);'
      );

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Invalid Check Constraint Definition'))).toBe(true);
    });
  });

  it('51. should strictly validateWatchedStatusCheckConstraint semantically', () => {
    // 1. Canonical PostgreSQL generated definition
    expect(
      validateWatchedStatusCheckConstraint(
        'CHECK ((((status = \'WATCHED\'::"WatchStatus") AND ("watchedAt" IS NOT NULL)) OR ((status = \'TO_WATCH\'::"WatchStatus") AND ("watchedAt" IS NULL))))'
      )
    ).toBe(true);

    // 2. Canonical standard SQL definition
    expect(
      validateWatchedStatusCheckConstraint(
        'CHECK (("status" = \'WATCHED\' AND "watchedAt" IS NOT NULL) OR ("status" = \'TO_WATCH\' AND "watchedAt" IS NULL))'
      )
    ).toBe(true);

    // 3. Reversed branches
    expect(
      validateWatchedStatusCheckConstraint(
        'CHECK (("status" = \'TO_WATCH\' AND "watchedAt" IS NULL) OR ("status" = \'WATCHED\' AND "watchedAt" IS NOT NULL))'
      )
    ).toBe(true);

    // 4. Inverted nullability (MUST FAIL)
    expect(
      validateWatchedStatusCheckConstraint(
        'CHECK (("status" = \'WATCHED\' AND "watchedAt" IS NULL) OR ("status" = \'TO_WATCH\' AND "watchedAt" IS NOT NULL))'
      )
    ).toBe(false);

    // 5. Permissive OR TRUE (MUST FAIL)
    expect(
      validateWatchedStatusCheckConstraint(
        'CHECK (("status" = \'WATCHED\' AND "watchedAt" IS NOT NULL) OR ("status" = \'TO_WATCH\' AND "watchedAt" IS NULL) OR TRUE)'
      )
    ).toBe(false);

    // 6. Missing one branch (MUST FAIL)
    expect(
      validateWatchedStatusCheckConstraint('CHECK ("status" = \'WATCHED\' AND "watchedAt" IS NOT NULL)')
    ).toBe(false);

    // 7. Empty or malformed string (MUST FAIL)
    expect(validateWatchedStatusCheckConstraint('')).toBe(false);
    expect(validateWatchedStatusCheckConstraint(null as any)).toBe(false);
  });
});
