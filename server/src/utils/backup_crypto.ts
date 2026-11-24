import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { pipeline } from 'stream/promises';

// Format versions
export const BACKUP_MAGIC_V1 = Buffer.from('CTBK01', 'ascii'); // 6 bytes (Legacy: 100,000 iterations)
export const BACKUP_MAGIC_V2 = Buffer.from('CTBK02', 'ascii'); // 6 bytes (Current: 600,000 iterations)
export const BACKUP_MAGIC_HEADER = BACKUP_MAGIC_V2; // Default for all new backups
export const BACKUP_MAGIC_HEADER_V1 = BACKUP_MAGIC_V1;
export const BACKUP_MAGIC_HEADER_V2 = BACKUP_MAGIC_V2;

export const SALT_LENGTH = 16; // 16 bytes
export const IV_LENGTH = 12; // 12 bytes
export const TAG_LENGTH = 16; // 16 bytes
export const HEADER_LENGTH = BACKUP_MAGIC_V2.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH; // 50 bytes

export const DEFAULT_PBKDF2_ITERATIONS = 600000; // OWASP recommendation for PBKDF2-HMAC-SHA256
export const LEGACY_PBKDF2_ITERATIONS = 100000; // Backward-compatible iteration count for CTBK01
export const PBKDF2_ITERATIONS = DEFAULT_PBKDF2_ITERATIONS; // Current default
export const PBKDF2_DIGEST = 'sha256';
export const KEY_LENGTH = 32; // 256 bits for AES-256-GCM
export const CIPHER_ALGO = 'aes-256-gcm';

export interface CryptoFileOptions {
  // Overwriting existing backup files is strictly prohibited across all operations
}

export interface BackupHeaderMetadata {
  magic: string;
  version: number;
  iterations: number;
  saltHex: string;
  ivHex: string;
  tagHex: string;
  validHeader: boolean;
  fileSizeBytes: number;
}

export type PublicationState =
  | 'STAGING_WRITTEN'
  | 'STAGING_VERIFIED'
  | 'RENAME_ATTEMPTED'
  | 'PUBLISHED'
  | 'ROLLBACK_INITIATED'
  | 'ROLLED_BACK'
  | 'POST_PUBLICATION_ROLLBACK_FAILED';

export function getAuthorizedWindowsIdentities(): Set<string> {
  const user = (process.env.USERNAME || 'Administrator').toLowerCase();
  const domain = (process.env.USERDOMAIN || '').toLowerCase();
  return new Set([
    'nt authority\\system',
    'system',
    '*s-1-5-18',
    's-1-5-18',
    'builtin\\administrators',
    'administrators',
    '*s-1-5-32-544',
    's-1-5-32-544',
    user,
    `${domain}\\${user}`,
  ]);
}

/**
 * Hardens Windows NTFS Access Control Lists (ACLs):
 * - Inspects existing ACLs to discover any explicit unauthorized ACEs.
 * - Strips all inherited permissions (/inheritance:r).
 * - Purges all existing explicit unauthorized access rules (/remove:g Everyone, Users, etc.).
 * - Grants FullControl strictly to:
 *   1. Current User
 *   2. Local SYSTEM (*S-1-5-18)
 *   3. BUILTIN\Administrators (*S-1-5-32-544)
 * - Configures ContainerInherit & ObjectInherit for directories, None for files.
 * - Throws fail-closed if icacls fails.
 */
export function secureWindowsAcl(targetPath: string, isDirectory: boolean = false): void {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(targetPath)) return;

  const resolved = path.resolve(targetPath);
  const currentUser = process.env.USERNAME || 'Administrator';
  const inheritFlags = isDirectory ? ':(OI)(CI)F' : ':F';

  try {
    // 1. Inspect existing ACL to discover explicit unauthorized identities to purge
    const initialCheck = verifyWindowsAcl(resolved);
    const removeArgs: string[] = [];
    for (const unauth of initialCheck.unauthorizedSids) {
      removeArgs.push('/remove:g', unauth);
    }
    // Also explicitly purge common overly permissive built-ins
    removeArgs.push(
      '/remove:g', 'Everyone',
      '/remove:g', '*S-1-1-0',
      '/remove:g', 'Users',
      '/remove:g', 'BUILTIN\\Users',
      '/remove:g', '*S-1-5-32-545'
    );

    // 2. Strip inheritance, purge unauthorized ACEs, and grant FullControl strictly to allowlist
    execFileSync(
      'icacls.exe',
      [
        resolved,
        '/inheritance:r',
        ...removeArgs,
        '/grant:r', `*S-1-5-32-544${inheritFlags}`,
        '/grant:r', `*S-1-5-18${inheritFlags}`,
        '/grant:r', `${currentUser}${inheritFlags}`,
      ],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err: any) {
    throw new Error(`Failed to secure Windows NTFS ACL on "${resolved}": ${err.message}`);
  }
}

