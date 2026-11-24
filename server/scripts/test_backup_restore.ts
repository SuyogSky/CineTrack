import 'dotenv/config';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { sanitizeDatabaseUrl } from '../src/config/env';

export interface BackupRestoreOptions {
  sourceUrl?: string;
  expectedDbName?: string;
  expectedHost?: string;
  customDumpPath?: string;
  skipDump?: boolean;
  skipDataAssertion?: boolean;
  injectDumpFailure?: boolean;
  injectRestoreFailure?: boolean;
  injectVerificationFailure?: boolean;
  injectDumpCleanupFailure?: boolean;
  injectDbCleanupFailure?: boolean;
  injectClientShutdownFailure?: boolean;
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

export const IMMUTABLE_APPROVED_TEST_HOSTS = [
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'host.docker.internal',
] as const;

export const IMMUTABLE_EXACT_TEST_DATABASES = [
  'cinetrack_test',
  'cinetrack_ci',
  'cinetrack_e2e',
] as const;

export const IMMUTABLE_DISPOSABLE_PREFIXES = [
  'cinetrack_restore_',
  'cinetrack_disposable_',
] as const;

export function parsePostgresUrl(rawUrl: string): {
  user: string;
  password?: string;
  host: string;
  port: number;
  database: string;
  sslmode?: string;
  ssl?: boolean | object;
} {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error('SECURITY REJECTION: PostgreSQL connection URL cannot be empty or undefined.');
  }

  try {
    const parsed = new URL(rawUrl.trim());
    const sslmode = parsed.searchParams.get('sslmode')?.toLowerCase();
    const sslrootcert = parsed.searchParams.get('sslrootcert');

    let ssl: boolean | object | undefined = undefined;
    if (sslmode === 'disable') {
      ssl = false;
    } else if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
      ssl = {
        rejectUnauthorized: sslmode === 'verify-full' || sslmode === 'verify-ca',
        ...(sslrootcert && fs.existsSync(sslrootcert) ? { ca: fs.readFileSync(sslrootcert).toString() } : {}),
      };
    }

    return {
      user: decodeURIComponent(parsed.username || 'postgres'),
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      host: (parsed.hostname || 'localhost').toLowerCase(),
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      database: parsed.pathname.replace(/^\//, '').split('?')[0] || 'postgres',
      sslmode,
      ssl,
    };
  } catch (err: any) {
    throw new Error(`SECURITY REJECTION: Malformed PostgreSQL connection URL: ${err.message}`);
  }
}

/**
 * Strict immutable host allowlisting.
 * Environment variables CANNOT expand the immutable allowlist.
 */
export function assertApprovedHost(host: string, label: string = 'Host'): void {
  const hostLower = host.toLowerCase().trim();
  const allowed = [...IMMUTABLE_APPROVED_TEST_HOSTS];
  if (!allowed.includes(hostLower as any)) {
    throw new Error(
      `SECURITY REJECTION: ${label} "${host}" is not on the strict immutable allowlist of approved test hosts [${allowed.join(', ')}]. Cross-host operations or unapproved hosts are strictly prohibited.`
    );
  }
}

/**
 * Strict immutable configuration-based allowlist for disposable test databases.
 * Substring matches and broad prefixes (e.g. 'contest', 'cinetrack_production_test') are strictly prohibited.
 * Only exact known test databases or strictly patterned disposable databases are allowed.
 */
export function assertApprovedSourceTestDatabase(dbName: string): void {
  if (!dbName || typeof dbName !== 'string') {
    throw new Error('SECURITY REJECTION: Database name cannot be empty.');
  }
  const lower = dbName.toLowerCase().trim();
  // Reject production / root / live databases
  if (
    ['cinetrack', 'postgres', 'template0', 'template1'].includes(lower) ||
    lower.includes('prod') ||
    lower.includes('live') ||
    lower.includes('main')
  ) {
    throw new Error(
      `SECURITY REJECTION: Database "${dbName}" is a production/root database. Test operations are strictly forbidden.`
    );
  }
  // Source test database MUST be on the exact list of approved test databases
  if (!IMMUTABLE_EXACT_TEST_DATABASES.includes(lower as any)) {
    throw new Error(
      `SECURITY REJECTION: Source test database "${dbName}" is not on the immutable exact test databases list [${IMMUTABLE_EXACT_TEST_DATABASES.join(', ')}]. Broad prefix-based trust is strictly prohibited.`
    );
  }
}

