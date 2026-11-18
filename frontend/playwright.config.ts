import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: [
    /real\.spec\.ts/,
    /auth\.spec\.ts/,
    /admin\.spec\.ts/,
    /e2ee-browser\.spec\.ts/,
    /e2ee\.real\.spec\.ts/,
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_USE_MOCKS: 'true',
      VITE_AUTH_MODE: 'dev',
      VITE_DEV_SESSION: 'true',
    },
  },
});
