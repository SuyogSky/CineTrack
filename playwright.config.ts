import { defineConfig, devices } from '@playwright/test';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const reuseServer = process.env.PLAYWRIGHT_REUSE_SERVER === 'true';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        colorScheme: 'dark',
      },
    },
  ],
  webServer: [
    {
      command: `${npmCmd} --prefix server run dev`,
      url: 'http://localhost:5000/health',
      reuseExistingServer: reuseServer,
      timeout: 30000,
    },
    {
      command: `${npmCmd} --prefix client run dev`,
      url: 'http://localhost:5173',
      reuseExistingServer: reuseServer,
      timeout: 30000,
    },
  ],
});
