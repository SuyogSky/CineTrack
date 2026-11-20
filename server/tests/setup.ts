import { beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma, disconnectDatabase } from '../src/config/database';

beforeAll(async () => {
  await prisma.$connect();
  // Fail-safe check: verify active database is indeed the exact test database
  const result = await prisma.$queryRawUnsafe<Array<{ current_database: string }>>(
    'SELECT current_database();'
  );
  const currentDb = result[0]?.current_database || '';
  const expectedDb = (process.env.EXPECTED_TEST_DATABASE_NAME || 'cinetrack_test').toLowerCase();

  if (currentDb.toLowerCase() !== expectedDb) {
    throw new Error(
      `CRITICAL SAFETY CHECK FAILED: Connected to database "${currentDb}" which does NOT match expected test database "${expectedDb}". Refusing to run tests against non-test database!`
    );
  }
});

beforeEach(async () => {
  // Clean up database tables in order of dependencies
  await prisma.session.deleteMany();
  await prisma.collaborationInvitation.deleteMany();
  await prisma.collectionMovie.deleteMany();
  await prisma.collectionMember.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.user.deleteMany();
  await prisma.movie.deleteMany();
});

afterAll(async () => {
  await disconnectDatabase();
});
