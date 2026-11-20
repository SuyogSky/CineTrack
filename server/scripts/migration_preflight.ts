import { pool } from '../src/config/database';

interface ConflictReport {
  category: string;
  count: number;
  details: unknown[];
  resolutionHint: string;
}

export async function runMigrationPreflight(): Promise<{
  success: boolean;
  conflicts: ConflictReport[];
}> {
  const client = await pool.connect();
  const conflicts: ConflictReport[] = [];

  try {
    // Check if tables exist before running checks (fresh DB scenario)
    const tableCheck = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name IN ('User', 'Collection', 'CollectionMovie', 'Session');
    `);
    const existingTables = new Set(tableCheck.rows.map((r: { table_name: string }) => r.table_name));

    if (!existingTables.has('User') || !existingTables.has('Collection')) {
      console.log('ℹ️ Preflight notice: Core tables not yet created (fresh database). Migration is safe to proceed.');
      return { success: true, conflicts: [] };
    }

    // 1. Check for Case-Insensitive Duplicate Usernames
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

    // 2. Check for Case-Insensitive Duplicate Emails
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

    // 3. Check for Multiple Default Watchlists per Owner
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

    // 4. Check for Orphaned Collection Movies
    if (existingTables.has('CollectionMovie')) {
      const orphanedMovies = await client.query(`
        SELECT cm.id, cm."collectionId"
        FROM "CollectionMovie" cm
        LEFT JOIN "Collection" c ON cm."collectionId" = c.id
        WHERE c.id IS NULL;
      `);
      if (orphanedMovies.rows.length > 0) {
        conflicts.push({
          category: 'Orphaned Collection Movies (Invalid Foreign Key)',
          count: orphanedMovies.rows.length,
          details: orphanedMovies.rows,
          resolutionHint:
            'Inspect or clean up orphaned entries: DELETE FROM "CollectionMovie" WHERE id IN (\'...\');',
        });
      }
    }

    // 5. Check for Orphaned Sessions
    if (existingTables.has('Session')) {
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
          resolutionHint: 'Remove sessions with non-existent users: DELETE FROM "Session" WHERE "userId" IS NULL;',
        });
      }
    }

    const success = conflicts.length === 0;
    return { success, conflicts };
  } finally {
    client.release();
  }
}

async function cli() {
  console.log('🔍 Executing CineTrack Database Migration Preflight Diagnostics...');
  try {
    const { success, conflicts } = await runMigrationPreflight();
    if (!success) {
      console.error('\n🚨 MIGRATION PREFLIGHT ABORTED: Database integrity conflicts detected!');
      for (const conflict of conflicts) {
        console.error(`\n❌ [${conflict.category}] (${conflict.count} conflict groups found):`);
        console.error(JSON.stringify(conflict.details, null, 2));
        console.error(`👉 Manual Remediation: ${conflict.resolutionHint}`);
      }
      console.error('\n🛑 Preflight safety gate halted execution to prevent migration failure or index corruption.');
      process.exit(1);
    }
    console.log('✅ Preflight verification successful. Target database is 100% clean and ready for migration deployment.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to execute migration preflight diagnostics:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].includes('migration_preflight')) {
  cli();
}
