import { defineConfig, devices } from '@playwright/test';

/** Real-backend integration (I-01). B-01 must run on localhost:8081 (dev profile). */
export default defineConfig({
  testDir: './e2e',
  testMatch: /real\.spec\.ts/,
  // E7-F7B needs the docker E2EE overlay, not this Vite/real-backend harness.
  testIgnore: /e2ee\.real\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5180',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5180',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_USE_MOCKS: 'false',
      VITE_AUTH_MODE: 'dev',
      VITE_DEV_SESSION: 'true',
      VITE_API_BASE_URL: '/api/v1',
      VITE_API_PROXY_TARGET: 'http://localhost:8081',
    },
  },
});
