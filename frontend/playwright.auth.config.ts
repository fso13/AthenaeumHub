import { defineConfig, devices } from '@playwright/test';

/**
 * Auth BFF password flow against the MSW mock backend (no Keycloak).
 * Run with: npm run test:e2e:auth
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /(auth|admin)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_USE_MOCKS: 'true',
      VITE_AUTH_MODE: 'password',
      VITE_DEV_SESSION: 'false',
    },
  },
});
