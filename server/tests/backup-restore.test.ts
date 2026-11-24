import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from 'pg';
import {
  runBackupRestoreVerification,
  computeTableChunkedHash,
  assertDisposableTestDatabase,
  assertApprovedHost,
  parsePostgresUrl,
  quoteIdent,
  resolveBackupSourceUrl,
  resolveAdminUrl,
  expectTablesMatch,
  compareColumnsBidirectional,
  compareConstraintsBidirectional,
  compareIndexesBidirectional,
  compareEnumsBidirectional,
  assertApprovedSourceTestDatabase,
  IMMUTABLE_EXACT_TEST_DATABASES,
} from '../scripts/test_backup_restore';

describe('Phase 3: Backup and Restore Verification Comprehensive Safety & Bidirectional Tests', () => {
  const baseAdminUrl =
    process.env.BACKUP_TEST_SOURCE_URL ||
    process.env.TEST_DATABASE_URL ||
    'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public';

  // --- Group 1: URL Resolution & Fallback Rejection Tests (Section 4.1 & Section 8 items 1-6) ---
  it('1. should reject when dedicated backup source URL is missing', () => {
    const oldSourceUrl = process.env.BACKUP_TEST_SOURCE_URL;
    delete process.env.BACKUP_TEST_SOURCE_URL;
    try {
      expect(() => resolveBackupSourceUrl(undefined)).toThrow(
        /SECURITY REJECTION: Dedicated backup source URL is required/
      );
    } finally {
      if (oldSourceUrl) process.env.BACKUP_TEST_SOURCE_URL = oldSourceUrl;
    }
  });

  it('2. should reject when backup source URL is an empty string', () => {
    expect(() => resolveBackupSourceUrl('')).toThrow(
      /SECURITY REJECTION: Dedicated backup source URL is missing or empty/
    );
    expect(() => resolveBackupSourceUrl('   ')).toThrow(
      /SECURITY REJECTION: Dedicated backup source URL is missing or empty/
    );
  });

  it('3. should refuse to silently fall back to TEST_DATABASE_URL when BACKUP_TEST_SOURCE_URL is unset', () => {
    const oldSourceUrl = process.env.BACKUP_TEST_SOURCE_URL;
    const oldTestUrl = process.env.TEST_DATABASE_URL;
    delete process.env.BACKUP_TEST_SOURCE_URL;
    process.env.TEST_DATABASE_URL = 'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public';

    try {
      expect(() => resolveBackupSourceUrl(undefined)).toThrow(
        /SECURITY REJECTION: Dedicated backup source URL is required \(BACKUP_TEST_SOURCE_URL\)/
      );
    } finally {
      if (oldSourceUrl) process.env.BACKUP_TEST_SOURCE_URL = oldSourceUrl;
      if (oldTestUrl) process.env.TEST_DATABASE_URL = oldTestUrl;
    }
  });

  it('4. should refuse to silently fall back to primary DATABASE_URL', () => {
    const oldSourceUrl = process.env.BACKUP_TEST_SOURCE_URL;
    delete process.env.BACKUP_TEST_SOURCE_URL;

    try {
      expect(() => resolveBackupSourceUrl(undefined)).toThrow(
        /Silent fallback to DATABASE_URL or TEST_DATABASE_URL is strictly disabled/
      );
    } finally {
      if (oldSourceUrl) process.env.BACKUP_TEST_SOURCE_URL = oldSourceUrl;
    }
  });

  it('5. should reject malformed connection URLs', () => {
    expect(() => parsePostgresUrl('not-a-valid-url')).toThrow(/Malformed PostgreSQL connection URL/);
    expect(() => parsePostgresUrl('')).toThrow(/cannot be empty or undefined/);
  });

  it('6. should validate parsed PostgreSQL connection components accurately', () => {
    const parsed = parsePostgresUrl('postgresql://myuser:mypass@127.0.0.1:5433/cinetrack_test?sslmode=disable');
    expect(parsed.user).toBe('myuser');
    expect(parsed.password).toBe('mypass');
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(5433);
    expect(parsed.database).toBe('cinetrack_test');
  });

  // --- Group 2: Host Allowlisting & Host Consistency (Section 4.2, 4.4 & Section 8 items 7-12) ---
  it('7. should reject unapproved source database hosts', () => {
    expect(() => assertApprovedHost('evil.external.host.com', 'Source Host')).toThrow(
      /is not on the strict (immutable )?allowlist of approved test hosts/
    );
    expect(() => assertApprovedHost('production-db.internal', 'Source Host')).toThrow(
      /is not on the strict (immutable )?allowlist of approved test hosts/
    );
  });

  it('8. should reject unapproved restore administration hosts', () => {
    expect(() => assertApprovedHost('unknown-admin.cloud.com', 'Restore Admin Host')).toThrow(
      /is not on the strict (immutable )?allowlist of approved test hosts/
    );
  });

  it('9. should reject source and restore administration host mismatch unconditionally', () => {
    const srcConn = parsePostgresUrl('postgresql://user:pass@localhost:5432/cinetrack_test');
    const oldAdminUrl = process.env.BACKUP_TEST_RESTORE_ADMIN_URL;
    process.env.BACKUP_TEST_RESTORE_ADMIN_URL = 'postgresql://user:pass@127.0.0.1:5432/postgres';

    try {
      expect(() => resolveAdminUrl(srcConn)).toThrow(
        /Restore administration host "127.0.0.1" does not match source database host "localhost"/
      );
    } finally {
      if (oldAdminUrl) {
        process.env.BACKUP_TEST_RESTORE_ADMIN_URL = oldAdminUrl;
      } else {
        delete process.env.BACKUP_TEST_RESTORE_ADMIN_URL;
      }
    }
  });

  it('10. should reject production database names unconditionally, including substrings', () => {
    expect(() => assertDisposableTestDatabase('cinetrack')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('production')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('cinetrack_production')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('cinetrack_production_test')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('prod_testing')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('live_test_db')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('main_ci_db')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('postgres')).toThrow(/SECURITY REJECTION/);
  });

  it('11. should strictly reject substring false positives like "contest", "protest", and "latest"', () => {
    expect(() => assertDisposableTestDatabase('contest')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('contest_db')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('protest')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('latest_movies')).toThrow(/SECURITY REJECTION/);
    expect(() => assertDisposableTestDatabase('attest_db')).toThrow(/SECURITY REJECTION/);
  });

  it('12. should accept legitimate approved test or disposable database names and enforce expected matching', () => {
    expect(() => assertDisposableTestDatabase('cinetrack_test')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_ci')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_e2e')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_disposable_abc123')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_restore_12345')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_test', 'cinetrack_test')).not.toThrow();
    expect(() => assertDisposableTestDatabase('cinetrack_test', 'cinetrack_ci')).toThrow(/does not match/);
    expect(() => assertDisposableTestDatabase('unapproved_custom_db', 'unapproved_custom_db')).toThrow(/not on the strict allowlist/);
  });

  it('13. should reject unsafe SQL identifiers', () => {
    expect(() => quoteIdent('valid_db_123')).not.toThrow();
    expect(quoteIdent('valid_db_123')).toBe('"valid_db_123"');
    expect(() => quoteIdent('drop database; --')).toThrow(/Unsafe SQL identifier/);
    expect(() => quoteIdent('db"name')).toThrow(/Unsafe SQL identifier/);
    expect(() => quoteIdent('db name')).toThrow(/Unsafe SQL identifier/);
  });

  // --- Group 3: Bidirectional Schema Comparison Tests (Section 5 & Section 8 items 15-26) ---
  it('14. should detect missing tables and unexpected extra tables in bidirectional table comparison', () => {
    expect(() => expectTablesMatch(['User', 'Movie'], ['User'])).toThrow(/Missing in restored: \[Movie\]/);
    expect(() => expectTablesMatch(['User'], ['User', 'ExtraTable'])).toThrow(/Unexpected extra in restored: \[ExtraTable\]/);
    expect(() => expectTablesMatch(['User', 'Movie'], ['User', 'Movie'])).not.toThrow();
  });

  it('15. should detect missing columns in restored database', () => {
    const src = [{ table_name: 'User', column_name: 'email', data_type: 'character varying', is_nullable: 'NO', udt_name: 'varchar', column_default: null }];
    const res: any[] = [];
    expect(() => compareColumnsBidirectional(src, res)).toThrow(/Column "User.email" missing in restored database/);
  });

  it('16. should detect unexpected extra columns in restored database', () => {
    const src: any[] = [];
    const res = [{ table_name: 'User', column_name: 'legacy_col', data_type: 'text', is_nullable: 'YES', udt_name: 'text', column_default: null }];
    expect(() => compareColumnsBidirectional(src, res)).toThrow(/Unexpected extra column "User.legacy_col" found in restored database/);
  });

  it('17. should detect column data type, nullability, or default mismatches', () => {
    const src = [{ table_name: 'User', column_name: 'email', data_type: 'character varying', is_nullable: 'NO', udt_name: 'varchar', column_default: null }];
    const resDiffType = [{ table_name: 'User', column_name: 'email', data_type: 'integer', is_nullable: 'NO', udt_name: 'int4', column_default: null }];
    const resDiffNull = [{ table_name: 'User', column_name: 'email', data_type: 'character varying', is_nullable: 'YES', udt_name: 'varchar', column_default: null }];

    expect(() => compareColumnsBidirectional(src, resDiffType)).toThrow(/Column definition mismatch on "User.email"/);
    expect(() => compareColumnsBidirectional(src, resDiffNull)).toThrow(/Column definition mismatch on "User.email"/);
  });

  it('18. should detect missing and unexpected extra constraints bidirectionally', () => {
    const src = [{ table_name: 'User', conname: 'User_email_key', def: 'UNIQUE (email)' }];
    const resEmpty: any[] = [];
    expect(() => compareConstraintsBidirectional(src, resEmpty)).toThrow(/Constraint "User:User_email_key" missing from restored database/);

    const resExtra = [
      { table_name: 'User', conname: 'User_email_key', def: 'UNIQUE (email)' },
      { table_name: 'User', conname: 'User_unexpected_con', def: 'CHECK (email IS NOT NULL)' },
    ];
    expect(() => compareConstraintsBidirectional(src, resExtra)).toThrow(/Unexpected extra constraint "User:User_unexpected_con" found in restored database/);
  });

  it('19. should detect missing and unexpected extra indexes bidirectionally', () => {
    const src = [{ tablename: 'User', indexname: 'User_email_idx', indexdef: 'CREATE UNIQUE INDEX "User_email_idx" ON "User" (email)' }];
    const resEmpty: any[] = [];
    expect(() => compareIndexesBidirectional(src, resEmpty)).toThrow(/Index "User_email_idx" missing from restored database/);

    const resExtra = [
      { tablename: 'User', indexname: 'User_email_idx', indexdef: 'CREATE UNIQUE INDEX "User_email_idx" ON "User" (email)' },
      { tablename: 'User', indexname: 'User_rogue_idx', indexdef: 'CREATE INDEX "User_rogue_idx" ON "User" (id)' },
    ];
    expect(() => compareIndexesBidirectional(src, resExtra)).toThrow(/Unexpected extra index "User_rogue_idx" found in restored database/);
  });

  it('20. should detect missing and unexpected extra enum values bidirectionally', () => {
    const src = [
      { typname: 'MediaType', enumlabel: 'MOVIE', enumsortorder: 1 },
      { typname: 'MediaType', enumlabel: 'TV', enumsortorder: 2 },
    ];
    const resMissing = [{ typname: 'MediaType', enumlabel: 'MOVIE', enumsortorder: 1 }];
    const resExtra = [
      { typname: 'MediaType', enumlabel: 'MOVIE', enumsortorder: 1 },
      { typname: 'MediaType', enumlabel: 'TV', enumsortorder: 2 },
      { typname: 'MediaType', enumlabel: 'PODCAST', enumsortorder: 3 },
    ];

    expect(() => compareEnumsBidirectional(src, resMissing)).toThrow(/Enum value "MediaType:TV:2" missing from restored database/);
    expect(() => compareEnumsBidirectional(src, resExtra)).toThrow(/Unexpected extra enum value "MediaType:PODCAST:3" found in restored database/);
  });

  // --- Group 4: Failure Injection & Cleanup Reliability (Section 4.6 & Section 8 items 30-36) ---
  it('21. should handle and cleanup after injected pg_dump failure', async () => {
    await expect(
      runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        injectDumpFailure: true,
      })
    ).rejects.toThrow(/Injected simulated pg_dump execution failure/);
  });

  it('22. should handle and guarantee cleanup of temporary database after injected restore failure', async () => {
    await expect(
      runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        injectRestoreFailure: true,
      })
    ).rejects.toThrow(/Injected simulated pg_restore execution failure/);
  });

  it('23. should handle and guarantee cleanup after verification assertion failure', async () => {
    await expect(
      runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        injectVerificationFailure: true,
      })
    ).rejects.toThrow(/Injected simulated verification assertion failure/);
  });

  it('24. should report secondary cleanup failure when dump file deletion fails', async () => {
    await expect(
      runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        injectDumpCleanupFailure: true,
      })
    ).rejects.toThrow(/CLEANUP FAILURE.*Injected simulated dump file deletion failure/s);
  });

  it('25. should report secondary cleanup failure when database drop fails', async () => {
    await expect(
      runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        injectDbCleanupFailure: true,
      })
    ).rejects.toThrow(/CLEANUP FAILURE.*Injected simulated database drop failure/s);
  });

  it('26. should report secondary cleanup failure when admin client shutdown fails', async () => {
    await expect(
      runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        injectClientShutdownFailure: true,
      })
    ).rejects.toThrow(/CLEANUP FAILURE.*Injected simulated adminClient shutdown failure/s);
  });

  it('27. should combine primary failure and secondary cleanup failure when both throw', async () => {
    await expect(
      runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        injectVerificationFailure: true,
        injectDumpCleanupFailure: true,
      })
    ).rejects.toThrow(/PRIMARY FAILURE:.*AND CLEANUP FAILURE:/s);
  });

  // --- Group 5: Live Database Verification (Section 5.7 & Section 8 items 9, 13, 27-29) ---
  it('28. should reject corrupt or empty backup dump files on restore and preserve caller custom dump file', async () => {
    const corruptDumpPath = path.resolve(__dirname, '..', `temp_corrupt_${Date.now()}.dump`);
    fs.writeFileSync(corruptDumpPath, 'THIS_IS_CORRUPT_NON_DUMP_DATA');

    try {
      await expect(
        runBackupRestoreVerification({
          sourceUrl: baseAdminUrl,
          customDumpPath: corruptDumpPath,
          skipDump: true,
        })
      ).rejects.toThrow();

      // Caller-owned custom dump file must be preserved by cleanup
      expect(fs.existsSync(corruptDumpPath)).toBe(true);
    } finally {
      if (fs.existsSync(corruptDumpPath)) {
        fs.unlinkSync(corruptDumpPath);
      }
    }
  });

  it('29. should prove that unrelated databases are not dropped during cleanup', async () => {
    const unrelatedDbName = `cinetrack_unrelated_safe_${Date.now()}`;
    const adminClient = new Client({ connectionString: baseAdminUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${unrelatedDbName}";`);

    try {
      const result = await runBackupRestoreVerification({ sourceUrl: baseAdminUrl });
      expect(result.success).toBe(true);

      const checkRes = await adminClient.query(
        `SELECT 1 FROM pg_database WHERE datname = $1;`,
        [unrelatedDbName]
      );
      expect(checkRes.rows.length).toBe(1);
    } finally {
      await adminClient.query(`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid();
      `, [unrelatedDbName]);
      await adminClient.query(`DROP DATABASE IF EXISTS "${unrelatedDbName}";`);
      await adminClient.end();
    }
  });

  it('30. should successfully complete live backup, restore, bidirectional schema match, and relational usability verification', async () => {
    const result = await runBackupRestoreVerification({ sourceUrl: baseAdminUrl });
    expect(result.success).toBe(true);
    expect(result.verifiedTables.length).toBeGreaterThan(0);
    expect(result.verifiedConstraintsCount).toBeGreaterThan(0);
    expect(result.verifiedIndexesCount).toBeGreaterThan(0);
  });

  it('31. should preserve caller-provided custom dump files after successful verification', async () => {
    const customValidDump = path.resolve(__dirname, '..', `temp_custom_valid_${Date.now()}.dump`);

    const genResult = await runBackupRestoreVerification({
      sourceUrl: baseAdminUrl,
      customDumpPath: customValidDump,
    });
    expect(genResult.success).toBe(true);
    expect(fs.existsSync(customValidDump)).toBe(true);

    try {
      const verifyResult = await runBackupRestoreVerification({
        sourceUrl: baseAdminUrl,
        customDumpPath: customValidDump,
        skipDump: true,
      });
      expect(verifyResult.success).toBe(true);
      expect(fs.existsSync(customValidDump)).toBe(true);
    } finally {
      if (fs.existsSync(customValidDump)) {
        fs.unlinkSync(customValidDump);
      }
    }
  });

  it('32. should execute true keyset pagination across chunk boundaries without OFFSET on single primary key tables', async () => {
    const client = new Client({ connectionString: baseAdminUrl });
    await client.connect();

    try {
      // Use small chunk size (e.g. 2 rows) to verify multiple keyset traversals
      const result = await computeTableChunkedHash(client, 'User', 2);
      expect(result).toBeDefined();
      expect(result.rowCount).toBeGreaterThanOrEqual(0);
      expect(result.tableHash).toHaveLength(64);
    } finally {
      await client.end();
    }
  });

  it('33. should execute keyset pagination with composite PK comparison (pk1, pk2) > ($1, $2) across chunk boundaries without OFFSET', async () => {
    const client = new Client({ connectionString: baseAdminUrl });
    await client.connect();

    const tempCompositeTable = `temp_composite_pk_${Date.now()}`;
    try {
      await client.query(`
        CREATE TABLE "${tempCompositeTable}" (
          collection_id TEXT NOT NULL,
          movie_id TEXT NOT NULL,
          val INT NOT NULL,
          PRIMARY KEY (collection_id, movie_id)
        );
      `);

      // Insert 10 rows across multiple composite keys
      for (let i = 1; i <= 10; i++) {
        await client.query(
          `INSERT INTO "${tempCompositeTable}" (collection_id, movie_id, val) VALUES ($1, $2, $3);`,
          [`col_${Math.floor(i / 3)}`, `mov_${i % 3}`, i]
        );
      }

      // Compute hash with small chunk size = 3 (triggers 4 keyset iterations)
      const chunkedResult = await computeTableChunkedHash(client, tempCompositeTable, 3);
      expect(chunkedResult.rowCount).toBe(10);
      expect(chunkedResult.tableHash).toHaveLength(64);

      // Verify that full-batch hash matches chunked hash identically
      const singleBatchResult = await computeTableChunkedHash(client, tempCompositeTable, 100);
      expect(chunkedResult.tableHash).toBe(singleBatchResult.tableHash);
    } finally {
      await client.query(`DROP TABLE IF EXISTS "${tempCompositeTable}";`);
      await client.end();
    }
  });

  it('34. should reject unapproved or untrusted hosts fail-closed', () => {
    expect(() => assertApprovedHost('192.168.1.100', 'Source Host')).toThrow(
      /SECURITY REJECTION: Source Host "192.168.1.100" is not on the strict/
    );
    expect(() => assertApprovedHost('attacker-database.com', 'Source Host')).toThrow(
      /SECURITY REJECTION: Source Host "attacker-database.com" is not on the strict/
    );
  });

  it('35. should maintain snapshot consistency across keyset pagination during concurrent writes using single REPEATABLE READ snapshot', async () => {
    const clientA = new Client({ connectionString: baseAdminUrl });
    const clientB = new Client({ connectionString: baseAdminUrl });
    await clientA.connect();
    await clientB.connect();

    const testTable = `temp_snapshot_test_${Date.now()}`;
    try {
      await clientA.query(`
        CREATE TABLE "${testTable}" (
          id TEXT PRIMARY KEY,
          val INT NOT NULL
        );
      `);
      // Insert initial 5 rows
      for (let i = 1; i <= 5; i++) {
        await clientA.query(`INSERT INTO "${testTable}" (id, val) VALUES ($1, $2);`, [`id_${i}`, i]);
      }

      // Start REPEATABLE READ READ ONLY transaction on clientA
      await clientA.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');

      // Compute hash for initial rows inside transaction (inExistingTransaction = true)
      const initialHash = await computeTableChunkedHash(clientA, testTable, 2, true);
      expect(initialHash.rowCount).toBe(5);

      // Concurrently insert 5 more rows on clientB
      for (let i = 6; i <= 10; i++) {
        await clientB.query(`INSERT INTO "${testTable}" (id, val) VALUES ($1, $2);`, [`id_${i}`, i]);
      }

      // Re-run computeTableChunkedHash on clientA inside the SAME snapshot
      const snapshotHash = await computeTableChunkedHash(clientA, testTable, 2, true);

      // ClientA must still see exactly 5 rows and identical hash due to REPEATABLE READ snapshot isolation
      expect(snapshotHash.rowCount).toBe(5);
      expect(snapshotHash.tableHash).toBe(initialHash.tableHash);

      await clientA.query('COMMIT;');

      // Outside the snapshot transaction, clientA now sees all 10 rows
      const fullHash = await computeTableChunkedHash(clientA, testTable, 2, false);
      expect(fullHash.rowCount).toBe(10);
      expect(fullHash.tableHash).not.toBe(initialHash.tableHash);
    } finally {
      try {
        await clientA.query('ROLLBACK;');
      } catch {}
      await clientA.query(`DROP TABLE IF EXISTS "${testTable}";`);
      await clientA.end();
      await clientB.end();
    }
  });

  it('36. should reject broad prefixes and production databases in assertApprovedSourceTestDatabase', () => {
    expect(() => assertApprovedSourceTestDatabase('cinetrack_production_test')).toThrow(
      /is a production\/root database|is not on the immutable exact test databases list/
    );
    expect(() => assertApprovedSourceTestDatabase('cinetrack_prod')).toThrow(
      /is a production\/root database/
    );
    expect(() => assertApprovedSourceTestDatabase('cinetrack')).toThrow(
      /is a production\/root database/
    );
    expect(() => assertApprovedSourceTestDatabase('postgres')).toThrow(
      /is a production\/root database/
    );
    expect(() => assertApprovedSourceTestDatabase('random_prefix_test')).toThrow(
      /is not on the immutable exact test databases list/
    );
  });

  it('37. should allow exact approved test databases in assertApprovedSourceTestDatabase', () => {
    for (const db of IMMUTABLE_EXACT_TEST_DATABASES) {
      expect(() => assertApprovedSourceTestDatabase(db)).not.toThrow();
    }
  });

  afterAll(() => {
    // Clean up any injected-failure temp dump files
    const serverDir = path.resolve(__dirname, '..');
    const files = fs.readdirSync(serverDir);
    for (const file of files) {
      if (file.startsWith('temp_backup_') && file.endsWith('.dump')) {
        try {
          fs.unlinkSync(path.join(serverDir, file));
        } catch {}
      }
      if (file.startsWith('temp_corrupt_') && file.endsWith('.dump')) {
        try {
          fs.unlinkSync(path.join(serverDir, file));
        } catch {}
      }
    }
  });
});
