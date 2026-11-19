import { defineConfig } from '@playwright/test';

const PORT = 4320;

/**
 * Browser performance benchmark: 12,000 synthetic aircraft, each with a 6,000 km
 * route (`?stress=12000`). Results are written to perf-results/.
 * Headless Chromium falls back to software rendering (SwiftShader) unless told to use
 * the GPU, so on macOS ANGLE is pointed at Metal. The renderer used is recorded in the
 * results; numbers from a software renderer are not representative. HEADED=1 shows the window.
 */
const gpuArgs = process.env.PERF_SWIFTSHADER === '1'
  ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu'] : ['--enable-gpu'];
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.perf\.ts/,
  timeout: 300_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 1000 },
    headless: !process.env.HEADED,
    launchOptions: {
      args: ['--ignore-gpu-blocklist', ...gpuArgs],
    },
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
      OPENSKY_API_URL: 'http://127.0.0.1:9/api',
      OPENSKY_TOKEN_URL: 'http://127.0.0.1:9/token',
      OPENSKY_CLIENT_ID: '',
      OPENSKY_CLIENT_SECRET: '',
    },
  },
});
