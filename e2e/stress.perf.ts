import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const AIRCRAFT = 12_000;
const MEASURE_MS = 10_000;

const pct = (values: number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : Number.NaN;
};
const round = (n: number): number => Math.round(n * 100) / 100;

test(`${AIRCRAFT} synthetic aircraft with a 6,000 km route each`, async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${new URL(baseURL!).origin}/`) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    errors.push(`Unexpected external request: ${url}`);
    return route.abort();
  });
  const loadStart = Date.now();
  await page.goto(`/?stress=${AIRCRAFT}&stressManual=1`);
  await page.waitForFunction(() => (window.__flightTracker?.stats().routeSegments ?? 0) > 0, null, { timeout: 120_000 });
  const loadMs = Date.now() - loadStart;
  // Every aircraft has a route, so this is the heaviest route load the globe can see.
  const full = await page.evaluate(() => window.__flightTracker!.stats());
  expect(full.routes).toBe(AIRCRAFT);
  await expect(page.getByTestId('status-mode')).toHaveText(/Synthetic stress test/);

  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });

  const measure = async (label: string) => {
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__flightTracker!.resetFrameStats());
    await page.waitForTimeout(MEASURE_MS);
    const { intervals, cpu } = await page.evaluate(() => window.__flightTracker!.frameStats());
    const frames = intervals.filter((v) => v > 0);
    return {
      label,
      frames: frames.length,
      fps: round(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)),
      frameIntervalMs: { p50: round(pct(frames, 0.5)), p95: round(pct(frames, 0.95)), p99: round(pct(frames, 0.99)), max: round(Math.max(...frames)) },
      mainThreadMs: { p50: round(pct(cpu, 0.5)), p95: round(pct(cpu, 0.95)), max: round(Math.max(...cpu)) },
    };
  };

  const globeView = await measure('whole globe, auto-rotating');
  await page.evaluate(() => {
    window.__flightTracker!.setAutoRotate(false);
    window.__flightTracker!.lookAt(45, 10, 1.6);
  });
  const zoomed = await measure('zoomed in');

  // Simulate new snapshots: every aircraft moves; routes are unchanged and are not rebuilt.
  const updates = [];
  for (let i = 0; i < 3; i++) {
    const { applyMs } = await page.evaluate(() => window.__flightTracker!.stressAdvance!(15));
    await page.waitForTimeout(500);
    updates.push({ applyMs: round(applyMs), routesVersion: (await page.evaluate(() => window.__flightTracker!.stats())).routesVersion });
  }
  const s = await page.evaluate(() => window.__flightTracker!.stats());

  const result = {
    date: new Date().toISOString(),
    renderer,
    aircraft: s.aircraft,
    instanceCapacity: s.instanceCapacity,
    drawCalls: s.drawCalls,
    routes: s.routes,
    routeSegments: s.routeSegments,
    routeBufferMiB: round(s.routeBufferBytes / 2 ** 20),
    initialRouteBuildMs: round(full.lastRouteRebuildMs),
    jsHeapMiB: s.jsHeapBytes === null ? null : round(s.jsHeapBytes / 2 ** 20),
    initialLoadMs: loadMs,
    runs: [globeView, zoomed],
    snapshotUpdates: updates,
  };
  mkdirSync('perf-results', { recursive: true });
  writeFileSync('perf-results/stress-12000.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  expect(errors).toEqual([]);
  expect(s.aircraft).toBe(AIRCRAFT);
  // Routes stay fixed while aircraft move: same geometry, no rebuild.
  expect(s.routeSegments).toBe(full.routeSegments);
  expect(updates.every((u) => u.routesVersion === full.routesVersion)).toBe(true);
  // Globe + atmosphere + aircraft (one instanced call) + all routes (one call).
  expect(s.drawCalls).toBeLessThanOrEqual(6);
});
