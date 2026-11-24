import { describe, it, expect } from 'vitest';
import { assertSeedAllowed, ALLOWED_SEED_DATABASES, DEFAULT_ALLOWED_SEED_HOSTS } from '../prisma/seed';

describe('CineTrack Seed Safety & Identity Protection Tests', () => {
  it('1. should reject production database "cinetrack" when NODE_ENV=production', () => {
    expect(() => assertSeedAllowed('cinetrack', 'production', 'true', 0)).toThrow(
      /FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production\/root database "cinetrack"/
    );
  });

  it('2. should reject production database "cinetrack" even when NODE_ENV=development and ALLOW_DEMO_SEED=true', () => {
    expect(() => assertSeedAllowed('cinetrack', 'development', 'true', 0)).toThrow(
      /FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production\/root database "cinetrack"/
    );
  });

  it('3. should reject database containing "prod" keyword regardless of NODE_ENV', () => {
    expect(() => assertSeedAllowed('cinetrack_prod', 'development', 'true', 0)).toThrow(
      /FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production\/root database "cinetrack_prod"/
    );
    expect(() => assertSeedAllowed('my_production_db', 'development', 'true', 0)).toThrow(
      /FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production\/root database "my_production_db"/
    );
  });

  it('4. should reject database containing "live" keyword', () => {
    expect(() => assertSeedAllowed('cinetrack_live', 'development', 'true', 0)).toThrow(
      /FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production\/root database "cinetrack_live"/
    );
  });

  it('5. should reject database containing "main" keyword', () => {
    expect(() => assertSeedAllowed('cinetrack_main', 'development', 'true', 0)).toThrow(
      /FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production\/root database "cinetrack_main"/
    );
  });

  it('6. should reject system root database "postgres"', () => {
    expect(() => assertSeedAllowed('postgres', 'development', 'true', 0)).toThrow(
      /FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production\/root database "postgres"/
    );
  });

  it('7. should reject when NODE_ENV is production even if database name looks harmless', () => {
    expect(() => assertSeedAllowed('cinetrack_dev', 'production', 'true', 0)).toThrow(
      /FATAL SECURITY REJECTION: Database seeding is strictly forbidden in production mode/
    );
  });

  it('8. should reject by default when ALLOW_DEMO_SEED is unset or undefined', () => {
    expect(() => assertSeedAllowed('cinetrack_dev', 'development', undefined, 0)).toThrow(
      /Database seeding is disabled by default. Set ALLOW_DEMO_SEED=true/
    );
  });

  it('9. should reject when ALLOW_DEMO_SEED is "false"', () => {
    expect(() => assertSeedAllowed('cinetrack_dev', 'development', 'false', 0)).toThrow(
      /Database seeding is disabled by default. Set ALLOW_DEMO_SEED=true/
    );
  });

  it('10. should reject arbitrary or unapproved database names not in ALLOWED_SEED_DATABASES', () => {
    expect(() => assertSeedAllowed('cinetrack_random', 'development', 'true', 0)).toThrow(
      /SECURITY REJECTION: Target database "cinetrack_random" is not on the list of approved development databases/
    );
  });

  it('11. should reject when real non-demo user accounts exist (nonDemoUserCount > 0)', () => {
    expect(() => assertSeedAllowed('cinetrack_dev', 'development', 'true', 1)).toThrow(
      /SECURITY REJECTION: Target database contains 1 real user account\(s\). Seeding aborted to protect existing data/
    );
    expect(() => assertSeedAllowed('cinetrack_dev', 'development', 'true', 5)).toThrow(
      /SECURITY REJECTION: Target database contains 5 real user account\(s\). Seeding aborted to protect existing data/
    );
  });

  it('12. should allow seeding on cinetrack_dev when NODE_ENV=development, ALLOW_DEMO_SEED=true, and nonDemoUserCount=0', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: '127.0.0.1',
        allowedHosts: ['127.0.0.1'],
      })
    ).not.toThrow();
  });

  it('13. should allow seeding on cinetrack_test and cinetrack_local when all security requirements are satisfied', () => {
    expect(() => assertSeedAllowed('cinetrack_test', 'test', 'true', 0, { host: 'localhost' })).not.toThrow();
    expect(() =>
      assertSeedAllowed('cinetrack_local', 'development', 'true', 0, {
        host: '::1',
        allowedHosts: ['::1'],
      })
    ).not.toThrow();
  });

  it('14. should accurately export the immutable ALLOWED_SEED_DATABASES list', () => {
    expect(ALLOWED_SEED_DATABASES).toEqual(['cinetrack_dev', 'cinetrack_test', 'cinetrack_local']);
  });

  it('15. should reject non-approved remote database host during seeding', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: '192.168.1.150',
        allowedHosts: ['127.0.0.1', 'localhost'],
      })
    ).toThrow(/FATAL SECURITY REJECTION: Database seeding is forbidden on non-approved host "192.168.1.150"/);
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: 'db.production.aws.internal',
        allowedHosts: ['127.0.0.1', 'localhost'],
      })
    ).toThrow(/FATAL SECURITY REJECTION: Database seeding is forbidden on non-approved host "db.production.aws.internal"/);
  });

  it('16. should allow approved local hosts (localhost, 127.0.0.1, ::1)', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: '127.0.0.1',
        allowedHosts: ['127.0.0.1'],
      })
    ).not.toThrow();
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: 'localhost',
        allowedHosts: ['localhost'],
      })
    ).not.toThrow();
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: '::1',
        allowedHosts: ['::1'],
      })
    ).not.toThrow();
  });

  it('17. should reject empty, null, or whitespace database name fail-closed', () => {
    expect(() => assertSeedAllowed('', 'development', 'true', 0, { host: '127.0.0.1' })).toThrow(
      /FATAL SECURITY REJECTION: Database identity could not be verified/
    );
    expect(() => assertSeedAllowed('   ', 'development', 'true', 0, { host: '127.0.0.1' })).toThrow(
      /FATAL SECURITY REJECTION: Database identity could not be verified/
    );
    expect(() => assertSeedAllowed(null as any, 'development', 'true', 0, { host: '127.0.0.1' })).toThrow(
      /FATAL SECURITY REJECTION: Database identity could not be verified/
    );
  });

  it('18. should accurately export the immutable DEFAULT_ALLOWED_SEED_HOSTS list', () => {
    expect(DEFAULT_ALLOWED_SEED_HOSTS).toEqual(['localhost', '127.0.0.1', '::1']);
  });

  // Priority 2 New Strict Fail-Closed Tests:
  it('19. should reject NULL server address fail-closed when no socket policy is active', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, { host: null })
    ).toThrow(/FATAL SECURITY REJECTION: Database server IP address is NULL or unavailable/);
  });

  it('20. should reject undefined or empty string server address fail-closed', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, { host: undefined })
    ).toThrow(/FATAL SECURITY REJECTION: Database server IP address is NULL or unavailable/);
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, { host: '   ' })
    ).toThrow(/FATAL SECURITY REJECTION: Database server IP address is NULL or unavailable/);
  });

  it('21. should reject when allowedHosts is explicitly configured as an empty array', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, { host: '127.0.0.1', allowedHosts: [] })
    ).toThrow(/FATAL SECURITY REJECTION: No trusted seed hosts configured/);
  });

  it('22. should permit local Unix socket transport ONLY when explicitly authorized by policy', () => {
    // Rejected if allowUnixSocket is false
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: null,
        allowUnixSocket: false,
        isUnixSocket: true,
      })
    ).toThrow(/FATAL SECURITY REJECTION: Database server IP address is NULL/);

    // Rejected if isUnixSocket is false
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: null,
        allowUnixSocket: true,
        isUnixSocket: false,
      })
    ).toThrow(/FATAL SECURITY REJECTION: Database server IP address is NULL/);

    // Permitted when both are true
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: null,
        allowUnixSocket: true,
        isUnixSocket: true,
      })
    ).not.toThrow();
  });

  it('23. should reject misleading environment variables attempting to bypass seed safety', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_prod', 'production', 'true', 0, {
        host: '127.0.0.1',
      })
    ).toThrow(/FATAL SECURITY REJECTION/);
  });

  it('24. should reject non-test seeding when allowedHosts is undefined (no explicit trusted host config)', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: '127.0.0.1',
        // allowedHosts omitted
      })
    ).toThrow(/FATAL SECURITY REJECTION: Explicit trusted seed-host configuration is required for non-test seeding/);
  });

  it('25. should reject remote database host even if in allowedHosts when allowRemoteSeed is false', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: '10.0.1.50',
        allowedHosts: ['10.0.1.50'],
        allowRemoteSeed: false,
      })
    ).toThrow(/FATAL SECURITY REJECTION: Remote database seeding is forbidden on host "10.0.1.50"/);
  });

  it('26. should allow remote database host in development when in allowedHosts AND allowRemoteSeed=true', () => {
    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'development', 'true', 0, {
        host: '10.0.1.50',
        allowedHosts: ['10.0.1.50'],
        allowRemoteSeed: true,
      })
    ).not.toThrow();
  });

  it('27. should reject remote database host even with allowRemoteSeed=true if NODE_ENV=production or db=cinetrack', () => {
    expect(() =>
      assertSeedAllowed('cinetrack', 'development', 'true', 0, {
        host: '10.0.1.50',
        allowedHosts: ['10.0.1.50'],
        allowRemoteSeed: true,
      })
    ).toThrow(/FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production\/root database "cinetrack"/);

    expect(() =>
      assertSeedAllowed('cinetrack_dev', 'production', 'true', 0, {
        host: '10.0.1.50',
        allowedHosts: ['10.0.1.50'],
        allowRemoteSeed: true,
      })
    ).toThrow(/FATAL SECURITY REJECTION: Database seeding is strictly forbidden in production mode/);
  });
});