export function assertDisposableTestDatabase(dbName: string, expectedDbName?: string): void {
  if (!dbName || typeof dbName !== 'string' || dbName.trim() === '') {
    throw new Error('SECURITY REJECTION: Database name cannot be empty.');
  }

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

  // Strict allowlist: MUST match exact known test databases or disposable prefix
  const isExactAllowed = IMMUTABLE_EXACT_TEST_DATABASES.includes(lower as any);
  const isStrictDisposablePattern =
    (lower.startsWith('cinetrack_restore_') || lower.startsWith('cinetrack_disposable_')) &&
    /^[a-zA-Z0-9_]+$/.test(lower);

  if (!isExactAllowed && !isStrictDisposablePattern) {
    throw new Error(
      `SECURITY REJECTION: Target database "${dbName}" is not on the strict allowlist of approved test databases [${IMMUTABLE_EXACT_TEST_DATABASES.join(', ')}]. Broad prefix-based trust is strictly prohibited.`
    );
  }

  // If explicit expected database name is configured (e.g. BACKUP_TEST_SOURCE_DATABASE),
  // it must match, but it NEVER bypasses the allowlist check above!
  if (expectedDbName && expectedDbName.trim() !== '') {
    if (lower !== expectedDbName.toLowerCase().trim()) {
      throw new Error(
        `SECURITY REJECTION: Target database "${dbName}" does not match configured expected database "${expectedDbName}".`
      );
    }
  }
}

export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: "${name}"`);
  }
  return `"${name}"`;
}

/**
 * Resolves source database URL without ANY silent fallback to DATABASE_URL or TEST_DATABASE_URL.
 */
export function resolveBackupSourceUrl(optionUrl?: string): string {
  if (optionUrl !== undefined) {
    if (!optionUrl || typeof optionUrl !== 'string' || optionUrl.trim() === '') {
      throw new Error(
        'SECURITY REJECTION: Dedicated backup source URL is missing or empty. Silent fallbacks to DATABASE_URL or TEST_DATABASE_URL are strictly prohibited.'
      );
    }
    return optionUrl.trim();
  }

  const envUrl = process.env.BACKUP_TEST_SOURCE_URL;
  if (!envUrl || envUrl.trim() === '') {
    throw new Error(
      'SECURITY REJECTION: Dedicated backup source URL is required (BACKUP_TEST_SOURCE_URL). Silent fallback to DATABASE_URL or TEST_DATABASE_URL is strictly disabled.'
    );
  }
  return envUrl.trim();
}

/**
 * Resolves admin connection URL ensuring admin host consistency.
 * Cross-host operations are strictly prohibited without bypass.
 */
export function resolveAdminUrl(sourceConn: ReturnType<typeof parsePostgresUrl>): {
  adminConn: ReturnType<typeof parsePostgresUrl>;
  adminUrl: string;
} {
  const envAdmin = process.env.BACKUP_TEST_RESTORE_ADMIN_URL;
  if (envAdmin && envAdmin.trim() !== '') {
    const adminConn = parsePostgresUrl(envAdmin.trim());
    assertApprovedHost(adminConn.host, 'Restore Admin Host');
    if (adminConn.host !== sourceConn.host) {
      throw new Error(
        `SECURITY REJECTION: Restore administration host "${adminConn.host}" does not match source database host "${sourceConn.host}". Silent cross-host operations are strictly prohibited.`
      );
    }
    return { adminConn, adminUrl: envAdmin.trim() };
  }

  // Same-server admin connection targeting postgres maintenance DB
  const defaultAdmin = `postgresql://${encodeURIComponent(sourceConn.user)}${
    sourceConn.password ? ':' + encodeURIComponent(sourceConn.password) : ''
  }@${sourceConn.host}:${sourceConn.port}/postgres`;
  const adminConn = parsePostgresUrl(defaultAdmin);
  assertApprovedHost(adminConn.host, 'Restore Admin Host');
  return { adminConn, adminUrl: defaultAdmin };
}

export function expectTablesMatch(source: string[], restored: string[]) {
  const missing = source.filter((t) => !restored.includes(t));
  const unexpected = restored.filter((t) => !source.includes(t));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Table mismatch between source and restored database. Missing in restored: [${missing.join(', ')}], Unexpected extra in restored: [${unexpected.join(', ')}]`
    );
  }
}

