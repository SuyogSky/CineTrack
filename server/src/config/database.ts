import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { env, extractDatabaseName, sanitizeDatabaseUrl } from './env';

export { extractDatabaseName, sanitizeDatabaseUrl };

export interface DatabaseEnvironmentConfig {
  NODE_ENV: string;
  DATABASE_URL: string;
  TEST_DATABASE_URL?: string;
  EXPECTED_TEST_DATABASE_NAME?: string;
}

export const APPROVED_TEST_DATABASE_NAMES = ['cinetrack_test', 'cinetrack_ci', 'cinetrack_e2e'] as const;

export const APPROVED_TEST_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres'] as const;

export function resolveApplicationConnectionString(config: DatabaseEnvironmentConfig): string {
  // CRITICAL SAFETY RULE: Never allow TARGET_DATABASE_URL or any migration override
  // to dictate application connections. Normal runtime and tests resolve strictly
  // from their designated configuration variables.

  if (config.NODE_ENV === 'test') {
    if (!config.TEST_DATABASE_URL || config.TEST_DATABASE_URL.trim() === '') {
      throw new Error(
        'FATAL: TEST_DATABASE_URL is strictly required in test mode. Fallback to DATABASE_URL is disabled for data safety.'
      );
    }
    const dbName = extractDatabaseName(config.TEST_DATABASE_URL).toLowerCase();

    // 1. Strictly reject production database names even in test mode
    if (dbName === 'cinetrack' || dbName.includes('prod') || dbName.includes('live')) {
      const sanitized = sanitizeDatabaseUrl(config.TEST_DATABASE_URL);
      throw new Error(
        `FATAL: Test database name "${dbName}" appears to be a production database. Refusing to connect to: ${sanitized}`
      );
    }

    // 2. IMMUTABLE TEST DATABASE ALLOWLIST:
    // Approved test databases are strictly hardcoded in code. Environment variables cannot expand this list.
    const isApprovedTestDb = APPROVED_TEST_DATABASE_NAMES.includes(dbName as any);

    if (!isApprovedTestDb) {
      const sanitized = sanitizeDatabaseUrl(config.TEST_DATABASE_URL);
      throw new Error(
        `FATAL: Test database name "${dbName}" is not on the immutable allowlist of approved test databases [${APPROVED_TEST_DATABASE_NAMES.join(', ')}]. Refusing to connect to: ${sanitized}`
      );
    }

    // 3. If EXPECTED_TEST_DATABASE_NAME is configured, it must also be in the immutable allowlist and match dbName
    if (config.EXPECTED_TEST_DATABASE_NAME) {
      const expected = config.EXPECTED_TEST_DATABASE_NAME.toLowerCase().trim();
      if (!APPROVED_TEST_DATABASE_NAMES.includes(expected as any)) {
        throw new Error(
          `FATAL: Configured EXPECTED_TEST_DATABASE_NAME "${expected}" is not an approved test database. Environment variables cannot expand the test database allowlist.`
        );
      }
      if (dbName !== expected) {
        throw new Error(
          `FATAL: Test database name "${dbName}" does not match configured EXPECTED_TEST_DATABASE_NAME "${expected}".`
        );
      }
    }

    return config.TEST_DATABASE_URL;
  }

  // Production or Development runtime
  if (!config.DATABASE_URL || config.DATABASE_URL.trim() === '') {
    throw new Error('FATAL: DATABASE_URL is strictly required in production/development mode.');
  }

  // In production mode, reject accidental connections to test databases
  if (config.NODE_ENV === 'production') {
    const dbName = extractDatabaseName(config.DATABASE_URL).toLowerCase();
    if (
      APPROVED_TEST_DATABASE_NAMES.includes(dbName as any) ||
      dbName.includes('test') ||
      dbName.includes('disposable')
    ) {
      const sanitized = sanitizeDatabaseUrl(config.DATABASE_URL);
      throw new Error(
        `FATAL: Production mode cannot connect to a test database "${dbName}". Refusing to connect to: ${sanitized}`
      );
    }
  }

  return config.DATABASE_URL;
}

