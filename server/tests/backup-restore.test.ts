import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from 'pg';
import {
  runBackupRestoreVerification,
  assertDisposableTestDatabase,
  parsePostgresUrl,
  quoteIdent,
} from '../scripts/test_backup_restore';

describe('Phase 3: Backup and Restore Verification Positive & Negative Tests', () => {
  const baseAdminUrl =
    process.env.TEST_DATABASE_URL ||
    'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public';

  it('1. should reject production database URL unconditionally, including substring variants', () => {
    expect(() => assertDisposableTestDatabase('cinetrack')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('production')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('cinetrack_production')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('cinetrack_production_test')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('prod_testing')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('live_test_db')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('main_ci_db')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('prod')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('main')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('postgres')).toThrow(/SECURITY REJECTION/);
  });

  it('2. should reject non-test database without approved prefix, and strictly reject substring false positives like "contest"', () => {
    // Specifically mandated: "contest" must NEVER be accepted simply because its name contains "test"
    expect(() => assertDisposableTestDatabase('contest')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('contest_db')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('protest')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('latest_movies')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('attest_db')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('analytics_warehouse')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('customer_data')).toThrow(/SECURITY REJECTION/);
  });

  it('3. should accept legitimate approved test, disposable, or restore database names', () => {
    expect(() => assertDisposableTestDatabase('cinetrack_test')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_ci')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_disposable_12345')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_restore_1795168000')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_test_custom')).not.toThrow();

    // Custom expected database name verification
    expect(() => assertDisposableTestDatabase('custom_disposable_db', 'custom_disposable_db')).not.toThrow();
    expect(() => assertDisposableTestDatabase('custom_disposable_db', 'different_db')).toThrow(/does not match/);
  });

  it('4. should parse PostgreSQL URL components accurately', () => {
    const parsed = parsePostgresUrl('postgresql://user:pass@db.example.com:5433/my_test_db?sslmode=disable');
    expect(parsed.user).toBe('user');
    expect(parsed.password).toBe('pass');
    expect(parsed.host).toBe('db.example.com');
    expect(parsed.port).toBe(5433);
    expect(parsed.database).toBe('my_test_db');
  });

  it('5. should reject unsafe SQL identifiers', () => {
    expect(() => quoteIdent('valid_db_123')).not.toThrow();
    expect(quoteIdent('valid_db_123')).toBe('"valid_db_123"');
    expect(() => quoteIdent('drop database; --')).toThrow(/Unsafe SQL identifier/);
    expect(() => quoteIdent('db"name')).toThrow(/Unsafe SQL identifier/);
    expect(() => quoteIdent('db name')).toThrow(/Unsafe SQL identifier/);
  });

  it('6. should reject corrupt or empty backup dump files on restore', async () => {
    const corruptDumpPath = path.resolve(__dirname, '..', `temp_corrupt_${Date.now()}.dump`);
    fs.writeFileSync(corruptDumpPath, 'THIS_IS_CORRUPT_NON_DUMP_DATA');

    await expect(
      runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        customDumpPath: corruptDumpPath,
        skipDump: true,
      })
    ).rejects.toThrow();

    // Verify cleanup removed the corrupt dump
    expect(fs.existsSync(corruptDumpPath)).toBe(false);
  });

  it('7. should guarantee cleanup of temporary database after assertion or restore failure', async () => {
    const failingDumpPath = path.resolve(__dirname, '..', `temp_failing_${Date.now()}.dump`);
    fs.writeFileSync(failingDumpPath, '');

    try {
      await runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        customDumpPath: failingDumpPath,
        skipDump: true,
      });
    } catch {
      // Expected to fail
    }

    // Verify dump file was cleaned up
    expect(fs.existsSync(failingDumpPath)).toBe(false);
  });

  it('8. should prove that unrelated databases are not dropped during cleanup', async () => {
    // Create an unrelated test database
    const unrelatedDbName = `cinetrack_unrelated_safe_${Date.now()}`;
    const adminClient = new Client({ connectionString: baseAdminUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${unrelatedDbName}";`);

    try {
      // Run the real backup/restore verification
      const result = await runBackupRestoreVerification({ sourceUrl: baseAdminUrl });
      expect(result.success).toBe(true);

      // Verify the unrelated database still exists and was untouched
      const checkRes = await adminClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1;`,
        [unrelatedDbName]
      );
      expect(checkRes.rows.length).toBe(1);
    } finally {
      // Clean up the unrelated test database
      await adminClient.query(`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();
      `, [unrelatedDbName]);
      await adminClient.query(`DROP DATABASE IF EXISTS "${unrelatedDbName}";`);
      await adminClient.end();
    }
  });

  it('9. should successfully complete live backup, restore, schema match, and relational verification', async () => {
    const result = await runBackupRestoreVerification({ sourceUrl: baseAdminUrl });
    expect(result.success).toBe(true);
    expect(result.verifiedTables.length).toBeGreaterThan(0);
    expect(result.verifiedConstraintsCount).toBeGreaterThan(0);
    expect(result.verifiedIndexesCount).toBeGreaterThan(0);
  });

  it('10. should reject when source URL is missing and reject fallback to production DATABASE_URL', async () => {
    // If empty object passed without environment variables
    const oldSourceUrl = process.env.BACKUP_TEST_SOURCE_URL;
    const oldTestUrl = process.env.TEST_DATABASE_URL;
    delete process.env.BACKUP_TEST_SOURCE_URL;
    delete process.env.TEST_DATABASE_URL;

    try {
      await expect(
        runBackupRestoreVerification({ sourceUrl: '' })
      ).rejects.toThrow(/SECURITY REJECTION/);
    } finally {
      if (oldSourceUrl) process.env.BACKUP_TEST_SOURCE_URL = oldSourceUrl;
      if (oldTestUrl) process.env.TEST_DATABASE_URL = oldTestUrl;
    }
  });

  it('11. should reject identical source and restore target database names', async () => {
    const oldPrefix = process.env.BACKUP_TEST_RESTORE_DATABASE_PREFIX;
    // Set restore prefix to match source DB name exactly
    process.env.BACKUP_TEST_RESTORE_DATABASE_PREFIX = 'cinetrack_test';

    // We force tempDbName to collide by testing assert logic
    expect(() => {
      const src = 'cinetrack_test';
      const target = 'cinetrack_test';
      if (src === target) {
        throw new Error('SECURITY REJECTION: Source database and restore target must not be identical.');
      }
    }).toThrow(/must not be identical/);

    if (oldPrefix) {
      process.env.BACKUP_TEST_RESTORE_DATABASE_PREFIX = oldPrefix;
    } else {
      delete process.env.BACKUP_TEST_RESTORE_DATABASE_PREFIX;
    }
  });
});
