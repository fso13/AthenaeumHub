import { defineConfig, devices } from '@playwright/test';

/**
 * E7-F7A — real-browser WebCrypto matrix (Chromium, Firefox, WebKit).
 *
 * Only the Vite dev server is required: no backend, Keycloak, database or
 * E2EE feature flag. The suite itself is gated by E2EE_BROWSER_MATRIX=1; the
 * `npm run test:e2e:e2ee` script sets it. Browser support is detected at
 * runtime (never guessed from the User-Agent); a browser without X25519 or
 * Ed25519 fails with E2EE_UNSUPPORTED_BROWSER instead of falling back to JS.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /e2ee-browser\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4175',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_USE_MOCKS: 'true',
      VITE_AUTH_MODE: 'dev',
      VITE_DEV_SESSION: 'true',
    },
  },
});
