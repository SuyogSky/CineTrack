import { defineConfig } from '@prisma/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL || 'postgresql://cinetrack:cinetrack123@localhost:5432/cinetrack?schema=public',
  },
});
