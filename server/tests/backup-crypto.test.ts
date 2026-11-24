import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  encryptBackupFile,
  decryptBackupFile,
  inspectBackupHeader,
  atomicPublishNoClobber,
  secureWindowsAcl,
  verifyWindowsAcl,
  setRestrictiveFileMode,
  setRestrictiveDirMode,
  ensureSecureOutputDir,
  fsyncDirectorySafely,
  cleanupAbandonedStagingFiles,
  BACKUP_MAGIC_HEADER,
  HEADER_LENGTH,
} from '../src/utils/backup_crypto';

describe('Phase 4: Authenticated Backup Encryption (AES-256-GCM + PBKDF2)', () => {
  const testDir = path.resolve(__dirname, 'temp_crypto_test');
  const createdFiles: string[] = [];

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true, mode: 0o700 });
      setRestrictiveDirMode(testDir, 0o700);
    }
  });

  function getTempFile(name: string): string {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true, mode: 0o700 });
      setRestrictiveDirMode(testDir, 0o700);
    }
    const fullPath = path.join(testDir, `${Date.now()}_${name}`);
    createdFiles.push(fullPath);
    return fullPath;
  }

  afterEach(() => {
    while (createdFiles.length > 0) {
      const file = createdFiles.pop();
      if (file && fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
    }
    if (fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('1. should successfully encrypt and decrypt a file with identical SHA-256 digest round-trip', async () => {
    const rawData = 'CineTrack production database backup payload with relational data and schema.';
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('decrypted.dump');
    const passphrase = 'SuperSecureProductionPassphrase123!#';

    fs.writeFileSync(srcPath, rawData, 'utf-8');
    const srcSha = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex');

    const encRes = await encryptBackupFile(srcPath, encPath, passphrase);
    expect(encRes.bytesWritten).toBeGreaterThan(HEADER_LENGTH);
    expect(fs.existsSync(encPath)).toBe(true);

    // Verify ciphertext is not equal to raw text
    const cipherBytes = fs.readFileSync(encPath);
    expect(cipherBytes.includes(Buffer.from(rawData))).toBe(false);

    const decRes = await decryptBackupFile(encPath, decPath, passphrase);
    expect(decRes.bytesWritten).toBe(Buffer.byteLength(rawData, 'utf-8'));
    expect(fs.existsSync(decPath)).toBe(true);

    const decSha = crypto.createHash('sha256').update(fs.readFileSync(decPath)).digest('hex');
    expect(decSha).toBe(srcSha);
    expect(fs.readFileSync(decPath, 'utf-8')).toBe(rawData);
  });

  it('2. should handle large multi-megabyte binary dumps correctly without memory exhaustion', async () => {
    const srcPath = getTempFile('large_source.bin');
    const encPath = getTempFile('large_encrypted.enc');
    const decPath = getTempFile('large_decrypted.bin');
    const passphrase = 'LargeDumpPassphrase$2026';

    // 2MB random binary dump data
    const largeBuffer = crypto.randomBytes(2 * 1024 * 1024);
    fs.writeFileSync(srcPath, largeBuffer);
    const srcSha = crypto.createHash('sha256').update(largeBuffer).digest('hex');

    await encryptBackupFile(srcPath, encPath, passphrase);
    await decryptBackupFile(encPath, decPath, passphrase);

    const decSha = crypto.createHash('sha256').update(fs.readFileSync(decPath)).digest('hex');
    expect(decSha).toBe(srcSha);
  });

  it('3. should reject decryption with an incorrect passphrase and clean up output', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('decrypted_wrong_pass.dump');
    const correctPassphrase = 'CorrectPassphrase999!';
    const wrongPassphrase = 'WrongPassphrase888!';

    fs.writeFileSync(srcPath, 'Confidential movie watchlist data');
    await encryptBackupFile(srcPath, encPath, correctPassphrase);

    await expect(decryptBackupFile(encPath, decPath, wrongPassphrase)).rejects.toThrow(
      /authentication tag verification failed/i
    );

    // Verify partially decrypted file is cleaned up
    expect(fs.existsSync(decPath)).toBe(false);
  });

  it('4. should reject decryption when ciphertext bytes are corrupted (bit-flip detection)', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('decrypted_tampered.dump');
    const passphrase = 'BitFlipTestPassphrase!';

    fs.writeFileSync(srcPath, 'Original uncorrupted CineTrack backup data');
    await encryptBackupFile(srcPath, encPath, passphrase);

    // Tamper single byte in the ciphertext portion (past header length)
    const fileBytes = fs.readFileSync(encPath);
    fileBytes[HEADER_LENGTH + 2] ^= 0x01; // flip 1 bit
    fs.writeFileSync(encPath, fileBytes);

    await expect(decryptBackupFile(encPath, decPath, passphrase)).rejects.toThrow(
      /authentication tag verification failed/i
    );
    expect(fs.existsSync(decPath)).toBe(false);
  });

  it('5. should reject decryption when authentication tag is tampered', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('decrypted_tag_tamper.dump');
    const passphrase = 'TagTamperPassphrase!';

    fs.writeFileSync(srcPath, 'Authenticity check data');
    await encryptBackupFile(srcPath, encPath, passphrase);

    // Tamper 1 byte of the authentication tag (at offset 34)
    const fileBytes = fs.readFileSync(encPath);
    fileBytes[35] ^= 0xff;
    fs.writeFileSync(encPath, fileBytes);

    await expect(decryptBackupFile(encPath, decPath, passphrase)).rejects.toThrow(
      /authentication tag verification failed/i
    );
    expect(fs.existsSync(decPath)).toBe(false);
  });

  it('6. should reject decryption when IV is tampered', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('decrypted_iv_tamper.dump');
    const passphrase = 'IVTamperPassphrase!';

    fs.writeFileSync(srcPath, 'IV test data');
    await encryptBackupFile(srcPath, encPath, passphrase);

    // Tamper 1 byte of IV (at offset 22)
    const fileBytes = fs.readFileSync(encPath);
    fileBytes[24] ^= 0xaa;
    fs.writeFileSync(encPath, fileBytes);

    await expect(decryptBackupFile(encPath, decPath, passphrase)).rejects.toThrow(
      /authentication tag verification failed/i
    );
    expect(fs.existsSync(decPath)).toBe(false);
  });

  it('7. should reject decryption when Salt is tampered', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('decrypted_salt_tamper.dump');
    const passphrase = 'SaltTamperPassphrase!';

    fs.writeFileSync(srcPath, 'Salt test data');
    await encryptBackupFile(srcPath, encPath, passphrase);

    // Tamper 1 byte of salt (at offset 6)
    const fileBytes = fs.readFileSync(encPath);
    fileBytes[10] ^= 0x55;
    fs.writeFileSync(encPath, fileBytes);

    await expect(decryptBackupFile(encPath, decPath, passphrase)).rejects.toThrow(
      /authentication tag verification failed/i
    );
    expect(fs.existsSync(decPath)).toBe(false);
  });

  it('8. should reject files with invalid or corrupted magic header', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('decrypted_bad_magic.dump');
    const passphrase = 'MagicTestPassphrase!';

    fs.writeFileSync(srcPath, 'Valid source data');
    await encryptBackupFile(srcPath, encPath, passphrase);

    // Overwrite magic header
    const fileBytes = fs.readFileSync(encPath);
    fileBytes.write('BADMGC', 0);
    fs.writeFileSync(encPath, fileBytes);

    await expect(decryptBackupFile(encPath, decPath, passphrase)).rejects.toThrow(
      /unrecognized magic header/i
    );
  });

  it('9. should reject truncated files shorter than header length', async () => {
    const encPath = getTempFile('truncated.enc');
    const decPath = getTempFile('decrypted.dump');
    const passphrase = 'TruncatedPassphrase!';

    fs.writeFileSync(encPath, Buffer.from('SHORT')); // only 5 bytes, requires 50

    await expect(decryptBackupFile(encPath, decPath, passphrase)).rejects.toThrow(
      /Encrypted backup file is truncated/i
    );
  });

  it('10. should reject empty or missing passphrase on encryption and decryption', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('decrypted.dump');
    fs.writeFileSync(srcPath, 'Data for empty pass test');

    await expect(encryptBackupFile(srcPath, encPath, '')).rejects.toThrow(
      /passphrase is required/i
    );
    await expect(encryptBackupFile(srcPath, encPath, '   ')).rejects.toThrow(
      /passphrase is required/i
    );

    // Now valid encrypt
    await encryptBackupFile(srcPath, encPath, 'validpass123');

    await expect(decryptBackupFile(encPath, decPath, '')).rejects.toThrow(
      /passphrase is required/i
    );
    await expect(decryptBackupFile(encPath, decPath, '   ')).rejects.toThrow(
      /passphrase is required/i
    );
  });

  it('11. should reject non-existent input files', async () => {
    const nonExistent = path.resolve(__dirname, 'does_not_exist_xyz.bin');
    const outPath = getTempFile('out.bin');

    await expect(encryptBackupFile(nonExistent, outPath, 'somepass')).rejects.toThrow(
      /does not exist/i
    );
    await expect(decryptBackupFile(nonExistent, outPath, 'somepass')).rejects.toThrow(
      /does not exist/i
    );
  });

  it('12. should inspect backup headers accurately', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const passphrase = 'InspectHeaderPassphrase!';

    fs.writeFileSync(srcPath, 'Inspect header test payload');
    await encryptBackupFile(srcPath, encPath, passphrase);

    const info = inspectBackupHeader(encPath);
    expect(info.validHeader).toBe(true);
    expect(info.magic).toBe(BACKUP_MAGIC_HEADER.toString('ascii'));
    expect(info.saltHex).toHaveLength(32); // 16 bytes hex
    expect(info.ivHex).toHaveLength(24); // 12 bytes hex
    expect(info.tagHex).toHaveLength(32); // 16 bytes hex
    expect(info.fileSizeBytes).toBeGreaterThan(HEADER_LENGTH);
  });

  it('13. should reject when source and destination paths resolve to the exact same file', async () => {
    const filePath = getTempFile('same_file.dump');
    fs.writeFileSync(filePath, 'Data for same file path check');
    const pass = 'Passphrase123!';

    await expect(encryptBackupFile(filePath, filePath, pass)).rejects.toThrow(
      /cannot resolve to the same file/i
    );
    await expect(decryptBackupFile(filePath, filePath, pass)).rejects.toThrow(
      /cannot resolve to the same file/i
    );
  });

  it('14. should protect pre-existing destination file from overwrite during encryption and decryption', async () => {
    const srcPath = getTempFile('source.dump');
    const existingDest = getTempFile('existing_dest.bin');
    const originalContent = 'IMPORTANT_EXISTING_USER_DATA_DO_NOT_DESTROY';
    fs.writeFileSync(srcPath, 'New encrypted data');
    fs.writeFileSync(existingDest, originalContent);
    const pass = 'Passphrase123!';

    // Encrypt must reject without altering existingDest
    await expect(encryptBackupFile(srcPath, existingDest, pass)).rejects.toThrow(
      /Destination file already exists/i
    );
    expect(fs.readFileSync(existingDest, 'utf-8')).toBe(originalContent);

    // Prepare encrypted file
    const validEnc = getTempFile('valid.enc');
    await encryptBackupFile(srcPath, validEnc, pass);

    // Decrypt must reject without altering existingDest
    await expect(decryptBackupFile(validEnc, existingDest, pass)).rejects.toThrow(
      /Destination file already exists/i
    );
    expect(fs.readFileSync(existingDest, 'utf-8')).toBe(originalContent);
  });

  it('15. should strictly reject overwriting pre-existing destination and preserve original contents', async () => {
    const srcPath = getTempFile('source.dump');
    const existingDest = getTempFile('existing_dest_strict.bin');
    const initialContent = 'Strictly protected content';
    fs.writeFileSync(srcPath, 'New content to write');
    fs.writeFileSync(existingDest, initialContent);
    const pass = 'Passphrase123!';

    await expect(encryptBackupFile(srcPath, existingDest, pass)).rejects.toThrow(
      /Overwriting backup files is strictly disallowed/i
    );
    expect(fs.readFileSync(existingDest, 'utf-8')).toBe(initialContent);

    const validEnc = getTempFile('valid_strict.enc');
    await encryptBackupFile(srcPath, validEnc, pass);

    const decryptedDest = getTempFile('dec_dest_strict.bin');
    fs.writeFileSync(decryptedDest, initialContent);
    await expect(decryptBackupFile(validEnc, decryptedDest, pass)).rejects.toThrow(
      /Overwriting backup files is strictly disallowed/i
    );
    expect(fs.readFileSync(decryptedDest, 'utf-8')).toBe(initialContent);
  });

  it('16. should preserve existing destination file and never write partial files when decryption fails', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const nonExistentTarget = getTempFile('nonexistent_target.dump');
    const existingDest = getTempFile('preexisting_target.dump');
    const initialContent = 'Valuable initial plaintext that must never be destroyed';
    fs.writeFileSync(srcPath, 'Secret backup data');
    fs.writeFileSync(existingDest, initialContent);
    const pass = 'CorrectPass123!';

    await encryptBackupFile(srcPath, encPath, pass);

    // 1. Existing destination is strictly rejected and untouched
    await expect(
      decryptBackupFile(encPath, existingDest, pass)
    ).rejects.toThrow(/Destination file already exists/i);
    expect(fs.readFileSync(existingDest, 'utf-8')).toBe(initialContent);

    // 2. Attempt decryption to nonExistentTarget with wrong password
    await expect(
      decryptBackupFile(encPath, nonExistentTarget, 'WrongPassword999!')
    ).rejects.toThrow(/authentication tag verification failed/i);
    expect(fs.existsSync(nonExistentTarget)).toBe(false);

    // 3. Corrupt ciphertext and attempt decryption
    const encBytes = fs.readFileSync(encPath);
    encBytes[HEADER_LENGTH + 5] ^= 0x01;
    fs.writeFileSync(encPath, encBytes);

    await expect(
      decryptBackupFile(encPath, nonExistentTarget, pass)
    ).rejects.toThrow(/authentication tag verification failed/i);
    expect(fs.existsSync(nonExistentTarget)).toBe(false);
  });

  it('17. should guarantee unauthenticated plaintext is never exposed at destination path', async () => {
    const srcPath = getTempFile('source.dump');
    const encPath = getTempFile('encrypted.enc');
    const decPath = getTempFile('new_target.dump');
    fs.writeFileSync(srcPath, 'Plaintext payload that should never leak if unauthenticated');
    const pass = 'AuthGuardPass!';

    await encryptBackupFile(srcPath, encPath, pass);

    // Tamper auth tag
    const encBytes = fs.readFileSync(encPath);
    encBytes[36] ^= 0xff;
    fs.writeFileSync(encPath, encBytes);

    await expect(decryptBackupFile(encPath, decPath, pass)).rejects.toThrow(
      /authentication tag verification failed/i
    );

    // Destination file must NEVER have been published!
    expect(fs.existsSync(decPath)).toBe(false);

    // Temporary files in testDir matching .tmp. should also be cleaned up
    const remainingTempFiles = fs.readdirSync(testDir).filter((f) => f.includes('.tmp.'));
    expect(remainingTempFiles).toHaveLength(0);
  });

  it('18. should support concurrent encryption and decryption operations with separate output files without interference', async () => {
    const pass = 'ConcurrentCryptoPass!';
    const count = 5;
    const inputs: string[] = [];
    const encs: string[] = [];
    const decs: string[] = [];

    for (let i = 0; i < count; i++) {
      const src = getTempFile(`concurrent_${i}.dump`);
      const enc = getTempFile(`concurrent_${i}.enc`);
      const dec = getTempFile(`concurrent_${i}_dec.dump`);
      fs.writeFileSync(src, `Concurrent payload ${i} - ${crypto.randomBytes(64).toString('hex')}`);
      inputs.push(src);
      encs.push(enc);
      decs.push(dec);
    }

    // Encrypt all concurrently
    await Promise.all(
      inputs.map((src, idx) => encryptBackupFile(src, encs[idx], pass))
    );

    // Decrypt all concurrently
    await Promise.all(
      encs.map((enc, idx) => decryptBackupFile(enc, decs[idx], pass))
    );

    for (let i = 0; i < count; i++) {
      const orig = fs.readFileSync(inputs[i], 'utf-8');
      const restored = fs.readFileSync(decs[i], 'utf-8');
      expect(restored).toBe(orig);
    }
  }, 45000);

  it('19. should atomically reject publishing to an existing destination without clobbering', () => {
    const staging = getTempFile('staged.tmp');
    const finalFile = getTempFile('existing_dest.bin');
    fs.writeFileSync(finalFile, 'ORIGINAL_UNTOUCHED_CONTENT');
    fs.writeFileSync(staging, 'NEW_STAGED_CONTENT');

    expect(() => {
      atomicPublishNoClobber(staging, finalFile);
    }).toThrow(/EEXIST.*Destination file already exists/i);

    // Final file must be untouched
    expect(fs.readFileSync(finalFile, 'utf-8')).toBe('ORIGINAL_UNTOUCHED_CONTENT');
    // Staging file remains available for investigation or retry
    expect(fs.existsSync(staging)).toBe(true);
  });

  it('20. should safely handle concurrent publications to the same destination: exactly one succeeds and others fail closed', async () => {
    const finalDest = getTempFile('race_target.bin');
    const stagings: string[] = [];
    for (let i = 0; i < 4; i++) {
      const s = getTempFile(`race_stg_${i}.tmp`);
      fs.writeFileSync(s, `CONTENT_FROM_WORKER_${i}`);
      stagings.push(s);
    }

    const results = await Promise.allSettled(
      stagings.map((stg) => Promise.resolve().then(() => atomicPublishNoClobber(stg, finalDest)))
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one worker must succeed in publishing to the target
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);

    for (const rej of rejected) {
      if (rej.status === 'rejected') {
        expect(rej.reason.message).toMatch(/EEXIST.*Destination file already exists/i);
      }
    }

    // Destination must exist and contain one worker's content
    expect(fs.existsSync(finalDest)).toBe(true);
    const content = fs.readFileSync(finalDest, 'utf-8');
    expect(content).toMatch(/^CONTENT_FROM_WORKER_\d$/);
  });

  it('21. should enforce restrictive file permissions (0600) and directory permissions (0700) where supported', async () => {
    const srcPath = getTempFile('perm_source.dump');
    const encPath = getTempFile('perm_encrypted.enc');
    const decPath = getTempFile('perm_decrypted.dump');
    const pass = 'PermissionsSecurePass123!';
    fs.writeFileSync(srcPath, 'Confidential data for permissions check');

    await encryptBackupFile(srcPath, encPath, pass);
    await decryptBackupFile(encPath, decPath, pass);

    // On POSIX systems, inspect file mode
    if (process.platform !== 'win32') {
      const encStat = fs.statSync(encPath);
      const decStat = fs.statSync(decPath);
      // 0o600: read/write owner only (0o777 mask: 0o600)
      expect(encStat.mode & 0o777).toBe(0o600);
      expect(decStat.mode & 0o777).toBe(0o600);
    } else {
      // On Windows, verify files were created and readable/writable
      expect(fs.existsSync(encPath)).toBe(true);
      expect(fs.existsSync(decPath)).toBe(true);
    }
  });

  it('22. should clean up temporary staging files on decryption authentication failure without leaving leaks', async () => {
    const srcPath = getTempFile('leak_source.dump');
    const encPath = getTempFile('leak_enc.enc');
    const decPath = getTempFile('leak_dec.dump');
    fs.writeFileSync(srcPath, 'Super sensitive data that must not leak');
    const pass = 'LeakGuardPass99!';

    await encryptBackupFile(srcPath, encPath, pass);

    // Corrupt the ciphertext
    const encBytes = fs.readFileSync(encPath);
    encBytes[HEADER_LENGTH + 10] ^= 0x55;
    fs.writeFileSync(encPath, encBytes);

    await expect(decryptBackupFile(encPath, decPath, pass)).rejects.toThrow(/authentication tag verification failed/i);

    // Verify no temporary files remain in testDir
    const tempFiles = fs.readdirSync(testDir).filter((f) => f.includes('.tmp.'));
    expect(tempFiles).toHaveLength(0);
    expect(fs.existsSync(decPath)).toBe(false);
  });

  it('23. should never expose partially written or corrupt files at finalPath in atomicPublishNoClobber', () => {
    const staging = getTempFile('atomic_staging.dump');
    const finalDest = getTempFile('atomic_final.dump');
    const existingContent = 'CANNOT_BE_OVERWRITTEN_BY_ANY_FAILING_OR_PARTIAL_PUBLICATION';
    fs.writeFileSync(finalDest, existingContent);
    fs.writeFileSync(staging, 'New completed staging content');

    // Attempt publication to existing destination -> must throw EEXIST
    expect(() => atomicPublishNoClobber(staging, finalDest)).toThrow(/EEXIST: Destination file already exists/);
    expect(fs.readFileSync(finalDest, 'utf-8')).toBe(existingContent);
    // Staging file should still exist since publication was rejected
    expect(fs.existsSync(staging)).toBe(true);

    // Now test publication to fresh target
    const freshTarget = getTempFile('fresh_atomic_final.dump');
    atomicPublishNoClobber(staging, freshTarget);
    expect(fs.existsSync(freshTarget)).toBe(true);
    expect(fs.readFileSync(freshTarget, 'utf-8')).toBe('New completed staging content');
    // Staging must be unlinked after successful publication
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('24. should fail closed when filesystem does not support atomic hardlink publication without downgrading to unsafe overwrite', () => {
    const staging = getTempFile('link_unsupported_stg.dump');
    const finalDest = getTempFile('link_unsupported_final.dump');
    fs.writeFileSync(staging, 'Staging content to test unsupported hardlink failure');

    const originalLinkSync = fs.linkSync;
    try {
      // Simulate a filesystem that does not support hardlinks (e.g. EXDEV followed by ENOSYS or ENOTSUP)
      fs.linkSync = () => {
        const err: any = new Error('Function not implemented');
        err.code = 'ENOSYS';
        throw err;
      };

      expect(() => atomicPublishNoClobber(staging, finalDest)).toThrow(
        /ATOMIC_PUBLICATION_UNSUPPORTED/
      );
      // Destination must not exist
      expect(fs.existsSync(finalDest)).toBe(false);
    } finally {
      fs.linkSync = originalLinkSync;
    }
  });

  it('25. should treat required fsync failure as hard failure and never swallow synchronization errors', () => {
    const staging = getTempFile('fsync_fail_stg.dump');
    const finalDest = getTempFile('fsync_fail_final.dump');
    fs.writeFileSync(staging, 'Payload that fails fsync');

    const originalFsync = fs.fsyncSync;
    try {
      fs.fsyncSync = () => {
        const err: any = new Error('Disk flush I/O failure (EIO)');
        err.code = 'EIO';
        throw err;
      };

      expect(() => atomicPublishNoClobber(staging, finalDest)).toThrow(/Disk flush I\/O failure/);
      expect(fs.existsSync(finalDest)).toBe(false);
    } finally {
      fs.fsyncSync = originalFsync;
    }
  });

  it('26. should roll back published file if post-publication permission or directory sync fails', () => {
    const staging = getTempFile('post_pub_fail_stg.dump');
    const finalDest = getTempFile('post_pub_fail_final.dump');
    fs.writeFileSync(staging, 'Payload to test post-publication rollback');

    const originalChmod = fs.chmodSync;
    try {
      if (process.platform !== 'win32') {
        fs.chmodSync = (targetPath: any) => {
          if (String(targetPath) === finalDest) {
            throw new Error('Chmod permission denied on target');
          }
          originalChmod(targetPath, 0o600);
        };

        expect(() => atomicPublishNoClobber(staging, finalDest)).toThrow(/Post-publication durability/);
        // Destination must be unlinked/rolled back so improperly permissioned file is not left behind
        expect(fs.existsSync(finalDest)).toBe(false);
      }
    } finally {
      fs.chmodSync = originalChmod;
    }
  });

  it('27. should preserve safe behavior under concurrent attempts to publish to the same destination', async () => {
    const finalDest = getTempFile('concurrent_final.dump');
    const staging1 = getTempFile('concurrent_stg1.dump');
    const staging2 = getTempFile('concurrent_stg2.dump');

    fs.writeFileSync(staging1, 'Worker 1 Content');
    fs.writeFileSync(staging2, 'Worker 2 Content');

    // Attempt publication
    let successes = 0;
    let collisions = 0;

    const pub1 = () => {
      try {
        atomicPublishNoClobber(staging1, finalDest);
        successes++;
      } catch (err: any) {
        if (err.message.includes('EEXIST')) collisions++;
      }
    };

    const pub2 = () => {
      try {
        atomicPublishNoClobber(staging2, finalDest);
        successes++;
      } catch (err: any) {
        if (err.message.includes('EEXIST')) collisions++;
      }
    };

    pub1();
    pub2();

    expect(successes).toBe(1);
    expect(collisions).toBe(1);
    expect(fs.existsSync(finalDest)).toBe(true);
    expect(fs.readFileSync(finalDest, 'utf-8')).toBe('Worker 1 Content');
  });

  it('28. should encrypt using CTBK02 format with 600,000 PBKDF2 iterations', async () => {
    const srcPath = getTempFile('v2_src.dump');
    const encPath = getTempFile('v2_enc.dump.enc');
    const passphrase = 'V2FormatPassphrase2026!#';

    fs.writeFileSync(srcPath, 'CTBK02 600,000 iterations test data');
    const res = await encryptBackupFile(srcPath, encPath, passphrase);

    expect(res.version).toBe(2);
    expect(res.iterations).toBe(600000);

    const header = inspectBackupHeader(encPath);
    expect(header.magic).toBe('CTBK02');
    expect(header.version).toBe(2);
    expect(header.iterations).toBe(600000);
    expect(header.validHeader).toBe(true);
  });

  it('29. should preserve backward compatibility by successfully decrypting legacy CTBK01 (100k iterations) backups', async () => {
    const legacyPlaintext = 'Legacy CineTrack backup created with format v1 (100,000 PBKDF2 iterations)';
    const legacyFile = getTempFile('legacy_v1.dump.enc');
    const decFile = getTempFile('legacy_v1_decrypted.dump');
    const passphrase = 'LegacyKey100k!';

    // Manually construct a valid CTBK01 (v1) backup file using 100,000 iterations
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(legacyPlaintext, 'utf-8')), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header = Buffer.concat([
      Buffer.from('CTBK01', 'ascii'),
      salt,
      iv,
      tag,
    ]);

    fs.writeFileSync(legacyFile, Buffer.concat([header, ciphertext]));

    // Inspect header
    const inspected = inspectBackupHeader(legacyFile);
    expect(inspected.magic).toBe('CTBK01');
    expect(inspected.version).toBe(1);
    expect(inspected.iterations).toBe(100000);
    expect(inspected.validHeader).toBe(true);

    // Decrypt with decryptBackupFile
    const decRes = await decryptBackupFile(legacyFile, decFile, passphrase);
    expect(decRes.version).toBe(1);
    expect(decRes.iterations).toBe(100000);
    expect(fs.readFileSync(decFile, 'utf-8')).toBe(legacyPlaintext);
  });

  it('30. should reject backup files with unrecognized magic headers fail-closed', async () => {
    const invalidFile = getTempFile('invalid_magic.dump.enc');
    const bogusHeader = Buffer.concat([
      Buffer.from('BOGUS!', 'ascii'),
      crypto.randomBytes(44),
      Buffer.from('encrypted data'),
    ]);
    fs.writeFileSync(invalidFile, bogusHeader);

    const header = inspectBackupHeader(invalidFile);
    expect(header.validHeader).toBe(false);
    expect(header.version).toBe(0);

    const decTarget = getTempFile('bogus_dec.dump');
    await expect(decryptBackupFile(invalidFile, decTarget, 'SomePassphrase123!')).rejects.toThrow(
      /unrecognized magic header "BOGUS!"/
    );
  });

  it('31. should enforce restrictive file permissions and verify Windows ACL inheritance removal', () => {
    const testFile = getTempFile('acl_test.txt');
    fs.writeFileSync(testFile, 'Sensitive Data');
    setRestrictiveFileMode(testFile);

    if (process.platform === 'win32') {
      const aclRes = verifyWindowsAcl(testFile);
      expect(aclRes.protected).toBe(true);
      expect(aclRes.inherited).toBe(false);
    } else {
      const stat = fs.statSync(testFile);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('32. should handle directory fsync correctly across platforms', () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    // Calling fsyncDirectorySafely on existing directory should not throw
    expect(() => fsyncDirectorySafely(testDir)).not.toThrow();

    // Calling fsyncDirectorySafely on non-existent directory should throw ENOENT
    const nonExistentDir = path.join(testDir, 'does_not_exist_dir');
    expect(() => fsyncDirectorySafely(nonExistentDir)).toThrow();
  });

  it('33. should fail-closed with STAGING_CLEANUP_FAILED if atomicPublishNoClobber cannot delete staging file', () => {
    const staging = getTempFile('stg_fail_cleanup.tmp');
    const finalDest = getTempFile('dest_fail_cleanup.tmp');
    fs.writeFileSync(staging, 'Payload');

    const originalUnlink = fs.unlinkSync;
    try {
      // Mock unlinkSync to fail when unlinking staging file
      fs.unlinkSync = (filePath: fs.PathLike) => {
        if (filePath === staging) {
          const err: any = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return originalUnlink(filePath);
      };

      expect(() => atomicPublishNoClobber(staging, finalDest)).toThrow(/STAGING_CLEANUP_FAILED/);
    } finally {
      fs.unlinkSync = originalUnlink;
    }
  });

  it('34. should clean up abandoned staging files older than maxAgeMs', () => {
    const stagingDir = path.join(testDir, '.staging_abandoned_test');
    if (!fs.existsSync(stagingDir)) {
      fs.mkdirSync(stagingDir, { recursive: true });
    }

    const oldStagingFile = path.join(stagingDir, 'abandoned_old.tmp');
    const newStagingFile = path.join(stagingDir, 'active_new.tmp');
    const regularFile = path.join(stagingDir, 'regular_file.txt');

    fs.writeFileSync(oldStagingFile, 'abandoned');
    fs.writeFileSync(newStagingFile, 'new');
    fs.writeFileSync(regularFile, 'regular');

    // Set mtime of oldStagingFile to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldStagingFile, twoHoursAgo, twoHoursAgo);

    const result = cleanupAbandonedStagingFiles(stagingDir, 60 * 60 * 1000); // 1 hour max age
    expect(result.cleaned).toContain(oldStagingFile);
    expect(fs.existsSync(oldStagingFile)).toBe(false);
    expect(fs.existsSync(newStagingFile)).toBe(true);
    expect(fs.existsSync(regularFile)).toBe(true);

    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
  });

  it('35. should reject files or directories with explicit unauthorized allow ACEs (Everyone) in verifyWindowsAcl', () => {
    if (process.platform !== 'win32') return;

    const testFile = getTempFile('acl_unauth_everyone.tmp');
    fs.writeFileSync(testFile, 'Test payload for ACL verification');

    // Secure the file first to ensure clean baseline
    secureWindowsAcl(testFile, false);
    const cleanVerif = verifyWindowsAcl(testFile);
    expect(cleanVerif.protected).toBe(true);
    expect(cleanVerif.unauthorizedSids).toHaveLength(0);

    // Explicitly grant Everyone read access via icacls
    const { execFileSync } = require('child_process');
    execFileSync('icacls.exe', [testFile, '/grant', 'Everyone:(R)'], { stdio: 'ignore' });

    // verifyWindowsAcl must detect unauthorized S-1-1-0 or Everyone
    const taintedVerif = verifyWindowsAcl(testFile);
    expect(taintedVerif.protected).toBe(false);
    expect(
      taintedVerif.unauthorizedSids.some((u) => u.toLowerCase().includes('everyone') || u.includes('S-1-1-0'))
    ).toBe(true);
  });

  it('36. should purge existing unauthorized explicit ACEs when secureWindowsAcl is called on a pre-existing file or directory', () => {
    if (process.platform !== 'win32') return;

    const testFile = getTempFile('acl_purge_existing.tmp');
    fs.writeFileSync(testFile, 'Pre-existing file with unauthorized ACE');

    // Explicitly add unauthorized ACE
    const { execFileSync } = require('child_process');
    execFileSync('icacls.exe', [testFile, '/grant', 'Everyone:(R)'], { stdio: 'ignore' });

    // Verify it is currently unauthorized
    const beforeVerif = verifyWindowsAcl(testFile);
    expect(beforeVerif.protected).toBe(false);

    // Call secureWindowsAcl to purge unauthorized entries and apply clean allowlist
    secureWindowsAcl(testFile, false);

    const afterVerif = verifyWindowsAcl(testFile);
    expect(afterVerif.protected).toBe(true);
    expect(afterVerif.inherited).toBe(false);
    expect(afterVerif.unauthorizedSids).toHaveLength(0);
  });

  it('37. should fail closed with POST_PUBLICATION_ROLLBACK_FAILED when post-publication fails and rollback unlink fails', () => {
    const staging = getTempFile('stg_rollback_fail.tmp');
    const finalDest = getTempFile('dest_rollback_fail.tmp');
    fs.writeFileSync(staging, 'Payload');

    const originalUnlink = fs.unlinkSync;
    const originalChmod = fs.chmodSync;

    try {
      // Force setRestrictiveFileMode to fail on finalDest by throwing in chmodSync
      fs.chmodSync = (targetPath: fs.PathLike, mode: fs.Mode) => {
        if (typeof targetPath === 'string' && path.resolve(targetPath) === path.resolve(finalDest)) {
          throw new Error('Injected chmod permission failure');
        }
        return originalChmod(targetPath, mode);
      };

      // Force rollback unlink to also fail
      fs.unlinkSync = (targetPath: fs.PathLike) => {
        if (typeof targetPath === 'string' && path.resolve(targetPath) === path.resolve(finalDest)) {
          throw new Error('EPERM: operation not permitted on rollback unlink');
        }
        return originalUnlink(targetPath);
      };

      expect(() => atomicPublishNoClobber(staging, finalDest)).toThrow(/POST_PUBLICATION_ROLLBACK_FAILED/);
    } finally {
      fs.unlinkSync = originalUnlink;
      fs.chmodSync = originalChmod;
    }
  });

  it('38. should never unlink destination file if destination already exists (strict no-overwrite guarantee on EEXIST)', () => {
    const staging = getTempFile('stg_no_clobber.tmp');
    const finalDest = getTempFile('dest_pre_existing.tmp');
    const sacredContent = 'DO_NOT_OVERWRITE_OR_DELETE_ME_12345';

    fs.writeFileSync(staging, 'New staging content');
    fs.writeFileSync(finalDest, sacredContent);

    expect(() => atomicPublishNoClobber(staging, finalDest)).toThrow(/EEXIST/);

    // Verify final destination was NEVER touched or deleted
    expect(fs.existsSync(finalDest)).toBe(true);
    expect(fs.readFileSync(finalDest, 'utf-8')).toBe(sacredContent);
  });

  it('39. should fail closed with PLAINTEXT_STAGING_CLEANUP_FAILED if plaintext staging unlinking fails during decryption error', async () => {
    const srcPath = getTempFile('source_cleanup_fail.dump');
    const encPath = getTempFile('encrypted_cleanup_fail.enc');
    const decPath = getTempFile('decrypted_cleanup_fail.dump');
    const passphrase = 'ValidPassphrase123!@#';

    fs.writeFileSync(srcPath, 'Some sensitive database plaintext');
    await encryptBackupFile(srcPath, encPath, passphrase);

    const originalUnlink = fs.unlinkSync;
    try {
      // Simulate unlinking failure on temporary plaintext staging file (.dec_staging)
      fs.unlinkSync = (targetPath: fs.PathLike) => {
        if (typeof targetPath === 'string' && path.basename(targetPath).startsWith('.dec_staging')) {
          throw new Error('EBUSY: plaintext staging file locked by antivirus');
        }
        return originalUnlink(targetPath);
      };

      // Decrypt with WRONG passphrase so decryption fails, triggering staging cleanup
      await expect(decryptBackupFile(encPath, decPath, 'WrongPassphrase!')).rejects.toThrow(
        /PLAINTEXT_STAGING_CLEANUP_FAILED/
      );
    } finally {
      fs.unlinkSync = originalUnlink;
    }
  });

  it('40. should create newly created output directory with restrictive permissions during decryptBackupFile', async () => {
    const srcPath = getTempFile('new_dir_source.dump');
    const encPath = getTempFile('new_dir_encrypted.enc');
    const newDir = path.join(testDir, `brand_new_out_dir_${Date.now()}`);
    const decPath = path.join(newDir, 'decrypted.dump');
    const passphrase = 'ValidPassphrase123!@#';

    expect(fs.existsSync(newDir)).toBe(false);

    fs.writeFileSync(srcPath, 'Plaintext payload to test new directory permissions');
    await encryptBackupFile(srcPath, encPath, passphrase);

    const res = await decryptBackupFile(encPath, decPath, passphrase);
    expect(res.outputPath).toBe(decPath);
    expect(fs.existsSync(decPath)).toBe(true);
    expect(fs.existsSync(newDir)).toBe(true);

    if (process.platform === 'win32') {
      const acl = verifyWindowsAcl(newDir);
      expect(acl.protected).toBe(true);
      expect(acl.inherited).toBe(false);
      expect(acl.unauthorizedSids).toHaveLength(0);
    } else {
      const mode = fs.statSync(newDir).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  it('41. should preserve safe permissions on pre-existing output directory without modifying them during decryptBackupFile', async () => {
    const srcPath = getTempFile('safe_exist_src.dump');
    const encPath = getTempFile('safe_exist_enc.enc');
    const safeDir = path.join(testDir, `safe_existing_dir_${Date.now()}`);
    const decPath = path.join(safeDir, 'decrypted.dump');
    const passphrase = 'ValidPassphrase123!@#';

    fs.mkdirSync(safeDir, { recursive: true, mode: 0o700 });
    setRestrictiveDirMode(safeDir, 0o700);

    // Capture baseline permissions before decryption
    let baselineAcl: string | null = null;
    let baselineMode: number | null = null;
    if (process.platform === 'win32') {
      baselineAcl = verifyWindowsAcl(safeDir).aclOutput;
    } else {
      baselineMode = fs.statSync(safeDir).mode & 0o777;
    }

    fs.writeFileSync(srcPath, 'Plaintext payload to test preserving existing safe dir');
    await encryptBackupFile(srcPath, encPath, passphrase);

    // Decrypt into the pre-existing safe directory
    const res = await decryptBackupFile(encPath, decPath, passphrase);
    expect(res.outputPath).toBe(decPath);
    expect(fs.existsSync(decPath)).toBe(true);

    // Verify permissions were NOT altered
    if (process.platform === 'win32') {
      const afterAcl = verifyWindowsAcl(safeDir).aclOutput;
      expect(afterAcl).toBe(baselineAcl);
    } else {
      const afterMode = fs.statSync(safeDir).mode & 0o777;
      expect(afterMode).toBe(baselineMode);
    }
  });

  it('42. should reject decryptBackupFile when output directory has insecure permissions and not silently modify it', async () => {
    const srcPath = getTempFile('unsafe_exist_src.dump');
    const encPath = getTempFile('unsafe_exist_enc.enc');
    const unsafeDir = path.join(testDir, `unsafe_existing_dir_${Date.now()}`);
    const decPath = path.join(unsafeDir, 'decrypted.dump');
    const passphrase = 'ValidPassphrase123!@#';

    fs.mkdirSync(unsafeDir, { recursive: true });
    if (process.platform === 'win32') {
      // Grant explicit unauthorized permission to Everyone to create an insecure existing directory
      const { execFileSync } = await import('child_process');
      execFileSync('icacls.exe', [unsafeDir, '/grant:r', 'Everyone:(OI)(CI)(R)'], { stdio: 'ignore' });
      const checkBefore = verifyWindowsAcl(unsafeDir);
      expect(checkBefore.protected).toBe(false);
    } else {
      fs.chmodSync(unsafeDir, 0o777);
      expect((fs.statSync(unsafeDir).mode & 0o077) !== 0).toBe(true);
    }

    fs.writeFileSync(srcPath, 'Sensitive payload');
    await encryptBackupFile(srcPath, encPath, passphrase);

    // Must reject fail-closed with INSECURE_DIRECTORY
    await expect(decryptBackupFile(encPath, decPath, passphrase)).rejects.toThrow(
      /INSECURE_DIRECTORY/
    );

    // Verify the insecure directory was NOT silently modified or repaired
    if (process.platform === 'win32') {
      const checkAfter = verifyWindowsAcl(unsafeDir);
      expect(checkAfter.protected).toBe(false);
      expect(checkAfter.unauthorizedSids).toContain('Everyone');
    } else {
      const modeAfter = fs.statSync(unsafeDir).mode & 0o777;
      expect((modeAfter & 0o077) !== 0).toBe(true);
    }
  });

  it('43. should surface PLAINTEXT_STAGING_CLEANUP_FAILED and identify exact remaining path when sibling staging cleanup fails in cross-volume fallback', async () => {
    const srcPath = getTempFile('fallback_cleanup_fail_src.dump');
    const encPath = getTempFile('fallback_cleanup_fail_enc.enc');
    const decPath = getTempFile('fallback_cleanup_fail_dec.dump');
    const passphrase = 'ValidPassphrase123!@#';

    fs.writeFileSync(srcPath, 'Sensitive database plaintext for cross-volume sibling cleanup test');
    await encryptBackupFile(srcPath, encPath, passphrase);

    const originalLink = fs.linkSync;
    const originalUnlink = fs.unlinkSync;
    let siblingStagingPathDetected: string | null = null;

    try {
      // 1. Force atomicPublishNoClobber primary hardlink to fail with EXDEV to trigger cross-volume fallback
      let linkCallCount = 0;
      fs.linkSync = (src: fs.PathLike, dst: fs.PathLike) => {
        linkCallCount++;
        if (linkCallCount === 1) {
          // First attempt: primary link throws EXDEV
          const err = new Error('EXDEV: cross-device link not permitted');
          (err as any).code = 'EXDEV';
          throw err;
        }
        // Second attempt: hardlink from siblingStaging to absFinal succeeds
        return originalLink(src, dst);
      };

      // 2. Force deletion of sibling staging file to fail
      fs.unlinkSync = (targetPath: fs.PathLike) => {
        if (typeof targetPath === 'string' && path.basename(targetPath).startsWith('.publish_staging')) {
          siblingStagingPathDetected = path.resolve(targetPath);
          throw new Error('EPERM: sibling staging file locked by backup indexer');
        }
        return originalUnlink(targetPath);
      };

      // Decrypt file: publication succeeds, but sibling staging cleanup fails
      await expect(decryptBackupFile(encPath, decPath, passphrase)).rejects.toThrow(
        /PLAINTEXT_STAGING_CLEANUP_FAILED/
      );

      // Verify the error surfaced the failure, publicationState PUBLISHED, and the sibling path
      expect(siblingStagingPathDetected).not.toBeNull();
      expect(fs.existsSync(siblingStagingPathDetected!)).toBe(true);

      // Successfully published destination MUST NOT be accidentally deleted!
      expect(fs.existsSync(decPath)).toBe(true);
      expect(fs.readFileSync(decPath, 'utf-8')).toBe('Sensitive database plaintext for cross-volume sibling cleanup test');
    } finally {
      fs.linkSync = originalLink;
      fs.unlinkSync = originalUnlink;
      if (siblingStagingPathDetected && fs.existsSync(siblingStagingPathDetected)) {
        try { fs.unlinkSync(siblingStagingPathDetected); } catch {}
      }
    }
  });

  it('44. should surface PLAINTEXT_STAGING_CLEANUP_FAILED and preserve original error when destination exists (EEXIST) and sibling staging cleanup fails', async () => {
    const srcPath = getTempFile('fallback_eexist_src.dump');
    const encPath = getTempFile('fallback_eexist_enc.enc');
    const decPath = getTempFile('fallback_eexist_dec.dump');
    const passphrase = 'ValidPassphrase123!@#';
    const sacredExistingContent = 'PRE_EXISTING_DESTINATION_SACRED_CONTENT';

    fs.writeFileSync(srcPath, 'New decrypted data');
    await encryptBackupFile(srcPath, encPath, passphrase);

    // Ensure destination does NOT exist when decryptBackupFile is initially invoked
    if (fs.existsSync(decPath)) {
      fs.unlinkSync(decPath);
    }

    const originalLink = fs.linkSync;
    const originalUnlink = fs.unlinkSync;
    let siblingStagingPathDetected: string | null = null;

    try {
      // Force primary link to simulate concurrent destination creation AND throw EXDEV
      let linkCallCount = 0;
      fs.linkSync = (src: fs.PathLike, dst: fs.PathLike) => {
        linkCallCount++;
        if (linkCallCount === 1) {
          // Simulate concurrent process creating the destination file right during publication
          fs.writeFileSync(decPath, sacredExistingContent);
          const err = new Error('EXDEV: cross-device link not permitted');
          (err as any).code = 'EXDEV';
          throw err;
        }
        // Second link will fail with EEXIST because decPath was created concurrently
        return originalLink(src, dst);
      };

      // Force deletion of sibling staging file in finally to fail
      fs.unlinkSync = (targetPath: fs.PathLike) => {
        if (typeof targetPath === 'string' && path.basename(targetPath).startsWith('.publish_staging')) {
          siblingStagingPathDetected = path.resolve(targetPath);
          throw new Error('EBUSY: resource locked');
        }
        return originalUnlink(targetPath);
      };

      // Must reject with PLAINTEXT_STAGING_CLEANUP_FAILED preserving both STAGING_CLEANUP_FAILED and EEXIST
      let thrownError: any = null;
      try {
        await decryptBackupFile(encPath, decPath, passphrase);
      } catch (err: any) {
        thrownError = err;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError.message).toMatch(/PLAINTEXT_STAGING_CLEANUP_FAILED/);
      expect(thrownError.message).toMatch(/STAGING_CLEANUP_FAILED/);
      expect(thrownError.message).toMatch(/EEXIST/);
      expect(thrownError.message).toContain('.publish_staging');

      // Pre-existing destination must remain completely untouched!
      expect(fs.existsSync(decPath)).toBe(true);
      expect(fs.readFileSync(decPath, 'utf-8')).toBe(sacredExistingContent);
    } finally {
      fs.linkSync = originalLink;
      fs.unlinkSync = originalUnlink;
      if (siblingStagingPathDetected && fs.existsSync(siblingStagingPathDetected)) {
        try { fs.unlinkSync(siblingStagingPathDetected); } catch {}
      }
    }
  });

  it('45. should successfully clean up both original and sibling staging files during normal cross-volume fallback', async () => {
    const srcPath = getTempFile('fallback_success_src.dump');
    const encPath = getTempFile('fallback_success_enc.enc');
    const decPath = getTempFile('fallback_success_dec.dump');
    const passphrase = 'ValidPassphrase123!@#';
    const payload = 'Cross-volume fallback successful publication data';

    fs.writeFileSync(srcPath, payload);
    await encryptBackupFile(srcPath, encPath, passphrase);

    const originalLink = fs.linkSync;
    let exdevTriggered = false;

    try {
      let linkCallCount = 0;
      fs.linkSync = (src: fs.PathLike, dst: fs.PathLike) => {
        linkCallCount++;
        if (linkCallCount === 1) {
          exdevTriggered = true;
          const err = new Error('EXDEV: cross-device link not permitted');
          (err as any).code = 'EXDEV';
          throw err;
        }
        return originalLink(src, dst);
      };

      const res = await decryptBackupFile(encPath, decPath, passphrase);
      expect(res.outputPath).toBe(decPath);
      expect(fs.existsSync(decPath)).toBe(true);
      expect(fs.readFileSync(decPath, 'utf-8')).toBe(payload);
      expect(exdevTriggered).toBe(true);

      // Verify no leftover staging files in testDir (.publish_staging or .dec_staging)
      const leftovers = fs.readdirSync(testDir).filter(
        (f) => f.startsWith('.publish_staging') || f.startsWith('.dec_staging')
      );
      expect(leftovers).toHaveLength(0);
    } finally {
      fs.linkSync = originalLink;
    }
  });
});