export function compareColumnsBidirectional(srcCols: any[], resCols: any[]) {
  const srcColMap = new Map(srcCols.map((r) => [`${r.table_name}.${r.column_name}`, r]));
  const resColMap = new Map(resCols.map((r) => [`${r.table_name}.${r.column_name}`, r]));

  // Direction 1: source -> restored
  for (const [key, srcCol] of srcColMap.entries()) {
    const resCol = resColMap.get(key);
    if (!resCol) {
      throw new Error(`Column "${key}" missing in restored database.`);
    }
    if (
      srcCol.data_type !== resCol.data_type ||
      srcCol.is_nullable !== resCol.is_nullable ||
      srcCol.udt_name !== resCol.udt_name ||
      srcCol.column_default !== resCol.column_default
    ) {
      throw new Error(
        `Column definition mismatch on "${key}": source has [type=${srcCol.data_type}, nullable=${srcCol.is_nullable}, default=${srcCol.column_default}], restored has [type=${resCol.data_type}, nullable=${resCol.is_nullable}, default=${resCol.column_default}]`
      );
    }
  }

  // Direction 2: restored -> source (detect unexpected extra columns)
  for (const [key] of resColMap.entries()) {
    if (!srcColMap.has(key)) {
      throw new Error(`Unexpected extra column "${key}" found in restored database.`);
    }
  }
}

export function compareConstraintsBidirectional(srcCons: any[], resCons: any[]) {
  const srcConMap = new Map(srcCons.map((r) => [`${r.table_name}:${r.conname}`, r.def]));
  const resConMap = new Map(resCons.map((r) => [`${r.table_name}:${r.conname}`, r.def]));

  // Direction 1: source -> restored
  for (const [conKey, srcDef] of srcConMap.entries()) {
    const resDef = resConMap.get(conKey);
    if (!resDef) {
      throw new Error(`Constraint "${conKey}" missing from restored database!`);
    }
    if (srcDef !== resDef) {
      throw new Error(`Constraint definition mismatch on "${conKey}":\nSource: ${srcDef}\nRestored: ${resDef}`);
    }
  }

  // Direction 2: restored -> source (detect unexpected extra constraints)
  for (const [conKey] of resConMap.entries()) {
    if (!srcConMap.has(conKey)) {
      throw new Error(`Unexpected extra constraint "${conKey}" found in restored database!`);
    }
  }
}

export function compareIndexesBidirectional(srcIdxs: any[], resIdxs: any[]) {
  const srcIndexMap = new Map(srcIdxs.map((r) => [r.indexname, r.indexdef]));
  const resIndexMap = new Map(resIdxs.map((r) => [r.indexname, r.indexdef]));

  // Direction 1: source -> restored
  for (const [idxName, srcDef] of srcIndexMap.entries()) {
    const resDef = resIndexMap.get(idxName);
    if (!resDef) {
      throw new Error(`Index "${idxName}" missing from restored database!`);
    }
    if (srcDef !== resDef) {
      throw new Error(`Index definition mismatch on "${idxName}":\nSource: ${srcDef}\nRestored: ${resDef}`);
    }
  }

  // Direction 2: restored -> source (detect unexpected extra indexes)
  for (const [idxName] of resIndexMap.entries()) {
    if (!srcIndexMap.has(idxName)) {
      throw new Error(`Unexpected extra index "${idxName}" found in restored database!`);
    }
  }
}

export function compareEnumsBidirectional(srcEnums: any[], resEnums: any[]) {
  const srcEnumSet = new Set(srcEnums.map((r) => `${r.typname}:${r.enumlabel}:${r.enumsortorder}`));
  const resEnumSet = new Set(resEnums.map((r) => `${r.typname}:${r.enumlabel}:${r.enumsortorder}`));

  // Direction 1: source -> restored
  for (const item of srcEnumSet) {
    if (!resEnumSet.has(item)) {
      throw new Error(`Enum value "${item}" missing from restored database!`);
    }
  }

  // Direction 2: restored -> source (detect unexpected extra enum values)
  for (const item of resEnumSet) {
    if (!srcEnumSet.has(item)) {
      throw new Error(`Unexpected extra enum value "${item}" found in restored database!`);
    }
  }
}

