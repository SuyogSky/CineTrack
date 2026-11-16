import { beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma, disconnectDatabase } from '../src/config/database';

beforeAll(async () => {
  await prisma.$connect();
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
