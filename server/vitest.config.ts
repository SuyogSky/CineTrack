import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config();

const testDbUrl = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    env: {
      NODE_ENV: 'test',
      EXPECTED_TEST_DATABASE_NAME: process.env.EXPECTED_TEST_DATABASE_NAME || 'cinetrack_test',
      DATABASE_URL: testDbUrl || '',
      TEST_DATABASE_URL: testDbUrl || '',
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'test-access-secret-32-chars-long-min!!',
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-32-chars-long-min!',
      CSRF_SECRET: process.env.CSRF_SECRET || 'test-csrf-secret-32-chars-long-min!!!!',
    },
  },
});