export async function compareSequencesBidirectional(sourceClient: Client, verifyClient: Client) {
  const seqQuery = `
    SELECT sequence_name, data_type, start_value, minimum_value, maximum_value, increment, cycle_option
    FROM information_schema.sequences
    WHERE sequence_schema = 'public'
    ORDER BY sequence_name;
  `;
  const srcSeqs = await sourceClient.query(seqQuery);
  const resSeqs = await verifyClient.query(seqQuery);

  const srcSeqMap = new Map(srcSeqs.rows.map((r) => [r.sequence_name, r]));
  const resSeqMap = new Map(resSeqs.rows.map((r) => [r.sequence_name, r]));

  for (const [name, srcSeq] of srcSeqMap.entries()) {
    const resSeq = resSeqMap.get(name);
    if (!resSeq) {
      throw new Error(`Sequence "${name}" missing from restored database!`);
    }
    if (srcSeq.increment !== resSeq.increment || srcSeq.start_value !== resSeq.start_value) {
      throw new Error(`Sequence definition mismatch on "${name}".`);
    }
  }
  for (const [name] of resSeqMap.entries()) {
    if (!srcSeqMap.has(name)) {
      throw new Error(`Unexpected extra sequence "${name}" found in restored database!`);
    }
  }
}

/**
 * Computes deterministic table data hash using true keyset pagination (no OFFSET)
 * and row-level SHA-256 in a REPEATABLE READ READ ONLY transaction snapshot.
 * Formats every row via native PostgreSQL `to_jsonb(t)` to ensure cross-platform
 * and cross-session determinism across timestamps, numbers, text, and JSON types.
 * Memory is strictly bounded to `chunkSize` rows at a time in both PostgreSQL and Node.
 * When `inExistingTransaction` is true, relies on the caller's active snapshot without issuing BEGIN/COMMIT.
 */
