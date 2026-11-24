import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { Client } from 'pg';
import {
  parsePostgresUrl,
  quoteIdent,
  assertDisposableTestDatabase,
  assertApprovedHost,
  computeTableChunkedHash,
} from './test_backup_restore';
import {
  encryptBackupFile,
  decryptBackupFile,
  atomicPublishNoClobber,
  setRestrictiveFileMode,
  setRestrictiveDirMode,
  secureWindowsAcl,
  verifyWindowsAcl,
  cleanupAbandonedStagingFiles,
} from './backup_crypto';
import { validateWatchedStatusCheckConstraint } from './migration_preflight';
import {
  CINETRACK_SCHEMA_MANIFEST,
  normalizeDefaultExpression,
  validateWatchedStatusConstraintSemantics,
} from './schema_manifest';

export interface BackupConfig {
  databaseUrl?: string;
  outputDir?: string;
  encryptionPassphrase?: string;
  retentionDays?: number;
  webhookUrl?: string;
  isPreMigration?: boolean;
  verifyRestore?: boolean;
  adminUrl?: string;
  minBackupsToKeep?: number;
}

export interface SourceDatabaseStats {
  tables: string[];
  rowCounts: Record<string, number>;
  tableHashes: Record<string, string>;
  totalRows: number;
}

export interface RestoreVerificationResult {
  status: 'VERIFIED' | 'FAILED' | 'SKIPPED';
  verifiedAt?: string;
  durationMs?: number;
  error?: string;
  disposableDbName?: string;
  verifiedTablesCount?: number;
  verifiedTables?: string[];
  tableRowCounts?: Record<string, number>;
  checksumsVerified?: boolean;
}

export interface BackupMetadata {
  id: string;
  timestamp: string;
  databaseName: string;
  host: string;
  port: number;
  rawSize: number;
  encryptedSize: number;
  rawSha256: string;
  encryptedSha256: string;
  isPreMigration: boolean;
  durationMs: number;
  status: 'SUCCESS' | 'FAILED';
  error?: string;
  archivePath: string;
  metaPath: string;
  sourceStats?: SourceDatabaseStats;
  restoreVerification?: RestoreVerificationResult;
}

export interface RetentionOptions {
  minBackupsToKeep?: number;
}

export interface RetentionResult {
  kept: string[];
  pruned: string[];
}

/**
 * Calculates SHA-256 of a file using streaming I/O.
 * Memory usage is strictly bounded (64KB chunks) regardless of dump file size.
 */
