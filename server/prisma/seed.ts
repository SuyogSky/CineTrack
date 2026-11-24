import crypto from 'crypto';
import { prisma } from '../src/config/database';
import { hashPassword } from '../src/utils/password';
import { MovieService } from '../src/services/movie.service';
import { env, extractDatabaseName } from '../src/config/env';

export const ALLOWED_SEED_DATABASES = ['cinetrack_dev', 'cinetrack_test', 'cinetrack_local'] as const;
export const DEFAULT_ALLOWED_SEED_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

export interface SeedSafetyOptions {
  host?: string | null;
  allowedHosts?: string[];
  allowUnixSocket?: boolean;
  isUnixSocket?: boolean;
  allowRemoteSeed?: boolean;
}

/**
 * Validates whether database seeding is permitted under strict fail-closed security invariants.
 *
 * Enforced Security Rules:
 * 0. Host Verification (Fail-Closed):
 *    - A NULL or undefined server IP address is strictly rejected unless an explicit, verified
 *      Unix-domain socket transport policy is activated (allowUnixSocket=true and isUnixSocket=true).
 *    - In non-test environments, explicit trusted host configuration is required (no silent fallback).
 *    - Remote servers require explicit ALLOW_REMOTE_SEED=true even if listed in allowedHosts.
 *    - Production mode is strictly forbidden under all circumstances.
 * 1. Target Database Name Verification:
 *    - Must not contain production, live, or main keywords.
 *    - Must match an explicitly approved development database name ('cinetrack_dev', 'cinetrack_test', 'cinetrack_local').
 * 2. Environment Verification:
 *    - NODE_ENV === 'production' is strictly forbidden.
 * 3. Explicit Opt-In:
 *    - Mandatory ALLOW_DEMO_SEED=true is required.
 * 4. User Protection:
 *    - Seeding is aborted if existing non-demo user data is present.
 */
export function assertSeedAllowed(
  liveDbName: string,
  nodeEnv?: string,
  allowDemoSeed?: string,
  nonDemoUserCount: number = 0,
  options?: SeedSafetyOptions
): void {
  // Database name presence check
  if (!liveDbName || typeof liveDbName !== 'string' || liveDbName.trim() === '') {
    throw new Error('FATAL SECURITY REJECTION: Database identity could not be verified. Target database name is empty or missing.');
  }

  const dbLower = (liveDbName || '').toLowerCase().trim();

  // Rule 1: Reject production keywords anywhere in the database name
  const prodKeywords = ['cinetrack', 'prod', 'production', 'live', 'main', 'postgres', 'template0', 'template1'];
  if (
    dbLower === 'cinetrack' ||
    dbLower.includes('prod') ||
    dbLower.includes('production') ||
    dbLower.includes('live') ||
    dbLower.includes('main') ||
    dbLower === 'postgres'
  ) {
    throw new Error(
      `FATAL SECURITY REJECTION: Database seeding is strictly forbidden on production/root database "${liveDbName}" under all circumstances, regardless of NODE_ENV.`
    );
  }

  // Rule 2: Reject production mode
  const effectiveEnv = nodeEnv || process.env.NODE_ENV || env.NODE_ENV;
  if (effectiveEnv === 'production') {
    throw new Error('FATAL SECURITY REJECTION: Database seeding is strictly forbidden in production mode.');
  }

  // Rule 3: Mandatory explicit opt-in
  const effectiveOptIn = allowDemoSeed ?? process.env.ALLOW_DEMO_SEED;
  if (effectiveOptIn !== 'true') {
    throw new Error(
      'Database seeding is disabled by default. Set ALLOW_DEMO_SEED=true to intentionally seed development demo data.'
    );
  }

  // Rule 4: Must match an approved development database
  if (!ALLOWED_SEED_DATABASES.includes(dbLower as any)) {
    throw new Error(
      `SECURITY REJECTION: Target database "${liveDbName}" is not on the list of approved development databases [${ALLOWED_SEED_DATABASES.join(', ')}].`
    );
  }

  // Rule 5: Reject if real user accounts already exist
  if (nonDemoUserCount > 0) {
    throw new Error(
      `SECURITY REJECTION: Target database contains ${nonDemoUserCount} real user account(s). Seeding aborted to protect existing data from contamination.`
    );
  }

  // Rule 6: Host Identity Verification (Strict Fail-Closed)
  const hostVal = options?.host;
  const isNullHost = hostVal === undefined || hostVal === null || (typeof hostVal === 'string' && hostVal.trim() === '');

  if (isNullHost) {
    const isPermittedSocket = options?.allowUnixSocket === true && options?.isUnixSocket === true;
    if (!isPermittedSocket) {
      throw new Error(
        'FATAL SECURITY REJECTION: Database server IP address is NULL or unavailable. Host verification cannot be skipped (fail-closed). Configure explicit socket policy or connect via TCP loopback.'
      );
    }
  } else {
    // Host is provided: validate against trusted host list
    const allowedHosts = options?.allowedHosts;

    if (allowedHosts !== undefined && allowedHosts.length === 0) {
      throw new Error('FATAL SECURITY REJECTION: No trusted seed hosts configured. Seeding aborted.');
    }

    // In non-test mode, explicit trusted host configuration is required (no silent default fallback)
    if (effectiveEnv !== 'test') {
      if (allowedHosts === undefined) {
        throw new Error(
          'FATAL SECURITY REJECTION: Explicit trusted seed-host configuration is required for non-test seeding (SEED_ALLOWED_HOSTS). Permissive default fallback is forbidden.'
        );
      }
    }

    const effectiveAllowed =
      allowedHosts && allowedHosts.length > 0 ? allowedHosts : [...DEFAULT_ALLOWED_SEED_HOSTS];
    const hostStr = String(hostVal).toLowerCase().trim();

    if (!effectiveAllowed.includes(hostStr)) {
      throw new Error(
        `FATAL SECURITY REJECTION: Database seeding is forbidden on non-approved host "${hostVal}". Allowed hosts: [${effectiveAllowed.join(', ')}].`
      );
    }

    // Distinguish local loopback connections from remote connections
    const isLocalLoopback = hostStr === '127.0.0.1' || hostStr === '::1' || hostStr === 'localhost';
    if (!isLocalLoopback) {
      const isRemoteAllowed =
        options?.allowRemoteSeed === true || process.env.ALLOW_REMOTE_SEED === 'true';
      if (!isRemoteAllowed) {
        throw new Error(
          `FATAL SECURITY REJECTION: Remote database seeding is forbidden on host "${hostVal}". Merely including a remote host in SEED_ALLOWED_HOSTS is insufficient; explicit ALLOW_REMOTE_SEED=true is required.`
        );
      }
    }
  }
}