export async function computeTableChunkedHash(
  client: Client,
  tableName: string,
  chunkSize: number = 500,
  inExistingTransaction: boolean = false
): Promise<{ rowCount: number; tableHash: string }> {
  const qTbl = quoteIdent(tableName);

  // Discover primary key columns for deterministic keyset pagination/ordering
  const pkRes = await client.query(
    `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = $1
    ORDER BY kcu.ordinal_position;
  `,
    [tableName]
  );
  let pkRawCols = pkRes.rows.map((r: { column_name: string }) => r.column_name);
  let pkCols = pkRawCols.map((c: string) => quoteIdent(c));

  // If table lacks explicit PK, fallback to physical tuple identifier ctid for keyset ordering
  if (pkCols.length === 0) {
    pkRawCols = ['ctid'];
    pkCols = ['ctid'];
  }

  // Consistent transaction snapshot: REPEATABLE READ READ ONLY
  if (!inExistingTransaction) {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
  }

  try {
    const countRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${qTbl};`);
    const totalRows = countRes.rows[0].cnt;

    if (totalRows === 0) {
      return {
        rowCount: 0,
        tableHash: crypto.createHash('sha256').update('EMPTY_TABLE').digest('hex'),
      };
    }

    const tableHasher = crypto.createHash('sha256');
    let processedRows = 0;
    let lastCursor: any[] | null = null;

    const isSinglePk = pkCols.length === 1;
    const orderByClause = pkCols.map((c) => `${c} ASC`).join(', ');

    while (processedRows < totalRows) {
      let chunkRes;

      if (!lastCursor) {
        // First batch: start from the beginning
        chunkRes = await client.query(
          `
          SELECT ${pkCols.join(', ')}, encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash
          FROM (
            SELECT * FROM ${qTbl}
            ORDER BY ${orderByClause}
            LIMIT $1
          ) t;
        `,
          [chunkSize]
        );
      } else {
        // Keyset pagination: NO OFFSET!
        if (isSinglePk) {
          chunkRes = await client.query(
            `
            SELECT ${pkCols[0]}, encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash
            FROM (
              SELECT * FROM ${qTbl}
              WHERE ${pkCols[0]} > $1
              ORDER BY ${orderByClause}
              LIMIT $2
            ) t;
          `,
            [lastCursor[0], chunkSize]
          );
        } else {
          // Composite PK row-value tuple comparison: (pk1, pk2, ...) > ($1, $2, ...)
          const placeholders = pkCols.map((_, idx) => `$${idx + 1}`).join(', ');
          const limitIdx = pkCols.length + 1;
          chunkRes = await client.query(
            `
            SELECT ${pkCols.join(', ')}, encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash
            FROM (
              SELECT * FROM ${qTbl}
              WHERE (${pkCols.join(', ')}) > (${placeholders})
              ORDER BY ${orderByClause}
              LIMIT $${limitIdx}
            ) t;
          `,
            [...lastCursor, chunkSize]
          );
        }
      }

      if (chunkRes.rows.length === 0) {
        break;
      }

      for (const row of chunkRes.rows) {
        tableHasher.update(row.row_hash);
      }

      processedRows += chunkRes.rows.length;

      // Extract cursor from the last row of the batch
      const lastRow: Record<string, any> = chunkRes.rows[chunkRes.rows.length - 1];
      lastCursor = pkRawCols.map((col: string) => lastRow[col]);

      if (chunkRes.rows.length < chunkSize) {
        break;
      }
    }

    return {
      rowCount: processedRows,
      tableHash: tableHasher.digest('hex'),
    };
  } finally {
    if (!inExistingTransaction) {
      try {
        await client.query('COMMIT;');
      } catch {}
    }
  }
}

export async function runBackupRestoreVerification(
  options: BackupRestoreOptions = {}
): Promise<BackupRestoreResult> {
  console.log('🧪 Starting CineTrack Real PostgreSQL Backup and Restore Test...');

  // 1. Resolve source database URL: do NOT silently fall back to DATABASE_URL or TEST_DATABASE_URL
  const sourceUrl = resolveBackupSourceUrl(options.sourceUrl);
  const conn = parsePostgresUrl(sourceUrl);

  // Validate host against explicit allowlist
  assertApprovedHost(conn.host, 'Source Database Host');

  assertApprovedSourceTestDatabase(conn.database);
  if (options.expectedDbName && conn.database.toLowerCase() !== options.expectedDbName.toLowerCase()) {
    throw new Error(
      `SECURITY REJECTION: Target database "${conn.database}" does not match configured expected database "${options.expectedDbName}".`
    );
  }

  console.log(`🔒 Source test database validated: "${conn.database}" on ${conn.host}:${conn.port}`);

  // Resolve admin connection and verify admin host consistency
  const { adminConn } = resolveAdminUrl(conn);

  // Tool compatibility check
  try {
    const dumpVer = execFileSync('pg_dump', ['--version'], { stdio: 'pipe' }).toString().trim();
    const restoreVer = execFileSync('pg_restore', ['--version'], { stdio: 'pipe' }).toString().trim();
    console.log(`🛠️ Verified PostgreSQL toolchain: ${dumpVer} / ${restoreVer}`);
  } catch (toolErr: any) {
    throw new Error(`PostgreSQL toolchain check failed (pg_dump or pg_restore not available): ${toolErr.message}`);
  }

  const restorePrefix = 'cinetrack_restore_';
  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempDbName = `${restorePrefix}${Date.now()}_${randomSuffix}`;

  // Prevent source and restore from ever being the same database
  if (tempDbName === conn.database) {
    throw new Error(
      `SECURITY REJECTION: Source database "${conn.database}" and restore target "${tempDbName}" must not be identical.`
    );
  }
  assertDisposableTestDatabase(tempDbName);

  const isGeneratedDump = !options.customDumpPath;
  const dumpFile =
    options.customDumpPath ||
    path.resolve(__dirname, '..', `temp_backup_${Date.now()}_${randomSuffix}.dump`);

  const dumpEnv = {
    ...process.env,
    PGPASSWORD: conn.password || '',
    ...(conn.sslmode ? { PGSSLMODE: conn.sslmode } : {}),
  };

  const restoreEnv = {
    ...process.env,
    PGPASSWORD: adminConn.password || '',
    ...(adminConn.sslmode ? { PGSSLMODE: adminConn.sslmode } : {}),
  };

  let adminClient: Client | null = null;
  let verifyClient: Client | null = null;
  let sourceClient: Client | null = null;
  let primaryError: Error | null = null;
  let tempDbCreated = false;
  let processOwnedRestoreDatabase: string | null = null;

  try {
    // 2. Connect to source database and verify live PostgreSQL connection identity
    sourceClient = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      connectionTimeoutMillis: 5000,
      ssl: conn.ssl,
    });
    await sourceClient.connect();

    const identityRes = await sourceClient.query(`
      SELECT 
        current_database() AS current_db,
        current_user AS current_user,
        inet_server_addr() AS server_addr,
        inet_server_port() AS server_port,
        version() AS version;
    `);

    const liveDb = identityRes.rows[0]?.current_db;
    const liveUser = identityRes.rows[0]?.current_user;
    const liveServerAddr = identityRes.rows[0]?.server_addr?.toString();
    const liveServerPort = identityRes.rows[0]?.server_port;

    console.log(`🔒 Live PostgreSQL connection verified: DB="${liveDb}", User="${liveUser}", Server="${liveServerAddr || conn.host}:${liveServerPort || conn.port}"`);

    // Strict fail-closed verification of socket identity
    const isExplicitUnixSocket = conn.host.startsWith('/') || conn.host === '' || conn.host === 'socket';
    if (!liveServerAddr) {
      if (!isExplicitUnixSocket) {
        throw new Error(
          'SECURITY REJECTION: Source database socket identity could not be verified (inet_server_addr() returned null). Cross-host or untrusted socket connections are strictly prohibited.'
        );
      }
      console.log('🔒 Verified local Unix domain socket connection to PostgreSQL.');
    } else {
      const allowedAddrs = ['127.0.0.1', '::1', '172.17.0.1', 'localhost'];
      if (!allowedAddrs.includes(liveServerAddr) && liveServerAddr !== conn.host) {
        throw new Error(
          `SECURITY REJECTION: Connected server IP "${liveServerAddr}" does not match approved local IP addresses [${allowedAddrs.join(', ')}].`
        );
      }
    }

    if (liveDb !== conn.database) {
      throw new Error(
        `SECURITY REJECTION: Live connected database "${liveDb}" does not match configured target "${conn.database}". Connection aborted.`
      );
    }
    assertApprovedSourceTestDatabase(liveDb);

    if (options.expectedHost && conn.host !== options.expectedHost) {
      throw new Error(
        `SECURITY REJECTION: Connected host "${conn.host}" does not match expected host "${options.expectedHost}".`
      );
    }

    // 3. Prepare dump file
    if (!options.skipDump) {
      if (isGeneratedDump && fs.existsSync(dumpFile)) {
        fs.unlinkSync(dumpFile);
      }

      if (options.injectDumpFailure) {
        throw new Error('Injected simulated pg_dump execution failure');
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
          { env: dumpEnv, stdio: 'pipe', timeout: 60000 }
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
    adminClient = new Client({
      host: adminConn.host,
      port: adminConn.port,
      user: adminConn.user,
      password: adminConn.password,
      database: adminConn.database,
      connectionTimeoutMillis: 5000,
      ssl: adminConn.ssl,
    });
    await adminClient.connect();

    // Verify admin identity: strictly fail-closed
    const adminIdentityRes = await adminClient.query(`
      SELECT current_database() AS current_db, current_user AS current_user, inet_server_addr() AS server_addr;
    `);
    const adminServerAddr = adminIdentityRes.rows[0]?.server_addr?.toString();
    console.log(`🔒 Admin connected to "${adminIdentityRes.rows[0]?.current_db}" on ${adminConn.host}`);

    if (!adminServerAddr) {
      if (!isExplicitUnixSocket) {
        throw new Error(
          'SECURITY REJECTION: Admin database socket identity could not be verified (inet_server_addr() returned null on TCP connection). Cross-host or untrusted socket connections are strictly prohibited.'
        );
      }
    } else {
      if (liveServerAddr !== adminServerAddr) {
        throw new Error(
          `SECURITY REJECTION: Admin server address "${adminServerAddr}" does not match source server address "${liveServerAddr}". Cross-host operations are strictly prohibited.`
        );
      }
    }

    await adminClient.query(`CREATE DATABASE ${quoteIdent(tempDbName)};`);
    tempDbCreated = true;
    processOwnedRestoreDatabase = tempDbName;

    if (options.injectRestoreFailure) {
      throw new Error('Injected simulated pg_restore execution failure');
    }

    // 6. Perform pg_restore into disposable database using direct arguments array with admin credentials
    console.log(`📥 Executing pg_restore into "${tempDbName}"...`);
    try {
      execFileSync(
        'pg_restore',
        [
          '-h', adminConn.host,
          '-p', String(adminConn.port),
          '-U', adminConn.user,
          '-d', tempDbName,
          '--no-owner',
          '--clean',
          '--if-exists',
          dumpFile,
        ],
        { env: restoreEnv, stdio: 'pipe', timeout: 60000 }
      );
    } catch (restoreErr: any) {
      const stderr = restoreErr?.stderr?.toString() || restoreErr?.message || 'Unknown pg_restore error';
      throw new Error(`pg_restore failed with exit code ${restoreErr?.status ?? 'unknown'}: ${stderr}`);
    }

    // 7. Connect to restored database to perform comprehensive schema and data verification
    console.log(`🔍 Comparing source "${conn.database}" and restored "${tempDbName}"...`);
    verifyClient = new Client({
      host: adminConn.host,
      port: adminConn.port,
      user: adminConn.user,
      password: adminConn.password,
      database: tempDbName,
      connectionTimeoutMillis: 5000,
      ssl: adminConn.ssl,
    });
    await verifyClient.connect();

    // Verify restore client identity: strictly fail-closed
    const verifyIdentityRes = await verifyClient.query(`
      SELECT current_database() AS current_db, current_user AS current_user, inet_server_addr() AS server_addr;
    `);
    const verifyDb = verifyIdentityRes.rows[0]?.current_db;
    const verifyServerAddr = verifyIdentityRes.rows[0]?.server_addr?.toString();

    if (verifyDb !== tempDbName) {
      throw new Error(
        `SECURITY REJECTION: Connected restore database "${verifyDb}" does not match temporary target "${tempDbName}". Aborting verification.`
      );
    }
    if (!verifyServerAddr) {
      if (!isExplicitUnixSocket) {
        throw new Error(
          'SECURITY REJECTION: Restored database socket identity could not be verified (inet_server_addr() returned null on TCP connection). Cross-host or untrusted socket connections are strictly prohibited.'
        );
      }
    } else {
      if (verifyServerAddr !== liveServerAddr) {
        throw new Error(
          `SECURITY REJECTION: Restored server address "${verifyServerAddr}" does not match source server address "${liveServerAddr}".`
        );
      }
    }

    if (options.injectVerificationFailure) {
      throw new Error('Injected simulated verification assertion failure');
    }

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
    console.log(`✅ All ${resTables.length} tables matched bidirectionally between source and restored database.`);

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

    // B. Verify column definitions bidirectionally
    const colQuery = `
      SELECT table_name, column_name, data_type, is_nullable, column_default, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, column_name;
    `;
    const srcCols = await sourceClient.query(colQuery);
    const resCols = await verifyClient.query(colQuery);

    compareColumnsBidirectional(srcCols.rows, resCols.rows);
    console.log(`✅ All ${resCols.rows.length} column definitions verified bidirectionally matching.`);

    // C. Verify row counts and chunked cryptographic SHA-256 hashes for each table within a consistent snapshot
    const tableCounts: Record<string, number> = {};
    await sourceClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    await verifyClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');

    try {
      for (const tbl of resTables) {
        const srcHashRes = await computeTableChunkedHash(sourceClient, tbl, 500, true);
        const resHashRes = await computeTableChunkedHash(verifyClient, tbl, 500, true);

        tableCounts[tbl] = resHashRes.rowCount;

        if (srcHashRes.rowCount !== resHashRes.rowCount) {
          throw new Error(
            `Row count mismatch on table "${tbl}": source has ${srcHashRes.rowCount}, restored has ${resHashRes.rowCount}`
          );
        }

        if (!options.skipDataAssertion && srcHashRes.tableHash !== resHashRes.tableHash) {
          throw new Error(`Data checksum mismatch on table "${tbl}". Source and restored data differ!`);
        }
      }
      await sourceClient.query('COMMIT;');
      await verifyClient.query('COMMIT;');
    } catch (err) {
      try {
        await sourceClient.query('ROLLBACK;');
      } catch {}
      try {
        await verifyClient.query('ROLLBACK;');
      } catch {}
      throw err;
    }

    // D. Verify constraints bidirectionally
    const constraintQuery = `
      SELECT conname, contype, conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
      ORDER BY conname;
    `;
    const srcConstraints = await sourceClient.query(constraintQuery);
    const resConstraints = await verifyClient.query(constraintQuery);

    compareConstraintsBidirectional(srcConstraints.rows, resConstraints.rows);
    console.log(`✅ All ${resConstraints.rows.length} schema constraints and definitions preserved bidirectionally.`);

    // E. Verify indexes bidirectionally
    const indexQuery = `
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname;
    `;
    const srcIndexes = await sourceClient.query(indexQuery);
    const resIndexes = await verifyClient.query(indexQuery);

    compareIndexesBidirectional(srcIndexes.rows, resIndexes.rows);
    console.log(`✅ All ${resIndexes.rows.length} indexes and definitions preserved bidirectionally.`);

    // F. Verify enum types and values bidirectionally
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

    compareEnumsBidirectional(srcEnums.rows, resEnums.rows);
    console.log(`✅ All ${resEnums.rows.length} enum labels verified bidirectionally.`);

    // G. Verify sequences bidirectionally
    await compareSequencesBidirectional(sourceClient, verifyClient);

    // H. Verify application usability on restored database: run relational joins
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
    // Structured cleanup runs in finally block; tracks created resources and bubbles errors
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

    if (tempDbCreated && adminClient && processOwnedRestoreDatabase) {
      const dbToDrop = processOwnedRestoreDatabase;
      if (dbToDrop !== tempDbName) {
        cleanupErrors.push(
          `SECURITY REJECTION: Process-owned restore database "${dbToDrop}" does not match tracked temporary target "${tempDbName}". Refusing to drop unowned database.`
        );
      } else {
        try {
          assertDisposableTestDatabase(dbToDrop);
          if (options.injectDbCleanupFailure) {
            throw new Error('Injected simulated database drop failure');
          }
          // Terminate any active connections to dbToDrop
          await adminClient.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
            [dbToDrop]
          );
          await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbToDrop)};`);

          // Verify that the temporary database no longer exists
          const checkDb = await adminClient.query(
            `SELECT 1 FROM pg_database WHERE datname = $1;`,
            [dbToDrop]
          );
          if (checkDb.rows.length > 0) {
            cleanupErrors.push(`Temporary database "${dbToDrop}" was not successfully dropped!`);
          } else {
            console.log(`✅ Temporary restore database "${dbToDrop}" successfully dropped and verified.`);
            processOwnedRestoreDatabase = null;
          }
        } catch (cleanupErr: any) {
          cleanupErrors.push(
            `Failed to drop temporary database "${dbToDrop}": ${cleanupErr.message}`
          );
        }
      }
    }

    if (adminClient) {
      try {
        if (options.injectClientShutdownFailure) {
          throw new Error('Injected simulated adminClient shutdown failure');
        }
        await adminClient.end();
      } catch (err: any) {
        cleanupErrors.push(`Failed to close adminClient: ${err.message}`);
      }
    }

    if (isGeneratedDump && fs.existsSync(dumpFile)) {
      try {
        if (options.injectDumpCleanupFailure) {
          throw new Error('Injected simulated dump file deletion failure');
        }
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

async function cli() {
  try {
    const targetUrl = process.argv[2] || process.env.BACKUP_TEST_SOURCE_URL;
    if (!targetUrl) {
      console.error('❌ Missing target URL: pass as CLI argument or set BACKUP_TEST_SOURCE_URL.');
      process.exit(1);
    }
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
