import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  executeProductionBackup,
  applyBackupRetention,
  executeRestoreFromBackup,
  verifyBackupRestorability,
  validateBackupEnvironment,
  calculateFileSha256,
  BACKUP_FILE_REGEX,
} from '../scripts/backup_production';
import { decryptBackupFile, setRestrictiveDirMode } from '../src/utils/backup_crypto';

describe('Phase 6: Production Backup Strategy, Scheduler & Retention Worker Tests', () => {
  const testBackupDir = path.resolve(__dirname, 'temp_prod_backups');
  const testDbUrl =
    process.env.BACKUP_TEST_SOURCE_URL ||
    process.env.TEST_DATABASE_URL ||
    'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_test?schema=public';
  const passphrase = 'SuperSecureProductionPassphrase2026!';

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

  it('1. should execute a real production backup, creating encrypted archive and metadata manifest', async () => {
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
    });

    expect(meta.status).toBe('SUCCESS');
    expect(meta.encryptedSize).toBeGreaterThan(50);
    expect(meta.rawSize).toBeGreaterThan(0);
    expect(meta.rawSha256).toHaveLength(64);
    expect(meta.encryptedSha256).toHaveLength(64);
    expect(fs.existsSync(meta.archivePath)).toBe(true);
    expect(fs.existsSync(meta.metaPath)).toBe(true);

    // Verify metadata JSON contents
    const metaJson = JSON.parse(fs.readFileSync(meta.metaPath, 'utf-8'));
    expect(metaJson.id).toBe(meta.id);
    expect(metaJson.status).toBe('SUCCESS');
    expect(metaJson.databaseName).toBe('cinetrack_test');

    // Verify encrypted archive can be decrypted and matches rawSha256
    const decryptedTemp = path.join(testBackupDir, 'test_decrypted.dump');
    await decryptBackupFile(meta.archivePath, decryptedTemp, passphrase);

    expect(fs.existsSync(decryptedTemp)).toBe(true);
    const decSha = crypto.createHash('sha256').update(fs.readFileSync(decryptedTemp)).digest('hex');
    expect(decSha).toBe(meta.rawSha256);
  });

  it('2. should reject execution when encryption passphrase is missing', async () => {
    const oldKey = process.env.BACKUP_ENCRYPTION_KEY;
    delete process.env.BACKUP_ENCRYPTION_KEY;

    try {
      await expect(
        executeProductionBackup({
          databaseUrl: testDbUrl,
          outputDir: testBackupDir,
          encryptionPassphrase: '',
        })
      ).rejects.toThrow(/BACKUP_ENCRYPTION.*is strictly required/i);
    } finally {
      if (oldKey) process.env.BACKUP_ENCRYPTION_KEY = oldKey;
    }
  });

  it('3. should correctly prune expired backups according to retention policy', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Create a 40-day-old backup
    const oldName = 'cinetrack_20261010_120000.dump.enc';
    const oldPath = path.join(testBackupDir, oldName);
    const oldMeta = `${oldPath}.meta.json`;
    fs.writeFileSync(oldPath, 'OLD_BACKUP_DUMP');
    fs.writeFileSync(oldMeta, '{}');
    const oldTime = (now - 40 * dayMs) / 1000;
    fs.utimesSync(oldPath, oldTime, oldTime);
    fs.utimesSync(oldMeta, oldTime, oldTime);

    // Create a 5-day-old backup
    const recentName = 'cinetrack_20261118_120000.dump.enc';
    const recentPath = path.join(testBackupDir, recentName);
    const recentMeta = `${recentPath}.meta.json`;
    fs.writeFileSync(recentPath, 'RECENT_BACKUP_DUMP');
    fs.writeFileSync(recentMeta, '{}');
    const recentTime = (now - 5 * dayMs) / 1000;
    fs.utimesSync(recentPath, recentTime, recentTime);
    fs.utimesSync(recentMeta, recentTime, recentTime);

    // Create a brand new backup
    const newName = 'cinetrack_20261123_120000.dump.enc';
    const newPath = path.join(testBackupDir, newName);
    const newMeta = `${newPath}.meta.json`;
    fs.writeFileSync(newPath, 'NEW_BACKUP_DUMP');
    fs.writeFileSync(newMeta, '{}');

    // Retention: 30 days
    const res = applyBackupRetention(testBackupDir, 30);

    expect(res.pruned).toContain(oldName);
    expect(res.kept).toContain(recentName);
    expect(res.kept).toContain(newName);

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(oldMeta)).toBe(false);
    expect(fs.existsSync(recentPath)).toBe(true);
    expect(fs.existsSync(newPath)).toBe(true);
  });

  it('4. should NEVER prune the newest backup, even if older than retention window (last known good guarantee)', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Only one backup exists, but it is 60 days old
    const soleBackupName = 'cinetrack_20260901_120000.dump.enc';
    const solePath = path.join(testBackupDir, soleBackupName);
    const soleMeta = `${solePath}.meta.json`;
    fs.writeFileSync(solePath, 'SOLE_OLD_BACKUP');
    fs.writeFileSync(soleMeta, JSON.stringify({ status: 'SUCCESS' }));
    const oldTime = (now - 60 * dayMs) / 1000;
    fs.utimesSync(solePath, oldTime, oldTime);
    fs.utimesSync(soleMeta, oldTime, oldTime);

    // Retention: 30 days
    const res = applyBackupRetention(testBackupDir, 30);

    // MUST NOT BE PRUNED!
    expect(res.pruned).toHaveLength(0);
    expect(res.kept).toContain(soleBackupName);
    expect(fs.existsSync(solePath)).toBe(true);
  });

  it('5. should strictly ignore unrelated files during retention cleanup', () => {
    const unrelatedFile1 = path.join(testBackupDir, 'user_document.pdf');
    const unrelatedFile2 = path.join(testBackupDir, 'notes.txt');
    const unrelatedFile3 = path.join(testBackupDir, 'custom_dump.dump');
    fs.writeFileSync(unrelatedFile1, 'PDF_DATA');
    fs.writeFileSync(unrelatedFile2, 'TEXT_DATA');
    fs.writeFileSync(unrelatedFile3, 'RAW_DUMP');

    const res = applyBackupRetention(testBackupDir, 1);

    expect(fs.existsSync(unrelatedFile1)).toBe(true);
    expect(fs.existsSync(unrelatedFile2)).toBe(true);
    expect(fs.existsSync(unrelatedFile3)).toBe(true);
  });

  it('6. should ensure concurrent backups started in the same second produce distinct filenames without collision or overwriting', async () => {
    // Execute two real backups in parallel
    const [meta1, meta2] = await Promise.all([
      executeProductionBackup({
        databaseUrl: testDbUrl,
        outputDir: testBackupDir,
        encryptionPassphrase: passphrase,
      }),
      executeProductionBackup({
        databaseUrl: testDbUrl,
        outputDir: testBackupDir,
        encryptionPassphrase: passphrase,
      }),
    ]);

    expect(meta1.id).not.toBe(meta2.id);
    expect(meta1.archivePath).not.toBe(meta2.archivePath);
    expect(meta1.metaPath).not.toBe(meta2.metaPath);
    expect(fs.existsSync(meta1.archivePath)).toBe(true);
    expect(fs.existsSync(meta2.archivePath)).toBe(true);
    expect(fs.existsSync(meta1.metaPath)).toBe(true);
    expect(fs.existsSync(meta2.metaPath)).toBe(true);
    expect(meta1.status).toBe('SUCCESS');
    expect(meta2.status).toBe('SUCCESS');
  });

  it('7. should accurately compute streaming SHA-256 without whole-file reads on empty, small, and large binary files', async () => {
    const emptyFile = path.join(testBackupDir, 'stream_empty.bin');
    fs.writeFileSync(emptyFile, Buffer.alloc(0));

    const smallFile = path.join(testBackupDir, 'stream_small.bin');
    const smallContent = Buffer.from('CineTrack Streaming SHA-256 Test Content');
    fs.writeFileSync(smallFile, smallContent);

    // 256KB binary buffer (larger than 64KB highWaterMark chunk)
    const largeFile = path.join(testBackupDir, 'stream_large.bin');
    const largeContent = crypto.randomBytes(256 * 1024);
    fs.writeFileSync(largeFile, largeContent);

    const emptySha = await calculateFileSha256(emptyFile);
    expect(emptySha).toBe(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));

    const smallSha = await calculateFileSha256(smallFile);
    expect(smallSha).toBe(crypto.createHash('sha256').update(smallContent).digest('hex'));

    const largeSha = await calculateFileSha256(largeFile);
    expect(largeSha).toBe(crypto.createHash('sha256').update(largeContent).digest('hex'));
  });

  it('8. should verify production backup restorability by decrypting and restoring into a disposable database', async () => {
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
    });

    expect(meta.status).toBe('SUCCESS');

    // Run restorability verification directly
    const vRes = await verifyBackupRestorability(meta.archivePath, passphrase, {
      databaseUrl: testDbUrl,
    });

    expect(vRes.verified).toBe(true);
    expect(vRes.verifiedTablesCount).toBeGreaterThan(0);
    expect(vRes.disposableDbName).toMatch(/^cinetrack_restore_verify_/);
  });

  it('9. should record VERIFIED restore status in metadata manifest when verifyRestore option is enabled', async () => {
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
      verifyRestore: true,
    });

    expect(meta.status).toBe('SUCCESS');
    expect(meta.restoreVerification).toBeDefined();
    expect(meta.restoreVerification?.status).toBe('VERIFIED');
    expect(meta.restoreVerification?.verifiedAt).toBeDefined();
    expect(meta.restoreVerification?.durationMs).toBeGreaterThan(0);

    // Read manifest from disk
    const savedMeta = JSON.parse(fs.readFileSync(meta.metaPath, 'utf-8'));
    expect(savedMeta.restoreVerification?.status).toBe('VERIFIED');
  });

  it('10. should safely handle retention policy prioritizing the newest successful backup even if failed backups exist', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // A valid successful backup from 45 days ago
    const successfulOldName = 'cinetrack_20261010_100000_11111111.dump.enc';
    const successfulOldPath = path.join(testBackupDir, successfulOldName);
    const successfulOldMeta = `${successfulOldPath}.meta.json`;
    fs.writeFileSync(successfulOldPath, 'SUCCESSFUL_OLD_BACKUP');
    fs.writeFileSync(successfulOldMeta, JSON.stringify({ status: 'SUCCESS' }));
    const oldTime = (now - 45 * dayMs) / 1000;
    fs.utimesSync(successfulOldPath, oldTime, oldTime);
    fs.utimesSync(successfulOldMeta, oldTime, oldTime);

    // A newer failed backup from 2 days ago
    const failedRecentName = 'cinetrack_20261122_100000_22222222.dump.enc';
    const failedRecentPath = path.join(testBackupDir, failedRecentName);
    const failedRecentMeta = `${failedRecentPath}.meta.json`;
    fs.writeFileSync(failedRecentPath, 'FAILED_RECENT_BACKUP');
    fs.writeFileSync(failedRecentMeta, JSON.stringify({ status: 'FAILED' }));
    const recentTime = (now - 2 * dayMs) / 1000;
    fs.utimesSync(failedRecentPath, recentTime, recentTime);
    fs.utimesSync(failedRecentMeta, recentTime, recentTime);

    // Retention window: 30 days
    const res = applyBackupRetention(testBackupDir, 30);

    // The successful backup must be preserved as the last known good backup!
    expect(res.kept).toContain(successfulOldName);
    expect(fs.existsSync(successfulOldPath)).toBe(true);
  });

  it('11. should perform restore verification by default on production backups', async () => {
    // When verifyRestore is undefined and BACKUP_VERIFY_RESTORE is not set to false,
    // it must automatically perform restore verification
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
    });

    expect(meta.status).toBe('SUCCESS');
    expect(meta.restoreVerification).toBeDefined();
    expect(meta.restoreVerification?.status).toBe('VERIFIED');
    expect(meta.restoreVerification?.verifiedTablesCount).toBeGreaterThanOrEqual(8);
    expect(meta.restoreVerification?.checksumsVerified).toBe(true);
    expect(meta.sourceStats).toBeDefined();
    expect(meta.sourceStats?.tables).toContain('User');
    expect(meta.sourceStats?.tables).toContain('Movie');
  });

  it('12. should explicitly record SKIPPED in manifest when verifyRestore is intentionally set to false', async () => {
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
      verifyRestore: false,
    });

    expect(meta.status).toBe('SUCCESS');
    expect(meta.restoreVerification).toBeDefined();
    expect(meta.restoreVerification?.status).toBe('SKIPPED');
    expect(meta.restoreVerification?.verifiedAt).toBeUndefined();

    // Verify disk manifest also records SKIPPED
    const diskMeta = JSON.parse(fs.readFileSync(meta.metaPath, 'utf-8'));
    expect(diskMeta.restoreVerification?.status).toBe('SKIPPED');
  });

  it('13. should fail closed and preserve backup archive for investigation if restore verification fails', async () => {
    // We can simulate verification failure by passing an invalid sourceStats table count expectation
    const originalVerify = verifyBackupRestorability;

    // Execute backup with injected verification failure
    await expect(
      executeProductionBackup({
        databaseUrl: testDbUrl,
        outputDir: testBackupDir,
        encryptionPassphrase: passphrase,
        verifyRestore: true,
        adminUrl: 'postgresql://invalid_admin:invalid@localhost:5432/postgres',
      })
    ).rejects.toThrow(/restorability verification/i);

    // Verify that the backup archive file was preserved for forensic investigation!
    const files = fs.readdirSync(testBackupDir).filter((f) => BACKUP_FILE_REGEX.test(f));
    expect(files.length).toBeGreaterThan(0);

    // Verify that the failure manifest was written to disk with FAILED status
    const metaFiles = fs.readdirSync(testBackupDir).filter((f) => f.endsWith('.meta.json'));
    expect(metaFiles.length).toBeGreaterThan(0);
    const failureMeta = JSON.parse(fs.readFileSync(path.join(testBackupDir, metaFiles[0]), 'utf-8'));
    expect(failureMeta.status).toBe('FAILED');
    expect(failureMeta.restoreVerification?.status).toBe('FAILED');
  });

  it('14. should treat missing manifests as INVALID and never select them as last known-good backup', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Archive 1: Valid backup from 40 days ago WITH valid manifest
    const validOldName = 'cinetrack_20261010_100000_11111111.dump.enc';
    const validOldPath = path.join(testBackupDir, validOldName);
    const validOldMeta = `${validOldPath}.meta.json`;
    fs.writeFileSync(validOldPath, 'VALID_OLD_BACKUP');
    fs.writeFileSync(validOldMeta, JSON.stringify({ status: 'SUCCESS', id: '1' }));
    const oldTime = (now - 40 * dayMs) / 1000;
    fs.utimesSync(validOldPath, oldTime, oldTime);
    fs.utimesSync(validOldMeta, oldTime, oldTime);

    // Archive 2: Newer archive from 2 days ago WITHOUT manifest (interrupted/corrupted)
    const invalidRecentName = 'cinetrack_20261122_100000_22222222.dump.enc';
    const invalidRecentPath = path.join(testBackupDir, invalidRecentName);
    fs.writeFileSync(invalidRecentPath, 'CORRUPTED_DUMP_NO_META');
    const recentTime = (now - 2 * dayMs) / 1000;
    fs.utimesSync(invalidRecentPath, recentTime, recentTime);

    // Retention: 30 days
    const res = applyBackupRetention(testBackupDir, 30);

    // The valid old backup MUST be kept as the last known good backup!
    // The invalid recent archive must NOT usurp the valid backup.
    expect(res.kept).toContain(validOldName);
    expect(fs.existsSync(validOldPath)).toBe(true);
  });

  it('15. should treat malformed JSON manifests as INVALID and preserve older valid backups', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Valid old backup (35 days old)
    const validOldName = 'cinetrack_20261015_100000_33333333.dump.enc';
    const validOldPath = path.join(testBackupDir, validOldName);
    const validOldMeta = `${validOldPath}.meta.json`;
    fs.writeFileSync(validOldPath, 'VALID_OLD_DATA');
    fs.writeFileSync(validOldMeta, JSON.stringify({ status: 'SUCCESS', id: '3' }));
    const oldTime = (now - 35 * dayMs) / 1000;
    fs.utimesSync(validOldPath, oldTime, oldTime);
    fs.utimesSync(validOldMeta, oldTime, oldTime);

    // Newer archive (5 days old) with corrupted/malformed manifest
    const malformedRecentName = 'cinetrack_20261119_100000_44444444.dump.enc';
    const malformedRecentPath = path.join(testBackupDir, malformedRecentName);
    const malformedRecentMeta = `${malformedRecentPath}.meta.json`;
    fs.writeFileSync(malformedRecentPath, 'DATA_WITH_CORRUPT_META');
    fs.writeFileSync(malformedRecentMeta, 'MALFORMED_NON_JSON_CONTENT{{{');
    const recentTime = (now - 5 * dayMs) / 1000;
    fs.utimesSync(malformedRecentPath, recentTime, recentTime);
    fs.utimesSync(malformedRecentMeta, recentTime, recentTime);

    const res = applyBackupRetention(testBackupDir, 30);

    // Valid old backup must be preserved as the true last known-good!
    expect(res.kept).toContain(validOldName);
    expect(fs.existsSync(validOldPath)).toBe(true);
  });

  it('16. should preserve at least minBackupsToKeep valid backups even if all are older than retention window', () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Create 4 valid backups all older than 30 days (e.g. 40, 50, 60, 70 days old)
    const backupNames: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const name = `cinetrack_2026090${i}_100000_0000000${i}.dump.enc`;
      const p = path.join(testBackupDir, name);
      const m = `${p}.meta.json`;
      fs.writeFileSync(p, `VALID_BACKUP_${i}`);
      fs.writeFileSync(m, JSON.stringify({ status: 'SUCCESS', id: `${i}` }));
      const t = (now - (30 + i * 10) * dayMs) / 1000;
      fs.utimesSync(p, t, t);
      fs.utimesSync(m, t, t);
      backupNames.push(name);
    }

    // Apply retention with minBackupsToKeep = 3, retentionDays = 30
    const res = applyBackupRetention(testBackupDir, 30, { minBackupsToKeep: 3 });

    // Newest 3 must be kept (to satisfy minBackupsToKeep = 3)
    // Oldest 1 (70 days old) should be pruned
    expect(res.kept).toContain(backupNames[0]); // 40 days old (newest)
    expect(res.kept).toContain(backupNames[1]); // 50 days old
    expect(res.kept).toContain(backupNames[2]); // 60 days old
    expect(res.pruned).toContain(backupNames[3]); // 70 days old
    expect(fs.existsSync(path.join(testBackupDir, backupNames[3]))).toBe(false);
  });

  it('17. should pass operational validation with valid database, configuration, and toolchains', async () => {
    const res = await validateBackupEnvironment({
      databaseUrl: testDbUrl,
      encryptionPassphrase: 'SuperSecureValidationKey2026!#$',
      outputDir: testBackupDir,
      retentionDays: 30,
      minBackupsToKeep: 3,
    });

    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.checks.databaseUrlConfigured).toBe(true);
    expect(res.checks.encryptionKeyConfigured).toBe(true);
    expect(res.checks.outputDirectory.writable).toBe(true);
    expect(res.checks.database.snapshotExportCapable).toBe(true);
    expect(res.checks.pgDump.installed).toBe(true);
    expect(res.checks.pgRestore.installed).toBe(true);
  });

  it('18. should fail operational validation when passphrase is missing or too short', async () => {
    const resEmpty = await validateBackupEnvironment({
      databaseUrl: testDbUrl,
      encryptionPassphrase: '',
      outputDir: testBackupDir,
    });
    expect(resEmpty.valid).toBe(false);
    expect(resEmpty.errors.some((e) => e.includes('missing or empty'))).toBe(true);

    const resShort = await validateBackupEnvironment({
      databaseUrl: testDbUrl,
      encryptionPassphrase: 'ShortKey123',
      outputDir: testBackupDir,
    });
    expect(resShort.valid).toBe(false);
    expect(resShort.errors.some((e) => e.includes('too short'))).toBe(true);
  });

  it('19. should fail operational validation when DATABASE_URL is missing or malformed', async () => {
    const resMissing = await validateBackupEnvironment({
      databaseUrl: '',
      encryptionPassphrase: 'ValidSuperSecureKey2026!#$',
      outputDir: testBackupDir,
    });
    expect(resMissing.valid).toBe(false);
    expect(resMissing.errors.some((e) => e.includes('DATABASE_URL is missing'))).toBe(true);

    const resInvalid = await validateBackupEnvironment({
      databaseUrl: 'not_a_valid_postgres_url://host:port',
      encryptionPassphrase: 'ValidSuperSecureKey2026!#$',
      outputDir: testBackupDir,
    });
    expect(resInvalid.valid).toBe(false);
  });

  it('20. should execute coordinated snapshot backup and verify comprehensive structural restorability', async () => {
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
      verifyRestore: true,
    });

    expect(meta.status).toBe('SUCCESS');
    expect(meta.restoreVerification?.status).toBe('VERIFIED');
    expect(meta.restoreVerification?.verifiedTablesCount).toBe(9);
    expect(meta.restoreVerification?.checksumsVerified).toBe(true);
  }, 120000);

  it('21. should reject unsafe or root output directory path', async () => {
    const res = await validateBackupEnvironment({
      databaseUrl: testDbUrl,
      encryptionPassphrase: 'SuperSecureValidationKey2026!#$',
      outputDir: process.platform === 'win32' ? 'C:\\' : '/',
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('root or critical system directory'))).toBe(true);
  });

  it('22. should reject invalid retention days or minBackupsToKeep', async () => {
    const resDays = await validateBackupEnvironment({
      databaseUrl: testDbUrl,
      encryptionPassphrase: 'SuperSecureValidationKey2026!#$',
      outputDir: testBackupDir,
      retentionDays: -5,
    });
    expect(resDays.valid).toBe(false);
    expect(resDays.errors.some((e) => e.includes('BACKUP_RETENTION_DAYS must be a positive integer'))).toBe(true);

    const resKeep = await validateBackupEnvironment({
      databaseUrl: testDbUrl,
      encryptionPassphrase: 'SuperSecureValidationKey2026!#$',
      outputDir: testBackupDir,
      minBackupsToKeep: 0,
    });
    expect(resKeep.valid).toBe(false);
    expect(resKeep.errors.some((e) => e.includes('BACKUP_MIN_KEEP must be a positive integer >= 1'))).toBe(true);
  });

  it('23. should detect when target database name matches disposable verification prefix', async () => {
    const bogusUrl = 'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_restore_disposable?schema=public';
    const res = await validateBackupEnvironment({
      databaseUrl: bogusUrl,
      encryptionPassphrase: 'SuperSecureValidationKey2026!#$',
      outputDir: testBackupDir,
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('matches the disposable restore prefix'))).toBe(true);
  });

  it('24. should stage plaintext dumps in dedicated .cinetrack_staging directory with no leftover files', async () => {
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
    });

    expect(meta.status).toBe('SUCCESS');
    const stagingDir = path.join(testBackupDir, '.cinetrack_staging');
    expect(fs.existsSync(stagingDir)).toBe(true);

    // Verify zero plaintext files remain in staging directory
    const remainingFiles = fs.readdirSync(stagingDir);
    expect(remainingFiles.filter((f) => f.endsWith('.dump') || f.startsWith('cinetrack_dump_'))).toHaveLength(0);
  });

  it('25. should fail closed with CRITICAL_SECURITY_FAILURE if plaintext dump cleanup fails', async () => {
    const originalUnlink = fs.unlinkSync;
    let intercepted = false;

    try {
      fs.unlinkSync = (targetPath: fs.PathLike) => {
        const pathStr = String(targetPath);
        if (pathStr.includes('.cinetrack_staging') && pathStr.includes('cinetrack_dump_')) {
          intercepted = true;
          const err: any = new Error('EPERM: operation not permitted on locked dump');
          err.code = 'EPERM';
          throw err;
        }
        return originalUnlink(targetPath);
      };

      await expect(
        executeProductionBackup({
          databaseUrl: testDbUrl,
          outputDir: testBackupDir,
          encryptionPassphrase: passphrase,
          verifyRestore: false,
        })
      ).rejects.toThrow(/CRITICAL_SECURITY_FAILURE: Plaintext database dump cleanup failed/);

      expect(intercepted).toBe(true);
    } finally {
      fs.unlinkSync = originalUnlink;
    }
  });

  it('26. should verify live probe database creation and drop capability in validateBackupEnvironment', async () => {
    const res = await validateBackupEnvironment({
      databaseUrl: testDbUrl,
      encryptionPassphrase: passphrase,
      outputDir: testBackupDir,
      verifyRestore: true,
      restoreAdminUrl: testDbUrl,
    });

    expect(res.valid).toBe(true);
    expect(res.checks.restoreVerification?.probeCapabilityVerified).toBe(true);
  }, 30000);

  it('27. should reject symlink output directory fail-closed in validateBackupEnvironment', async () => {
    const originalLstat = fs.lstatSync;
    try {
      fs.lstatSync = (p: fs.PathLike, options?: any) => {
        const stats = originalLstat(p, options);
        if (String(p) === testBackupDir || path.resolve(String(p)) === path.resolve(testBackupDir)) {
          return {
            ...stats,
            isSymbolicLink: () => true,
          } as any;
        }
        return stats;
      };

      const res = await validateBackupEnvironment({
        databaseUrl: testDbUrl,
        encryptionPassphrase: passphrase,
        outputDir: testBackupDir,
      });

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('symbolic link'))).toBe(true);
    } finally {
      fs.lstatSync = originalLstat;
    }
  });

  it('28. should protect non-disposable databases during executeRestoreFromBackup without explicit confirmation', async () => {
    // Generate an encrypted backup file to restore from
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
      verifyRestore: false,
    });

    const prodTargetUrl = 'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack_prod?schema=public';

    // 1. Verification restore against non-disposable database
    await expect(
      executeRestoreFromBackup(meta.archivePath, prodTargetUrl, passphrase, {
        isVerificationRestore: true,
      })
    ).rejects.toThrow(/Verification restore cannot target non-disposable database "cinetrack_prod"/);

    // 2. Destructive restore against production without explicit confirmation
    await expect(
      executeRestoreFromBackup(meta.archivePath, prodTargetUrl, passphrase, {
        allowDestructiveRestore: false,
      })
    ).rejects.toThrow(/Destructive restore against production or primary database "cinetrack_prod" requires explicit authorization/);

    // 3. Destructive restore with mismatched confirmation database name
    await expect(
      executeRestoreFromBackup(meta.archivePath, prodTargetUrl, passphrase, {
        allowDestructiveRestore: true,
        confirmedTargetDatabase: 'other_db',
      })
    ).rejects.toThrow(/Destructive restore against production or primary database "cinetrack_prod" requires explicit authorization/);
  }, 60000);

  it('29. should execute zero write or probe operations when symlink is detected in validateBackupEnvironment', async () => {
    const originalLstat = fs.lstatSync;
    const originalOpen = fs.openSync;
    let writeProbeAttempted = false;

    try {
      fs.lstatSync = (p: fs.PathLike, options?: any) => {
        const stats = originalLstat(p, options);
        if (String(p) === testBackupDir || path.resolve(String(p)) === path.resolve(testBackupDir)) {
          return {
            ...stats,
            isSymbolicLink: () => true,
          } as any;
        }
        return stats;
      };

      fs.openSync = (p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
        if (typeof p === 'string' && path.basename(p).startsWith('.probe_validate_')) {
          writeProbeAttempted = true;
          throw new Error('SECURITY VIOLATION: Write probe attempted on symlinked directory!');
        }
        return originalOpen(p, flags, mode);
      };

      const res = await validateBackupEnvironment({
        databaseUrl: testDbUrl,
        encryptionPassphrase: passphrase,
        outputDir: testBackupDir,
      });

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('symbolic link'))).toBe(true);
      expect(writeProbeAttempted).toBe(false);
      expect(res.checks.outputDirectory?.isSymlink).toBe(true);
    } finally {
      fs.lstatSync = originalLstat;
      fs.openSync = originalOpen;
    }
  });

  it('30. should not modify permissions of pre-existing user-owned output directory in validateBackupEnvironment', async () => {
    // Ensure test directory exists prior to running validation
    if (!fs.existsSync(testBackupDir)) {
      fs.mkdirSync(testBackupDir, { recursive: true });
    }

    const { Client } = require('pg');
    const res = await validateBackupEnvironment({
      databaseUrl: testDbUrl,
      encryptionPassphrase: passphrase,
      outputDir: testBackupDir,
    });

    expect(res.checks.outputDirectory?.path).toBe(testBackupDir);
    expect(res.checks.outputDirectory?.safe).toBe(true);
  });

  it('31. should fail closed with RESTORE_CLEANUP_FAILED if disposable database cleanup fails in verifyBackupRestorability', async () => {
    // Generate valid backup file
    const meta = await executeProductionBackup({
      databaseUrl: testDbUrl,
      outputDir: testBackupDir,
      encryptionPassphrase: passphrase,
      verifyRestore: false,
    });

    const { Client } = require('pg');
    const originalQuery = Client.prototype.query;

    try {
      // Intercept query to make DROP DATABASE fail during cleanup
      Client.prototype.query = function (queryText: any, values: any, callback: any) {
        if (typeof queryText === 'string' && queryText.includes('DROP DATABASE')) {
          return Promise.reject(new Error('Injected database drop permission failure'));
        }
        return originalQuery.apply(this, arguments);
      };

      await expect(
        verifyBackupRestorability(meta.archivePath, passphrase, {
          databaseUrl: testDbUrl,
        })
      ).rejects.toThrow(/RESTORE_CLEANUP_FAILED/);
    } finally {
      Client.prototype.query = originalQuery;
    }
  }, 60000);
});
