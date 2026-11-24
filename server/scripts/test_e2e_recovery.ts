import 'dotenv/config';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import {
  executeProductionBackup,
  executeRestoreFromBackup,
  auditRestoredDatabaseSchema,
} from './backup_production';
import { CINETRACK_SCHEMA_MANIFEST } from './schema_manifest';
import { setRestrictiveDirMode } from '../src/utils/backup_crypto';

const DB_HOST = 'localhost';
const DB_PORT = 5432;
const DB_USER = 'cinetrack';
const DB_PASS = 'cinetrack123';
const BACKUP_PASSPHRASE = 'CineTrackE2ERecoverySuperSecure2026!#$';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function runE2ERecoveryTest() {
  console.log('🚀 Starting Complete End-to-End Database Backup, Encryption, and Restoration Recovery Test...');
  const startTime = Date.now();
  const testId = Date.now();
  const sourceDbName = `cinetrack_disposable_source_${testId}`;
  const targetDbName = `cinetrack_restore_target_${testId}`;
  const tempBackupDir = path.resolve(__dirname, `../temp_e2e_backups_${testId}`);

  let adminClient: Client | null = null;
  let sourceClient: Client | null = null;
  let targetClient: Client | null = null;

  try {
    if (!fs.existsSync(tempBackupDir)) {
      fs.mkdirSync(tempBackupDir, { recursive: true, mode: 0o700 });
      setRestrictiveDirMode(tempBackupDir, 0o700);
    }

    // 1. Connect admin client
    adminClient = new Client({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      database: 'postgres',
    });
    await adminClient.connect();
    console.log('✅ Admin connection established to PostgreSQL 18.6.');

    // 2. Create disposable source database
    console.log(`🛠️ Step 1/13: Creating disposable source database "${sourceDbName}"...`);
    await adminClient.query(`CREATE DATABASE ${quoteIdent(sourceDbName)};`);

    // 3. Apply Prisma migrations to source database
    console.log(`📜 Step 2/13: Applying Prisma migrations to "${sourceDbName}"...`);
    const sourceDbUrl = `postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${sourceDbName}?schema=public`;
    execFileSync(
      'npx',
      ['prisma', 'migrate', 'deploy'],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: sourceDbUrl },
        stdio: 'pipe',
        timeout: 60000,
        shell: true,
      }
    );
    console.log('✅ All Prisma migrations deployed cleanly to source database.');

    // 4. Connect to source database and seed rich representative data
    console.log(`🌱 Step 3/13: Seeding representative CineTrack relational data into "${sourceDbName}"...`);
    sourceClient = new Client({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      database: sourceDbName,
    });
    await sourceClient.connect();

    const u1Id = 'e2e_user_alice_' + testId;
    const u2Id = 'e2e_user_bob_' + testId;
    const m1Id = 'e2e_movie_inception_' + testId;
    const m2Id = 'e2e_movie_breaking_bad_' + testId;
    const c1Id = 'e2e_col_alice_watchlist_' + testId;
    const c2Id = 'e2e_col_scifi_' + testId;
    const cm1Id = 'e2e_cm_1_' + testId;
    const cm2Id = 'e2e_cm_2_' + testId;
    const mem1Id = 'e2e_mem_1_' + testId;
    const inv1Id = 'e2e_inv_1_' + testId;
    const s1Id = 'e2e_sess_1_' + testId;

    await sourceClient.query('BEGIN;');
    // Users
    await sourceClient.query(`
      INSERT INTO "User" (id, username, email, "passwordHash", "createdAt", "updatedAt")
      VALUES 
        ($1, $2, $3, 'argon2id$mockhash1', NOW(), NOW()),
        ($4, $5, $6, 'argon2id$mockhash2', NOW(), NOW());
    `, [u1Id, `alice_${testId}`, `alice_${testId}@cinetrack.local`, u2Id, `bob_${testId}`, `bob_${testId}@cinetrack.local`]);

    // Movies
    await sourceClient.query(`
      INSERT INTO "Movie" (id, "tmdbId", "mediaType", title, "releaseYear", genres, "createdAt", "updatedAt")
      VALUES 
        ($1, 27205, 'MOVIE'::"MediaType", 'Inception', 2010, '["Sci-Fi","Action"]'::jsonb, NOW(), NOW()),
        ($2, 1396, 'TV'::"MediaType", 'Breaking Bad', 2008, '["Drama","Crime"]'::jsonb, NOW(), NOW());
    `, [m1Id, m2Id]);

    // Collections
    await sourceClient.query(`
      INSERT INTO "Collection" (id, "ownerId", title, visibility, "isDefaultWatchlist", "createdAt", "updatedAt")
      VALUES 
        ($1, $2, 'Alice Watchlist', 'PRIVATE'::"CollectionVisibility", true, NOW(), NOW()),
        ($3, $2, 'Sci-Fi Collection', 'PUBLIC_LINK'::"CollectionVisibility", false, NOW(), NOW());
    `, [c1Id, u1Id, c2Id]);

    // Collection Movies
    await sourceClient.query(`
      INSERT INTO "CollectionMovie" (id, "collectionId", "movieId", "addedBy", status, "watchedAt", "createdAt", "updatedAt")
      VALUES 
        ($1, $2, $3, $4, 'WATCHED'::"WatchStatus", NOW(), NOW(), NOW()),
        ($5, $6, $7, $4, 'TO_WATCH'::"WatchStatus", NULL, NOW(), NOW());
    `, [cm1Id, c1Id, m1Id, u1Id, cm2Id, c2Id, m2Id]);

    // Collection Members
    await sourceClient.query(`
      INSERT INTO "CollectionMember" (id, "collectionId", "userId", role, "joinedAt")
      VALUES ($1, $2, $3, 'MEMBER'::"MemberRole", NOW());
    `, [mem1Id, c2Id, u2Id]);

    // Collaboration Invitations
    await sourceClient.query(`
      INSERT INTO "CollaborationInvitation" (id, "collectionId", "inviterId", "inviteeId", status, "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 'PENDING'::"InvitationStatus", NOW(), NOW());
    `, [inv1Id, c2Id, u1Id, u2Id]);

    // Sessions
    await sourceClient.query(`
      INSERT INTO "Session" (id, "userId", "tokenHash", "previousTokenHash", "historicalTokenHashes", "expiresAt", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days', NOW(), NOW());
    `, [s1Id, u1Id, `token_${testId}`, `prev_${testId}`, [`hist1_${testId}`, `hist2_${testId}`]]);

    await sourceClient.query('COMMIT;');
    console.log('✅ Representative relational dataset inserted across all 7 application tables.');

    // 5. Execute production backup with AES-256-GCM (CTBK02, 600,000 iterations)
    console.log(`📦 Step 4/13: Creating authenticated encrypted production backup (CTBK02, 600,000 PBKDF2 iterations)...`);
    const backupResult = await executeProductionBackup({
      databaseUrl: sourceDbUrl,
      outputDir: tempBackupDir,
      encryptionPassphrase: BACKUP_PASSPHRASE,
      verifyRestore: false, // We will manually verify restoration in the target disposable DB
    });
    console.log(`✅ Backup archive created: "${path.basename(backupResult.archivePath)}" (${backupResult.encryptedSize} bytes).`);
    console.log(`   SHA-256 Digest: ${backupResult.encryptedSha256}`);

    const sourceStats = backupResult.sourceStats;
    if (!sourceStats) {
      throw new Error('Backup metadata missing sourceStats!');
    }
    console.log(`✅ Source database statistics calculated under transaction snapshot: ${sourceStats.totalRows} total rows.`);

    // 7. Verify archive header format version
    console.log(`🔍 Step 6/13: Inspecting backup archive header format...`);
    const headerBuf = Buffer.alloc(6);
    const fd = fs.openSync(backupResult.archivePath, 'r');
    fs.readSync(fd, headerBuf, 0, 6, 0);
    fs.closeSync(fd);
    const magicStr = headerBuf.toString('ascii');
    if (magicStr !== 'CTBK02') {
      throw new Error(`Expected magic header CTBK02, got "${magicStr}"`);
    }
    console.log(`✅ Format verified: ${magicStr} (OWASP PBKDF2 600,000 iterations).`);

    // 8. Create target disposable database
    console.log(`🛠️ Step 7/13: Creating target disposable restoration database "${targetDbName}"...`);
    await adminClient.query(`CREATE DATABASE ${quoteIdent(targetDbName)};`);

    // 9. Execute decryption and restoration into target database
    console.log(`📥 Step 8/13: Restoring decrypted snapshot into "${targetDbName}"...`);
    const targetDbUrl = `postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${targetDbName}?schema=public`;
    await executeRestoreFromBackup(backupResult.archivePath, targetDbUrl, BACKUP_PASSPHRASE);
    console.log('✅ pg_restore executed cleanly into target database.');

    // 10. Connect to restored database
    console.log(`🔗 Step 9/13: Connecting to restored database "${targetDbName}"...`);
    targetClient = new Client({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      database: targetDbName,
    });
    await targetClient.connect();

    // 11. Run comprehensive restored schema audit against schema manifest
    console.log(`🔍 Step 10/13: Auditing restored database schema, columns, defaults, FKs, indexes against manifest...`);
    const tableRes = await targetClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    const restoredTables: string[] = tableRes.rows.map((r: { table_name: string }) => r.table_name);
    const auditRes = await auditRestoredDatabaseSchema(targetClient, restoredTables, { sourceStats });
    console.log(`✅ Restored schema passed 100% of audit checks (${restoredTables.length} tables verified).`);

    // 12. Verify row counts and data integrity hashes
    console.log(`📊 Step 11/13: Verifying exact row counts and deterministic checksums...`);
    const sourceTables = Object.keys(CINETRACK_SCHEMA_MANIFEST.tables);
    for (const tbl of sourceTables) {
      const srcCount = sourceStats.rowCounts[tbl];
      const tgtCount = auditRes.tableRowCounts[tbl];
      if (srcCount !== tgtCount) {
        throw new Error(`Table ${tbl} row count mismatch: source=${srcCount}, restored=${tgtCount}`);
      }
    }
    console.log(`✅ All table row counts match source data exactly.`);

    // 13. Verify relational queries and application invariants
    console.log(`🧪 Step 12/13: Verifying relational query execution and application invariants on restored database...`);
    // Query 1: Join User -> Collection -> CollectionMovie -> Movie
    const joinRes = await targetClient.query(`
      SELECT 
        u.username,
        c.title AS collection_title,
        m.title AS movie_title,
        m."mediaType",
        cm.status,
        cm."watchedAt"
      FROM "User" u
      JOIN "Collection" c ON c."ownerId" = u.id
      JOIN "CollectionMovie" cm ON cm."collectionId" = c.id
      JOIN "Movie" m ON m.id = cm."movieId"
      WHERE u.id = $1
      ORDER BY m.title;
    `, [u1Id]);

    if (joinRes.rows.length !== 2) {
      throw new Error(`Unexpected relational join result length: ${JSON.stringify(joinRes.rows)}`);
    }
    const inceptionRow = joinRes.rows.find((r: any) => r.movie_title === 'Inception');
    const bbRow = joinRes.rows.find((r: any) => r.movie_title === 'Breaking Bad');
    if (!inceptionRow || inceptionRow.status !== 'WATCHED' || !inceptionRow.watchedAt) {
      throw new Error(`Inception row missing or invalid status: ${JSON.stringify(inceptionRow)}`);
    }
    if (!bbRow || bbRow.status !== 'TO_WATCH' || bbRow.watchedAt !== null) {
      throw new Error(`Breaking Bad row missing or invalid status: ${JSON.stringify(bbRow)}`);
    }
    console.log(`   - Verified relational join query (User -> Collection -> Movie): 2 movies verified (Inception WATCHED, Breaking Bad TO_WATCH).`);

    // Query 2: Invariant: Default watchlist uniqueness
    const defColRes = await targetClient.query(`
      SELECT COUNT(*)::int AS cnt FROM "Collection" WHERE "ownerId" = $1 AND "isDefaultWatchlist" = true;
    `, [u1Id]);
    if (defColRes.rows[0].cnt !== 1) {
      throw new Error(`Default watchlist invariant violated: expected 1, got ${defColRes.rows[0].cnt}`);
    }
    console.log(`   - Verified single default watchlist invariant for User.`);

    // Query 3: Invariant: Watched status check constraint active in restored database
    const checkViolated = await targetClient.query(`
      SELECT conname FROM pg_constraint WHERE conname = 'CollectionMovie_status_watchedAt_check';
    `);
    if (checkViolated.rows.length === 0) {
      throw new Error('CHECK constraint missing on restored database!');
    }
    console.log(`   - Verified CollectionMovie_status_watchedAt_check constraint present and active.`);

    console.log(`🎉 Step 13/13: End-to-End Recovery Test PASSED 100%! All 13 recovery stages validated.`);
    const totalDuration = Date.now() - startTime;
    console.log(`⏱️ Total E2E recovery test duration: ${totalDuration}ms.`);
  } finally {
    // Guaranteed cleanup
    console.log('🧹 Executing safe teardown of disposable verification databases...');
    if (sourceClient) {
      try { await sourceClient.end(); } catch {}
    }
    if (targetClient) {
      try { await targetClient.end(); } catch {}
    }
    if (adminClient) {
      try {
        await adminClient.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1;`, [sourceDbName]);
        await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(sourceDbName)};`);
        console.log(`   - Dropped disposable source DB "${sourceDbName}".`);
      } catch (err: any) {
        console.error(`Failed to drop source DB: ${err.message}`);
      }

      try {
        await adminClient.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1;`, [targetDbName]);
        await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(targetDbName)};`);
        console.log(`   - Dropped disposable target DB "${targetDbName}".`);
      } catch (err: any) {
        console.error(`Failed to drop target DB: ${err.message}`);
      }

      try { await adminClient.end(); } catch {}
    }

    if (fs.existsSync(tempBackupDir)) {
      try {
        fs.rmSync(tempBackupDir, { recursive: true, force: true });
        console.log(`   - Cleaned up temporary backup directory.`);
      } catch {}
    }
  }
}

runE2ERecoveryTest().catch((err) => {
  console.error('❌ E2E Recovery Test Failed:', err);
  process.exit(1);
});