export async function main() {
  // Query live connected database identity directly from PostgreSQL
  let identity: Array<{ db_name: string; user_name: string; server_addr: string | null; server_port: number | null }>;
  try {
    identity = await prisma.$queryRaw<Array<{ db_name: string; user_name: string; server_addr: string | null; server_port: number | null }>>`
      SELECT current_database() AS db_name, current_user AS user_name, inet_server_addr()::text AS server_addr, inet_server_port() AS server_port;
    `;
  } catch (queryErr: any) {
    throw new Error(`FATAL SECURITY REJECTION: Failed to query live PostgreSQL database identity: ${queryErr.message}`);
  }

  if (!identity || identity.length === 0 || !identity[0]?.db_name || identity[0].db_name.trim() === '') {
    throw new Error('FATAL SECURITY REJECTION: Database identity query returned an empty or missing database name.');
  }
  const liveDbName = identity[0].db_name;
  const serverAddr = identity[0].server_addr ? String(identity[0].server_addr).trim() : null;

  // Enforce explicit host configuration
  const allowedHostsEnv = process.env.SEED_ALLOWED_HOSTS;
  let allowedHosts: string[] | undefined;
  if (allowedHostsEnv !== undefined) {
    allowedHosts = allowedHostsEnv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  const allowUnixSocket = process.env.SEED_ALLOW_UNIX_SOCKET === 'true';
  const isUnixSocket = serverAddr === null && (Boolean(process.env.DATABASE_URL?.includes('host=/')) || Boolean(process.env.DATABASE_URL?.includes('socket=')));
  const allowRemoteSeed = process.env.ALLOW_REMOTE_SEED === 'true';

  // 1. Initial Identity & Environment Validation (ensures zero application table reads or writes on unsafe target)
  assertSeedAllowed(liveDbName, process.env.NODE_ENV, process.env.ALLOW_DEMO_SEED, 0, {
    host: serverAddr,
    allowedHosts,
    allowUnixSocket,
    isUnixSocket,
    allowRemoteSeed,
  });

  // 2. Check for existing non-demo user data - fail closed if table or query fails!
  let nonDemoUserCount = 0;
  try {
    nonDemoUserCount = await prisma.user.count({
      where: { email: { not: 'demo@cinetrack.local' } },
    });
  } catch (userCountErr: any) {
    throw new Error(
      `FATAL SECURITY REJECTION: Unable to verify user table state prior to seeding (${userCountErr.message}). Ensure migrations are applied before running seed.`
    );
  }

  // 3. Final verification with user count
  if (nonDemoUserCount > 0) {
    throw new Error(
      `SECURITY REJECTION: Target database contains ${nonDemoUserCount} real user account(s). Seeding aborted to protect existing data from contamination.`
    );
  }

  console.log(`🌱 Seeding database "${liveDbName}" for development/test environment...`);

  // 1. Create Demo User with non-predictable credentials
  const demoEmail = 'demo@cinetrack.local';
  const existingUser = await prisma.user.findUnique({
    where: { email: demoEmail },
  });

  let demoUser = existingUser;
  if (!demoUser) {
    // Generate secure demo password with high entropy unless dev override provided
    const demoPassword = process.env.DEMO_USER_PASSWORD || `CineTrackDemo_${crypto.randomBytes(8).toString('hex')}!`;
    const passwordHash = await hashPassword(demoPassword);
    demoUser = await prisma.user.create({
      data: {
        username: 'demo_user',
        email: demoEmail,
        passwordHash,
      },
    });
    console.log(`✅ Demo user created: "${demoEmail}"`);
  }

  // 2. Ensure default watchlist exists for demo user
  let watchlist = await prisma.collection.findFirst({
    where: {
      ownerId: demoUser.id,
      isDefaultWatchlist: true,
    },
  });

  if (!watchlist) {
    watchlist = await prisma.collection.create({
      data: {
        ownerId: demoUser.id,
        title: 'Watchlist',
        description: 'Your default watchlist',
        isDefaultWatchlist: true,
      },
    });
    console.log('✅ Default watchlist initialized.');
  }

  // 3. Seed sample movies (Fight Club, Inception, Breaking Bad, The Dark Knight)
  const sampleMedia = [
    { tmdbId: 550, mediaType: 'MOVIE' as const, title: 'Fight Club' },
    { tmdbId: 27205, mediaType: 'MOVIE' as const, title: 'Inception' },
    { tmdbId: 155, mediaType: 'MOVIE' as const, title: 'The Dark Knight' },
    { tmdbId: 1396, mediaType: 'TV' as const, title: 'Breaking Bad' },
  ];

  for (const item of sampleMedia) {
    try {
      const movie = await MovieService.getOrCreateMovie(item.tmdbId, item.mediaType);
      const existing = await prisma.collectionMovie.findUnique({
        where: {
          collectionId_movieId: {
            collectionId: watchlist.id,
            movieId: movie.id,
          },
        },
      });

      if (!existing) {
        await prisma.collectionMovie.create({
          data: {
            collectionId: watchlist.id,
            movieId: movie.id,
            addedBy: demoUser.id,
            status: 'TO_WATCH',
          },
        });
        console.log(`  Added "${item.title}" (${item.mediaType}) to watchlist`);
      }
    } catch (err: any) {
      console.warn(`  Warning: Could not fetch TMDb data for ${item.title}: ${err.message}. Creating minimal record.`);
      let movie = await prisma.movie.findUnique({
        where: {
          tmdbId_mediaType: {
            tmdbId: item.tmdbId,
            mediaType: item.mediaType,
          },
        },
      });
      if (!movie) {
        movie = await prisma.movie.create({
          data: {
            tmdbId: item.tmdbId,
            mediaType: item.mediaType,
            title: item.title,
            genres: [],
          },
        });
      }
      const existing = await prisma.collectionMovie.findUnique({
        where: {
          collectionId_movieId: {
            collectionId: watchlist.id,
            movieId: movie.id,
          },
        },
      });
      if (!existing) {
        await prisma.collectionMovie.create({
          data: {
            collectionId: watchlist.id,
            movieId: movie.id,
            addedBy: demoUser.id,
            status: 'TO_WATCH',
          },
        });
      }
    }
  }

  console.log('🎉 Seeding completed successfully.');
}

if (process.argv[1] && process.argv[1].includes('seed')) {
  main()
    .catch((e) => {
      console.error('❌ Seeding failed:', e.message);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