export function calculateFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found for SHA-256 calculation: "${filePath}"`));
    }
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Validates production database connection and fetches live identity.
 */
export async function verifyProductionDatabase(databaseUrl: string): Promise<{ dbName: string; host: string; port: number; version: string }> {
  const conn = parsePostgresUrl(databaseUrl);
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectionTimeoutMillis: 5000,
    ssl: conn.ssl,
  });

  try {
    await client.connect();
    const res = await client.query('SELECT current_database() AS db_name, version() AS version;');
    const dbName = res.rows[0]?.db_name || conn.database;
    const version = res.rows[0]?.version || 'unknown';
    return {
      dbName,
      host: conn.host,
      port: conn.port,
      version,
    };
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

/**
 * Strictly regex matches CineTrack managed backup files.
 * Supports both collision-resistant files with 8-hex random suffix and legacy unsuffixed files.
 * Example:
 * - cinetrack_20261124_083000_a1b2c3d4.dump.enc
 * - cinetrack_20261124_083000_a1b2c3d4.pre_migration.dump.enc
 * - cinetrack_20261123_140000.dump.enc
 * - cinetrack_20261123_140000.pre_migration.dump.enc
 */
export const BACKUP_FILE_REGEX = /^cinetrack_(\d{8}_\d{6})(?:_([0-9a-fA-F]{8}))?(\.pre_migration)?\.dump\.enc$/;

/**
 * Applies retention policy to managed backup archives.
 * SAFETY RULES:
 * 1. Only processes files strictly matching BACKUP_FILE_REGEX.
 * 2. Backups without a valid, parseable .meta.json or with status !== 'SUCCESS' are classified as INVALID.
 * 3. Invalid archives are NEVER selected as the newest valid backup.
 * 4. Invalid archives NEVER cause older valid backups to be deleted.
 * 5. NEVER deletes the newest valid (last known good) backup, even if older than retention window.
 * 6. Preserves a configurable minimum number of valid backups (default: 3).
 * 7. Pruning strictly deletes matching .meta.json alongside the archive.
 * 8. Non-CineTrack or foreign files in outputDir are strictly ignored.
 */
export function applyBackupRetention(
  outputDir: string,
  retentionDays: number = 30,
  options: RetentionOptions = {}
): RetentionResult {
  if (!fs.existsSync(outputDir)) {
    return { kept: [], pruned: [] };
  }

  const minKeep = options.minBackupsToKeep ?? parseInt(process.env.BACKUP_MIN_KEEP || '3', 10);
  const entries = fs.readdirSync(outputDir);
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  interface ArchiveRecord {
    name: string;
    fullPath: string;
    metaPath: string;
    mtimeMs: number;
    isValid: boolean;
    isVerified: boolean;
    reason?: string;
  }

  const records: ArchiveRecord[] = [];

  for (const file of entries) {
    if (BACKUP_FILE_REGEX.test(file)) {
      const fullPath = path.join(outputDir, file);
      const metaPath = `${fullPath}.meta.json`;

      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size === 0) {
          records.push({
            name: file,
            fullPath,
            metaPath,
            mtimeMs: stat.mtimeMs,
            isValid: false,
            isVerified: false,
            reason: 'Empty or non-regular archive file',
          });
          continue;
        }

        // Validate manifest exists
        if (!fs.existsSync(metaPath)) {
          records.push({
            name: file,
            fullPath,
            metaPath,
            mtimeMs: stat.mtimeMs,
            isValid: false,
            isVerified: false,
            reason: 'Missing metadata manifest (.meta.json)',
          });
          continue;
        }

        let metaContent: any;
        try {
          metaContent = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch {
          records.push({
            name: file,
            fullPath,
            metaPath,
            mtimeMs: stat.mtimeMs,
            isValid: false,
            isVerified: false,
            reason: 'Malformed JSON in metadata manifest',
          });
          continue;
        }

        // Validate manifest structure and status
        if (!metaContent || typeof metaContent !== 'object') {
          records.push({
            name: file,
            fullPath,
            metaPath,
            mtimeMs: stat.mtimeMs,
            isValid: false,
            isVerified: false,
            reason: 'Invalid metadata manifest object',
          });
          continue;
        }

        if (metaContent.status !== 'SUCCESS') {
          records.push({
            name: file,
            fullPath,
            metaPath,
            mtimeMs: stat.mtimeMs,
            isValid: false,
            isVerified: false,
            reason: `Metadata status is "${metaContent.status}" (expected "SUCCESS")`,
          });
          continue;
        }

        if (metaContent.restoreVerification?.status === 'FAILED') {
          records.push({
            name: file,
            fullPath,
            metaPath,
            mtimeMs: stat.mtimeMs,
            isValid: false,
            isVerified: false,
            reason: 'Restore verification status is FAILED',
          });
          continue;
        }

        const isVerified = metaContent.restoreVerification?.status === 'VERIFIED';
        records.push({
          name: file,
          fullPath,
          metaPath,
          mtimeMs: stat.mtimeMs,
          isValid: true,
          isVerified,
        });
      } catch {
        // File may have been concurrently removed
      }
    }
  }

  // Separate valid and invalid archives
  const validBackups = records.filter((r) => r.isValid).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const invalidBackups = records.filter((r) => !r.isValid).sort((a, b) => b.mtimeMs - a.mtimeMs);

  const kept: string[] = [];
  const pruned: string[] = [];

  // RULE: The newest valid backup is the "last known good" backup and MUST NEVER BE DELETED!
  const lastKnownGood = validBackups[0] || null;

  // Process valid backups:
  validBackups.forEach((b, index) => {
    const isNewestValid = lastKnownGood && b.name === lastKnownGood.name;
    const isWithinMinKeep = index < minKeep;
    const isWithinRetention = b.mtimeMs >= cutoffTime;

    if (isNewestValid || isWithinMinKeep || isWithinRetention) {
      kept.push(b.name);
      if (isNewestValid) {
        console.log(`[Retention] Preserving last known-good valid backup: "${b.name}"`);
      } else if (isWithinMinKeep) {
        console.log(`[Retention] Preserving valid backup "${b.name}" to satisfy minimum keep threshold (${minKeep})`);
      }
    } else {
      // Safe to prune
      try {
        fs.unlinkSync(b.fullPath);
        pruned.push(b.name);
        if (fs.existsSync(b.metaPath)) {
          fs.unlinkSync(b.metaPath);
        }
        console.log(`[Retention] Pruned expired valid backup: "${b.name}"`);
      } catch (err: any) {
        console.error(`⚠️ [Retention] Failed to prune expired backup "${b.name}":`, err.message);
        kept.push(b.name);
      }
    }
  });

  // Process invalid backups:
  // Invalid archives must NEVER cause valid backups to be deleted.
  // If an invalid archive is older than cutoffTime, it can be pruned safely.
  for (const b of invalidBackups) {
    console.warn(`[Retention] Invalid backup archive detected: "${b.name}" (Reason: ${b.reason})`);
    if (b.mtimeMs < cutoffTime) {
      try {
        fs.unlinkSync(b.fullPath);
        pruned.push(b.name);
        if (fs.existsSync(b.metaPath)) {
          fs.unlinkSync(b.metaPath);
        }
        console.log(`[Retention] Pruned expired invalid backup: "${b.name}"`);
      } catch (err: any) {
        kept.push(b.name);
      }
    } else {
      kept.push(b.name);
    }
  }

  return { kept, pruned };
}

/**
 * Sends a webhook notification without leaking credentials or secrets.
 */
async function sendWebhookNotification(webhookUrl: string, payload: object): Promise<void> {
  try {
    const body = JSON.stringify(payload);
    // Use native fetch (available in Node.js 18+)
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err: any) {
    console.error(`⚠️ Webhook notification dispatch failed: ${err.message}`);
  }
}

export const ALL_EXPECTED_APP_TABLES = [
  'User',
  'Movie',
  'Collection',
  'CollectionMovie',
  'CollectionMember',
  'CollaborationInvitation',
  'Session',
  '_prisma_migrations',
] as const;

/**
 * Executes a full production database backup with native pg_dump -F c,
 * authenticated AES-256-GCM encryption, streaming SHA-256 calculation,
 * atomic no-clobber staging, metadata manifest generation,
 * mandatory restore verification by default, and retention policy enforcement.
 */
export async function executeProductionBackup(config: BackupConfig = {}): Promise<BackupMetadata> {
  const startTime = Date.now();
  const rawDbUrl = config.databaseUrl || process.env.DATABASE_URL;
  if (!rawDbUrl || rawDbUrl.trim() === '') {
    throw new Error('DATABASE_URL is required to perform production backup.');
  }

  const passphrase =
    config.encryptionPassphrase ||
    process.env.BACKUP_ENCRYPTION_PASSPHRASE ||
    process.env.BACKUP_ENCRYPTION_KEY;
  if (!passphrase || passphrase.trim().length === 0) {
    throw new Error(
      'BACKUP_ENCRYPTION_PASSPHRASE (or BACKUP_ENCRYPTION_KEY) is strictly required to encrypt production backups.'
    );
  }

  const outputDir = path.resolve(
    config.outputDir || process.env.BACKUP_OUTPUT_DIR || path.resolve(__dirname, '../backups')
  );
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    setRestrictiveDirMode(outputDir, 0o700);
  }

  const conn = parsePostgresUrl(rawDbUrl);
  const { dbName, host, port, version } = await verifyProductionDatabase(rawDbUrl);
  console.log(`📦 Starting CineTrack production backup for "${dbName}" (${version}) on ${host}:${port}...`);

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestampStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const tag = config.isPreMigration ? '.pre_migration' : '';

  // Collision-resistant backup identifier format: cinetrack_<TIMESTAMP>_<RANDOM_HEX>[.pre_migration]
  const backupId = `cinetrack_${timestampStr}_${randomSuffix}${tag}`;

  // Dedicated application-owned secure staging directory for unencrypted database dumps
  const stagingDir = path.join(outputDir, '.cinetrack_staging');
  if (!fs.existsSync(stagingDir)) {
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  }
  setRestrictiveDirMode(stagingDir, 0o700);
  if (process.platform === 'win32') {
    const dirAcl = verifyWindowsAcl(stagingDir);
    if (!dirAcl.protected) {
      throw new Error(`NTFS ACL protection verification failed for staging directory "${stagingDir}".`);
    }
  }

  // Pre-create unencrypted staging dump file with restrictive permissions before pg_dump writes any data
  const rawDumpTemp = path.join(stagingDir, `cinetrack_dump_${backupId}_${crypto.randomBytes(6).toString('hex')}.tmp`);
  const rawFd = fs.openSync(rawDumpTemp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  fs.closeSync(rawFd);
  setRestrictiveFileMode(rawDumpTemp, 0o600);
  if (process.platform === 'win32') {
    const fileAcl = verifyWindowsAcl(rawDumpTemp);
    if (!fileAcl.protected) {
      throw new Error(`NTFS ACL protection verification failed for staging dump file "${rawDumpTemp}".`);
    }
  }

  const finalEncryptedFile = path.join(outputDir, `${backupId}.dump.enc`);
  const tempEncryptedFile = path.join(outputDir, `${backupId}.dump.enc.tmp.${crypto.randomBytes(6).toString('hex')}`);
  const finalMetaFile = path.join(outputDir, `${backupId}.dump.enc.meta.json`);
  const tempMetaFile = path.join(outputDir, `${backupId}.dump.enc.meta.json.tmp.${crypto.randomBytes(6).toString('hex')}`);

  const dumpEnv = {
    ...process.env,
    PGPASSWORD: conn.password || '',
    ...(conn.sslmode ? { PGSSLMODE: conn.sslmode } : {}),
  };

  // 1. Establish statClient and export coordinated PostgreSQL snapshot for atomic lockstep backup
  const sourceStats: SourceDatabaseStats = {
    tables: [],
    rowCounts: {},
    tableHashes: {},
    totalRows: 0,
  };

  const statClient = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectionTimeoutMillis: 5000,
    ssl: conn.ssl,
  });

  let snapshotId: string | null = null;
  let statClientClosed = false;

  try {
    await statClient.connect();
    await statClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    const snapRes = await statClient.query('SELECT pg_export_snapshot() AS snapshot_id;');
    snapshotId = snapRes.rows[0]?.snapshot_id || null;
    if (!snapshotId) {
      throw new Error('Failed to export transaction snapshot via pg_export_snapshot().');
    }
    console.log(`📸 Coordinated transaction snapshot exported: "${snapshotId}"`);

    // Capture source stats within the exact same exported snapshot transaction
    const tRes = await statClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    sourceStats.tables = tRes.rows.map((r: { table_name: string }) => r.table_name);

    let sumRows = 0;
    for (const tbl of sourceStats.tables) {
      const cRes = await statClient.query(`SELECT COUNT(*)::int AS cnt FROM ${quoteIdent(tbl)};`);
      const rowCount = cRes.rows[0]?.cnt || 0;
      sourceStats.rowCounts[tbl] = rowCount;
      sumRows += rowCount;

      const hashRes = await computeTableChunkedHash(statClient, tbl, 500, true);
      sourceStats.tableHashes[tbl] = hashRes.tableHash;
    }
    sourceStats.totalRows = sumRows;

    // 2. Generate custom-format pg_dump using the exact same exported snapshot
    console.log(`📥 Executing coordinated pg_dump -F c --snapshot="${snapshotId}" for "${dbName}"...`);
    execFileSync(
      'pg_dump',
      [
        '-h', conn.host,
        '-p', String(conn.port),
        '-U', conn.user,
        '-F', 'c',
        '-b',
        '--snapshot', snapshotId,
        '-f', rawDumpTemp,
        conn.database,
      ],
      { env: dumpEnv, stdio: 'pipe', timeout: 300000 }
    );

    // Commit snapshot transaction now that pg_dump and sourceStats have both completed
    await statClient.query('COMMIT;');
    await statClient.end();
    statClientClosed = true;

    if (!fs.existsSync(rawDumpTemp) || fs.statSync(rawDumpTemp).size === 0) {
      throw new Error('pg_dump produced an empty or missing snapshot file.');
    }
    setRestrictiveFileMode(rawDumpTemp, 0o600);

    const rawStat = fs.statSync(rawDumpTemp);
    // Bounded streaming SHA-256 calculation (zero readFileSync full memory loading)
    const rawSha256 = await calculateFileSha256(rawDumpTemp);

    // 3. Encrypt raw snapshot into temporary file with authenticated AES-256-GCM + PBKDF2 (600,000 iter, CTBK02)
    console.log(`🔒 Encrypting snapshot with Authenticated AES-256-GCM (PBKDF2 600k, CTBK02)...`);
    await encryptBackupFile(rawDumpTemp, tempEncryptedFile, passphrase);

    // Atomic no-clobber placement: hardlink/O_EXCL ensures destination cannot be clobbered
    atomicPublishNoClobber(tempEncryptedFile, finalEncryptedFile);
    setRestrictiveFileMode(finalEncryptedFile, 0o600);

    const encStat = fs.statSync(finalEncryptedFile);
    // Bounded streaming SHA-256 calculation on encrypted archive
    const encryptedSha256 = await calculateFileSha256(finalEncryptedFile);

    // 4. Clean up unencrypted raw dump from disk immediately and verify cleanup
    let plaintextCleanupFailed = false;
    let plaintextCleanupError = '';
    try {
      if (fs.existsSync(rawDumpTemp)) {
        fs.unlinkSync(rawDumpTemp);
      }
    } catch (cleanupErr: any) {
      plaintextCleanupFailed = true;
      plaintextCleanupError = cleanupErr.message;
    }

    if (plaintextCleanupFailed || fs.existsSync(rawDumpTemp)) {
      const failMsg = `CRITICAL_SECURITY_FAILURE: Plaintext database dump cleanup failed for "${path.basename(rawDumpTemp)}"${plaintextCleanupError ? ` (${plaintextCleanupError})` : ''}. Production backup aborted fail-closed to prevent plaintext data exposure.`;
      console.error(`❌ ${failMsg}`);
      throw new Error(failMsg);
    }

    // 5. Restore verification: enabled by default for scheduled & production backups
    let restoreVerification: RestoreVerificationResult = { status: 'SKIPPED' };
    let shouldVerifyRestore = true;

    if (config.verifyRestore !== undefined) {
      shouldVerifyRestore = config.verifyRestore;
    } else if (process.env.BACKUP_VERIFY_RESTORE !== undefined) {
      const val = process.env.BACKUP_VERIFY_RESTORE.toLowerCase().trim();
      shouldVerifyRestore = val !== 'false' && val !== '0' && val !== 'no';
    }

    if (shouldVerifyRestore) {
      console.log(`🧪 Running comprehensive production backup restorability verification...`);
      try {
        const vRes = await verifyBackupRestorability(finalEncryptedFile, passphrase, {
          databaseUrl: rawDbUrl,
          adminUrl: config.adminUrl || process.env.BACKUP_TEST_RESTORE_ADMIN_URL,
          sourceStats,
        });
        restoreVerification = {
          status: 'VERIFIED',
          verifiedAt: new Date().toISOString(),
          durationMs: vRes.durationMs,
          disposableDbName: vRes.disposableDbName,
          verifiedTablesCount: vRes.verifiedTablesCount,
          verifiedTables: vRes.verifiedTables,
          tableRowCounts: vRes.tableRowCounts,
          checksumsVerified: vRes.checksumsVerified,
        };
      } catch (vErr: any) {
        console.error(`❌ Backup restorability verification failed: ${vErr.message}`);
        restoreVerification = {
          status: 'FAILED',
          verifiedAt: new Date().toISOString(),
          error: vErr.message,
        };

        // Write failure manifest atomically before re-throwing so state is preserved
        const failureDurationMs = Date.now() - startTime;
        const failureMeta: BackupMetadata = {
          id: backupId,
          timestamp: now.toISOString(),
          databaseName: dbName,
          host,
          port,
          rawSize: rawStat.size,
          encryptedSize: encStat.size,
          rawSha256,
          encryptedSha256,
          isPreMigration: !!config.isPreMigration,
          durationMs: failureDurationMs,
          status: 'FAILED',
          error: `Restorability verification failed: ${vErr.message}`,
          archivePath: finalEncryptedFile,
          metaPath: finalMetaFile,
          sourceStats,
          restoreVerification,
        };
        fs.writeFileSync(tempMetaFile, JSON.stringify(failureMeta, null, 2), { encoding: 'utf-8', mode: 0o600 });
        atomicPublishNoClobber(tempMetaFile, finalMetaFile);

        throw new Error(
          `Production backup created at "${finalEncryptedFile}" but failed restorability verification: ${vErr.message}`
        );
      }
    } else {
      console.log(`⚠️ Backup restorability verification explicitly skipped by configuration.`);
    }

    const durationMs = Date.now() - startTime;

    // 6. Construct metadata manifest and stage atomically
    const metadata: BackupMetadata = {
      id: backupId,
      timestamp: now.toISOString(),
      databaseName: dbName,
      host,
      port,
      rawSize: rawStat.size,
      encryptedSize: encStat.size,
      rawSha256,
      encryptedSha256,
      isPreMigration: !!config.isPreMigration,
      durationMs,
      status: 'SUCCESS',
      archivePath: finalEncryptedFile,
      metaPath: finalMetaFile,
      sourceStats,
      restoreVerification,
    };

    fs.writeFileSync(tempMetaFile, JSON.stringify(metadata, null, 2), { encoding: 'utf-8', mode: 0o600 });
    atomicPublishNoClobber(tempMetaFile, finalMetaFile);
    setRestrictiveFileMode(finalMetaFile, 0o600);
    console.log(`✅ Production backup complete: ${path.basename(finalEncryptedFile)} (${encStat.size} bytes in ${durationMs}ms)`);

    // 7. Apply retention policy
    const retentionDays = config.retentionDays || parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
    const minKeep = config.minBackupsToKeep || parseInt(process.env.BACKUP_MIN_KEEP || '3', 10);
    const retentionRes = applyBackupRetention(outputDir, retentionDays, { minBackupsToKeep: minKeep });
    if (retentionRes.pruned.length > 0) {
      console.log(`🧹 Pruned ${retentionRes.pruned.length} expired backup(s): ${retentionRes.pruned.join(', ')}`);
    }

    // 8. Webhook alert
    const webhookUrl = config.webhookUrl || process.env.BACKUP_WEBHOOK_URL;
    if (webhookUrl) {
      await sendWebhookNotification(webhookUrl, {
        event: 'BACKUP_SUCCESS',
        id: backupId,
        database: dbName,
        sizeBytes: encStat.size,
        durationMs,
        timestamp: metadata.timestamp,
        restorabilityStatus: restoreVerification.status,
      });
    }

    return metadata;
  } catch (err: any) {
    if (fs.existsSync(rawDumpTemp)) {
      try {
        fs.unlinkSync(rawDumpTemp);
      } catch (cleanupErr: any) {
        console.error(`❌ Critical: Failed to delete raw plaintext dump on backup failure: ${cleanupErr.message}`);
        err.message = `${err.message} [CRITICAL: Plaintext dump file "${path.basename(rawDumpTemp)}" could not be removed from staging: ${cleanupErr.message}]`;
      }
    }
    if (fs.existsSync(tempEncryptedFile)) {
      try {
        fs.unlinkSync(tempEncryptedFile);
      } catch {}
    }
    if (fs.existsSync(tempMetaFile)) {
      try {
        fs.unlinkSync(tempMetaFile);
      } catch {}
    }
    // Attempt sweep of stale staging files
    try {
      cleanupAbandonedStagingFiles(stagingDir);
    } catch {}

    const durationMs = Date.now() - startTime;
    const failureMeta: BackupMetadata = {
      id: backupId,
      timestamp: now.toISOString(),
      databaseName: dbName,
      host,
      port,
      rawSize: 0,
      encryptedSize: 0,
      rawSha256: '',
      encryptedSha256: '',
      isPreMigration: !!config.isPreMigration,
      durationMs,
      status: 'FAILED',
      error: err.message,
      archivePath: finalEncryptedFile,
      metaPath: finalMetaFile,
      sourceStats,
    };

    const webhookUrl = config.webhookUrl || process.env.BACKUP_WEBHOOK_URL;
    if (webhookUrl) {
      await sendWebhookNotification(webhookUrl, {
        event: 'BACKUP_FAILED',
        id: backupId,
        database: dbName,
        error: err.message,
        durationMs,
        timestamp: failureMeta.timestamp,
      });
    }

    throw err;
  } finally {
    if (!statClientClosed) {
      try {
        await statClient.query('ROLLBACK;');
      } catch {}
      try {
        await statClient.end();
      } catch {}
    }
  }
}

/**
 * Exhaustively validates restored schema, constraints, indexes, nullability, defaults,
 * foreign keys with cascade actions, zero orphaned records, migration history, and data integrity hashes
 * against the centralized, version-controlled CINETRACK_SCHEMA_MANIFEST.
 */
export async function auditRestoredDatabaseSchema(
  verifyClient: Client,
  restoredTables: string[],
  options: { sourceStats?: SourceDatabaseStats } = {}
): Promise<{ verified: boolean; tableRowCounts: Record<string, number> }> {
  // A. Table Verification: verify all expected tables exist and reject unexpected tables
  const expectedTableNames = Object.keys(CINETRACK_SCHEMA_MANIFEST.tables);
  for (const expectedTable of expectedTableNames) {
    if (!restoredTables.includes(expectedTable)) {
      throw new Error(
        `Restored database is missing expected table "${expectedTable}". Found tables: [${restoredTables.join(', ')}]`
      );
    }
  }
  for (const actualTable of restoredTables) {
    if (!CINETRACK_SCHEMA_MANIFEST.tables[actualTable]) {
      throw new Error(
        `Restored database contains unexpected table "${actualTable}". Schema drift detected.`
      );
    }
  }

  // B. Deep Column, Data Type, Nullability & Default Verification
  const colRes = await verifyClient.query(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length,
           numeric_precision, numeric_scale, is_identity, is_generated, generation_expression, collation_name
    FROM information_schema.columns 
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `);
  const tableColumns = new Map<string, Map<string, any>>();
  for (const row of colRes.rows) {
    if (!tableColumns.has(row.table_name)) {
      tableColumns.set(row.table_name, new Map());
    }
    tableColumns.get(row.table_name)!.set(row.column_name, row);
  }

  for (const [tblName, tblManifest] of Object.entries(CINETRACK_SCHEMA_MANIFEST.tables)) {
    const existingCols = tableColumns.get(tblName);
    if (!existingCols) {
      throw new Error(`Restored table "${tblName}" is missing column metadata.`);
    }

    for (const [colName, expCol] of Object.entries(tblManifest.columns)) {
      const actual = existingCols.get(colName);
      if (!actual) {
        throw new Error(`Restored table "${tblName}" is missing required column "${colName}".`);
      }
      if (actual.data_type !== expCol.dataType) {
        throw new Error(
          `Restored column "${tblName}.${colName}" data type mismatch: got "${actual.data_type}", expected "${expCol.dataType}".`
        );
      }
      if (actual.udt_name !== expCol.udtName) {
        throw new Error(
          `Restored column "${tblName}.${colName}" user-defined type mismatch: got "${actual.udt_name}", expected "${expCol.udtName}".`
        );
      }
      const actualNullable = actual.is_nullable === 'YES';
      if (actualNullable !== expCol.nullable) {
        throw new Error(
          `Restored column "${tblName}.${colName}" nullability mismatch: got ${actualNullable}, expected ${expCol.nullable}.`
        );
      }

      // Compare column defaults using robust normalization
      const normActualDefault = normalizeDefaultExpression(actual.column_default);
      const normExpectedDefault = normalizeDefaultExpression(expCol.default);
      if (normActualDefault !== normExpectedDefault) {
        throw new Error(
          `Restored column "${tblName}.${colName}" default expression mismatch: got "${actual.column_default}" (normalized: "${normActualDefault}"), expected "${expCol.default}" (normalized: "${normExpectedDefault}").`
        );
      }

      // Compare character max length where specified
      if (expCol.maxLength !== null && actual.character_maximum_length !== expCol.maxLength) {
        throw new Error(
          `Restored column "${tblName}.${colName}" max length mismatch: got ${actual.character_maximum_length}, expected ${expCol.maxLength}.`
        );
      }

      // Compare numeric precision and scale where specified
      if (expCol.numericPrecision !== null && actual.numeric_precision !== expCol.numericPrecision) {
        throw new Error(
          `Restored column "${tblName}.${colName}" numeric precision mismatch: got ${actual.numeric_precision}, expected ${expCol.numericPrecision}.`
        );
      }
      if (expCol.numericScale !== null && actual.numeric_scale !== expCol.numericScale) {
        throw new Error(
          `Restored column "${tblName}.${colName}" numeric scale mismatch: got ${actual.numeric_scale}, expected ${expCol.numericScale}.`
        );
      }

      // Compare identity and generated column properties
      const actualIdentity = actual.is_identity === 'YES';
      if (actualIdentity !== expCol.isIdentity) {
        throw new Error(
          `Restored column "${tblName}.${colName}" identity property mismatch: got ${actualIdentity}, expected ${expCol.isIdentity}.`
        );
      }
      const actualGenerated = actual.is_generated === 'ALWAYS' || actual.is_generated === 'YES';
      if (actualGenerated !== expCol.isGenerated) {
        throw new Error(
          `Restored column "${tblName}.${colName}" generated property mismatch: got ${actualGenerated}, expected ${expCol.isGenerated}.`
        );
      }
      if (expCol.generationExpression !== null && actual.generation_expression !== expCol.generationExpression) {
        throw new Error(
          `Restored column "${tblName}.${colName}" generation expression mismatch: got "${actual.generation_expression}", expected "${expCol.generationExpression}".`
        );
      }
      if (expCol.collationName !== null && actual.collation_name !== expCol.collationName) {
        throw new Error(
          `Restored column "${tblName}.${colName}" collation mismatch: got "${actual.collation_name}", expected "${expCol.collationName}".`
        );
      }
    }

    // Reject unexpected extra columns on table
    for (const actualCol of existingCols.keys()) {
      if (!tblManifest.columns[actualCol]) {
        throw new Error(`Restored table "${tblName}" contains unexpected extra column "${actualCol}".`);
      }
    }
  }

  // C. Primary Key Verification: verify exact table, constraint existence, and ordered column list
  const pkRes = await verifyClient.query(`
    SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.ordinal_position;
  `);
  const actualPKs = new Map<string, string[]>();
  for (const row of pkRes.rows) {
    if (!actualPKs.has(row.table_name)) {
      actualPKs.set(row.table_name, []);
    }
    actualPKs.get(row.table_name)!.push(row.column_name);
  }

  for (const [tblName, tblManifest] of Object.entries(CINETRACK_SCHEMA_MANIFEST.tables)) {
    const cols = actualPKs.get(tblName);
    if (!cols || cols.length === 0) {
      throw new Error(`Restored table "${tblName}" is missing a PRIMARY KEY constraint.`);
    }
    if (JSON.stringify(cols) !== JSON.stringify(tblManifest.primaryKey)) {
      throw new Error(
        `Restored table "${tblName}" PRIMARY KEY columns mismatch: got [${cols.join(', ')}], expected [${tblManifest.primaryKey.join(', ')}].`
      );
    }
  }

  for (const tblName of actualPKs.keys()) {
    if (!CINETRACK_SCHEMA_MANIFEST.tables[tblName]) {
      throw new Error(`Restored database contains unexpected primary key on table "${tblName}".`);
    }
  }

  // D. Foreign Key Constraints & Referential Integrity Verification
  const fkRes = await verifyClient.query(`
    SELECT 
      c.conname, 
      t.relname AS table_name,
      ft.relname AS foreign_table_name,
      c.confdeltype AS delete_action,
      c.confupdtype AS update_action,
      c.convalidated AS is_validated,
      c.condeferrable AS is_deferrable,
      c.condeferred AS is_initially_deferred,
      ARRAY(
        SELECT a.attname::text 
        FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
      ) AS columns,
      ARRAY(
        SELECT fa.attname::text 
        FROM unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord)
        JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = fk.attnum
        ORDER BY fk.ord
      ) AS foreign_columns
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    LEFT JOIN pg_class ft ON c.confrelid = ft.oid
    WHERE n.nspname = 'public' AND c.contype = 'f';
  `);
  const fkMap = new Map<string, any>(fkRes.rows.map((r: any) => [r.conname, r]));

  for (const expFK of CINETRACK_SCHEMA_MANIFEST.foreignKeys) {
    const actual = fkMap.get(expFK.name);
    if (!actual) {
      throw new Error(`Restored database is missing required foreign key "${expFK.name}".`);
    }
    if (actual.table_name !== expFK.table) {
      throw new Error(`Foreign key "${expFK.name}" is attached to table "${actual.table_name}" (expected "${expFK.table}").`);
    }
    if (actual.foreign_table_name !== expFK.foreignTable) {
      throw new Error(`Foreign key "${expFK.name}" targets "${actual.foreign_table_name}" (expected "${expFK.foreignTable}").`);
    }
    if (actual.delete_action !== expFK.deleteAction) {
      throw new Error(`Foreign key "${expFK.name}" delete action is "${actual.delete_action}" (expected "${expFK.deleteAction}").`);
    }
    if (actual.update_action !== expFK.updateAction) {
      throw new Error(`Foreign key "${expFK.name}" update action is "${actual.update_action}" (expected "${expFK.updateAction}").`);
    }
    if (actual.is_deferrable !== expFK.isDeferrable) {
      throw new Error(`Foreign key "${expFK.name}" deferrable is ${actual.is_deferrable} (expected ${expFK.isDeferrable}).`);
    }
    if (actual.is_initially_deferred !== expFK.isInitiallyDeferred) {
      throw new Error(`Foreign key "${expFK.name}" initially deferred is ${actual.is_initially_deferred} (expected ${expFK.isInitiallyDeferred}).`);
    }
    if (actual.is_validated !== expFK.isValidated) {
      throw new Error(`Foreign key "${expFK.name}" is marked NOT VALID.`);
    }
    if (JSON.stringify(actual.columns) !== JSON.stringify(expFK.columns)) {
      throw new Error(`Foreign key "${expFK.name}" columns mismatch: got [${actual.columns.join(', ')}], expected [${expFK.columns.join(', ')}].`);
    }
    if (JSON.stringify(actual.foreign_columns) !== JSON.stringify(expFK.foreignColumns)) {
      throw new Error(`Foreign key "${expFK.name}" foreign columns mismatch: got [${actual.foreign_columns.join(', ')}], expected [${expFK.foreignColumns.join(', ')}].`);
    }
  }

  // Reject unexpected foreign keys
  const expectedFkNames = new Set(CINETRACK_SCHEMA_MANIFEST.foreignKeys.map((f) => f.name));
  for (const actualFk of fkRes.rows) {
    if (!expectedFkNames.has(actualFk.conname)) {
      throw new Error(`Restored database contains unexpected foreign key constraint "${actualFk.conname}".`);
    }
  }

  // Referential integrity check across all 10 foreign key relationships (zero orphaned records)
  const fkIntegrityChecks = [
    { name: 'Collection -> User (ownerId)', query: `SELECT count(*)::int AS cnt FROM "Collection" c LEFT JOIN "User" u ON c."ownerId" = u."id" WHERE u."id" IS NULL;` },
    { name: 'CollectionMovie -> Collection', query: `SELECT count(*)::int AS cnt FROM "CollectionMovie" cm LEFT JOIN "Collection" c ON cm."collectionId" = c."id" WHERE c."id" IS NULL;` },
    { name: 'CollectionMovie -> Movie', query: `SELECT count(*)::int AS cnt FROM "CollectionMovie" cm LEFT JOIN "Movie" m ON cm."movieId" = m."id" WHERE m."id" IS NULL;` },
    { name: 'CollectionMovie -> User (addedBy)', query: `SELECT count(*)::int AS cnt FROM "CollectionMovie" cm LEFT JOIN "User" u ON cm."addedBy" = u."id" WHERE u."id" IS NULL;` },
    { name: 'CollectionMember -> Collection', query: `SELECT count(*)::int AS cnt FROM "CollectionMember" cm LEFT JOIN "Collection" c ON cm."collectionId" = c."id" WHERE c."id" IS NULL;` },
    { name: 'CollectionMember -> User', query: `SELECT count(*)::int AS cnt FROM "CollectionMember" cm LEFT JOIN "User" u ON cm."userId" = u."id" WHERE u."id" IS NULL;` },
    { name: 'CollaborationInvitation -> Collection', query: `SELECT count(*)::int AS cnt FROM "CollaborationInvitation" ci LEFT JOIN "Collection" c ON ci."collectionId" = c."id" WHERE c."id" IS NULL;` },
    { name: 'CollaborationInvitation -> User (inviterId)', query: `SELECT count(*)::int AS cnt FROM "CollaborationInvitation" ci LEFT JOIN "User" u ON ci."inviterId" = u."id" WHERE u."id" IS NULL;` },
    { name: 'CollaborationInvitation -> User (inviteeId)', query: `SELECT count(*)::int AS cnt FROM "CollaborationInvitation" ci LEFT JOIN "User" u ON ci."inviteeId" = u."id" WHERE u."id" IS NULL;` },
    { name: 'Session -> User', query: `SELECT count(*)::int AS cnt FROM "Session" s LEFT JOIN "User" u ON s."userId" = u."id" WHERE u."id" IS NULL;` },
  ];

  for (const check of fkIntegrityChecks) {
    const res = await verifyClient.query(check.query);
    const orphaned = res.rows[0]?.cnt || 0;
    if (orphaned > 0) {
      throw new Error(`Referential integrity failure in restored database: found ${orphaned} orphaned row(s) in relationship ${check.name}.`);
    }
  }

  // E. CHECK Constraints Verification
  const checkRes = await verifyClient.query(`
    SELECT c.conname, t.relname AS table_name, c.convalidated, c.condeferrable, c.condeferred, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.contype = 'c';
  `);
  const checkMap = new Map<string, any>(checkRes.rows.map((r: any) => [r.conname, r]));

  for (const expCheck of CINETRACK_SCHEMA_MANIFEST.checkConstraints) {
    const actual = checkMap.get(expCheck.name);
    if (!actual) {
      throw new Error(`Restored database is missing required check constraint "${expCheck.name}".`);
    }
    if (actual.table_name !== expCheck.table) {
      throw new Error(`Check constraint "${expCheck.name}" is on table "${actual.table_name}" (expected "${expCheck.table}").`);
    }
    if (actual.convalidated !== expCheck.isValidated) {
      throw new Error(`Check constraint "${expCheck.name}" validation status is ${actual.convalidated} (expected ${expCheck.isValidated}).`);
    }
    if (actual.condeferrable !== expCheck.isDeferrable) {
      throw new Error(`Check constraint "${expCheck.name}" deferrable is ${actual.condeferrable} (expected ${expCheck.isDeferrable}).`);
    }
    if (!expCheck.semanticValidator(actual.def || '')) {
      throw new Error(`Check constraint "${expCheck.name}" definition failed semantic validation: "${actual.def}".`);
    }
  }

  // Reject unexpected check constraints
  const expectedCheckNames = new Set(CINETRACK_SCHEMA_MANIFEST.checkConstraints.map((c) => c.name));
  for (const actualCheck of checkRes.rows) {
    if (!expectedCheckNames.has(actualCheck.conname)) {
      throw new Error(`Restored database contains unexpected check constraint "${actualCheck.conname}" on table "${actualCheck.table_name}".`);
    }
    if (!actualCheck.convalidated) {
      throw new Error(`Check constraint "${actualCheck.conname}" is marked NOT VALID.`);
    }
  }

  // F. UNIQUE Constraints Verification (pg_constraint where contype = 'u')
  const uqRes = await verifyClient.query(`
    SELECT 
      c.conname,
      t.relname AS table_name,
      c.convalidated AS is_validated,
      c.condeferrable AS is_deferrable,
      c.condeferred AS is_initially_deferred,
      ARRAY(
        SELECT a.attname::text
        FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
      ) AS columns
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.contype = 'u';
  `);
  const uqMap = new Map<string, any>(uqRes.rows.map((r: any) => [r.conname, r]));

  for (const expUq of CINETRACK_SCHEMA_MANIFEST.uniqueConstraints || []) {
    const actual = uqMap.get(expUq.name);
    if (!actual) {
      throw new Error(`Restored database is missing required unique constraint "${expUq.name}" on table "${expUq.table}". (Note: standalone unique index cannot substitute for a unique constraint).`);
    }
    if (actual.table_name !== expUq.table) {
      throw new Error(`Unique constraint "${expUq.name}" is on table "${actual.table_name}" (expected "${expUq.table}").`);
    }
    if (actual.is_validated !== expUq.isValidated) {
      throw new Error(`Unique constraint "${expUq.name}" validation status is ${actual.is_validated} (expected ${expUq.isValidated}).`);
    }
    if (actual.is_deferrable !== expUq.isDeferrable) {
      throw new Error(`Unique constraint "${expUq.name}" deferrable is ${actual.is_deferrable} (expected ${expUq.isDeferrable}).`);
    }
    if (actual.is_initially_deferred !== expUq.isInitiallyDeferred) {
      throw new Error(`Unique constraint "${expUq.name}" initially deferred is ${actual.is_initially_deferred} (expected ${expUq.isInitiallyDeferred}).`);
    }
    const actualCols = (actual.columns || []).map((c: string) => c.toLowerCase());
    const expectedCols = expUq.columns.map((c: string) => c.toLowerCase());
    if (JSON.stringify(actualCols) !== JSON.stringify(expectedCols)) {
      throw new Error(`Unique constraint "${expUq.name}" columns mismatch: got [${(actual.columns || []).join(', ')}], expected [${expUq.columns.join(', ')}].`);
    }
  }

  // Reject unexpected unique constraints
  const expectedUqNames = new Set((CINETRACK_SCHEMA_MANIFEST.uniqueConstraints || []).map((u) => u.name));
  for (const actualUq of uqRes.rows) {
    if (!expectedUqNames.has(actualUq.conname)) {
      throw new Error(`Restored database contains unexpected unique constraint "${actualUq.conname}" on table "${actualUq.table_name}".`);
    }
    if (!actualUq.is_validated) {
      throw new Error(`Unique constraint "${actualUq.conname}" is marked NOT VALID.`);
    }
  }

  // G. Deep Validation of Indexes: existence, uniqueness, readiness, validity, access method, operator classes, sort direction, and column ordering
  const indexRes = await verifyClient.query(`
    SELECT 
      i.relname AS index_name,
      t.relname AS table_name,
      idx.indisunique AS is_unique,
      idx.indisvalid AS is_valid,
      idx.indisready AS is_ready,
      am.amname AS access_method,
      pg_get_indexdef(idx.indexrelid) AS index_def,
      pg_get_expr(idx.indpred, idx.indrelid) AS partial_predicate,
      idx.indnatts AS total_column_count,
      idx.indnkeyatts AS key_column_count,
      ARRAY(
        SELECT pg_get_indexdef(idx.indexrelid, k.ord::integer, true)
        FROM generate_series(1, idx.indnkeyatts) AS k(ord)
      ) AS indexed_key_columns,
      ARRAY(
        SELECT pg_get_indexdef(idx.indexrelid, k.ord::integer, true)
        FROM generate_series(idx.indnkeyatts + 1, idx.indnatts) AS k(ord)
      ) AS included_columns,
      ARRAY(
        SELECT opc.opcname::text
        FROM unnest(idx.indclass) WITH ORDINALITY AS cl(opcid, ord)
        JOIN pg_opclass opc ON opc.oid = cl.opcid
        ORDER BY cl.ord
      ) AS operator_classes,
      ARRAY(
        SELECT (idx.indoption[k.ord - 1] & 1 = 1) AS is_desc
        FROM generate_series(1, idx.indnkeyatts) AS k(ord)
      ) AS is_descending,
      ARRAY(
        SELECT (idx.indoption[k.ord - 1] & 2 = 2) AS is_nulls_first
        FROM generate_series(1, idx.indnkeyatts) AS k(ord)
      ) AS is_nulls_first
    FROM pg_index idx
    JOIN pg_class i ON idx.indexrelid = i.oid
    JOIN pg_class t ON idx.indrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    JOIN pg_am am ON i.relam = am.oid
    WHERE n.nspname = 'public';
  `);
  const indexMap = new Map<string, any>(indexRes.rows.map((r: any) => [r.index_name, r]));

  const normCol = (c: string) => c.trim().replace(/^"|"$/g, '').toLowerCase();

  for (const expIdx of CINETRACK_SCHEMA_MANIFEST.indexes) {
    const actual = indexMap.get(expIdx.name);
    if (!actual) {
      throw new Error(`Restored database is missing required index "${expIdx.name}".`);
    }
    if (actual.table_name !== expIdx.table) {
      throw new Error(`Restored index "${expIdx.name}" is on table "${actual.table_name}" (expected "${expIdx.table}").`);
    }
    if (actual.is_unique !== expIdx.unique) {
      throw new Error(`Restored index "${expIdx.name}" uniqueness mismatch: got ${actual.is_unique}, expected ${expIdx.unique}.`);
    }
    if (actual.access_method !== expIdx.accessMethod) {
      throw new Error(`Restored index "${expIdx.name}" access method is "${actual.access_method}" (expected "${expIdx.accessMethod}").`);
    }
    if (!actual.is_valid) {
      throw new Error(`Restored index "${expIdx.name}" is marked invalid (indisvalid = false).`);
    }
    if (!actual.is_ready) {
      throw new Error(`Restored index "${expIdx.name}" is not ready (indisready = false).`);
    }

    // Compare key columns and ordering
    const actualCols = (actual.indexed_key_columns || []).map(normCol);
    const expectedCols = expIdx.keyColumns.map(normCol);
    if (JSON.stringify(actualCols) !== JSON.stringify(expectedCols)) {
      throw new Error(
        `Restored index "${expIdx.name}" columns or order mismatch: got [${(actual.indexed_key_columns || []).join(', ')}], expected [${expIdx.keyColumns.join(', ')}].`
      );
    }

    // Compare included columns (from indnatts and indnkeyatts)
    const actualIncluded = (actual.included_columns || []).map(normCol);
    const expectedIncluded = (expIdx.includedColumns || []).map(normCol);
    if (JSON.stringify(actualIncluded) !== JSON.stringify(expectedIncluded)) {
      throw new Error(
        `Restored index "${expIdx.name}" included columns mismatch: got [${actualIncluded.join(', ')}], expected [${expectedIncluded.join(', ')}].`
      );
    }

    // Compare operator classes
    if (JSON.stringify(actual.operator_classes) !== JSON.stringify(expIdx.operatorClasses)) {
      throw new Error(
        `Restored index "${expIdx.name}" operator classes mismatch: got [${(actual.operator_classes || []).join(', ')}], expected [${expIdx.operatorClasses.join(', ')}].`
      );
    }

    // Compare sort direction (ASC vs DESC)
    if (JSON.stringify(actual.is_descending) !== JSON.stringify(expIdx.isDescending)) {
      throw new Error(
        `Restored index "${expIdx.name}" sort direction mismatch: got [${(actual.is_descending || []).join(', ')}], expected [${expIdx.isDescending.join(', ')}].`
      );
    }

    // Compare nulls ordering (NULLS FIRST vs NULLS LAST)
    if (JSON.stringify(actual.is_nulls_first) !== JSON.stringify(expIdx.isNullsFirst)) {
      throw new Error(
        `Restored index "${expIdx.name}" nulls first/last ordering mismatch: got [${(actual.is_nulls_first || []).join(', ')}], expected [${expIdx.isNullsFirst.join(', ')}].`
      );
    }

    // Compare partial index predicate
    const actualPred = (actual.partial_predicate || '').replace(/["\s()]/g, '').toLowerCase();
    const expPred = (expIdx.predicate || '').replace(/["\s()]/g, '').toLowerCase();
    if (actualPred !== expPred) {
      throw new Error(
        `Restored index "${expIdx.name}" partial predicate mismatch: got "${actual.partial_predicate}", expected "${expIdx.predicate}".`
      );
    }
  }

  // Reject unexpected application indexes
  const expectedIndexNames = new Set(CINETRACK_SCHEMA_MANIFEST.indexes.map((i) => i.name));
  for (const actualIdx of indexRes.rows) {
    if (CINETRACK_SCHEMA_MANIFEST.tables[actualIdx.table_name] && !expectedIndexNames.has(actualIdx.index_name)) {
      throw new Error(
        `Restored database contains unexpected index "${actualIdx.index_name}" on table "${actualIdx.table_name}". Schema drift detected.`
      );
    }
  }

  // G. Prisma Migration History Verification
  const migRes = await verifyClient.query(`
    SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
    FROM "_prisma_migrations"
    ORDER BY started_at ASC;
  `);
  if (migRes.rows.length === 0) {
    throw new Error('Restored database contains empty _prisma_migrations history.');
  }
  const migMap = new Map<string, any>(migRes.rows.map((r: any) => [r.migration_name, r]));
  for (const expMig of CINETRACK_SCHEMA_MANIFEST.migrations) {
    const actual = migMap.get(expMig.name);
    if (!actual) {
      throw new Error(`Restored database is missing expected applied migration "${expMig.name}".`);
    }
    if (actual.checksum !== expMig.checksum) {
      throw new Error(
        `Restored migration "${expMig.name}" checksum mismatch: got "${actual.checksum}", expected "${expMig.checksum}".`
      );
    }
    if (actual.rolled_back_at !== null) {
      throw new Error(`Restored migration "${expMig.name}" is marked rolled back.`);
    }
    if (actual.finished_at === null) {
      throw new Error(`Restored migration "${expMig.name}" is in an unfinished or failed state.`);
    }
    if (actual.applied_steps_count !== 1) {
      throw new Error(`Restored migration "${expMig.name}" has invalid applied_steps_count: ${actual.applied_steps_count}.`);
    }
  }
  const expectedMigNames = new Set(CINETRACK_SCHEMA_MANIFEST.migrations.map((m) => m.name));
  for (const row of migRes.rows) {
    if (!expectedMigNames.has(row.migration_name)) {
      throw new Error(`Restored database contains unexpected migration "${row.migration_name}". Schema drift detected.`);
    }
  }
  if (migRes.rows.length !== CINETRACK_SCHEMA_MANIFEST.migrations.length) {
    throw new Error(
      `Restored database migration count mismatch: found ${migRes.rows.length}, expected ${CINETRACK_SCHEMA_MANIFEST.migrations.length}.`
    );
  }

  // H. Validate row counts and deterministic checksums across all restored tables
  const tableRowCounts: Record<string, number> = {};
  await verifyClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
  try {
    for (const tbl of restoredTables) {
      const cRes = await verifyClient.query(`SELECT COUNT(*)::int AS cnt FROM ${quoteIdent(tbl)};`);
      const count = cRes.rows[0]?.cnt || 0;
      tableRowCounts[tbl] = count;

      // If sourceStats provided, compare row count
      if (options.sourceStats && options.sourceStats.rowCounts[tbl] !== undefined) {
        const expectedCount = options.sourceStats.rowCounts[tbl];
        if (count !== expectedCount) {
          throw new Error(
            `Restored row count mismatch on table "${tbl}": expected ${expectedCount}, got ${count}.`
          );
        }
      }

      // Validate table deterministic hash
      const hRes = await computeTableChunkedHash(verifyClient, tbl, 500, true);
      if (options.sourceStats && options.sourceStats.tableHashes[tbl] !== undefined) {
        const expectedHash = options.sourceStats.tableHashes[tbl];
        if (hRes.tableHash !== expectedHash) {
          throw new Error(
            `Restored table checksum mismatch on table "${tbl}": data integrity comparison failed.`
          );
        }
      }
    }
    await verifyClient.query('COMMIT;');
  } catch (txErr) {
    try {
      await verifyClient.query('ROLLBACK;');
    } catch {}
    throw txErr;
  }

  return { verified: true, tableRowCounts };
}

/**
 * Verifies real backup restorability by decrypting, verifying checksum,
 * restoring to a disposable test database, and running validation queries.
 * In a guaranteed finally block, drops the disposable database and removes
 * decrypted temp files.
 */
export async function verifyBackupRestorability(
  encryptedBackupPath: string,
  passphrase: string,
  options: {
    databaseUrl?: string;
    adminUrl?: string;
    sourceStats?: SourceDatabaseStats;
  } = {}
): Promise<{
  verified: boolean;
  durationMs: number;
  disposableDbName: string;
  verifiedTablesCount: number;
  verifiedTables: string[];
  tableRowCounts: Record<string, number>;
  checksumsVerified: boolean;
}> {
  const startTime = Date.now();
  if (!fs.existsSync(encryptedBackupPath)) {
    throw new Error(`Backup archive does not exist: "${encryptedBackupPath}"`);
  }

  const rawDbUrl =
    options.databaseUrl ||
    process.env.BACKUP_TEST_SOURCE_URL ||
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!rawDbUrl) {
    throw new Error('Database connection URL required for restore verification.');
  }

  const conn = parsePostgresUrl(rawDbUrl);
  assertApprovedHost(conn.host, 'Restore Verification Host');

  const adminConn = options.adminUrl ? parsePostgresUrl(options.adminUrl) : { ...conn, database: 'postgres' };
  assertApprovedHost(adminConn.host, 'Restore Verification Admin Host');

  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const disposableDbName = `cinetrack_restore_verify_${Date.now()}_${randomSuffix}`;
  assertDisposableTestDatabase(disposableDbName);

  const tempDecryptedDump = path.resolve(
    path.dirname(encryptedBackupPath),
    `verify_decrypted_${Date.now()}_${randomSuffix}.dump`
  );

  let adminClient: Client | null = null;
  let verifyClient: Client | null = null;
  let dbCreated = false;

  try {
    // 1. Decrypt into temporary dump file with restrictive permissions (0600)
    console.log(`🔓 Verifying decryption for "${path.basename(encryptedBackupPath)}"...`);
    await decryptBackupFile(encryptedBackupPath, tempDecryptedDump, passphrase);

    if (!fs.existsSync(tempDecryptedDump) || fs.statSync(tempDecryptedDump).size === 0) {
      throw new Error('Decryption produced an empty or missing snapshot file during restorability verification.');
    }
    setRestrictiveFileMode(tempDecryptedDump, 0o600);

    // 2. Connect to admin database and create disposable database
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

    console.log(`🛠️ Creating disposable verification database "${disposableDbName}"...`);
    await adminClient.query(`CREATE DATABASE ${quoteIdent(disposableDbName)};`);
    dbCreated = true;

    // 3. Execute pg_restore into disposable database
    console.log(`📥 Executing test pg_restore into "${disposableDbName}"...`);
    const restoreEnv = {
      ...process.env,
      PGPASSWORD: adminConn.password || '',
      ...(adminConn.sslmode ? { PGSSLMODE: adminConn.sslmode } : {}),
    };

    execFileSync(
      'pg_restore',
      [
        '-h', adminConn.host,
        '-p', String(adminConn.port),
        '-U', adminConn.user,
        '-d', disposableDbName,
        '--no-owner',
        '--clean',
        '--if-exists',
        tempDecryptedDump,
      ],
      { env: restoreEnv, stdio: 'pipe', timeout: 120000 }
    );

    // 4. Connect to disposable database and perform comprehensive validation
    verifyClient = new Client({
      host: adminConn.host,
      port: adminConn.port,
      user: adminConn.user,
      password: adminConn.password,
      database: disposableDbName,
      connectionTimeoutMillis: 5000,
      ssl: adminConn.ssl,
    });
    await verifyClient.connect();

    // Introspect base tables
    const tableRes = await verifyClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    const restoredTables: string[] = tableRes.rows.map((r: { table_name: string }) => r.table_name);

    // Run the comprehensive structural, constraint, index, and hash audit
    const { tableRowCounts } = await auditRestoredDatabaseSchema(verifyClient, restoredTables, options);

    const durationMs = Date.now() - startTime;
    console.log(
      `✅ Production backup restorability verified successfully in ${durationMs}ms (${restoredTables.length} tables verified, data integrity confirmed).`
    );

    return {
      verified: true,
      durationMs,
      disposableDbName,
      verifiedTablesCount: restoredTables.length,
      verifiedTables: restoredTables,
      tableRowCounts,
      checksumsVerified: !!options.sourceStats,
    };
  } finally {
    if (verifyClient) {
      try {
        await verifyClient.end();
      } catch {}
    }
    let cleanupError: Error | null = null;
    if (dbCreated && adminClient) {
      try {
        console.log(`🧹 Dropping disposable verification database "${disposableDbName}"...`);
        await adminClient.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();`,
          [disposableDbName]
        );
        try {
          await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(disposableDbName)} WITH (FORCE);`);
        } catch {
          await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(disposableDbName)};`);
        }

        // Independently verify that the database no longer exists in pg_database
        const checkRes = await adminClient.query(
          `SELECT 1 FROM pg_database WHERE datname = $1;`,
          [disposableDbName]
        );
        if (checkRes.rows.length > 0) {
          throw new Error(`Disposable verification database "${disposableDbName}" still exists in pg_database after DROP operation.`);
        }
        console.log(`✅ Disposable verification database "${disposableDbName}" successfully dropped and confirmed.`);
      } catch (err: any) {
        cleanupError = new Error(`RESTORE_CLEANUP_FAILED: Failed to drop disposable verification database "${disposableDbName}": ${err.message}`);
        console.error(`⚠️ ${cleanupError.message}`);
      }
    }
    if (adminClient) {
      try {
        await adminClient.end();
      } catch {}
    }
    if (fs.existsSync(tempDecryptedDump)) {
      try {
        fs.unlinkSync(tempDecryptedDump);
      } catch (dumpErr: any) {
        const unlinkErr = new Error(`PLAINTEXT_CLEANUP_FAILED: Temporary decrypted restore dump "${path.basename(tempDecryptedDump)}" could not be deleted: ${dumpErr.message}`);
        console.error(`❌ ${unlinkErr.message}`);
        if (cleanupError) {
          throw new Error(`RESTORE_FAILED_WITH_CLEANUP_FAILURE: ${cleanupError.message}; Additionally: ${unlinkErr.message}`);
        }
        throw unlinkErr;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

export interface RestoreOptions {
  isVerificationRestore?: boolean;
  allowDestructiveRestore?: boolean;
  confirmedTargetDatabase?: string;
}

/**
 * Restores a production encrypted backup into a target database.
 * Enforces strict operational safeguards to prevent accidental overwrites of production databases.
 */
export async function executeRestoreFromBackup(
  encryptedBackupPath: string,
  targetDatabaseUrl: string,
  passphrase: string,
  options: RestoreOptions = {}
): Promise<{ success: boolean; durationMs: number }> {
  const startTime = Date.now();
  if (!fs.existsSync(encryptedBackupPath)) {
    throw new Error(`Backup archive does not exist: "${encryptedBackupPath}"`);
  }

  const targetConn = parsePostgresUrl(targetDatabaseUrl);
  const targetDbLower = (targetConn.database || '').toLowerCase().trim();

  // Safeguard 1: Verification restores must target disposable database names
  if (options.isVerificationRestore) {
    const isDisposable =
      targetDbLower.startsWith('cinetrack_restore_') ||
      targetDbLower.startsWith('cinetrack_verification_') ||
      targetDbLower.startsWith('cinetrack_test_');
    if (!isDisposable) {
      throw new Error(
        `SECURITY REJECTION: Verification restore cannot target non-disposable database "${targetConn.database}". Must begin with an authorized prefix (e.g. cinetrack_restore_).`
      );
    }
  } else {
    // Safeguard 2: User-requested restores targeting production or application database require explicit authorization
    const prodKeywords = ['prod', 'production', 'live', 'main', 'postgres'];
    const isProdTarget =
      prodKeywords.some((kw) => targetDbLower.includes(kw)) ||
      (process.env.DATABASE_URL &&
        targetDbLower === (parsePostgresUrl(process.env.DATABASE_URL).database || '').toLowerCase());

    if (isProdTarget) {
      const isExplicitlyAuthorized =
        options.allowDestructiveRestore === true &&
        (options.confirmedTargetDatabase === targetConn.database ||
          process.env.CONFIRM_DESTRUCTIVE_RESTORE === targetConn.database);

      if (!isExplicitlyAuthorized) {
        throw new Error(
          `FATAL SAFETY REJECTION: Destructive restore against production or primary database "${targetConn.database}" requires explicit authorization (allowDestructiveRestore=true and CONFIRM_DESTRUCTIVE_RESTORE=${targetConn.database}).`
        );
      }
    }
  }

  const tempDecryptedDump = path.resolve(
    path.dirname(encryptedBackupPath),
    `temp_restore_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.dump`
  );

  try {
    console.log(`🔓 Decrypting and authenticating archive "${path.basename(encryptedBackupPath)}"...`);
    await decryptBackupFile(encryptedBackupPath, tempDecryptedDump, passphrase);

    console.log(`📥 Executing pg_restore into "${targetConn.database}"...`);
    const restoreEnv = {
      ...process.env,
      PGPASSWORD: targetConn.password || '',
      ...(targetConn.sslmode ? { PGSSLMODE: targetConn.sslmode } : {}),
    };

    execFileSync(
      'pg_restore',
      [
        '-h', targetConn.host,
        '-p', String(targetConn.port),
        '-U', targetConn.user,
        '-d', targetConn.database,
        '--no-owner',
        '--clean',
        '--if-exists',
        tempDecryptedDump,
      ],
      { env: restoreEnv, stdio: 'pipe', timeout: 300000 }
    );

    console.log(`✅ Restoration complete in ${Date.now() - startTime}ms.`);
    return { success: true, durationMs: Date.now() - startTime };
  } finally {
    if (fs.existsSync(tempDecryptedDump)) {
      try {
        fs.unlinkSync(tempDecryptedDump);
      } catch (dumpErr: any) {
        console.error(`❌ Critical: Failed to delete temporary decrypted restore dump "${path.basename(tempDecryptedDump)}": ${dumpErr.message}`);
        throw new Error(
          `PLAINTEXT_CLEANUP_FAILED: Temporary decrypted restore dump "${path.basename(tempDecryptedDump)}" could not be deleted after restoration: ${dumpErr.message}`
        );
      }
    }
  }
}

/**
 * Operatively validates the backup system environment:
 * 1. Configuration: DATABASE_URL, BACKUP_ENCRYPTION_PASSPHRASE, retention params.
 * 2. Filesystem & Permissions: Output directory writability, probe file creation with 0600, directory mode 0700.
 * 3. Database Connectivity & Identity: PostgreSQL connection, current_database, current_user, version, snapshot export capability.
 * 4. Toolchains: pg_dump and pg_restore executable and version 18.x.
 */
export async function validateBackupEnvironment(config: BackupConfig = {}): Promise<{
  valid: boolean;
  checks: Record<string, any>;
  errors: string[];
}> {
  const errors: string[] = [];
  const checks: Record<string, any> = {};

  // 1. Configuration Validation
  const rawDbUrl = config.databaseUrl !== undefined ? config.databaseUrl : process.env.DATABASE_URL;
  if (!rawDbUrl || rawDbUrl.trim() === '') {
    errors.push('DATABASE_URL is missing or empty.');
    checks.databaseUrlConfigured = false;
  } else {
    try {
      parsePostgresUrl(rawDbUrl);
      checks.databaseUrlConfigured = true;
    } catch (urlErr: any) {
      errors.push(`DATABASE_URL is invalid: ${urlErr.message}`);
      checks.databaseUrlConfigured = false;
    }
  }

  const passphrase =
    config.encryptionPassphrase !== undefined
      ? config.encryptionPassphrase
      : (process.env.BACKUP_ENCRYPTION_PASSPHRASE || process.env.BACKUP_ENCRYPTION_KEY);
  if (!passphrase || passphrase.trim().length === 0) {
    errors.push('BACKUP_ENCRYPTION_PASSPHRASE (or BACKUP_ENCRYPTION_KEY) is missing or empty.');
    checks.encryptionKeyConfigured = false;
  } else if (passphrase.length < 16) {
    errors.push(`BACKUP_ENCRYPTION_PASSPHRASE is too short (${passphrase.length} chars). Minimum required length is 16 characters.`);
    checks.encryptionKeyConfigured = false;
  } else {
    checks.encryptionKeyConfigured = true;
    checks.encryption = {
      configured: true,
      algorithm: 'aes-256-gcm',
      kdf: 'pbkdf2-sha256',
      iterations: 600000,
      formatVersion: 'CTBK02',
    };
  }

  const retentionDays = config.retentionDays ?? parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
  if (isNaN(retentionDays) || retentionDays <= 0) {
    errors.push(`BACKUP_RETENTION_DAYS must be a positive integer (got ${process.env.BACKUP_RETENTION_DAYS}).`);
    checks.retentionDaysValid = false;
  } else {
    checks.retentionDays = retentionDays;
  }

  const minKeep = config.minBackupsToKeep ?? parseInt(process.env.BACKUP_MIN_KEEP || '3', 10);
  if (isNaN(minKeep) || minKeep < 1) {
    errors.push(`BACKUP_MIN_KEEP must be a positive integer >= 1 (got ${process.env.BACKUP_MIN_KEEP}).`);
    checks.minKeepValid = false;
  } else {
    checks.minKeep = minKeep;
  }
  checks.retention = {
    days: retentionDays,
    minKeep,
    targetPattern: '^cinetrack_backup_.*',
  };

  // 2. Filesystem & Directory Permissions Validation
  const outputDir = path.resolve(
    config.outputDir || process.env.BACKUP_OUTPUT_DIR || path.resolve(__dirname, '../backups')
  );

  // Safety guard: reject system or root directories
  const normalizedOutDir = outputDir.toLowerCase().replace(/\\/g, '/');
  const prohibitedRoots = ['/', 'c:', 'c:/', '/etc', '/var', '/usr', '/bin', '/windows', '/system32'];
  if (prohibitedRoots.includes(normalizedOutDir) || prohibitedRoots.includes(normalizedOutDir.replace(/\/$/, ''))) {
    errors.push(`Output directory cannot be a root or critical system directory: "${outputDir}".`);
    checks.outputDirectory = { path: outputDir, safe: false };
  } else {
    try {
      if (fs.existsSync(outputDir)) {
        const lstat = fs.lstatSync(outputDir);
        if (lstat.isSymbolicLink()) {
          errors.push(`Output directory cannot be a symbolic link: "${outputDir}".`);
          checks.outputDirectory = { path: outputDir, safe: false, isSymlink: true };
          // Immediate stop: zero write, chmod, or probe file operations after symlink detection!
          return { valid: false, checks, errors };
        }
        // Inspect permissions of pre-existing user directory without altering them
        if (process.platform === 'win32') {
          const aclCheck = verifyWindowsAcl(outputDir);
          if (!aclCheck.protected) {
            errors.push(
              `Output directory has insecure Windows NTFS permissions: ${aclCheck.aclOutput}. Inheritance must be disabled and access restricted to authorized administrators/system.`
            );
          }
        } else {
          const mode = fs.statSync(outputDir).mode & 0o777;
          if ((mode & 0o077) !== 0) {
            errors.push(
              `Output directory "${outputDir}" has insecure permissions (${mode.toString(8)}). Expected owner-only 0700.`
            );
          }
        }
      } else {
        fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
        setRestrictiveDirMode(outputDir, 0o700);
      }

      // Test write, fsync, read, and delete capability via unique probe file
      const probeFile = path.join(
        outputDir,
        `.probe_validate_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.tmp`
      );
      const probeContent = 'CineTrack Operational Validation Probe ' + Date.now();
      const pFd = fs.openSync(probeFile, 'w+', 0o600);
      try {
        setRestrictiveFileMode(probeFile, 0o600);
        fs.writeSync(pFd, probeContent);
        fs.fsyncSync(pFd);
      } finally {
        fs.closeSync(pFd);
      }

      const readBack = fs.readFileSync(probeFile, 'utf-8');
      if (readBack !== probeContent) {
        throw new Error('Filesystem read verification failed (content mismatch).');
      }
      fs.unlinkSync(probeFile);

      checks.outputDirectory = {
        path: outputDir,
        writable: true,
        readable: true,
        directoryMode: '0700',
        safe: true,
      };
    } catch (fsErr: any) {
      errors.push(`Output directory filesystem check failed at "${outputDir}": ${fsErr.message}`);
      checks.outputDirectory = { path: outputDir, error: fsErr.message, safe: false };
    }
  }

  // 3. Database Connectivity, Identity & Capability Validation
  let serverMajorVersion = 0;
  if (rawDbUrl && checks.databaseUrlConfigured) {
    let client: Client | null = null;
    try {
      const conn = parsePostgresUrl(rawDbUrl);

      // Verify safe separation from disposable verification database (URL check)
      const restorePrefix = process.env.BACKUP_TEST_RESTORE_DATABASE_PREFIX || 'cinetrack_restore_';
      if (conn.database && conn.database.startsWith(restorePrefix)) {
        errors.push(`Target database "${conn.database}" matches the disposable restore prefix "${restorePrefix}". Backups cannot target verification databases.`);
      }

      client = new Client({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        connectionTimeoutMillis: 5000,
        ssl: conn.ssl,
      });
      await client.connect();

      const idRes = await client.query('SELECT current_database() AS db_name, current_user AS user_name, inet_server_addr()::text AS server_addr, version() AS version;');
      const dbName = idRes.rows[0]?.db_name;
      const userName = idRes.rows[0]?.user_name;
      const serverAddr = idRes.rows[0]?.server_addr;
      const dbVersion = idRes.rows[0]?.version;

      // Extract server major version
      const verMatch = (dbVersion || '').match(/PostgreSQL\s+(\d+)\./i);
      if (verMatch) {
        serverMajorVersion = parseInt(verMatch[1], 10);
      }

      // Verify connected DB matches configured DB in connection string
      if (conn.database && dbName && conn.database.toLowerCase() !== dbName.toLowerCase()) {
        errors.push(`Database identity mismatch: configured database is "${conn.database}", but live connection is "${dbName}".`);
      }

      // Verify safe separation from disposable verification database (live DB check)
      if (dbName && dbName.startsWith(restorePrefix) && !errors.some((e) => e.includes('matches the disposable restore prefix'))) {
        errors.push(`Target database "${dbName}" matches the disposable restore prefix "${restorePrefix}". Backups cannot target verification databases.`);
      }

      // Verify role privileges for disposable restore database creation
      let canCreateDb = false;
      try {
        const roleRes = await client.query('SELECT rolcreatedb, rolsuper FROM pg_roles WHERE rolname = current_user;');
        canCreateDb = Boolean(roleRes.rows[0]?.rolcreatedb || roleRes.rows[0]?.rolsuper);
      } catch {}

      // Test snapshot export capability
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
      const snapRes = await client.query('SELECT pg_export_snapshot() AS snapshot_id;');
      const snapshotId = snapRes.rows[0]?.snapshot_id;
      await client.query('ROLLBACK;');

      if (!snapshotId) {
        throw new Error('Database user cannot export transaction snapshot (pg_export_snapshot returned empty).');
      }

      checks.database = {
        name: dbName,
        user: userName,
        serverAddress: serverAddr || 'local/socket',
        version: dbVersion,
        serverMajorVersion,
        snapshotExportCapable: true,
      };

      // Verify real restore verification capability using a disposable probe database
      const shouldVerifyRestore =
        config.verifyRestore !== undefined
          ? config.verifyRestore
          : process.env.BACKUP_VERIFY_RESTORE !== 'false' &&
            process.env.BACKUP_VERIFY_RESTORE !== '0' &&
            process.env.BACKUP_VERIFY_RESTORE !== 'no';

      if (shouldVerifyRestore) {
        const adminUrl = config.adminUrl || process.env.BACKUP_TEST_RESTORE_ADMIN_URL || rawDbUrl;
        const adminConn = parsePostgresUrl(adminUrl);
        const probeDbName = `cinetrack_preflight_probe_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        let probeClient: Client | null = null;
        let probeCreated = false;

        try {
          probeClient = new Client({
            host: adminConn.host,
            port: adminConn.port,
            user: adminConn.user,
            password: adminConn.password,
            database: 'postgres',
            connectionTimeoutMillis: 5000,
            ssl: adminConn.ssl,
          });
          await probeClient.connect();

          // Check probe DB does not exist
          const existRes = await probeClient.query('SELECT 1 FROM pg_database WHERE datname = $1;', [probeDbName]);
          if (existRes.rows.length > 0) {
            throw new Error(`Probe database "${probeDbName}" already exists unexpectedly.`);
          }

          // Actually execute CREATE DATABASE
          await probeClient.query(`CREATE DATABASE ${quoteIdent(probeDbName)};`);
          probeCreated = true;

          // Verify probe DB now exists
          const createdRes = await probeClient.query('SELECT 1 FROM pg_database WHERE datname = $1;', [probeDbName]);
          if (createdRes.rows.length === 0) {
            throw new Error(`Probe database "${probeDbName}" creation could not be verified in pg_database.`);
          }

          // Actually execute DROP DATABASE
          await probeClient.query(`DROP DATABASE ${quoteIdent(probeDbName)} WITH (FORCE);`);
          probeCreated = false;

          checks.restoreVerification = {
            configured: true,
            restorePrefix,
            roleCanCreateDatabase: canCreateDb,
            probeCapabilityVerified: true,
            adminUser: adminConn.user,
          };
        } catch (probeErr: any) {
          errors.push(
            `Restore verification preflight check failed: Unable to create and clean up disposable probe database "${probeDbName}" (${probeErr.message}).`
          );
          checks.restoreVerification = {
            configured: false,
            restorePrefix,
            roleCanCreateDatabase: canCreateDb,
            probeCapabilityVerified: false,
            error: probeErr.message,
          };
        } finally {
          if (probeCreated && probeClient) {
            try {
              await probeClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(probeDbName)} WITH (FORCE);`);
            } catch (dropErr: any) {
              errors.push(`CRITICAL: Leftover probe database "${probeDbName}" could not be dropped: ${dropErr.message}`);
            }
          }
          if (probeClient) {
            try {
              await probeClient.end();
            } catch {}
          }
        }
      } else {
        checks.restoreVerification = {
          configured: false,
          skipped: true,
          restorePrefix,
          roleCanCreateDatabase: canCreateDb,
        };
      }
    } catch (dbErr: any) {
      errors.push(`Database connection or capability validation failed: ${dbErr.message}`);
      checks.database = { error: dbErr.message };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch {}
      }
    }
  }

  // 4. Toolchains Validation (pg_dump & pg_restore) and Version Compatibility
  let dumpMajorVersion = 0;
  try {
    const dumpVerOut = execFileSync('pg_dump', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!dumpVerOut.includes('pg_dump')) {
      throw new Error(`Unexpected pg_dump output: "${dumpVerOut}"`);
    }
    const dMatch = dumpVerOut.match(/(\d+)\./);
    if (dMatch) dumpMajorVersion = parseInt(dMatch[1], 10);

    // Verify option support
    const dumpHelp = execFileSync('pg_dump', ['--help'], { encoding: 'utf-8', timeout: 5000 });
    const supportsSnapshot = dumpHelp.includes('--snapshot');

    if (serverMajorVersion > 0 && dumpMajorVersion > 0 && dumpMajorVersion < serverMajorVersion) {
      errors.push(`pg_dump version (${dumpMajorVersion}.x) is older than PostgreSQL server (${serverMajorVersion}.x). Major version compatibility required.`);
    }
    if (!supportsSnapshot) {
      errors.push('Installed pg_dump does not support the required --snapshot option.');
    }

    checks.pgDump = {
      installed: true,
      version: dumpVerOut,
      majorVersion: dumpMajorVersion,
      supportsSnapshot,
      compatibleWithServer: serverMajorVersion > 0 ? dumpMajorVersion >= serverMajorVersion : true,
    };
  } catch (dumpErr: any) {
    errors.push(`Toolchain check failed: pg_dump is not available or executable: ${dumpErr.message}`);
    checks.pgDump = { installed: false, error: dumpErr.message };
  }

  let restoreMajorVersion = 0;
  try {
    const restoreVerOut = execFileSync('pg_restore', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!restoreVerOut.includes('pg_restore')) {
      throw new Error(`Unexpected pg_restore output: "${restoreVerOut}"`);
    }
    const rMatch = restoreVerOut.match(/(\d+)\./);
    if (rMatch) restoreMajorVersion = parseInt(rMatch[1], 10);

    if (serverMajorVersion > 0 && restoreMajorVersion > 0 && restoreMajorVersion < serverMajorVersion) {
      errors.push(`pg_restore version (${restoreMajorVersion}.x) is older than PostgreSQL server (${serverMajorVersion}.x). Major version compatibility required.`);
    }

    checks.pgRestore = {
      installed: true,
      version: restoreVerOut,
      majorVersion: restoreMajorVersion,
      compatibleWithServer: serverMajorVersion > 0 ? restoreMajorVersion >= serverMajorVersion : true,
    };
  } catch (restoreErr: any) {
    errors.push(`Toolchain check failed: pg_restore is not available or executable: ${restoreErr.message}`);
    checks.pgRestore = { installed: false, error: restoreErr.message };
  }

  return {
    valid: errors.length === 0,
    checks,
    errors,
  };
}

/**
 * CLI Entrypoint
 */
async function cli() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`CineTrack Production Backup Utility
Usage:
  node backup_production.js [options]

Options:
  --verify-restore    Enable full restore verification into a disposable database (default in production)
  --no-verify-restore, --skip-verify-restore
                      Disable restore verification (only for emergency fast dumps)
  --pre-migration     Tag backup as pre-migration snapshot (.pre_migration)
  --schedule, --worker Run as continuous scheduled background worker
  --verify-latest     Verify restorability of newest backup archive on disk
  --validate          Validate configuration, environment, and operational paths without taking backup
  --help, -h          Show this help message`);
    process.exit(0);
  }

  if (args.includes('--validate')) {
    console.log('🔍 Executing comprehensive operational validation of CineTrack backup environment...');
    const result = await validateBackupEnvironment();
    if (!result.valid) {
      console.error('❌ Operational validation failed:');
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }
    console.log('✅ CineTrack backup utility configuration, filesystem, database, and toolchains are valid and operational:');
    console.log(JSON.stringify(result.checks, null, 2));
    process.exit(0);
  }

  const isPreMigration = args.includes('--pre-migration');
  const isSchedule = args.includes('--schedule') || args.includes('--worker');
  const isVerify = args.includes('--verify-latest');

  let verifyRestore: boolean | undefined = undefined;
  if (args.includes('--verify-restore')) {
    verifyRestore = true;
  } else if (args.includes('--no-verify-restore') || args.includes('--skip-verify-restore')) {
    verifyRestore = false;
  }

  const passphrase =
    process.env.BACKUP_ENCRYPTION_PASSPHRASE || process.env.BACKUP_ENCRYPTION_KEY || '';

  if (isVerify) {
    const backupDir = path.resolve(process.env.BACKUP_OUTPUT_DIR || path.resolve(__dirname, '../backups'));
    const files = fs.readdirSync(backupDir).filter((f) => BACKUP_FILE_REGEX.test(f)).sort().reverse();
    if (files.length === 0) {
      console.error('❌ No backup files found to verify.');
      process.exit(1);
    }
    const latest = path.join(backupDir, files[0]);
    console.log(`🔍 Verifying latest backup: "${latest}"...`);
    // Runs restore verification into disposable test database
    await verifyBackupRestorability(latest, passphrase);
    process.exit(0);
  }

  if (isSchedule) {
    const hours = parseInt(process.env.BACKUP_INTERVAL_HOURS || '24', 10);
    const intervalMs = hours * 60 * 60 * 1000;
    console.log(`⏰ CineTrack Backup Worker started. Scheduled interval: every ${hours} hour(s).`);

    // Run first backup immediately with restore verification enabled
    try {
      await executeProductionBackup({ verifyRestore: verifyRestore ?? true });
    } catch (err: any) {
      console.error('❌ Initial scheduled backup failed:', err.message);
    }

    setInterval(async () => {
      try {
        console.log(`⏰ Scheduled backup trigger firing...`);
        await executeProductionBackup({ verifyRestore: verifyRestore ?? true });
      } catch (err: any) {
        console.error('❌ Scheduled backup run failed:', err.message);
      }
    }, intervalMs);
    return;
  }

  // Default: Run single backup
  try {
    const meta = await executeProductionBackup({ isPreMigration, verifyRestore });
    console.log(`🎉 Backup completed successfully: ${meta.id} (Status: ${meta.status}, RestoreVerification: ${meta.restoreVerification?.status})`);
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Backup execution failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes('backup_production')) {
  cli();
}
