import { describe, it, expect } from 'vitest';
import {
  prisma,
  resolveApplicationConnectionString,
  assertSafeTestDatabaseIdentity,
  LiveDbIdentity,
} from '../src/config/database';
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

  // --- Strict TARGET_DATABASE_URL & Environment Isolation Regression Tests ---

  it('should prove that TARGET_DATABASE_URL cannot override normal application connections', () => {
    const originalTarget = process.env.TARGET_DATABASE_URL;
    try {
      process.env.TARGET_DATABASE_URL = 'postgresql://attacker:pass@malicious.host:5432/hijacked_db';
      const resolved = resolveApplicationConnectionString({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://cinetrack_user:pass@db.internal:5432/cinetrack?schema=public',
      });
      expect(resolved).toBe('postgresql://cinetrack_user:pass@db.internal:5432/cinetrack?schema=public');
      expect(resolved).not.toContain('hijacked_db');
    } finally {
      if (originalTarget) {
        process.env.TARGET_DATABASE_URL = originalTarget;
      } else {
        delete process.env.TARGET_DATABASE_URL;
      }
    }
  });

  it('should prove that test mode cannot connect using DATABASE_URL as a fallback', () => {
    expect(() =>
      resolveApplicationConnectionString({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/cinetrack',
        TEST_DATABASE_URL: '',
      })
    ).toThrow(/TEST_DATABASE_URL is strictly required in test mode.*Fallback to DATABASE_URL is disabled/);
  });

  it('should fail safely when TEST_DATABASE_URL is undefined or missing', () => {
    expect(() =>
      resolveApplicationConnectionString({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/cinetrack',
      })
    ).toThrow(/TEST_DATABASE_URL is strictly required in test mode/);
  });

  it('should fail safely when test database name does not match approved test allowlist', () => {
    expect(() =>
      resolveApplicationConnectionString({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/cinetrack',
        TEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/unauthorized_user_db',
        EXPECTED_TEST_DATABASE_NAME: 'cinetrack_test',
      })
    ).toThrow(/is not on the immutable allowlist of approved test databases/);
  });

  it('should fail safely when test mode is pointed to production database cinetrack', () => {
    expect(() =>
      resolveApplicationConnectionString({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/cinetrack',
        TEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/cinetrack',
        EXPECTED_TEST_DATABASE_NAME: 'cinetrack', // Even if someone maliciously set expected name to cinetrack!
      })
    ).toThrow(/appears to be a production database/);
  });

  it('should fail safely when production mode is accidentally configured with a test database', () => {
    expect(() =>
      resolveApplicationConnectionString({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/cinetrack_test',
      })
    ).toThrow(/Production mode cannot connect to a test database/);
  });

  it('should reject unexpected database servers in assertSafeTestDatabaseIdentity', () => {
    const fakeIdentity: LiveDbIdentity = {
      db_name: 'cinetrack_test',
      user_name: 'cinetrack',
      server_ip: '198.51.100.24', // Non-loopback IP for localhost URL
      server_port: 5432,
      pg_version: 'PostgreSQL 18.6',
    };

    expect(() =>
      assertSafeTestDatabaseIdentity(
        fakeIdentity,
        'postgresql://cinetrack:pass@localhost:5432/cinetrack_test'
      )
    ).toThrow(/Expected local loopback server, but connected to server IP "198.51.100.24"/);
  });

  it('should reject unapproved remote hosts in assertSafeTestDatabaseIdentity', () => {
    const remoteIdentity: LiveDbIdentity = {
      db_name: 'cinetrack_test',
      user_name: 'cinetrack',
      server_ip: '203.0.113.50',
      server_port: 5432,
      pg_version: 'PostgreSQL 18.6',
    };

    expect(() =>
      assertSafeTestDatabaseIdentity(
        remoteIdentity,
        'postgresql://cinetrack:pass@untrusted-external-host.com:5432/cinetrack_test'
      )
    ).toThrow(/Test database host "untrusted-external-host.com" is not in approved test hosts list/);
  });

  it('should reject production database name in live database identity', () => {
    const prodIdentity: LiveDbIdentity = {
      db_name: 'cinetrack',
      user_name: 'cinetrack',
      server_ip: '127.0.0.1',
      server_port: 5432,
      pg_version: 'PostgreSQL 18.6',
    };

    expect(() =>
      assertSafeTestDatabaseIdentity(
        prodIdentity,
        'postgresql://cinetrack:pass@localhost:5432/cinetrack'
      )
    ).toThrow(/is NOT on the immutable allowlist of approved test databases/);
  });

  it('should prove that EXPECTED_TEST_DATABASE_NAME cannot expand the immutable allowlist in connection resolution', () => {
    expect(() =>
      resolveApplicationConnectionString({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/cinetrack',
        TEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/unauthorized_user_db',
        EXPECTED_TEST_DATABASE_NAME: 'unauthorized_user_db', // Attacker / operator sets expected name to match
      })
    ).toThrow(/is not on the immutable allowlist of approved test databases/);
  });

  it('should prove that EXPECTED_TEST_DATABASE_NAME cannot expand the immutable allowlist in live identity verification', () => {
    const originalExpected = process.env.EXPECTED_TEST_DATABASE_NAME;
    try {
      process.env.EXPECTED_TEST_DATABASE_NAME = 'malicious_prod_target';
      const fakeIdentity: LiveDbIdentity = {
        db_name: 'malicious_prod_target',
        user_name: 'cinetrack',
        server_ip: '127.0.0.1',
        server_port: 5432,
        pg_version: 'PostgreSQL 18.6',
      };

      expect(() =>
        assertSafeTestDatabaseIdentity(
          fakeIdentity,
          'postgresql://cinetrack:pass@localhost:5432/malicious_prod_target'
        )
      ).toThrow(/is NOT on the immutable allowlist of approved test databases/);
    } finally {
      if (originalExpected !== undefined) {
        process.env.EXPECTED_TEST_DATABASE_NAME = originalExpected;
      } else {
        delete process.env.EXPECTED_TEST_DATABASE_NAME;
      }
    }
  });

  it('should prove that TEST_APPROVED_HOSTS cannot expand the immutable host allowlist', () => {
    const originalHosts = process.env.TEST_APPROVED_HOSTS;
    try {
      process.env.TEST_APPROVED_HOSTS = 'remote-untrusted-host.internal,evil.com';
      const remoteIdentity: LiveDbIdentity = {
        db_name: 'cinetrack_test',
        user_name: 'cinetrack',
        server_ip: '10.0.0.99',
        server_port: 5432,
        pg_version: 'PostgreSQL 18.6',
      };

      expect(() =>
        assertSafeTestDatabaseIdentity(
          remoteIdentity,
          'postgresql://cinetrack:pass@remote-untrusted-host.internal:5432/cinetrack_test'
        )
      ).toThrow(/is not in approved test hosts list/);
    } finally {
      if (originalHosts !== undefined) {
        process.env.TEST_APPROVED_HOSTS = originalHosts;
      } else {
        delete process.env.TEST_APPROVED_HOSTS;
      }
    }
  });

  it('should fail closed when server identity is null, empty, or unverified', () => {
    expect(() =>
      assertSafeTestDatabaseIdentity(
        null as any,
        'postgresql://cinetrack:pass@localhost:5432/cinetrack_test'
      )
    ).toThrow(/Inability to verify server database identity/);

    expect(() =>
      assertSafeTestDatabaseIdentity(
        { db_name: '', user_name: '', server_ip: null, server_port: null, pg_version: '' },
        'postgresql://cinetrack:pass@localhost:5432/cinetrack_test'
      )
    ).toThrow(/Inability to verify server database identity/);
  });
});
