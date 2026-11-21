import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { env, extractDatabaseName, sanitizeDatabaseUrl } from './env';

export { extractDatabaseName, sanitizeDatabaseUrl };

function getConnectionString(): string {
  if (process.env.TARGET_DATABASE_URL) {
    return process.env.TARGET_DATABASE_URL;
  }
  if (env.NODE_ENV === 'test') {
    if (!env.TEST_DATABASE_URL) {
      throw new Error(
        'FATAL: TEST_DATABASE_URL is strictly required in test mode. Fallback to DATABASE_URL is disabled for data safety.'
      );
    }
    const dbName = extractDatabaseName(env.TEST_DATABASE_URL);
    const expected = (env.EXPECTED_TEST_DATABASE_NAME || 'cinetrack_test').toLowerCase();

    if (dbName.toLowerCase() !== expected) {
      const sanitized = sanitizeDatabaseUrl(env.TEST_DATABASE_URL);
      throw new Error(
        `FATAL: Test database name "${dbName}" does not match expected test database "${expected}". Refusing to connect to: ${sanitized}`
      );
    }
    return env.TEST_DATABASE_URL;
  }
  return env.DATABASE_URL;
}

const connectionString = getConnectionString();

export const pool = new Pool({
  connectionString,
  max: env.NODE_ENV === 'test' ? 5 : 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  await pool.end();
}