/**
 * Inspects Windows NTFS Access Control Lists (ACLs) to verify:
 * 1. Inheritance is disabled (no (I) inheritance flags).
 * 2. Every access rule strictly belongs to the approved allowlist:
 *    - Current User
 *    - Local SYSTEM (S-1-5-18)
 *    - BUILTIN\Administrators (S-1-5-32-544)
 * Rejects any file or directory containing unauthorized allow ACEs (e.g. Everyone, Users, arbitrary accounts).
 */
export function verifyWindowsAcl(targetPath: string): {
  protected: boolean;
  inherited: boolean;
  unauthorizedSids: string[];
  aclOutput: string;
} {
  if (process.platform !== 'win32') {
    return { protected: true, inherited: false, unauthorizedSids: [], aclOutput: 'POSIX platform (chmod used)' };
  }
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Target path does not exist for ACL verification: "${resolved}"`);
  }

  try {
    const output = execFileSync('icacls.exe', [resolved], { encoding: 'utf8', timeout: 5000 });
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    const authSet = getAuthorizedWindowsIdentities();
    const unauthorizedSids: string[] = [];
    let hasInherited = false;
    let ruleCount = 0;

    for (const line of lines) {
      if (line.startsWith('Successfully processed') || line.startsWith('Failed processing')) continue;
      let rulePart = line;
      if (rulePart.toLowerCase().startsWith(resolved.toLowerCase())) {
        rulePart = rulePart.slice(resolved.length).trim();
      }
      const colonIdx = rulePart.indexOf(':');
      if (colonIdx === -1) continue;
      ruleCount++;
      const identity = rulePart.slice(0, colonIdx).trim();
      const perms = rulePart.slice(colonIdx + 1).trim();

      if (perms.includes('(I)')) {
        hasInherited = true;
      }

      if (!authSet.has(identity.toLowerCase())) {
        unauthorizedSids.push(identity);
      }
    }

    const isSecure = !hasInherited && unauthorizedSids.length === 0;
    let aclOutput = `Protected=${isSecure}, Inherited=${hasInherited}, Rules=${ruleCount}`;
    if (unauthorizedSids.length > 0) {
      aclOutput += `, UnauthorizedIdentities=[${unauthorizedSids.join(', ')}]`;
    }

    return {
      protected: isSecure,
      inherited: hasInherited,
      unauthorizedSids,
      aclOutput,
    };
  } catch (err: any) {
    throw new Error(`Failed to verify Windows NTFS ACL on "${resolved}": ${err.message}`);
  }
}

/**
 * Restricts file permissions (default 0600: read/write owner only).
 * On POSIX: sets 0o600 and verifies resulting mode bits.
 * On Windows: clears read-only attributes, configures NTFS ACL to remove inheritance,
 * purges existing unauthorized ACEs, restricts to allowlist, and verifies resulting ACL.
 */
export function setRestrictiveFileMode(filePath: string, mode: number = 0o600): void {
  if (!fs.existsSync(filePath)) return;
  fs.chmodSync(filePath, mode);
  if (process.platform === 'win32') {
    secureWindowsAcl(filePath, false);
    const verif = verifyWindowsAcl(filePath);
    if (!verif.protected) {
      throw new Error(
        `Failed to verify restrictive file mode on "${filePath}": NTFS ACL verification failed (${verif.aclOutput})`
      );
    }
    return;
  }
  const actualMode = fs.statSync(filePath).mode & 0o777;
  if (actualMode !== mode) {
    throw new Error(
      `Failed to verify restrictive file mode on "${filePath}": expected ${mode.toString(8)}, got ${actualMode.toString(8)}`
    );
  }
}

/**
 * Restricts directory permissions (default 0700: rwx owner only).
 * On POSIX: sets 0o700 and verifies resulting mode bits.
 * On Windows: configures NTFS ACL to remove inheritance,
 * purges existing unauthorized ACEs, restricts to allowlist, and verifies resulting ACL.
 */
export function setRestrictiveDirMode(dirPath: string, mode: number = 0o700): void {
  if (!fs.existsSync(dirPath)) return;
  fs.chmodSync(dirPath, mode);
  if (process.platform === 'win32') {
    secureWindowsAcl(dirPath, true);
    const verif = verifyWindowsAcl(dirPath);
    if (!verif.protected) {
      throw new Error(
        `Failed to verify restrictive directory mode on "${dirPath}": NTFS ACL verification failed (${verif.aclOutput})`
      );
    }
    return;
  }
  const actualMode = fs.statSync(dirPath).mode & 0o777;
  if (actualMode !== mode) {
    throw new Error(
      `Failed to verify restrictive directory mode on "${dirPath}": expected ${mode.toString(8)}, got ${actualMode.toString(8)}`
    );
  }
}

/**
 * Ensures that an output directory for sensitive backup or decryption operations is secure.
 * - If the directory does NOT exist:
 *     1. Creates it with restrictive permissions (0700).
 *     2. Applies restrictive security configuration (owner-only mode / Windows NTFS ACLs).
 *     3. Verifies that the resulting permissions are correct.
 * - If the directory ALREADY exists:
 *     1. Inspects its existing permissions and ACLs without silently modifying them.
 *     2. If the directory is unsafe for the intended operation, rejects the operation
 *        with a clear and actionable error.
 *     3. Leaves safe existing directories completely untouched.
 */
export function ensureSecureOutputDir(dirPath: string): void {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    setRestrictiveDirMode(resolved, 0o700);
    if (process.platform === 'win32') {
      const aclCheck = verifyWindowsAcl(resolved);
      if (!aclCheck.protected) {
        throw new Error(
          `INSECURE_DIRECTORY: Newly created output directory "${resolved}" failed Windows NTFS ACL protection verification.`
        );
      }
    } else {
      const mode = fs.statSync(resolved).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `INSECURE_DIRECTORY: Newly created output directory "${resolved}" has insecure permissions (${mode.toString(8)}). Expected owner-only 0700.`
        );
      }
    }
  } else {
    // Existing directory: inspect without modifying permissions or ACLs!
    if (process.platform === 'win32') {
      const aclCheck = verifyWindowsAcl(resolved);
      if (!aclCheck.protected) {
        throw new Error(
          `INSECURE_DIRECTORY: Existing output directory "${resolved}" has insecure Windows NTFS permissions (${aclCheck.aclOutput}). Existing directories must not be silently modified; please restrict permissions to owner/administrators before retrying.`
        );
      }
    } else {
      const mode = fs.statSync(resolved).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `INSECURE_DIRECTORY: Existing output directory "${resolved}" has insecure permissions (${mode.toString(8)}). Expected owner-only 0700. Existing directories must not be silently modified; please restrict permissions before retrying.`
        );
      }
    }
  }
}

/**
 * Commits directory metadata changes to physical storage where the platform supports it.
 *
 * Platform Differences & Durability Limitations:
 * - POSIX (Linux, macOS, BSD): Directory entries are committed by calling fsync on the
 *   directory file descriptor. If the underlying filesystem does not support directory-level
 *   fsync (e.g. NFS or FAT), EINVAL or ENOTSUP is returned. Genuine permission failures (EPERM,
 *   EACCES) or file descriptor issues (EBADF, EIO) are NOT ignored and will throw fail-closed.
 * - Windows NTFS: Win32 file APIs and Node.js do not support FlushFileBuffers on directory handles.
 *   Calling openSync or fsyncSync on a directory in Windows fails with EISDIR or EPERM.
 *   This is a documented Win32 platform limitation. File content synchronization is guaranteed
 *   via file-level fsyncSync before atomic publication.
 */
export function fsyncDirectorySafely(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory does not exist: "${dirPath}"`);
  }
  if (process.platform === 'win32') {
    // Documented Win32 platform limitation: Windows NTFS does not support directory fsync handles
    return;
  }

  let dirFd: number | null = null;
  try {
    const flags = fs.constants.O_RDONLY | ((fs.constants as any).O_DIRECTORY || 0);
    dirFd = fs.openSync(dirPath, flags);
    fs.fsyncSync(dirFd);
  } catch (err: any) {
    // Only treat as unsupported when the underlying filesystem genuinely lacks directory fsync support
    if (err.code === 'EINVAL' || err.code === 'ENOTSUP' || err.code === 'EOPNOTSUPP') {
      return;
    }
    // Genuine errors (EPERM, EACCES, EBADF, EIO) MUST NOT be swallowed!
    throw new Error(`Directory fsync failed for "${dirPath}": [${err.code || 'UNKNOWN'}] ${err.message}`);
  } finally {
    if (dirFd !== null) {
      try {
        fs.closeSync(dirFd);
      } catch {}
    }
  }
}

