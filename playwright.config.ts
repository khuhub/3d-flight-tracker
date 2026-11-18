import { defineConfig, devices } from '@playwright/test';

const PORT = 4319;

/**
 * End-to-end test against the production build served by the backend in replay mode,
 * using the synthetic fixture in packages/server/test/fixtures/replay. No OpenSky access.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'npm run build && npm run start:e2e -w @flight/server',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: String(PORT),
      FLIGHT_MODE: 'replay',
      REPLAY_DIR: 'packages/server/test/fixtures/replay',
      ROUTES_FILE: 'packages/server/test/fixtures/routes/routes.json',
      // Point any accidental live traffic at a closed local port.
      OPENSKY_API_URL: 'http://127.0.0.1:9/api',
      OPENSKY_TOKEN_URL: 'http://127.0.0.1:9/token',
      OPENSKY_CLIENT_ID: '',
      OPENSKY_CLIENT_SECRET: '',
    },
  },
});
