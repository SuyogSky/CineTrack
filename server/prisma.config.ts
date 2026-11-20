import { defineConfig } from '@prisma/config';
import dotenv from 'dotenv';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('FATAL: DATABASE_URL environment variable is strictly required for Prisma operations');
}

export default defineConfig({
  datasource: {
    url: databaseUrl,
  },
});
