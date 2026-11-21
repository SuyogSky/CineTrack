import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { Client } from 'pg';
import { runMigrationPreflight, getDiskMigrations } from '../scripts/migration_preflight';

describe('Phase 4: Migration Preflight 4-State Machine & Integrity Tests', () => {
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

  // Helper to create all 7 application tables without migrations table
  async function createApplicationTablesOnly(client: Client) {
    await client.query(`
      CREATE TABLE "User" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        "passwordHash" TEXT NOT NULL,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE "Collection" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "ownerId" UUID NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        "isDefaultWatchlist" BOOLEAN DEFAULT false,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE "Movie" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tmdbId" INT NOT NULL,
        "mediaType" VARCHAR(50) DEFAULT 'MOVIE',
        title VARCHAR(255) NOT NULL,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE "CollectionMovie" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "collectionId" UUID NOT NULL,
        "movieId" UUID NOT NULL,
        "addedBy" UUID NOT NULL,
        status VARCHAR(50) DEFAULT 'TO_WATCH',
        "watchedAt" TIMESTAMP,
        note TEXT,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE "CollectionMember" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "collectionId" UUID NOT NULL,
        "userId" UUID NOT NULL,
        role VARCHAR(50) DEFAULT 'MEMBER',
        "joinedAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE "CollaborationInvitation" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "collectionId" UUID NOT NULL,
        "inviterId" UUID NOT NULL,
        "inviteeId" UUID NOT NULL,
        status VARCHAR(50) DEFAULT 'PENDING',
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE "Session" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" UUID NOT NULL,
        "tokenHash" TEXT NOT NULL,
        "expiresAt" TIMESTAMP NOT NULL,
        "revokedAt" TIMESTAMP,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "updatedAt" TIMESTAMP DEFAULT NOW()
      );
    `);
  }

  // Helper to create all 7 application tables AND all applied migration records matching disk
  async function createFullyValidSchema(client: Client) {
    await createApplicationTablesOnly(client);

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

    const diskMigrations = getDiskMigrations();
    for (let i = 0; i < diskMigrations.length; i++) {
      await client.query(`
        INSERT INTO "_prisma_migrations" (id, checksum, migration_name)
        VALUES ('${i + 1}', 'checksum_${i + 1}', '${diskMigrations[i]}');
      `);
    }
  }

  it('1. should classify completely empty database as State A (EMPTY) and pass', async () => {
    await withDisposableDb(async (testDbUrl) => {
      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(true);
      expect(result.state).toBe('EMPTY');
      expect(result.conflicts).toHaveLength(0);
    });
  });

  it('2. should classify fully initialized schema with clean data as State B (VALID) and pass', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(true);
      expect(result.state).toBe('VALID');
      expect(result.conflicts).toHaveLength(0);
    });
  });

  it('3. should classify database with unrelated tables and 0 application tables as State D (INCONSISTENT)', async () => {
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

  it('4. should classify database with unrelated tables alongside application tables as State D (INCONSISTENT)', async () => {
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

  it('5. should fail closed on partial schema missing User table with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP TABLE "User" CASCADE;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Partial Application Schema'))).toBe(true);
    });
  });

  it('6. should fail closed on partial schema missing Collection table with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP TABLE "Collection" CASCADE;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Partial Application Schema'))).toBe(true);
    });
  });

  it('7. should fail closed on partial schema missing CollectionMovie table with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('DROP TABLE "CollectionMovie" CASCADE;');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Partial Application Schema'))).toBe(true);
    });
  });

  it('8. should fail closed on database containing only some application tables with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await client.query(`
        CREATE TABLE "User" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL,
          "passwordHash" TEXT NOT NULL
        );
        CREATE TABLE "Movie" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tmdbId" INT NOT NULL,
          title VARCHAR(255) NOT NULL
        );
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Partial Application Schema'))).toBe(true);
    });
  });

  it('9. should fail closed on application tables existing without _prisma_migrations with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createApplicationTablesOnly(client);

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

  it('11. should fail closed on inconsistent migration history (migrations table exists but 0 app tables) with State D (INCONSISTENT)', async () => {
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

  it('12. should fail closed on failed migration recorded in _prisma_migrations with State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createApplicationTablesOnly(client);
      await client.query(`
        CREATE TABLE "_prisma_migrations" (
          id VARCHAR(36) PRIMARY KEY,
          checksum VARCHAR(64) NOT NULL,
          finished_at TIMESTAMPTZ,
          migration_name VARCHAR(255) NOT NULL,
          logs TEXT,
          rolled_back_at TIMESTAMPTZ,
          started_at TIMESTAMPTZ DEFAULT NOW(),
          applied_steps_count INT DEFAULT 0
        );
        INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name)
        VALUES ('1', 'abc', NULL, '20261117_failed_migration');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('Failed Prisma Migrations in History'))).toBe(true);
    });
  });

  it('13. should fail closed on unknown migration recorded in DB history with State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createApplicationTablesOnly(client);
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
        VALUES ('unknown_1', 'abc', '99999999_unknown_foreign_migration');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Unknown Migrations Recorded'))).toBe(true);
    });
  });

  it('14. should detect case-insensitive duplicate usernames as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query(`
        INSERT INTO "User" (username, email, "passwordHash") VALUES
        ('CinePhile', 'user1@example.com', 'hash1'),
        ('cinephile', 'user2@example.com', 'hash2');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Duplicate Usernames'))).toBe(true);
    });
  });

  it('15. should detect case-insensitive duplicate emails as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query(`
        INSERT INTO "User" (username, email, "passwordHash") VALUES
        ('user1', 'CinePhile@example.com', 'hash1'),
        ('user2', 'cinephile@example.com', 'hash2');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Duplicate Emails'))).toBe(true);
    });
  });

  it('16. should detect multiple default watchlists per user as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const userRes = await client.query(`
        INSERT INTO "User" (username, email, "passwordHash") VALUES
        ('user1', 'user1@example.com', 'hash1') RETURNING id;
      `);
      const userId = userRes.rows[0].id;

      await client.query(`
        INSERT INTO "Collection" ("ownerId", title, "isDefaultWatchlist") VALUES
        ('${userId}', 'Watchlist 1', true),
        ('${userId}', 'Watchlist 2', true);
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Multiple Default Watchlists'))).toBe(true);
    });
  });

  it('17. should detect orphaned CollectionMovie-to-Collection references as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const fakeCollectionId = crypto.randomUUID();
      const fakeMovieId = crypto.randomUUID();
      const fakeUserId = crypto.randomUUID();

      await client.query(`
        INSERT INTO "CollectionMovie" ("collectionId", "movieId", "addedBy") VALUES
        ('${fakeCollectionId}', '${fakeMovieId}', '${fakeUserId}');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Orphaned CollectionMovie-to-Collection'))).toBe(true);
    });
  });

  it('18. should detect orphaned Session-to-User references as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const fakeUserId = crypto.randomUUID();

      await client.query(`
        INSERT INTO "Session" ("userId", "tokenHash", "expiresAt") VALUES
        ('${fakeUserId}', 'somehash123', NOW() + INTERVAL '7 days');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('Orphaned Sessions'))).toBe(true);
    });
  });

  it('19. should detect orphaned CollaborationInvitation references as State D (INCONSISTENT)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const fakeCollectionId = crypto.randomUUID();
      const fakeUserId = crypto.randomUUID();

      await client.query(`
        INSERT INTO "CollaborationInvitation" ("collectionId", "inviterId", "inviteeId") VALUES
        ('${fakeCollectionId}', '${fakeUserId}', '${fakeUserId}');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('INCONSISTENT');
      expect(result.conflicts.some((c) => c.category.includes('CollaborationInvitation'))).toBe(true);
    });
  });

  it('20. should pass with clean valid relational data as State B (VALID)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      const userRes = await client.query(`
        INSERT INTO "User" (username, email, "passwordHash") VALUES
        ('validuser', 'validuser@example.com', 'hashedpass') RETURNING id;
      `);
      const userId = userRes.rows[0].id;

      const colRes = await client.query(`
        INSERT INTO "Collection" ("ownerId", title, "isDefaultWatchlist") VALUES
        ('${userId}', 'My Watchlist', true) RETURNING id;
      `);
      const colId = colRes.rows[0].id;

      const movieRes = await client.query(`
        INSERT INTO "Movie" ("tmdbId", "mediaType", title) VALUES
        (550, 'MOVIE', 'Fight Club') RETURNING id;
      `);
      const movieId = movieRes.rows[0].id;

      await client.query(`
        INSERT INTO "CollectionMovie" ("collectionId", "movieId", "addedBy") VALUES
        ('${colId}', '${movieId}', '${userId}');
      `);

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(true);
      expect(result.state).toBe('VALID');
      expect(result.conflicts).toHaveLength(0);
    });
  });

  it('21. should detect missing columns on CollectionMember table as State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "CollectionMember" DROP COLUMN "role";');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('CollectionMember'))).toBe(true);
    });
  });

  it('22. should detect missing columns on CollaborationInvitation table as State C (PARTIAL)', async () => {
    await withDisposableDb(async (testDbUrl, client) => {
      await createFullyValidSchema(client);
      await client.query('ALTER TABLE "CollaborationInvitation" DROP COLUMN "status";');

      const result = await runMigrationPreflight(testDbUrl);
      expect(result.success).toBe(false);
      expect(result.state).toBe('PARTIAL');
      expect(result.conflicts.some((c) => c.category.includes('CollaborationInvitation'))).toBe(true);
    });
  });
});
