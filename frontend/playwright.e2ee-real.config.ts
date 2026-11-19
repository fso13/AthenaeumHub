import { defineConfig, devices } from '@playwright/test';

/**
 * E7-F7B — real two-device E2EE against the boxed stack.
 *
 * This suite needs a running stack built with the test-only overlay
 * (`deploy/docker-compose.e2ee-test.yml`): backend `KRUG_E2EE_ENABLED=true`
 * and a SPA built with `VITE_E2EE_ENABLED=true`. There is deliberately no
 * `webServer` here: a Vite dev server cannot reproduce the overlay build and
 * the backend/Keycloak/PostgreSQL contract.
 *
 * Gated by `E2EE_REAL=1` (the npm script sets it); without the gate every test
 * is skipped. Chromium and Firefox only — WebKit/Safari is excluded by ADR-26
 * until its Ed25519 implementation passes the strict KAT.
 *
 * Fixture: both users are registered through the real BFF; the TOTP is read
 * from Mailpit (`E2EE_REAL_MAILPIT_URL`, default http://localhost:8025).
 * Destructive SQL (device reset / workspace cleanup) is opt-in only:
 * `E2EE_REAL_RESET=1`. See `e2e/e2ee-real-fixture.ts` and README.
 *
 * Traces/screenshots/video are disabled: a failing E2EE test must not write
 * decrypted message text to disk.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /e2ee\.real\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: [['list']],
  use: {
    // The overlay stack's PUBLIC_URL (and therefore the backend WS origin
    // allow-list) is http://localhost:8088. Using 127.0.0.1 changes the browser
    // Origin header and the realtime handshake is rejected with 403.
    baseURL: process.env.E2EE_REAL_BASE_URL ?? 'http://localhost:8088',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
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
  ],
});