/**
 * Atomically publishes a staging file to finalPath without clobbering an existing file.
 *
 * Durability and Safety Guarantees:
 * 1. Physical Flush: Staging file MUST be fsync'd prior to publication. Any fsync failure
 *    is treated as a hard failure and never swallowed.
 * 2. Atomic No-Clobber: On POSIX and Windows NTFS, fs.linkSync creates a hard link to finalPath.
 *    If finalPath already exists, the kernel atomically rejects the operation with EEXIST,
 *    preventing any TOCTOU race condition or file clobbering.
 * 3. Post-Publication Safety: After publication, restrictive file mode (0600) and parent directory
 *    fsync are executed. If any post-publication step fails, finalPath is immediately unlinked
 *    to prevent leaving an incorrectly permissioned or insecure backup.
 * 4. Staging Cleanup: Staging files are cleaned up on both success and failure paths.
 * 5. Fail-Closed: If atomic hardlinks are not supported by the filesystem, publication fails closed
 *    with ATOMIC_PUBLICATION_UNSUPPORTED. Unsafe fallback copies or renames are strictly forbidden.
 */
export function atomicPublishNoClobber(stagingPath: string, finalPath: string): void {
  const absStaging = path.resolve(stagingPath);
  const absFinal = path.resolve(finalPath);

  if (!fs.existsSync(absStaging)) {
    throw new Error(`Staging file does not exist for atomic publication: "${stagingPath}"`);
  }

  let publicationState: PublicationState = 'STAGING_WRITTEN';

  // 1. Ensure staging data is flushed to physical media before publication (hard failure on error)
  let sFd: number | null = null;
  try {
    try {
      // FlushFileBuffers on Windows requires write access ('r+')
      sFd = fs.openSync(absStaging, 'r+');
    } catch {
      sFd = fs.openSync(absStaging, 'r');
    }
    fs.fsyncSync(sFd);
  } finally {
    if (sFd !== null) {
      try {
        fs.closeSync(sFd);
      } catch {}
    }
  }

  // Ensure destination directory exists with restrictive permissions
  const targetDir = path.dirname(absFinal);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    setRestrictiveDirMode(targetDir, 0o700);
  }

  publicationState = 'STAGING_VERIFIED';

  try {
    // 2. Primary mechanism: atomic hardlink. Fails atomically with EEXIST if destination already exists.
    publicationState = 'RENAME_ATTEMPTED';
    fs.linkSync(absStaging, absFinal);
    publicationState = 'PUBLISHED';

    // 3. Post-publication verification: apply permissions and commit directory entry
    try {
      setRestrictiveFileMode(absFinal, 0o600);
      fsyncDirectorySafely(targetDir);
    } catch (postPubErr: any) {
      publicationState = 'ROLLBACK_INITIATED';
      try {
        fs.unlinkSync(absFinal);
        publicationState = 'ROLLED_BACK';
      } catch (rollbackErr: any) {
        publicationState = 'POST_PUBLICATION_ROLLBACK_FAILED';
        throw new Error(
          `POST_PUBLICATION_ROLLBACK_FAILED: Post-publication step failed for "${finalPath}" (${postPubErr.message}) and rollback unlink failed (${rollbackErr.message}). Destination file may be left in an inconsistent state.`
        );
      }
      throw new Error(`POST_PUBLICATION_FAILED_ROLLED_BACK: Post-publication durability/permission failure for "${finalPath}": ${postPubErr.message}`);
    }

    // 4. Remove staging file only after publication and post-publication steps completely succeed
    try {
      fs.unlinkSync(absStaging);
    } catch (unlinkErr: any) {
      throw new Error(
        `STAGING_CLEANUP_FAILED: Staging file "${absStaging}" could not be deleted after publication: ${unlinkErr.message}`
      );
    }
    return;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Destination already existed before we attempted rename/link -> strict no-overwrite guarantee: NEVER touch absFinal!
      throw new Error(
        `EEXIST: Destination file already exists (atomic no-clobber violation prevented): "${finalPath}"`
      );
    }

    // If it was already a Post-publication failure or Staging cleanup failure or rollback failure, rethrow it
    if (
      err.message &&
      (err.message.startsWith('POST_PUBLICATION_') ||
        err.message.startsWith('STAGING_CLEANUP_FAILED'))
    ) {
      throw err;
    }

    // Fallback handling for cross-volume links (EXDEV) or filesystems lacking hardlinks
    const siblingStaging = path.join(
      targetDir,
      `.publish_staging.${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
    );

    let copySucceeded = false;
    let operationErr: Error | null = null;
    let siblingCleanupErr: Error | null = null;
    try {
      const inFd = fs.openSync(absStaging, 'r');
      let outFd: number | null = null;
      try {
        outFd = fs.openSync(siblingStaging, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        setRestrictiveFileMode(siblingStaging, 0o600);
        const buf = Buffer.alloc(64 * 1024);
        let bytesRead = 0;
        let pos = 0;
        while ((bytesRead = fs.readSync(inFd, buf, 0, buf.length, pos)) > 0) {
          fs.writeSync(outFd, buf, 0, bytesRead);
          pos += bytesRead;
        }
        // Strict physical flush of sibling staging copy
        fs.fsyncSync(outFd);
        copySucceeded = true;
      } finally {
        if (outFd !== null) {
          try {
            fs.closeSync(outFd);
          } catch {}
        }
        try {
          fs.closeSync(inFd);
        } catch {}
      }

      if (!copySucceeded) {
        throw new Error(`Failed to copy staging file to target filesystem for "${finalPath}".`);
      }

      publicationState = 'STAGING_VERIFIED';

      // Try hardlink from sibling on same filesystem to destination
      try {
        publicationState = 'RENAME_ATTEMPTED';
        fs.linkSync(siblingStaging, absFinal);
        publicationState = 'PUBLISHED';
        try {
          setRestrictiveFileMode(absFinal, 0o600);
          fsyncDirectorySafely(targetDir);
        } catch (postErr: any) {
          publicationState = 'ROLLBACK_INITIATED';
          try {
            fs.unlinkSync(absFinal);
            publicationState = 'ROLLED_BACK';
          } catch (rollbackErr: any) {
            publicationState = 'POST_PUBLICATION_ROLLBACK_FAILED';
            throw new Error(
              `POST_PUBLICATION_ROLLBACK_FAILED: Post-publication step failed for "${finalPath}" (${postErr.message}) and rollback unlink failed (${rollbackErr.message}). Destination file may be left in an inconsistent state.`
            );
          }
          throw new Error(`POST_PUBLICATION_FAILED_ROLLED_BACK: Post-publication durability/permission failure for "${finalPath}": ${postErr.message}`);
        }

        try {
          if (fs.existsSync(siblingStaging)) {
            fs.unlinkSync(siblingStaging);
          }
        } catch (unlinkErr: any) {
          throw new Error(
            `STAGING_CLEANUP_FAILED: Sibling staging file "${siblingStaging}" could not be deleted after publication [publicationState: ${publicationState}]: ${unlinkErr.message}`
          );
        }
        try {
          if (fs.existsSync(absStaging)) {
            fs.unlinkSync(absStaging);
          }
        } catch (unlinkErr: any) {
          throw new Error(
            `STAGING_CLEANUP_FAILED: Source staging file "${absStaging}" could not be deleted after publication [publicationState: ${publicationState}]: ${unlinkErr.message}`
          );
        }
        return;
      } catch (linkErr: any) {
        if (linkErr.code === 'EEXIST') {
          throw new Error(
            `EEXIST: Destination file already exists (atomic no-clobber violation prevented): "${finalPath}"`
          );
        }
        if (
          linkErr.message &&
          (linkErr.message.startsWith('POST_PUBLICATION_') ||
            linkErr.message.startsWith('STAGING_CLEANUP_FAILED'))
        ) {
          throw linkErr;
        }

        // For a filesystem that does not support the required atomic no-clobber operation,
        // fail closed with a clear error rather than using an unsafe fallback.
        throw new Error(
          `ATOMIC_PUBLICATION_UNSUPPORTED: Target filesystem at "${finalPath}" does not support atomic no-clobber hardlinks (${linkErr.code || linkErr.message}). Publication aborted to prevent race conditions or overwriting.`
        );
      }
    } catch (err: any) {
      operationErr = err;
      throw err;
    } finally {
      if (fs.existsSync(siblingStaging)) {
        try {
          fs.unlinkSync(siblingStaging);
        } catch (cleanupErr: any) {
          siblingCleanupErr = cleanupErr;
        }
      }
      if (siblingCleanupErr) {
        const cleanupDetail = `STAGING_CLEANUP_FAILED: Sibling staging file "${siblingStaging}" could not be deleted [publicationState: ${publicationState}]: ${siblingCleanupErr.message}`;
        if (operationErr) {
          throw new Error(`${cleanupDetail}. Original operation error: ${operationErr.message}`);
        } else {
          throw new Error(cleanupDetail);
        }
      }
    }
  }
}

/**
 * Derives a 256-bit cryptographic key using PBKDF2-HMAC-SHA256.
 * Supports configurable iteration count (default: 600,000 for CTBK02, 100,000 for legacy CTBK01).
 */
export function deriveKey(
  passphrase: string,
  salt: Buffer,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Buffer {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length === 0) {
    throw new Error('Passphrase is required and cannot be empty for backup encryption/decryption.');
  }
  if (!salt || salt.length !== SALT_LENGTH) {
    throw new Error(`Salt must be exactly ${SALT_LENGTH} bytes.`);
  }
  if (!iterations || iterations < 100000) {
    throw new Error(`PBKDF2 iterations must be at least 100,000 (got ${iterations}).`);
  }
  return crypto.pbkdf2Sync(passphrase, salt, iterations, KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Inspects a backup file header without full decryption.
 * Identifies format version (CTBK01: v1 with 100k iterations, CTBK02: v2 with 600k iterations).
 */
export function inspectBackupHeader(filePath: string): BackupHeaderMetadata {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Backup file not found: ${filePath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size < HEADER_LENGTH) {
    throw new Error(`Backup file is truncated or invalid: expected at least ${HEADER_LENGTH} bytes, got ${stat.size}`);
  }

  const fd = fs.openSync(absPath, 'r');
  const headerBuf = Buffer.alloc(HEADER_LENGTH);
  try {
    fs.readSync(fd, headerBuf, 0, HEADER_LENGTH, 0);
  } finally {
    fs.closeSync(fd);
  }

  const magic = headerBuf.subarray(0, 6);
  let version = 0;
  let iterations = 0;

  if (magic.equals(BACKUP_MAGIC_V2)) {
    version = 2;
    iterations = DEFAULT_PBKDF2_ITERATIONS; // 600,000
  } else if (magic.equals(BACKUP_MAGIC_V1)) {
    version = 1;
    iterations = LEGACY_PBKDF2_ITERATIONS; // 100,000
  }

  const validHeader = version > 0;
  const salt = headerBuf.subarray(6, 6 + SALT_LENGTH);
  const iv = headerBuf.subarray(6 + SALT_LENGTH, 6 + SALT_LENGTH + IV_LENGTH);
  const tag = headerBuf.subarray(6 + SALT_LENGTH + IV_LENGTH, HEADER_LENGTH);

  return {
    magic: magic.toString('ascii'),
    version,
    iterations,
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    tagHex: tag.toString('hex'),
    validHeader,
    fileSizeBytes: stat.size,
  };
}

/**
 * Encrypts an unencrypted backup file using authenticated AES-256-GCM.
 * All new backups use CTBK02 format with 600,000 PBKDF2 iterations.
 *
 * Durability and Safety Guarantees:
 * - Rejects input and output resolving to same file.
 * - Protects pre-existing destination files (never overwrites).
 * - Encrypts into a unique temporary sibling file.
 * - Restricts permissions on temporary and final files (0600).
 * - Flushes completed temporary file (hard fsync) before atomic publication.
 * - Publishes atomically without clobbering.
 * - Cleans up temporary file on failure.
 * Output format: [MAGIC_V2 (6)][SALT (16)][IV (12)][TAG (16)][CIPHERTEXT (N)]
 */
export async function encryptBackupFile(
  inputPath: string,
  outputPath: string,
  passphrase: string,
  options: CryptoFileOptions = {}
): Promise<{ outputPath: string; bytesWritten: number; version: number; iterations: number }> {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length === 0) {
    throw new Error('Encryption passphrase is required and cannot be empty.');
  }

  const absInput = path.resolve(inputPath);
  const absOutput = path.resolve(outputPath);

  if (absInput === absOutput) {
    throw new Error(`Source and destination paths cannot resolve to the same file: "${inputPath}"`);
  }

  if (!fs.existsSync(absInput)) {
    throw new Error(`Source backup file does not exist: ${inputPath}`);
  }
  const inputStat = fs.statSync(absInput);
  if (!inputStat.isFile()) {
    throw new Error(`Source backup path is not a regular file: ${inputPath}`);
  }

  if (fs.existsSync(absOutput)) {
    throw new Error(
      `BACKUP_DESTINATION_EXISTS: Destination file already exists: "${outputPath}". Overwriting backup files is strictly disallowed.`
    );
  }

  // Ensure output directory exists with restrictive permissions (0700)
  const outDir = path.dirname(absOutput);
  ensureSecureOutputDir(outDir);

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt, DEFAULT_PBKDF2_ITERATIONS); // 600,000 iterations
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv);

  // Allocate 50-byte header buffer with placeholder for auth tag
  const headerBuf = Buffer.alloc(HEADER_LENGTH);
  BACKUP_MAGIC_V2.copy(headerBuf, 0); // CTBK02
  salt.copy(headerBuf, BACKUP_MAGIC_V2.length);
  iv.copy(headerBuf, BACKUP_MAGIC_V2.length + SALT_LENGTH);
  // tag (bytes 34..50) left zeroed for now

  const tempOutputPath = path.join(
    outDir,
    `.enc_staging.${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
  );
  let outFd: number | null = null;

  try {
    outFd = fs.openSync(tempOutputPath, 'w+', 0o600);
    setRestrictiveFileMode(tempOutputPath, 0o600);
    fs.writeSync(outFd, headerBuf, 0, HEADER_LENGTH, 0);

    const outStream = fs.createWriteStream(tempOutputPath, {
      fd: outFd,
      start: HEADER_LENGTH,
      autoClose: false,
      mode: 0o600,
    });
    const inStream = fs.createReadStream(absInput);

    await pipeline(inStream, cipher, outStream);

    // Retrieve authentication tag after stream completes
    const authTag = cipher.getAuthTag();
    if (authTag.length !== TAG_LENGTH) {
      throw new Error(`Invalid authentication tag generated: expected ${TAG_LENGTH} bytes, got ${authTag.length}`);
    }

    // Write auth tag at offset 34
    fs.writeSync(outFd, authTag, 0, TAG_LENGTH, BACKUP_MAGIC_V2.length + SALT_LENGTH + IV_LENGTH);

    // Physical durability flush of encrypted file before closing and publishing (hard failure on error)
    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFd = null;

    // Atomically publish completed encrypted file without clobbering
    atomicPublishNoClobber(tempOutputPath, absOutput);
  } catch (err: any) {
    if (outFd !== null) {
      try {
        fs.closeSync(outFd);
      } catch {}
    }
    // Clean up temporary staging file
    if (fs.existsSync(tempOutputPath)) {
      try {
        fs.unlinkSync(tempOutputPath);
      } catch {}
    }
    // NEVER touch absOutput! Pre-existing destination is preserved.
    throw err;
  }

  const finalStat = fs.statSync(absOutput);
  return {
    outputPath: absOutput,
    bytesWritten: finalStat.size,
    version: 2,
    iterations: DEFAULT_PBKDF2_ITERATIONS,
  };
}