export interface LiveDbIdentity {
  db_name: string;
  user_name: string;
  server_ip: string | null;
  server_port: number | null;
  pg_version: string;
}

export function assertSafeTestDatabaseIdentity(
  identity: LiveDbIdentity,
  configuredUrl: string,
  approvedHosts: readonly string[] = APPROVED_TEST_HOSTS
): void {
  if (!identity || !identity.db_name) {
    throw new Error(
      'CRITICAL SAFETY CHECK FAILED: Inability to verify server database identity. Identity query returned empty result!'
    );
  }

  const currentDb = identity.db_name.toLowerCase().trim();

  // 1. Strict database name check against IMMUTABLE allowlist
  const isApproved = APPROVED_TEST_DATABASE_NAMES.includes(currentDb as any);

  if (!isApproved) {
    throw new Error(
      `CRITICAL SAFETY CHECK FAILED: Connected to database "${currentDb}" which is NOT on the immutable allowlist of approved test databases [${APPROVED_TEST_DATABASE_NAMES.join(', ')}]. Refusing to operate on non-test database!`
    );
  }

  // If EXPECTED_TEST_DATABASE_NAME is present, it must be in the immutable allowlist and match live database
  if (process.env.EXPECTED_TEST_DATABASE_NAME) {
    const expected = process.env.EXPECTED_TEST_DATABASE_NAME.toLowerCase().trim();
    if (!APPROVED_TEST_DATABASE_NAMES.includes(expected as any)) {
      throw new Error(
        `CRITICAL SAFETY CHECK FAILED: Configured EXPECTED_TEST_DATABASE_NAME "${expected}" is not an approved test database. Environment variables cannot expand the test database allowlist!`
      );
    }
    if (currentDb !== expected) {
      throw new Error(
        `CRITICAL SAFETY CHECK FAILED: Live connected database "${currentDb}" does not match configured EXPECTED_TEST_DATABASE_NAME "${expected}". Refusing test connection!`
      );
    }
  }

  if (currentDb === 'cinetrack' || currentDb.includes('prod') || currentDb.includes('live')) {
    throw new Error(
      `CRITICAL SAFETY CHECK FAILED: Database "${currentDb}" appears to be a production database. Refusing to perform test operations!`
    );
  }

  // 2. Strict host check against IMMUTABLE allowlist (Environment variables CANNOT expand approved hosts)
  try {
    const parsed = new URL(configuredUrl);
    const host = parsed.hostname.toLowerCase();
    const isApprovedHost = approvedHosts.includes(host);

    if (!isApprovedHost) {
      throw new Error(
        `CRITICAL SAFETY CHECK FAILED: Test database host "${host}" is not in approved test hosts list [${approvedHosts.join(', ')}]. Environment variables cannot expand approved test hosts. Refusing test connection!`
      );
    }

    // If configured as localhost, ensure connected server IP (if reported) is a loopback
    if (
      (host === 'localhost' || host === '127.0.0.1' || host === '::1') &&
      identity.server_ip
    ) {
      const cleanIp = identity.server_ip.split('/')[0].trim();
      const isLoopback = cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp.startsWith('127.');
      if (!isLoopback) {
        throw new Error(
          `CRITICAL SAFETY CHECK FAILED: Expected local loopback server, but connected to server IP "${identity.server_ip}". Refusing test connection!`
        );
      }
    }
  } catch (err: any) {
    if (err.message.startsWith('CRITICAL SAFETY CHECK')) {
      throw err;
    }
    throw new Error(`CRITICAL SAFETY CHECK FAILED: Invalid test database URL: ${err.message}`);
  }
}

const connectionString = resolveApplicationConnectionString(env);

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
