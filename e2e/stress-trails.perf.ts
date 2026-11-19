import { expect, test } from '@playwright/test';

const AIRCRAFT = 12_000;

test('batches fleet trails for 12,000 aircraft', async ({ page, baseURL }) => {
  const errors: string[] = [];
  const origin = new URL(baseURL!).origin;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    errors.push(`Unexpected external request: ${url}`);
    return route.abort();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(`/?stress=${AIRCRAFT}&stressManual=1`);
  await page.waitForFunction((n) => window.__flightTracker?.stats().routes === n, AIRCRAFT, { timeout: 120_000 });
  await page.evaluate(() => window.__flightTracker!.setAutoRotate(false));
  const stats = () => page.evaluate(() => window.__flightTracker!.stats());
  const before = await stats();
  expect(before.aircraft).toBe(AIRCRAFT);
  expect(before.fleetTrailSegments).toBe(0);
  const toggle = page.getByRole('checkbox', { name: 'Show short trails for all aircraft' });

  // Hydrate the whole 90-second window with synthetic snapshots. No wall/GPU timings
  // are used to assess correctness, so this test also works with SwiftShader.
  await toggle.check();
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.__flightTracker!.stressAdvance!(15));
  await expect.poll(async () => (await stats()).fleetTrailSegments).toBeGreaterThan(AIRCRAFT * 4);
  const after = await stats();
  expect(after.aircraft).toBe(AIRCRAFT);
  expect(after.instanceCapacity).toBe(before.instanceCapacity);
  expect(after.routeSegments).toBe(before.routeSegments);
  expect(after.routesVersion).toBe(before.routesVersion);
  expect(after.trailBufferBytes).toBeLessThanOrEqual(16 * 2 ** 20);
  expect(after.drawCalls).toBe(before.drawCalls + 1);
  await toggle.uncheck();
  await expect.poll(async () => (await stats()).fleetTrailSegments).toBe(0);
  expect((await stats()).drawCalls).toBe(before.drawCalls);
  console.log(JSON.stringify({
    aircraft: after.aircraft, trailSegments: after.fleetTrailSegments,
    trailBufferBytes: after.trailBufferBytes, drawCallsOff: before.drawCalls, drawCallsOn: after.drawCalls,
  }));
  expect(errors).toEqual([]);
});