/**
 * Decrypts an authenticated AES-256-GCM backup file.
 * Preserves backward compatibility:
 * - Format CTBK01 uses 100,000 PBKDF2 iterations.
 * - Format CTBK02 uses 600,000 PBKDF2 iterations.
 *
 * Durability and Safety Guarantees:
 * - Never publishes plaintext unless GCM authentication tag verification succeeds.
 * - Flushes decrypted plaintext to physical media before publication.
 * - Publishes atomically without clobbering.
 * - Never overwrites pre-existing files at destination.
 * - Cleans up temporary plaintext staging file on failure.
 */
export async function decryptBackupFile(
  inputPath: string,
  outputPath: string,
  passphrase: string,
  options: CryptoFileOptions = {}
): Promise<{ outputPath: string; bytesWritten: number; version: number; iterations: number }> {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length === 0) {
    throw new Error('Decryption passphrase is required and cannot be empty.');
  }

  const absInput = path.resolve(inputPath);
  const absOutput = path.resolve(outputPath);

  if (absInput === absOutput) {
    throw new Error(`Source and destination paths cannot resolve to the same file: "${inputPath}"`);
  }

  if (!fs.existsSync(absInput)) {
    throw new Error(`Encrypted backup file does not exist: ${inputPath}`);
  }
  const inputStat = fs.statSync(absInput);
  if (inputStat.size < HEADER_LENGTH) {
    throw new Error(
      `Encrypted backup file is truncated: expected at least ${HEADER_LENGTH} bytes, got ${inputStat.size}`
    );
  }

  if (fs.existsSync(absOutput)) {
    throw new Error(
      `BACKUP_DESTINATION_EXISTS: Destination file already exists: "${outputPath}". Overwriting backup files is strictly disallowed.`
    );
  }

  const inFd = fs.openSync(absInput, 'r');
  const headerBuf = Buffer.alloc(HEADER_LENGTH);
  try {
    fs.readSync(inFd, headerBuf, 0, HEADER_LENGTH, 0);
  } finally {
    fs.closeSync(inFd);
  }

  const magic = headerBuf.subarray(0, 6);
  let version = 0;
  let iterations = 0;

  if (magic.equals(BACKUP_MAGIC_V2)) {
    version = 2;
    iterations = DEFAULT_PBKDF2_ITERATIONS; // 600,000
  } else if (magic.equals(BACKUP_MAGIC_V1)) {
    version = 1;
    iterations = LEGACY_PBKDF2_ITERATIONS; // 100,000
  } else {
    throw new Error(
      `Invalid backup file format: unrecognized magic header "${magic.toString('ascii')}". Supported formats: "${BACKUP_MAGIC_V2.toString('ascii')}" (v2) or "${BACKUP_MAGIC_V1.toString('ascii')}" (v1).`
    );
  }

  const salt = headerBuf.subarray(6, 6 + SALT_LENGTH);
  const iv = headerBuf.subarray(6 + SALT_LENGTH, 6 + SALT_LENGTH + IV_LENGTH);
  const tag = headerBuf.subarray(6 + SALT_LENGTH + IV_LENGTH, HEADER_LENGTH);

  const key = deriveKey(passphrase, salt, iterations);
  const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, iv);
  decipher.setAuthTag(tag);

  // Ensure output directory exists with restrictive permissions (0700)
  const outDir = path.dirname(absOutput);
  ensureSecureOutputDir(outDir);

  // Decrypt into a temporary staging sibling file first with restrictive permissions (0600)
  const tempOutputPath = path.join(
    outDir,
    `.dec_staging.${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
  );
  let outFd: number | null = null;

  try {
    // Exclusive creation: fails if file exists
    outFd = fs.openSync(
      tempOutputPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600
    );
    setRestrictiveFileMode(tempOutputPath, 0o600);
    if (process.platform === 'win32') {
      const aclCheck = verifyWindowsAcl(tempOutputPath);
      if (!aclCheck.protected) {
        throw new Error(`NTFS ACL protection verification failed for decrypted staging file "${tempOutputPath}".`);
      }
    }

    const outStream = fs.createWriteStream(tempOutputPath, {
      fd: outFd,
      autoClose: false,
      mode: 0o600,
    });
    const inStream = fs.createReadStream(absInput, { start: HEADER_LENGTH });

    await pipeline(inStream, decipher, outStream);

    // GCM authentication succeeded! Hard physical flush of plaintext before publication
    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFd = null;

    // Atomically publish decrypted plaintext without clobbering
    atomicPublishNoClobber(tempOutputPath, absOutput);
  } catch (err: any) {
    if (outFd !== null) {
      try {
        fs.closeSync(outFd);
      } catch {}
    }

    // Clean up temporary primary plaintext staging file independently
    let primaryCleanupErr: Error | null = null;
    if (fs.existsSync(tempOutputPath)) {
      try {
        fs.unlinkSync(tempOutputPath);
      } catch (unlinkErr: any) {
        primaryCleanupErr = unlinkErr;
      }
    }

    const msg = err.message || '';

    // If atomicPublishNoClobber reported that a staging file could not be cleaned up
    if (msg.includes('STAGING_CLEANUP_FAILED')) {
      let combined = `PLAINTEXT_STAGING_CLEANUP_FAILED: ${msg}`;
      if (primaryCleanupErr) {
        combined += ` [CRITICAL: Primary plaintext staging file "${path.basename(tempOutputPath)}" also could not be removed: ${primaryCleanupErr.message}]`;
      }
      throw new Error(combined);
    }

    if (primaryCleanupErr) {
      throw new Error(
        `PLAINTEXT_STAGING_CLEANUP_FAILED: ${msg} [CRITICAL: Decrypted plaintext staging file "${path.basename(tempOutputPath)}" could not be removed: ${primaryCleanupErr.message}]`
      );
    }

    if (msg.startsWith('POST_PUBLICATION_')) {
      throw err;
    }

    if (msg.includes('unable to authenticate') || msg.includes('Unsupported state')) {
      throw new Error(
        'Backup decryption failed: authentication tag verification failed. The passphrase may be incorrect, or the backup file has been tampered with or corrupted.'
      );
    }
    throw new Error(`Backup decryption failed: ${msg}`);
  }

  const outStat = fs.statSync(absOutput);
  return {
    outputPath: absOutput,
    bytesWritten: outStat.size,
    version,
    iterations,
  };
}

/**
 * Scans an application-owned staging directory and safely cleans up stale/abandoned staging files.
 * Protects against accumulating orphaned plaintext or encrypted staging artifacts.
 * Only targets known CineTrack staging prefixes (.enc_staging.*, .dec_staging.*, .publish_staging.*, cinetrack_dump_*, temp_restore_*).
 */
export function cleanupAbandonedStagingFiles(
  directoryPath: string,
  maxAgeMs: number = 3600000 // 1 hour default
): { cleaned: string[]; failed: string[]; errors: string[] } {
  const resolved = path.resolve(directoryPath);
  const cleaned: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];

  if (!fs.existsSync(resolved)) {
    return { cleaned, failed, errors };
  }

  const entries = fs.readdirSync(resolved);
  const now = Date.now();

  const stagingPrefixes = [
    '.enc_staging.',
    '.dec_staging.',
    '.publish_staging.',
    'cinetrack_dump_',
    'temp_restore_',
    '.probe_validate_',
    '.staging',
    'staging_',
  ];

  for (const entry of entries) {
    const isStaging =
      stagingPrefixes.some((prefix) => entry.startsWith(prefix)) ||
      entry.endsWith('.tmp') ||
      entry.startsWith('abandoned_');
    if (!isStaging) continue;

    const fullPath = path.join(resolved, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fullPath);
        cleaned.push(fullPath);
      }
    } catch (err: any) {
      failed.push(fullPath);
      errors.push(`Failed to remove abandoned staging file "${fullPath}": ${err.message}`);
    }
  }

  return { cleaned, failed, errors };
}
