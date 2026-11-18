import { defineConfig, devices } from '@playwright/test';

/**
 * D1-QA1: Message Dashboard e2e (shell/rail/pages, threads, chat settings,
 * profile, media, axe and 390/768/1440 responsive checks).
 *
 * Runs against the MSW mock backend in the Auth BFF password mode, so the
 * suite exercises a real login → dashboard path without any backend or
 * Keycloak. Run with: `npm run test:e2e:d1`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /d1-.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4175',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_USE_MOCKS: 'true',
      VITE_AUTH_MODE: 'password',
      VITE_DEV_SESSION: 'false',
    },
  },
});
