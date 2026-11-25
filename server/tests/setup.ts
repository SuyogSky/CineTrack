import { beforeAll, afterAll, beforeEach } from 'vitest';
import {
  prisma,
  disconnectDatabase,
  assertSafeTestDatabaseIdentity,
  LiveDbIdentity,
} from '../src/config/database';
import { env } from '../src/config/env';

let verifiedSafeTestConnection = false;

beforeAll(async () => {
  // 1. Strict NODE_ENV check
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `CRITICAL SAFETY CHECK FAILED: NODE_ENV is "${process.env.NODE_ENV}" (must be "test"). Refusing to run tests!`
    );
  }

  // 2. Strict TEST_DATABASE_URL check
  if (!env.TEST_DATABASE_URL) {
    throw new Error(
      'CRITICAL SAFETY CHECK FAILED: TEST_DATABASE_URL is not set. Refusing to run tests!'
    );
  }

  await prisma.$connect();

  // 3. Live PostgreSQL connection identity inspection
  const identityRows = await prisma.$queryRawUnsafe<LiveDbIdentity[]>(`
    SELECT 
      current_database() AS db_name, 
      current_user AS user_name, 
      inet_server_addr()::text AS server_ip, 
      inet_server_port() AS server_port, 
      version() AS pg_version;
  `);

  if (!identityRows || identityRows.length === 0) {
    throw new Error('CRITICAL SAFETY CHECK FAILED: Failed to query PostgreSQL connection identity!');
  }

  assertSafeTestDatabaseIdentity(identityRows[0], env.TEST_DATABASE_URL);
  verifiedSafeTestConnection = true;
});

beforeEach(async () => {
  if (!verifiedSafeTestConnection) {
    throw new Error(
      'CRITICAL SAFETY CHECK FAILED: Database connection safety verification not satisfied. Prohibiting table cleanup!'
    );
  }

  // Clean up database tables in order of dependencies
  await prisma.session.deleteMany();
  await prisma.collaborationInvitation.deleteMany();
  await prisma.userMovieWatchStatus.deleteMany();
  await prisma.collectionMovie.deleteMany();
  await prisma.collectionMember.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.user.deleteMany();
  await prisma.movie.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});
