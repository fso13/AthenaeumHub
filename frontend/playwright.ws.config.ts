import { defineConfig, devices } from '@playwright/test';

/**
 * E3 real WebSocket smoke. Requires backend E3 on http://localhost:8081
 * (dev profile, POST /api/v1/realtime/ticket + /ws) and a free 5173.
 * The spec skips itself unless E3_WS_REAL=1.
 *
 * Run with: E3_WS_REAL=1 npm run test:e2e:ws
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /ws\.real\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev -- --host localhost --port 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_USE_MOCKS: 'false',
      VITE_AUTH_MODE: 'dev',
      VITE_DEV_SESSION: 'true',
      VITE_API_BASE_URL: '/api/v1',
      VITE_API_PROXY_TARGET: 'http://localhost:8081',
      VITE_WS_PROXY_TARGET: 'http://localhost:8081',
    },
  },
});
