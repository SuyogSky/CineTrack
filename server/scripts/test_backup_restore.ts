import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { env, sanitizeDatabaseUrl } from '../src/config/env';

export interface BackupRestoreOptions {
  sourceUrl?: string;
  expectedDbName?: string;
  customDumpPath?: string;
  skipDump?: boolean;
  skipDataAssertion?: boolean;
}

export interface BackupRestoreResult {
  success: boolean;
  sourceDb: string;
  restoredDb: string;
  dumpFileSize: number;
  verifiedTables: string[];
  tableCounts: Record<string, number>;
  verifiedConstraintsCount: number;
  verifiedIndexesCount: number;
  error?: string;
}

export function parsePostgresUrl(rawUrl: string): {
  user: string;
  password?: string;
  host: string;
  port: number;
  database: string;
} {
  const parsed = new URL(rawUrl);
  return {
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    host: parsed.hostname || 'localhost',
    port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    database: parsed.pathname.replace(/^\//, '').split('?')[0] || 'postgres',
  };
}

/**
 * Strict explicit configuration-based allowlist for disposable test databases.
 * Substring matches (e.g. 'contest') are strictly prohibited.
 */
export function assertDisposableTestDatabase(dbName: string, expectedDbName?: string): void {
  const lower = dbName.toLowerCase().trim();

  // Reject production / live keywords anywhere
  const prodTokens = ['prod', 'production', 'live', 'main'];
  for (const token of prodTokens) {
    if (lower.includes(token)) {
      throw new Error(
        `SECURITY REJECTION: Target database "${dbName}" contains disallowed production keyword "${token}". Refusing to run backup/restore verification against production databases.`
      );
    }
  }

  // Reject root/system databases
  const rootDbs = ['cinetrack', 'postgres', 'template0', 'template1'];
  if (rootDbs.includes(lower)) {
    throw new Error(
      `SECURITY REJECTION: Target database "${dbName}" is a default/root database. Backup/restore verification can only run on dedicated test databases.`
    );
  }

  // If explicit expected database name is configured (e.g. BACKUP_TEST_SOURCE_DATABASE), check exact match
  if (expectedDbName && expectedDbName.trim() !== '') {
    if (lower !== expectedDbName.toLowerCase().trim()) {
      throw new Error(
        `SECURITY REJECTION: Target database "${dbName}" does not match configured expected database "${expectedDbName}".`
      );
    }
    return;
  }

  // Strict allowlist: MUST match exact known test databases or approved prefixes
  const exactAllowed = ['cinetrack_test', 'cinetrack_ci'];
  const isExactAllowed = exactAllowed.includes(lower);

  const restorePrefix = (process.env.BACKUP_TEST_RESTORE_DATABASE_PREFIX || 'cinetrack_restore_').toLowerCase();
  const isRestoreTarget = lower.startsWith(restorePrefix) || lower.startsWith('cinetrack_restore_');
  const isDisposableTarget = lower.startsWith('cinetrack_disposable_') || lower.startsWith('cinetrack_test_');

  // Specifically reject false positive substring matches like "contest", "protest", "latest"
  if (!isExactAllowed && !isRestoreTarget && !isDisposableTarget) {
    throw new Error(
      `SECURITY REJECTION: Target database "${dbName}" is not on the strict allowlist of disposable test databases. Substring matches (e.g. "contest") are strictly prohibited.`
    );
  }
}

export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: "${name}"`);
  }
  return `"${name}"`;
}

export async function runBackupRestoreVerification(
  options: BackupRestoreOptions = {}
): Promise<BackupRestoreResult> {
  console.log('🧪 Starting CineTrack Real PostgreSQL Backup and Restore Test...');

  // 1. Resolve source database URL: do NOT silently fall back to DATABASE_URL
  let sourceUrl = options.sourceUrl;
  if (sourceUrl === undefined) {
    sourceUrl =
      process.env.BACKUP_TEST_SOURCE_URL ||
      (env.NODE_ENV === 'test' && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : undefined);
  }

  if (!sourceUrl || sourceUrl.trim() === '') {
    throw new Error(
      'SECURITY REJECTION: Dedicated test database URL is required (BACKUP_TEST_SOURCE_URL or TEST_DATABASE_URL in test mode). Silent fallback to DATABASE_URL is strictly disabled.'
    );
  }

  const conn = parsePostgresUrl(sourceUrl);

  // Validate that source URL does not point to default DATABASE_URL
  if (env.DATABASE_URL && sourceUrl === env.DATABASE_URL && env.NODE_ENV !== 'test') {
    throw new Error(
      'SECURITY REJECTION: Target database URL matches primary DATABASE_URL. Destructive backup/restore testing is strictly prohibited on production/development databases.'
    );
  }

  const expectedDb = options.expectedDbName || process.env.BACKUP_TEST_SOURCE_DATABASE;
  assertDisposableTestDatabase(conn.database, expectedDb);

  // Reject production-like hosts
  const hostLower = conn.host.toLowerCase();
  if (hostLower.includes('prod') || hostLower.includes('production') || hostLower.includes('rds.amazonaws.com')) {
    throw new Error(
      `SECURITY REJECTION: Host "${conn.host}" is classified as a production environment. Backup/restore verification aborted.`
    );
  }

  console.log(`🔒 Source test database validated: "${conn.database}" on ${conn.host}:${conn.port}`);

  // Tool compatibility check
  try {
    const dumpVer = execFileSync('pg_dump', ['--version'], { stdio: 'pipe' }).toString().trim();
    const restoreVer = execFileSync('pg_restore', ['--version'], { stdio: 'pipe' }).toString().trim();
    console.log(`🛠️ Verified PostgreSQL toolchain: ${dumpVer} / ${restoreVer}`);
  } catch (toolErr: any) {
    throw new Error(`PostgreSQL toolchain check failed (pg_dump or pg_restore not available): ${toolErr.message}`);
  }

  const restorePrefix = process.env.BACKUP_TEST_RESTORE_DATABASE_PREFIX || 'cinetrack_restore_';
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const tempDbName = `${restorePrefix}${Date.now()}_${randomSuffix}`;

  // Prevent source and restore from ever being the same database
  if (tempDbName === conn.database) {
    throw new Error(
      `SECURITY REJECTION: Source database "${conn.database}" and restore target "${tempDbName}" must not be identical.`
    );
  }
  assertDisposableTestDatabase(tempDbName);

  const dumpFile =
    options.customDumpPath ||
    path.resolve(__dirname, '..', `temp_backup_${Date.now()}_${randomSuffix}.dump`);

  const execEnv = {
    ...process.env,
    PGPASSWORD: conn.password || '',
  };

  let adminClient: Client | null = null;
  let verifyClient: Client | null = null;
  let sourceClient: Client | null = null;
  let primaryError: Error | null = null;

  try {
    // 2. Connect to source database and verify live PostgreSQL connection identity
    sourceClient = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectionTimeoutMillis: 5000,
    });
    await sourceClient.connect();

    const identityRes = await sourceClient.query(`
      SELECT 
        current_database() AS current_db,
        current_user AS current_user,
        inet_server_addr() AS server_addr,
        inet_server_port() AS server_port,
        inet_client_addr() AS client_addr,
        version() AS version;
    `);

    const liveDb = identityRes.rows[0]?.current_db;
    const liveUser = identityRes.rows[0]?.current_user;
    const liveServerAddr = identityRes.rows[0]?.server_addr;
    const liveServerPort = identityRes.rows[0]?.server_port;

    console.log(`🔒 Live PostgreSQL connection verified: DB="${liveDb}", User="${liveUser}", Server="${liveServerAddr || conn.host}:${liveServerPort || conn.port}"`);

    if (liveDb !== conn.database) {
      throw new Error(
        `SECURITY REJECTION: Live connected database "${liveDb}" does not match configured target "${conn.database}". Connection aborted.`
      );
    }

    // 3. Prepare dump file
    if (!options.skipDump) {
      if (fs.existsSync(dumpFile)) {
        fs.unlinkSync(dumpFile);
      }

      // 4. Perform pg_dump of source database using direct arguments array (no shell interpolation)
      console.log(`📦 Creating custom-format pg_dump of "${conn.database}"...`);
      try {
        execFileSync(
          'pg_dump',
          [
            '-h', conn.host,
            '-p', String(conn.port),
            '-U', conn.user,
            '-F', 'c',
            '-b',
            '-f', dumpFile,
            conn.database,
          ],
          { env: execEnv, stdio: 'pipe', timeout: 60000 }
        );
      } catch (dumpErr: any) {
        const stderr = dumpErr?.stderr?.toString() || dumpErr?.message || 'Unknown pg_dump error';
        throw new Error(`pg_dump failed with exit code ${dumpErr?.status ?? 'unknown'}: ${stderr}`);
      }
    }

    if (!fs.existsSync(dumpFile) || fs.statSync(dumpFile).size === 0) {
      throw new Error('Backup dump file failed: file is empty or missing');
    }
    const dumpFileSize = fs.statSync(dumpFile).size;
    console.log(`✅ Backup dump file verified. Size: ${dumpFileSize} bytes`);

    // 5. Connect as admin to create unique disposable restore database
    console.log(`🛠️ Creating temporary restore database "${tempDbName}"...`);
    const adminUrl = process.env.BACKUP_TEST_RESTORE_ADMIN_URL;
    if (adminUrl) {
      const adminConn = parsePostgresUrl(adminUrl);
      adminClient = new Client({
        host: adminConn.host,
        port: adminConn.port,
        user: adminConn.user,
        password: adminConn.password,
        database: adminConn.database,
        connectionTimeoutMillis: 5000,
      });
    } else {
      adminClient = new Client({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        connectionTimeoutMillis: 5000,
      });
    }
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE ${quoteIdent(tempDbName)};`);

    // 6. Perform pg_restore into disposable database using direct arguments array (Fail closed on any non-zero exit code!)
    console.log(`📥 Executing pg_restore into "${tempDbName}"...`);
    try {
      execFileSync(
        'pg_restore',
        [
          '-h', conn.host,
          '-p', String(conn.port),
          '-U', conn.user,
          '-d', tempDbName,
          '--no-owner',
          '--clean',
          '--if-exists',
          dumpFile,
        ],
        { env: execEnv, stdio: 'pipe', timeout: 60000 }
      );
    } catch (restoreErr: any) {
      const stderr = restoreErr?.stderr?.toString() || restoreErr?.message || 'Unknown pg_restore error';
      throw new Error(`pg_restore failed with exit code ${restoreErr?.status ?? 'unknown'}: ${stderr}`);
    }

    // 7. Connect to restored database to perform comprehensive schema and data verification
    console.log(`🔍 Comparing source "${conn.database}" and restored "${tempDbName}"...`);
    verifyClient = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: tempDbName,
      connectionTimeoutMillis: 5000,
    });
    await verifyClient.connect();

    // A. Verify tables in public schema
    const srcTablesRes = await sourceClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    const resTablesRes = await verifyClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    const srcTables = srcTablesRes.rows.map((r) => r.table_name);
    const resTables = resTablesRes.rows.map((r) => r.table_name);

    expectTablesMatch(srcTables, resTables);
    console.log(`✅ All ${resTables.length} tables matched between source and restored database.`);

    // Expected core tables check
    const expectedCoreTables = [
      'User',
      'Collection',
      'Movie',
      'CollectionMovie',
      'CollectionMember',
      'CollaborationInvitation',
      'Session',
    ];
    for (const coreTable of expectedCoreTables) {
      if (srcTables.includes(coreTable) && !resTables.includes(coreTable)) {
        throw new Error(`Restored database is missing core application table: "${coreTable}"`);
      }
    }

    // B. Verify column definitions (name, data_type, is_nullable, column_default, udt_name)
    const colQuery = `
      SELECT table_name, column_name, data_type, is_nullable, column_default, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name;
    `;
    const srcCols = await sourceClient.query(colQuery);
    const resCols = await verifyClient.query(colQuery);

    const srcColMap = new Map(srcCols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
    const resColMap = new Map(resCols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));

    for (const [key, srcCol] of srcColMap.entries()) {
      const resCol = resColMap.get(key);
      if (!resCol) {
        throw new Error(`Column "${key}" missing in restored database.`);
      }
      if (
        srcCol.data_type !== resCol.data_type ||
        srcCol.is_nullable !== resCol.is_nullable ||
        srcCol.udt_name !== resCol.udt_name
      ) {
        throw new Error(
          `Column definition mismatch on "${key}": source has ${srcCol.data_type}/${srcCol.is_nullable}, restored has ${resCol.data_type}/${resCol.is_nullable}`
        );
      }
    }
    console.log(`✅ All ${resCols.rows.length} column definitions verified matching.`);

    // C. Verify row counts and data checksums for each table
    const tableCounts: Record<string, number> = {};
    for (const tbl of resTables) {
      const qTbl = quoteIdent(tbl);
      const srcCountRes = await sourceClient.query(`SELECT COUNT(*)::int AS cnt FROM ${qTbl};`);
      const resCountRes = await verifyClient.query(`SELECT COUNT(*)::int AS cnt FROM ${qTbl};`);

      const srcCount = srcCountRes.rows[0].cnt;
      const resCount = resCountRes.rows[0].cnt;
      tableCounts[tbl] = resCount;

      if (srcCount !== resCount) {
        throw new Error(
          `Row count mismatch on table "${tbl}": source has ${srcCount}, restored has ${resCount}`
        );
      }

      // If table has records, compare deterministic row checksums
      if (srcCount > 0 && !options.skipDataAssertion) {
        const srcChecksum = await sourceClient.query(`SELECT md5(string_agg(t.*::text, '' ORDER BY t.*::text)) AS hash FROM ${qTbl} t;`);
        const resChecksum = await verifyClient.query(`SELECT md5(string_agg(t.*::text, '' ORDER BY t.*::text)) AS hash FROM ${qTbl} t;`);
        if (srcChecksum.rows[0].hash !== resChecksum.rows[0].hash) {
          throw new Error(`Data checksum mismatch on table "${tbl}". Source and restored data differ!`);
        }
      }
    }

    // D. Verify constraints (primary keys, foreign keys, unique constraints, check constraints)
    const constraintQuery = `
      SELECT conname, contype, conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
      ORDER BY conname;
    `;
    const srcConstraints = await sourceClient.query(constraintQuery);
    const resConstraints = await verifyClient.query(constraintQuery);

    const srcConMap = new Map(srcConstraints.rows.map((r) => [`${r.table_name}:${r.conname}`, r.def]));
    const resConMap = new Map(resConstraints.rows.map((r) => [`${r.table_name}:${r.conname}`, r.def]));

    for (const [conKey, srcDef] of srcConMap.entries()) {
      const resDef = resConMap.get(conKey);
      if (!resDef) {
        throw new Error(`Constraint "${conKey}" missing from restored database!`);
      }
      if (srcDef !== resDef) {
        throw new Error(`Constraint definition mismatch on "${conKey}":\nSource: ${srcDef}\nRestored: ${resDef}`);
      }
    }
    console.log(`✅ All ${resConstraints.rows.length} schema constraints and definitions preserved.`);

    // E. Verify indexes (including partial unique indexes and composite indexes)
    const indexQuery = `
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname;
    `;
    const srcIndexes = await sourceClient.query(indexQuery);
    const resIndexes = await verifyClient.query(indexQuery);

    const srcIndexMap = new Map(srcIndexes.rows.map((r) => [r.indexname, r.indexdef]));
    const resIndexMap = new Map(resIndexes.rows.map((r) => [r.indexname, r.indexdef]));

    for (const [idxName, srcDef] of srcIndexMap.entries()) {
      const resDef = resIndexMap.get(idxName);
      if (!resDef) {
        throw new Error(`Index "${idxName}" missing from restored database!`);
      }
      if (srcDef !== resDef) {
        throw new Error(`Index definition mismatch on "${idxName}":\nSource: ${srcDef}\nRestored: ${resDef}`);
      }
    }
    console.log(`✅ All ${resIndexes.rows.length} indexes and definitions preserved.`);

    // F. Verify enum types and values
    const enumQuery = `
      SELECT t.typname, e.enumlabel, e.enumsortorder
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder;
    `;
    const srcEnums = await sourceClient.query(enumQuery);
    const resEnums = await verifyClient.query(enumQuery);

    const srcEnumSet = new Set(srcEnums.rows.map((r) => `${r.typname}:${r.enumlabel}`));
    const resEnumSet = new Set(resEnums.rows.map((r) => `${r.typname}:${r.enumlabel}`));

    for (const item of srcEnumSet) {
      if (!resEnumSet.has(item)) {
        throw new Error(`Enum value "${item}" missing from restored database!`);
      }
    }
    console.log(`✅ All ${resEnums.rows.length} enum labels verified.`);

    // G. Verify application usability on restored database: run relational joins
    if (resTables.includes('Collection') && resTables.includes('User')) {
      const testRelationalQuery = await verifyClient.query(`
        SELECT c.id, c.title, u.username
        FROM "Collection" c
        JOIN "User" u ON c."ownerId" = u.id
        LIMIT 5;
      `);
      console.log(`✅ Relational query usability verified on restored database (${testRelationalQuery.rows.length} rows returned).`);
    }

    console.log('🎉 SUCCESS: PostgreSQL Backup and Restore procedure 100% verified!');

    return {
      success: true,
      sourceDb: conn.database,
      restoredDb: tempDbName,
      dumpFileSize,
      verifiedTables: resTables,
      tableCounts,
      verifiedConstraintsCount: resConstraints.rows.length,
      verifiedIndexesCount: resIndexes.rows.length,
    };
  } catch (err: any) {
    primaryError = err instanceof Error ? err : new Error(String(err));
    throw primaryError;
  } finally {
    // Guaranteed cleanup runs even if assertions or commands throw!
    console.log(`🧹 Running guaranteed cleanup for "${tempDbName}"...`);
    const cleanupErrors: string[] = [];

    if (sourceClient) {
      try {
        await sourceClient.end();
      } catch (err: any) {
        cleanupErrors.push(`Failed to close sourceClient: ${err.message}`);
      }
    }
    if (verifyClient) {
      try {
        await verifyClient.end();
      } catch (err: any) {
        cleanupErrors.push(`Failed to close verifyClient: ${err.message}`);
      }
    }
    if (adminClient) {
      try {
        // Terminate any active connections to tempDbName
        await adminClient.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
          [tempDbName]
        );
        await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(tempDbName)};`);

        // Verify that the temporary database no longer exists
        const checkDb = await adminClient.query(
          `SELECT 1 FROM pg_database WHERE datname = $1;`,
          [tempDbName]
        );
        if (checkDb.rows.length > 0) {
          cleanupErrors.push(`Temporary database "${tempDbName}" was not successfully dropped!`);
        } else {
          console.log(`✅ Temporary restore database "${tempDbName}" successfully dropped and verified.`);
        }
      } catch (cleanupErr: any) {
        cleanupErrors.push(
          `Failed to drop temporary database "${tempDbName}": ${cleanupErr.message}`
        );
      } finally {
        try {
          await adminClient.end();
        } catch (err: any) {
          cleanupErrors.push(`Failed to close adminClient: ${err.message}`);
        }
      }
    }

    if (fs.existsSync(dumpFile)) {
      try {
        fs.unlinkSync(dumpFile);
        if (fs.existsSync(dumpFile)) {
          cleanupErrors.push(`Dump file "${dumpFile}" still exists after unlink!`);
        }
      } catch (err: any) {
        cleanupErrors.push(`Failed to delete dump file "${dumpFile}": ${err.message}`);
      }
    }

    if (cleanupErrors.length > 0) {
      const cleanupMsg = `CLEANUP FAILURE:\n${cleanupErrors.join('\n')}`;
      console.error(`🚨 ${cleanupMsg}`);
      if (primaryError) {
        throw new Error(`PRIMARY FAILURE: ${primaryError.message}\nAND ${cleanupMsg}`);
      } else {
        throw new Error(cleanupMsg);
      }
    }
  }
}

function expectTablesMatch(source: string[], restored: string[]) {
  const missing = source.filter((t) => !restored.includes(t));
  const unexpected = restored.filter((t) => !source.includes(t));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Table mismatch between source and restored database. Missing: [${missing.join(', ')}], Unexpected: [${unexpected.join(', ')}]`
    );
  }
}

async function cli() {
  try {
    const targetUrl = process.argv[2] || process.env.BACKUP_TEST_SOURCE_URL || env.TEST_DATABASE_URL;
    const result = await runBackupRestoreVerification({ sourceUrl: targetUrl });
    if (!result.success) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Backup/restore verification test failed:', err);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes('test_backup_restore')) {
  cli();
}
