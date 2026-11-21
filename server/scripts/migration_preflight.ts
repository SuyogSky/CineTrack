import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { env, sanitizeDatabaseUrl, extractDatabaseName } from '../src/config/env';

export const EXPECTED_APPLICATION_TABLES = [
  'User',
  'Collection',
  'Movie',
  'CollectionMovie',
  'CollectionMember',
  'CollaborationInvitation',
  'Session',
] as const;

export type DatabaseState = 'EMPTY' | 'VALID' | 'PARTIAL' | 'INCONSISTENT' | 'PARTIAL_OR_INCONSISTENT';

export interface ConflictReport {
  category: string;
  count: number;
  details: unknown[];
  resolutionHint: string;
}

export interface PreflightResult {
  success: boolean;
  state: DatabaseState;
  databaseName: string;
  conflicts: ConflictReport[];
  error?: string;
}

export function getDiskMigrations(): string[] {
  const migrationsDir = path.resolve(__dirname, '../prisma/migrations');
  if (!fs.existsSync(migrationsDir)) return [];
  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  return entries
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(migrationsDir, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort();
}

export async function runMigrationPreflight(
  targetPoolOrUrl?: Pool | string
): Promise<PreflightResult> {
  let pool: Pool;
  let shouldClosePool = false;

  if (targetPoolOrUrl instanceof Pool) {
    pool = targetPoolOrUrl;
  } else if (typeof targetPoolOrUrl === 'string') {
    pool = new Pool({ connectionString: targetPoolOrUrl, max: 2, connectionTimeoutMillis: 5000 });
    shouldClosePool = true;
  } else {
    // Default: use explicit TARGET_DATABASE_URL or appropriate environment URL
    const connectionString =
      process.env.TARGET_DATABASE_URL ||
      (env.NODE_ENV === 'test' && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : env.DATABASE_URL);
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
    shouldClosePool = true;
  }

  let client: PoolClient | null = null;
  const conflicts: ConflictReport[] = [];

  try {
    client = await pool.connect();

    // 1. Verify and log database identity
    const dbIdentityRes = await client.query('SELECT current_database() AS db_name, current_user AS user_name;');
    const currentDb = dbIdentityRes.rows[0]?.db_name || 'unknown';
    console.log(`🔍 Inspecting target database: "${currentDb}"`);

    // 2. Discover existing tables in 'public' schema
    const tableRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    `);
    const allTables = new Set(tableRes.rows.map((r: { table_name: string }) => r.table_name));
    const existingAppTables = EXPECTED_APPLICATION_TABLES.filter((t) => allTables.has(t));
    const hasMigrationsTable = allTables.has('_prisma_migrations');

    const unrelatedTables = Array.from(allTables).filter(
      (t) => !EXPECTED_APPLICATION_TABLES.includes(t as any) && t !== '_prisma_migrations'
    );

    // 3. Inspect _prisma_migrations history if present
    let appliedMigrationNames: string[] = [];
    let failedMigrationCount = 0;
    if (hasMigrationsTable) {
      const migRes = await client.query(`
        SELECT id, migration_name, finished_at, rolled_back_at, applied_steps_count
        FROM "_prisma_migrations"
        ORDER BY finished_at ASC;
      `);
      appliedMigrationNames = migRes.rows
        .filter((r) => r.finished_at && !r.rolled_back_at)
        .map((r) => r.migration_name);
      failedMigrationCount = migRes.rows.filter((r) => !r.finished_at || r.rolled_back_at).length;
    }

    // 4. Strict State Classification
    // Case A: Truly empty database (0 tables in public schema)
    if (allTables.size === 0) {
      console.log('ℹ️ Preflight notice: Truly empty database detected (0 tables). Clean for initial migration.');
      return {
        success: true,
        state: 'EMPTY',
        databaseName: currentDb,
        conflicts: [],
      };
    }

    // Case B: Unrelated tables exist and 0 CineTrack application tables exist
    // A database is NOT empty simply because CineTrack tables are missing!
    if (existingAppTables.length === 0 && unrelatedTables.length > 0) {
      conflicts.push({
        category: 'Unrelated User Tables in Schema',
        count: unrelatedTables.length,
        details: [{ unrelatedTables }],
        resolutionHint:
          `Database is not clean for migration. It contains ${unrelatedTables.length} unrelated table(s): ${unrelatedTables.join(', ')}. Target an empty database.`,
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: `Database contains unrelated tables (${unrelatedTables.join(', ')}); not clean for initial migration.`,
      };
    }

    // Case C: Inconsistent migration history without application tables
    if (existingAppTables.length === 0 && hasMigrationsTable) {
      conflicts.push({
        category: 'Inconsistent Migration History',
        count: appliedMigrationNames.length + failedMigrationCount,
        details: [{ appliedCount: appliedMigrationNames.length, failedMigrationCount }],
        resolutionHint:
          'Database contains _prisma_migrations history but 0 application tables. Reset migration metadata: DROP TABLE IF EXISTS "_prisma_migrations";',
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: 'Database has migration records but zero application tables.',
      };
    }

    // Case D: Partial application schema (some tables exist, but not all 7)
    if (existingAppTables.length > 0 && existingAppTables.length < EXPECTED_APPLICATION_TABLES.length) {
      const missingTables = EXPECTED_APPLICATION_TABLES.filter((t) => !allTables.has(t));
      conflicts.push({
        category: 'Partial Application Schema Detected',
        count: missingTables.length,
        details: [{ existingAppTables, missingTables }],
        resolutionHint:
          `Database contains a partially initialized schema. Missing tables: ${missingTables.join(', ')}. Run manual remediation or inspect migration state.`,
      });
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: `Partially initialized schema: ${missingTables.length} required application tables missing.`,
      };
    }

    // Case E: Unrelated tables exist alongside application tables
    if (unrelatedTables.length > 0) {
      conflicts.push({
        category: 'Unexpected/Unrelated Tables Detected in Schema',
        count: unrelatedTables.length,
        details: [{ unrelatedTables }],
        resolutionHint:
          `Database contains unexpected table(s) alongside application tables: ${unrelatedTables.join(', ')}. Verify schema isolation.`,
      });
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: `Database contains unexpected/unrelated tables: ${unrelatedTables.join(', ')}`,
      };
    }

    // Case F: Application tables exist but _prisma_migrations is missing
    if (!hasMigrationsTable) {
      conflicts.push({
        category: 'Missing Prisma Migration Metadata Table',
        count: 1,
        details: [{ message: 'All application tables exist but _prisma_migrations table is missing' }],
        resolutionHint:
          'Application tables exist without _prisma_migrations. Baseline the migration state using: npx prisma migrate resolve --applied <migration_name>',
      });
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: 'Application tables exist without _prisma_migrations history table.',
      };
    }

    // Case G: Failed migrations recorded in migration history
    if (failedMigrationCount > 0) {
      conflicts.push({
        category: 'Failed Prisma Migrations in History',
        count: failedMigrationCount,
        details: [{ failedMigrationCount }],
        resolutionHint:
          'Prisma migration history records one or more failed or rolled-back migrations. Resolve using: npx prisma migrate resolve',
      });
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: 'Migration history contains failed or incomplete migrations.',
      };
    }

    // Case H: Migration history divergence (check disk migrations vs database history)
    const diskMigrations = getDiskMigrations();
    if (diskMigrations.length > 0) {
      const diskSet = new Set(diskMigrations);
      const appliedSet = new Set(appliedMigrationNames);

      const unknownMigrations = appliedMigrationNames.filter((m) => !diskSet.has(m));
      if (unknownMigrations.length > 0) {
        conflicts.push({
          category: 'Unknown Migrations Recorded in Database History',
          count: unknownMigrations.length,
          details: [{ unknownMigrations }],
          resolutionHint: `Database contains migration records not present on disk: ${unknownMigrations.join(', ')}. Inspect branch drift.`,
        });
        return {
          success: false,
          state: 'INCONSISTENT',
          databaseName: currentDb,
          conflicts,
          error: `Database contains unknown migration records: ${unknownMigrations.join(', ')}`,
        };
      }

      const missingMigrations = diskMigrations.filter((m) => !appliedSet.has(m));
      if (missingMigrations.length > 0) {
        conflicts.push({
          category: 'Pending/Unapplied Migrations on Disk',
          count: missingMigrations.length,
          details: [{ missingMigrations }],
          resolutionHint: `Database is missing migration(s) that exist on disk: ${missingMigrations.join(', ')}. Deploy migrations before startup.`,
        });
        return {
          success: false,
          state: 'PARTIAL',
          databaseName: currentDb,
          conflicts,
          error: `Database is missing ${missingMigrations.length} migration(s): ${missingMigrations.join(', ')}`,
        };
      }
    }

    // Check for required columns on all application tables
    const colRes = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name IN ('User', 'Collection', 'Movie', 'CollectionMovie', 'CollectionMember', 'CollaborationInvitation', 'Session');
    `);
    const tableColumns = new Map<string, Map<string, { data_type: string; is_nullable: string }>>();
    for (const row of colRes.rows) {
      if (!tableColumns.has(row.table_name)) {
        tableColumns.set(row.table_name, new Map());
      }
      tableColumns.get(row.table_name)!.set(row.column_name, {
        data_type: row.data_type,
        is_nullable: row.is_nullable,
      });
    }

    const requiredColumns: Record<string, string[]> = {
      User: ['id', 'email', 'username', 'passwordHash'],
      Collection: ['id', 'ownerId', 'title', 'isDefaultWatchlist'],
      Movie: ['id', 'tmdbId', 'mediaType', 'title'],
      CollectionMovie: ['id', 'collectionId', 'movieId', 'addedBy', 'status'],
      CollectionMember: ['id', 'collectionId', 'userId', 'role'],
      CollaborationInvitation: ['id', 'collectionId', 'inviterId', 'inviteeId', 'status'],
      Session: ['id', 'userId', 'tokenHash', 'expiresAt', 'revokedAt'],
    };

    for (const [tbl, cols] of Object.entries(requiredColumns)) {
      const existingCols = tableColumns.get(tbl);
      if (!existingCols) continue;
      const missing = cols.filter((c) => !existingCols.has(c));
      if (missing.length > 0) {
        conflicts.push({
          category: `Missing Required Columns on Table "${tbl}"`,
          count: missing.length,
          details: [{ table: tbl, missingColumns: missing }],
          resolutionHint: `Table "${tbl}" is missing required schema columns: ${missing.join(', ')}. Inspect schema drift.`,
        });
      }
    }

    if (conflicts.length > 0) {
      return {
        success: false,
        state: 'PARTIAL',
        databaseName: currentDb,
        conflicts,
        error: 'Schema column drift or missing columns detected.',
      };
    }

    // Validate enum types and allowed values if enums exist
    const enumRes = await client.query(`
      SELECT t.typname, e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public';
    `);
    const enumValuesMap = new Map<string, Set<string>>();
    for (const row of enumRes.rows) {
      if (!enumValuesMap.has(row.typname)) {
        enumValuesMap.set(row.typname, new Set());
      }
      enumValuesMap.get(row.typname)!.add(row.enumlabel);
    }

    const expectedEnums: Record<string, string[]> = {
      CollectionVisibility: ['PRIVATE', 'PUBLIC_LINK'],
      MediaType: ['MOVIE', 'TV'],
      WatchStatus: ['TO_WATCH', 'WATCHED'],
      MemberRole: ['MEMBER', 'ADMIN'],
      InvitationStatus: ['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'],
    };

    for (const [enumName, expectedVals] of Object.entries(expectedEnums)) {
      const existingVals = enumValuesMap.get(enumName);
      if (existingVals) {
        const missingVals = expectedVals.filter((v) => !existingVals.has(v));
        if (missingVals.length > 0) {
          conflicts.push({
            category: `Incompatible Enum Values on "${enumName}"`,
            count: missingVals.length,
            details: [{ enumName, missingVals }],
            resolutionHint: `Enum "${enumName}" is missing required values: ${missingVals.join(', ')}. Ensure migrations have run cleanly.`,
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return {
        success: false,
        state: 'INCONSISTENT',
        databaseName: currentDb,
        conflicts,
        error: 'Schema enum definition differences detected.',
      };
    }

    // State B: Complete application schema exists. Run full data-integrity checks!
    console.log('🔍 Complete application schema detected. Running data integrity checks...');

    // 1. Case-Insensitive Duplicate Usernames
    const usernameDupes = await client.query(`
      SELECT LOWER(username) AS lower_val, array_agg(username) AS variants, array_agg(id) AS ids, COUNT(*) AS count
      FROM "User"
      GROUP BY LOWER(username)
      HAVING COUNT(*) > 1;
    `);
    if (usernameDupes.rows.length > 0) {
      conflicts.push({
        category: 'Case-Insensitive Duplicate Usernames',
        count: usernameDupes.rows.length,
        details: usernameDupes.rows,
        resolutionHint:
          'Manually resolve duplicate usernames using SQL: UPDATE "User" SET username = \'unique_name\' WHERE id = \'TARGET_ID\';',
      });
    }

    // 2. Case-Insensitive Duplicate Emails
    const emailDupes = await client.query(`
      SELECT LOWER(email) AS lower_val, array_agg(email) AS variants, array_agg(id) AS ids, COUNT(*) AS count
      FROM "User"
      GROUP BY LOWER(email)
      HAVING COUNT(*) > 1;
    `);
    if (emailDupes.rows.length > 0) {
      conflicts.push({
        category: 'Case-Insensitive Duplicate Emails',
        count: emailDupes.rows.length,
        details: emailDupes.rows,
        resolutionHint:
          'Manually update conflicting emails using SQL: UPDATE "User" SET email = \'unique_email@domain.com\' WHERE id = \'TARGET_ID\';',
      });
    }

    // 3. Multiple Default Watchlists per Owner
    const defaultWatchlistDupes = await client.query(`
      SELECT "ownerId", COUNT(*) AS count, array_agg(id) AS collection_ids
      FROM "Collection"
      WHERE "isDefaultWatchlist" = true
      GROUP BY "ownerId"
      HAVING COUNT(*) > 1;
    `);
    if (defaultWatchlistDupes.rows.length > 0) {
      conflicts.push({
        category: 'Multiple Default Watchlists per User',
        count: defaultWatchlistDupes.rows.length,
        details: defaultWatchlistDupes.rows,
        resolutionHint:
          'Retain one master default watchlist and set others to false: UPDATE "Collection" SET "isDefaultWatchlist" = false WHERE id = \'SECONDARY_ID\';',
      });
    }

    // 4. Orphaned CollectionMovie -> Collection
    const orphanedCMCollection = await client.query(`
      SELECT cm.id, cm."collectionId"
      FROM "CollectionMovie" cm
      LEFT JOIN "Collection" c ON cm."collectionId" = c.id
      WHERE c.id IS NULL;
    `);
    if (orphanedCMCollection.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMovie-to-Collection References',
        count: orphanedCMCollection.rows.length,
        details: orphanedCMCollection.rows,
        resolutionHint: 'DELETE FROM "CollectionMovie" WHERE "collectionId" NOT IN (SELECT id FROM "Collection");',
      });
    }

    // 5. Orphaned CollectionMovie -> Movie
    const orphanedCMMovie = await client.query(`
      SELECT cm.id, cm."movieId"
      FROM "CollectionMovie" cm
      LEFT JOIN "Movie" m ON cm."movieId" = m.id
      WHERE m.id IS NULL;
    `);
    if (orphanedCMMovie.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMovie-to-Movie References',
        count: orphanedCMMovie.rows.length,
        details: orphanedCMMovie.rows,
        resolutionHint: 'DELETE FROM "CollectionMovie" WHERE "movieId" NOT IN (SELECT id FROM "Movie");',
      });
    }

    // 6. Orphaned CollectionMovie -> User (addedBy)
    const orphanedCMUser = await client.query(`
      SELECT cm.id, cm."addedBy"
      FROM "CollectionMovie" cm
      LEFT JOIN "User" u ON cm."addedBy" = u.id
      WHERE u.id IS NULL;
    `);
    if (orphanedCMUser.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMovie-to-User References',
        count: orphanedCMUser.rows.length,
        details: orphanedCMUser.rows,
        resolutionHint: 'DELETE FROM "CollectionMovie" WHERE "addedBy" NOT IN (SELECT id FROM "User");',
      });
    }

    // 7. Orphaned CollectionMember -> Collection
    const orphanedMemberCollection = await client.query(`
      SELECT cm.id, cm."collectionId"
      FROM "CollectionMember" cm
      LEFT JOIN "Collection" c ON cm."collectionId" = c.id
      WHERE c.id IS NULL;
    `);
    if (orphanedMemberCollection.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMember-to-Collection References',
        count: orphanedMemberCollection.rows.length,
        details: orphanedMemberCollection.rows,
        resolutionHint: 'DELETE FROM "CollectionMember" WHERE "collectionId" NOT IN (SELECT id FROM "Collection");',
      });
    }

    // 8. Orphaned CollectionMember -> User
    const orphanedMemberUser = await client.query(`
      SELECT cm.id, cm."userId"
      FROM "CollectionMember" cm
      LEFT JOIN "User" u ON cm."userId" = u.id
      WHERE u.id IS NULL;
    `);
    if (orphanedMemberUser.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollectionMember-to-User References',
        count: orphanedMemberUser.rows.length,
        details: orphanedMemberUser.rows,
        resolutionHint: 'DELETE FROM "CollectionMember" WHERE "userId" NOT IN (SELECT id FROM "User");',
      });
    }

    // 9. Orphaned CollaborationInvitation -> Collection
    const orphanedInviteCollection = await client.query(`
      SELECT ci.id, ci."collectionId"
      FROM "CollaborationInvitation" ci
      LEFT JOIN "Collection" c ON ci."collectionId" = c.id
      WHERE c.id IS NULL;
    `);
    if (orphanedInviteCollection.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollaborationInvitation-to-Collection References',
        count: orphanedInviteCollection.rows.length,
        details: orphanedInviteCollection.rows,
        resolutionHint: 'DELETE FROM "CollaborationInvitation" WHERE "collectionId" NOT IN (SELECT id FROM "Collection");',
      });
    }

    // 10. Orphaned CollaborationInvitation -> User (inviterId or inviteeId)
    const orphanedInviteUser = await client.query(`
      SELECT ci.id, ci."inviterId", ci."inviteeId"
      FROM "CollaborationInvitation" ci
      LEFT JOIN "User" u1 ON ci."inviterId" = u1.id
      LEFT JOIN "User" u2 ON ci."inviteeId" = u2.id
      WHERE u1.id IS NULL OR u2.id IS NULL;
    `);
    if (orphanedInviteUser.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned CollaborationInvitation-to-User References',
        count: orphanedInviteUser.rows.length,
        details: orphanedInviteUser.rows,
        resolutionHint: 'DELETE FROM "CollaborationInvitation" WHERE "inviterId" NOT IN (SELECT id FROM "User") OR "inviteeId" NOT IN (SELECT id FROM "User");',
      });
    }

    // 11. Orphaned Session -> User
    const orphanedSessions = await client.query(`
      SELECT s.id, s."userId"
      FROM "Session" s
      LEFT JOIN "User" u ON s."userId" = u.id
      WHERE u.id IS NULL;
    `);
    if (orphanedSessions.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned Sessions',
        count: orphanedSessions.rows.length,
        details: orphanedSessions.rows,
        resolutionHint: 'DELETE FROM "Session" WHERE "userId" NOT IN (SELECT id FROM "User");',
      });
    }

    // 12. Orphaned Collection -> User (ownerId)
    const orphanedCollections = await client.query(`
      SELECT c.id, c."ownerId"
      FROM "Collection" c
      LEFT JOIN "User" u ON c."ownerId" = u.id
      WHERE u.id IS NULL;
    `);
    if (orphanedCollections.rows.length > 0) {
      conflicts.push({
        category: 'Orphaned Collections (Invalid Owner)',
        count: orphanedCollections.rows.length,
        details: orphanedCollections.rows,
        resolutionHint: 'DELETE FROM "Collection" WHERE "ownerId" NOT IN (SELECT id FROM "User");',
      });
    }

    const success = conflicts.length === 0;
    return {
      success,
      state: success ? 'VALID' : 'INCONSISTENT',
      databaseName: currentDb,
      conflicts,
    };
  } finally {
    if (client) {
      client.release();
    }
    if (shouldClosePool) {
      await pool.end();
    }
  }
}

async function cli() {
  console.log('🔍 Executing CineTrack Database Migration Preflight Diagnostics...');
  try {
    const targetUrl = process.env.TARGET_DATABASE_URL || process.argv[2];
    const { success, state, conflicts, databaseName, error } = await runMigrationPreflight(targetUrl);

    if (!success) {
      console.error(`\n🚨 MIGRATION PREFLIGHT ABORTED on database "${databaseName}" [State: ${state}]:`);
      if (error) {
        console.error(`❌ ${error}`);
      }
      for (const conflict of conflicts) {
        console.error(`\n❌ [${conflict.category}] (${conflict.count} conflict groups found):`);
        console.error(JSON.stringify(conflict.details, null, 2));
        console.error(`👉 Manual Remediation: ${conflict.resolutionHint}`);
      }
      console.error('\n🛑 Preflight safety gate halted execution to prevent migration failure or database inconsistency.');
      process.exit(1);
    }

    console.log(`✅ Preflight verification successful for "${databaseName}" [State: ${state}]. Target database is clean and ready for migration deployment.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to execute migration preflight diagnostics:', err);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes('migration_preflight')) {
  cli();
}

