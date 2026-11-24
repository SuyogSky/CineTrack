import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from 'pg';
import { executeProductionBackup, verifyBackupRestorability } from '../scripts/backup_production';
import { parsePostgresUrl, quoteIdent, computeTableChunkedHash } from '../scripts/test_backup_restore';
import { setRestrictiveDirMode } from '../src/utils/backup_crypto';

describe('Fix 1: Coordinated Snapshot Consistency & Concurrent Write Isolation', { timeout: 90000 }, () => {
  const testBackupDir = path.resolve(__dirname, 'temp_snapshot_backups');
  const testDbUrl =
    process.env.BACKUP_TEST_SOURCE_URL ||
    process.env.TEST_DATABASE_URL ||
    'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public';
  const passphrase = 'SnapshotIsolationPassphrase2026!';

  beforeEach(() => {
    if (!fs.existsSync(testBackupDir)) {
      fs.mkdirSync(testBackupDir, { recursive: true, mode: 0o700 });
      setRestrictiveDirMode(testBackupDir, 0o700);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testBackupDir)) {
      try {
        fs.rmSync(testBackupDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('1. should guarantee sourceStats and pg_dump capture the exact same snapshot even during concurrent writes', async () => {
    const conn = parsePostgresUrl(testDbUrl);
    const writerClient = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl: conn.ssl,
    });
    await writerClient.connect();

    try {
      // 1. Clean slate test user
      const testUserId = `user_snapshot_test_${Date.now()}`;
      await writerClient.query(
        `INSERT INTO "User" (id, username, email, "passwordHash", "updatedAt") VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT DO NOTHING;`,
        [testUserId, `snapshot_user_${Date.now()}`, `snapshot_${Date.now()}@cinetrack.local`, 'hash']
      );

      // 2. Start coordinated backup
      const backupPromise = executeProductionBackup({
        databaseUrl: testDbUrl,
        outputDir: testBackupDir,
        encryptionPassphrase: passphrase,
        verifyRestore: false, // We will manually verify restorability
      });

      // 3. Concurrently insert rows while backup is preparing/executing
      await writerClient.query(
        `INSERT INTO "Collection" (id, "ownerId", title, visibility, "isDefaultWatchlist", "updatedAt") VALUES ($1, $2, $3, 'PRIVATE'::"CollectionVisibility", false, NOW());`,
        [`col_concurrent_${Date.now()}_1`, testUserId, 'Concurrent Collection 1']
      );

      const meta = await backupPromise;

      expect(meta.status).toBe('SUCCESS');
      expect(meta.sourceStats).toBeDefined();

      // 4. Verify that restoring the backup produces identical row counts and checksums matching sourceStats
      const restoreRes = await verifyBackupRestorability(meta.archivePath, passphrase, {
        databaseUrl: testDbUrl,
        sourceStats: meta.sourceStats,
      });

      expect(restoreRes.verified).toBe(true);
      expect(restoreRes.checksumsVerified).toBe(true);

      // Clean up test rows
      await writerClient.query(`DELETE FROM "User" WHERE id = $1;`, [testUserId]);
    } finally {
      await writerClient.end();
    }
  });

  it('2. should maintain consistency during concurrent updates and reflect snapshot state', async () => {
    const conn = parsePostgresUrl(testDbUrl);
    const writerClient = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl: conn.ssl,
    });
    await writerClient.connect();

    try {
      const testUserId = `user_update_${Date.now()}`;
      await writerClient.query(
        `INSERT INTO "User" (id, username, email, "passwordHash", "updatedAt") VALUES ($1, $2, $3, $4, NOW());`,
        [testUserId, `update_user_${Date.now()}`, `update_${Date.now()}@cinetrack.local`, 'hash']
      );

      const backupPromise = executeProductionBackup({
        databaseUrl: testDbUrl,
        outputDir: testBackupDir,
        encryptionPassphrase: passphrase,
        verifyRestore: false,
      });

      // Concurrently update the user row
      await writerClient.query(
        `UPDATE "User" SET username = $1, "updatedAt" = NOW() WHERE id = $2;`,
        [`updated_name_${Date.now()}`, testUserId]
      );

      const meta = await backupPromise;
      expect(meta.status).toBe('SUCCESS');

      const restoreRes = await verifyBackupRestorability(meta.archivePath, passphrase, {
        databaseUrl: testDbUrl,
        sourceStats: meta.sourceStats,
      });
      expect(restoreRes.verified).toBe(true);
      expect(restoreRes.checksumsVerified).toBe(true);

      await writerClient.query(`DELETE FROM "User" WHERE id = $1;`, [testUserId]);
    } finally {
      await writerClient.end();
    }
  });

  it('3. should maintain consistency during concurrent deletes and reflect snapshot state', async () => {
    const conn = parsePostgresUrl(testDbUrl);
    const writerClient = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl: conn.ssl,
    });
    await writerClient.connect();

    try {
      const testUserId = `user_delete_${Date.now()}`;
      await writerClient.query(
        `INSERT INTO "User" (id, username, email, "passwordHash", "updatedAt") VALUES ($1, $2, $3, $4, NOW());`,
        [testUserId, `delete_user_${Date.now()}`, `delete_${Date.now()}@cinetrack.local`, 'hash']
      );

      const backupPromise = executeProductionBackup({
        databaseUrl: testDbUrl,
        outputDir: testBackupDir,
        encryptionPassphrase: passphrase,
        verifyRestore: false,
      });

      // Concurrently delete the row
      await writerClient.query(`DELETE FROM "User" WHERE id = $1;`, [testUserId]);

      const meta = await backupPromise;
      expect(meta.status).toBe('SUCCESS');

      const restoreRes = await verifyBackupRestorability(meta.archivePath, passphrase, {
        databaseUrl: testDbUrl,
        sourceStats: meta.sourceStats,
      });
      expect(restoreRes.verified).toBe(true);
      expect(restoreRes.checksumsVerified).toBe(true);
    } finally {
      await writerClient.end();
    }
  });

  it('4. should ensure a failed dump does not leave a published backup archive or manifest', async () => {
    // Pass an unreachable database URL with invalid port so pg_dump fails
    const badDbUrl = 'postgresql://cinetrack:wrongpass@127.0.0.1:54329/cinetrack_test?schema=public';

    await expect(
      executeProductionBackup({
        databaseUrl: badDbUrl,
        outputDir: testBackupDir,
        encryptionPassphrase: passphrase,
        verifyRestore: false,
      })
    ).rejects.toThrow();

    // Verify zero published .dump.enc or .meta.json files exist in testBackupDir
    const files = fs.readdirSync(testBackupDir);
    const publishedArchives = files.filter((f) => f.endsWith('.dump.enc') || f.endsWith('.meta.json'));
    expect(publishedArchives).toHaveLength(0);
  });

  it('5. should clean up exported snapshot transaction and connection on backup completion or error', async () => {
    const conn = parsePostgresUrl(testDbUrl);
    const inspectClient = new Client({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.password,
      database: conn.database,
      ssl: conn.ssl,
    });
    await inspectClient.connect();

    try {
      // Execute a normal backup
      const meta = await executeProductionBackup({
        databaseUrl: testDbUrl,
        outputDir: testBackupDir,
        encryptionPassphrase: passphrase,
        verifyRestore: false,
      });
      expect(meta.status).toBe('SUCCESS');

      // Check pg_stat_activity: no transaction must be left 'idle in transaction'
      const res = await inspectClient.query(`
        SELECT pid, state, query 
        FROM pg_stat_activity 
        WHERE datname = $1 AND state = 'idle in transaction';
      `, [conn.database]);

      expect(res.rows).toHaveLength(0);
    } finally {
      await inspectClient.end();
    }
  });
});
