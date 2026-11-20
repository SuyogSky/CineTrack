import { describe, it, expect } from 'vitest';
import { prisma } from '../src/config/database';
import { env, extractDatabaseName, sanitizeDatabaseUrl } from '../src/config/env';

describe('P0 Fail-Safe Test Database Isolation Tests', () => {
  it('should enforce that NODE_ENV is test and TEST_DATABASE_URL is active', () => {
    expect(env.NODE_ENV).toBe('test');
    expect(env.TEST_DATABASE_URL).toBeDefined();
    expect(extractDatabaseName(env.TEST_DATABASE_URL!)).toBe('cinetrack_test');
  });

  it('should verify live PostgreSQL connection is strictly connected to exact cinetrack_test database', async () => {
    const result = await prisma.$queryRawUnsafe<Array<{ current_database: string }>>(
      'SELECT current_database();'
    );
    expect(result.length).toBeGreaterThan(0);
    const dbName = result[0].current_database.toLowerCase();
    expect(dbName).toBe('cinetrack_test');
    expect(dbName).not.toBe('cinetrack'); // Must never be production database
  });

  it('should reject substring matching tricks like contest_prod', () => {
    const trickUrl = 'postgresql://user:pass@localhost:5432/contest_prod?schema=public';
    const dbName = extractDatabaseName(trickUrl);
    expect(dbName).toBe('contest_prod');
    // Substring .includes('test') would wrongly match contest_prod, but exact match rejects it:
    const expected = (env.EXPECTED_TEST_DATABASE_NAME || 'cinetrack_test').toLowerCase();
    expect(dbName.toLowerCase() === expected).toBe(false);
  });

  it('should sanitize credentials from database URLs in error messages and logs', () => {
    const secretUrl = 'postgresql://admin_user:SuperSecretPassword123!@db.internal:5432/cinetrack_test?schema=public';
    const sanitized = sanitizeDatabaseUrl(secretUrl);

    expect(sanitized).not.toContain('SuperSecretPassword123!');
    expect(sanitized).toContain('***');
    expect(sanitized).toContain('cinetrack_test');
  });

  it('should accurately extract database name regardless of query parameters and port', () => {
    expect(extractDatabaseName('postgresql://localhost/cinetrack_test')).toBe('cinetrack_test');
    expect(extractDatabaseName('postgresql://usr:pwd@127.0.0.1:5433/cinetrack_test?sslmode=disable')).toBe('cinetrack_test');
    expect(extractDatabaseName('postgresql://usr:pwd@127.0.0.1:5433/prod_db?sslmode=require')).toBe('prod_db');
  });
});
