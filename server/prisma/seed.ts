import crypto from 'crypto';
import { prisma } from '../src/config/database';
import { hashPassword } from '../src/utils/password';
import { MovieService } from '../src/services/movie.service';
import { env } from '../src/config/env';

async function main() {
  // Production safety guard: prevent running demo seeding in production under all circumstances
  if (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production') {
    console.error('⛔ FATAL: Database seeding is strictly forbidden in production environments.');
    throw new Error('Database seeding is strictly forbidden in production mode');
  }

  console.log('🌱 Seeding database for development/test environment...');

  // 1. Create Demo User with non-predictable credentials
  const demoEmail = 'demo@cinetrack.local';
  const existingUser = await prisma.user.findUnique({
    where: { email: demoEmail },
  });

  let demoUser = existingUser;
  if (!demoUser) {
    const randomPassword = crypto.randomBytes(16).toString('hex') + 'A1!';
    const passwordHash = await hashPassword(randomPassword);
    demoUser = await prisma.user.create({
      data: {
        username: 'cinephile_demo',
        email: demoEmail,
        passwordHash,
      },
    });
    console.log('👤 Created demo user for local test environment: cinephile_demo');
  }

  // 2. Ensure default watchlist
  let watchlist = await prisma.collection.findFirst({
    where: { ownerId: demoUser.id, isDefaultWatchlist: true },
  });

  if (!watchlist) {
    watchlist = await prisma.collection.create({
      data: {
        ownerId: demoUser.id,
        title: 'My Watchlist',
        description: 'Personal master watchlist for movies to watch.',
        visibility: 'PRIVATE',
        isDefaultWatchlist: true,
      },
    });
  }

  // 3. Create a Sci-Fi Classics collection with randomized shareToken
  let sciFiCollection = await prisma.collection.findFirst({
    where: { ownerId: demoUser.id, title: 'Must-Watch Sci-Fi' },
  });

  if (!sciFiCollection) {
    const randomShareToken = 'demo-' + crypto.randomBytes(8).toString('hex');
    sciFiCollection = await prisma.collection.create({
      data: {
        ownerId: demoUser.id,
        title: 'Must-Watch Sci-Fi',
        description: 'Mind-bending science fiction masterpieces.',
        visibility: 'PUBLIC_LINK',
        shareToken: randomShareToken,
      },
    });
    console.log(`📁 Created demo collection: Must-Watch Sci-Fi (Public: ${randomShareToken})`);
  }

  // 4. Add Inception, Interstellar, The Matrix
  const inception = await MovieService.getOrCreateMovie(27205);
  const interstellar = await MovieService.getOrCreateMovie(157336);
  const matrix = await MovieService.getOrCreateMovie(603);

  // Add to watchlist
  const watchlistMovies = [
    { movieId: inception.id, status: 'TO_WATCH' as const, note: 'Recommended by Sarah' },
    { movieId: interstellar.id, status: 'WATCHED' as const, note: 'Phenomenal Hans Zimmer score', watchedAt: new Date() },
  ];

  for (const item of watchlistMovies) {
    await prisma.collectionMovie.upsert({
      where: {
        collectionId_movieId: {
          collectionId: watchlist.id,
          movieId: item.movieId,
        },
      },
      update: {},
      create: {
        collectionId: watchlist.id,
        movieId: item.movieId,
        addedBy: demoUser.id,
        status: item.status,
        watchedAt: item.watchedAt,
        note: item.note,
      },
    });
  }

  // Add to SciFi collection
  const sciFiMovies = [
    { movieId: inception.id, status: 'WATCHED' as const, watchedAt: new Date() },
    { movieId: matrix.id, status: 'TO_WATCH' as const, note: 'Re-watch in 4K HDR' },
  ];

  for (const item of sciFiMovies) {
    await prisma.collectionMovie.upsert({
      where: {
        collectionId_movieId: {
          collectionId: sciFiCollection.id,
          movieId: item.movieId,
        },
      },
      update: {},
      create: {
        collectionId: sciFiCollection.id,
        movieId: item.movieId,
        addedBy: demoUser.id,
        status: item.status,
        watchedAt: item.watchedAt,
        note: item.note,
      },
    });
  }

  console.log('✅ Database seeding complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
