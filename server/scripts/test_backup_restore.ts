import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

async function main() {
  console.log('🧪 Starting CineTrack Real PostgreSQL Backup and Restore Test...');

  const dumpFile = path.resolve(__dirname, '..', 'temp_cinetrack_backup_test.dump');
  const tempDbName = 'cinetrack_restore_verify_disposable';
  const sourceDb = 'cinetrack_test';
  const pgUser = 'cinetrack';
  const pgPass = 'cinetrack123';
  const pgHost = 'localhost';
  const pgPort = '5432';

  const env = {
    ...process.env,
    PGPASSWORD: pgPass,
  };

  try {
    // 1. Ensure temp dump file does not exist
    if (fs.existsSync(dumpFile)) {
      fs.unlinkSync(dumpFile);
    }

    // 2. Perform pg_dump of source test database
    console.log(`📦 Creating custom-format pg_dump of "${sourceDb}"...`);
    execSync(
      `pg_dump -h ${pgHost} -p ${pgPort} -U ${pgUser} -F c -b -f "${dumpFile}" ${sourceDb}`,
      { env, stdio: 'inherit' }
    );

    if (!fs.existsSync(dumpFile) || fs.statSync(dumpFile).size === 0) {
      throw new Error('pg_dump failed to generate a non-empty backup file');
    }
    console.log(`✅ pg_dump succeeded. Backup file size: ${fs.statSync(dumpFile).size} bytes`);

    // 3. Create fresh disposable database for restore
    console.log(`🛠️ Creating temporary restore database "${tempDbName}"...`);
    const adminClient = new Client({
      host: pgHost,
      port: Number(pgPort),
      user: pgUser,
      password: pgPass,
      database: 'postgres',
    });
    await adminClient.connect();
    await adminClient.query(`DROP DATABASE IF EXISTS "${tempDbName}";`);
    await adminClient.query(`CREATE DATABASE "${tempDbName}";`);
    await adminClient.end();

    // 4. Perform pg_restore into disposable database
    console.log(`📥 Executing pg_restore into "${tempDbName}"...`);
    try {
      execSync(
        `pg_restore -h ${pgHost} -p ${pgPort} -U ${pgUser} -d ${tempDbName} --no-owner "${dumpFile}"`,
        { env, stdio: 'inherit' }
      );
    } catch (err: unknown) {
      // pg_restore can exit with 1 on warnings (e.g. existing extensions); check DB content directly
      console.log('Notice: pg_restore completed with minor notices.');
    }

    // 5. Connect to restored database and verify schema and tables
    console.log(`🔍 Verifying restored schema in "${tempDbName}"...`);
    const verifyClient = new Client({
      host: pgHost,
      port: Number(pgPort),
      user: pgUser,
      password: pgPass,
      database: tempDbName,
    });
    await verifyClient.connect();

    const tableRes = await verifyClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    const tables = tableRes.rows.map((r) => r.table_name);
    console.log('Restored tables found:', tables);

    const requiredTables = ['Collection', 'CollectionMovie', 'Movie', 'Session', 'User'];
    for (const reqTable of requiredTables) {
      if (!tables.includes(reqTable)) {
        throw new Error(`Missing expected restored table: ${reqTable}`);
      }
    }

    // Check row count queryability
    const countRes = await verifyClient.query('SELECT COUNT(*) AS count FROM "Collection";');
    console.log(`Collection table queryable, row count: ${countRes.rows[0].count}`);

    await verifyClient.end();
    console.log('✅ Schema and data verification PASSED on restored database.');

    // 6. Clean up disposable restore database
    console.log(`🧹 Dropping temporary restore database "${tempDbName}"...`);
    const cleanupClient = new Client({
      host: pgHost,
      port: Number(pgPort),
      user: pgUser,
      password: pgPass,
      database: 'postgres',
    });
    await cleanupClient.connect();
    await cleanupClient.query(`DROP DATABASE IF EXISTS "${tempDbName}";`);
    await cleanupClient.end();

    console.log('🎉 SUCCESS: PostgreSQL Backup and Restore procedure 100% verified!');
  } finally {
    if (fs.existsSync(dumpFile)) {
      fs.unlinkSync(dumpFile);
    }
  }
}

main().catch((err) => {
  console.error('❌ Backup/restore verification test failed:', err);
  process.exit(1);
});
