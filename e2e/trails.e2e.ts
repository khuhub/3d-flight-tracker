import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

function mintPixels(image: Buffer): number {
  const { data } = PNG.sync.read(image);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
    if (g > 65 && g > r + 12 && g > b + 6) count++;
  }
  return count;
}

test('selected and fleet trails can be shown independently in replay', async ({ page, baseURL }) => {
  const unexpected: string[] = [];
  const origin = new URL(baseURL!).origin;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    unexpected.push(url);
    return route.abort();
  });
  page.on('pageerror', (error) => unexpected.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') unexpected.push(message.text());
  });

  await page.goto('/');
  await expect(page.getByTestId('status-count')).toHaveText('8 aircraft');
  const toggle = page.getByRole('checkbox', { name: 'Show short trails for all aircraft' });
  await expect(toggle).not.toBeChecked();
  const canvas = page.getByTestId('globe-canvas');
  const box = (await canvas.boundingBox())!;
  const stats = () => page.evaluate(() => window.__flightTracker!.stats());
  await page.evaluate(() => {
    const api = window.__flightTracker!;
    api.setAutoRotate(false);
    api.lookAt(50.2, 4.03, 1.12);
    api.setRoutesVisible(false);
    api.setAircraftVisible(false);
  });
  const baseline = mintPixels(await canvas.screenshot());

  await toggle.check();
  await expect.poll(async () => (await stats()).fleetTrailSegments).toBeGreaterThan(8);
  await expect.poll(async () => mintPixels(await canvas.screenshot())).toBeGreaterThan(baseline);
  await toggle.uncheck();
  await expect.poll(async () => (await stats()).fleetTrailSegments).toBe(0);

  await page.evaluate(() => window.__flightTracker!.setAircraftVisible(true));
  const target = await page.evaluate(() => window.__flightTracker!.aircraft('4ca1b2'));
  expect(target).not.toBeNull();
  await page.mouse.click(box.x + target!.x, box.y + target!.y);
  await expect(page.getByTestId('details-callsign')).toHaveText('TST101');
  await expect.poll(async () => (await stats()).selectedTrailSegments).toBeGreaterThan(1);
  expect((await stats()).fleetTrailSegments).toBe(0);
  await page.evaluate(() => window.__flightTracker!.setAircraftVisible(false));
  await expect.poll(async () => mintPixels(await canvas.screenshot())).toBeGreaterThan(baseline);

  await toggle.check();
  await expect.poll(async () => (await stats()).fleetTrailSegments).toBeGreaterThan(0);
  expect((await stats()).selectedTrailSegments).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect.poll(async () => (await stats()).selectedTrailSegments).toBe(0);
  expect((await stats()).fleetTrailSegments).toBeGreaterThan(0);
  expect(unexpected).toEqual([]);
});

test('normal stress mode keeps aircraft moving and building trails past the motion cutoff', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?stress=8');
  await expect(page.getByTestId('status-mode')).toHaveText(/Synthetic stress test/);
  const target = await page.evaluate(() => {
    const debug = window.__flightTracker!;
    debug.setAutoRotate(false);
    return debug.visibleAircraft(1)[0]!.icao24;
  });
  await page.getByRole('checkbox', { name: 'Show short trails for all aircraft' }).check();
  const position = () => page.evaluate((id) => window.__flightTracker!.aircraft(id), target);
  // Fast forward triggers the refresh timer once per jump. Without refresh, aircraft
  // would be frozen and the fleet trail would stop growing after its motion cutoff.
  await page.clock.fastForward(360_000);
  const first = await position();
  await page.clock.fastForward(20_000);
  const second = await position();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(Math.hypot(second!.lat - first!.lat, second!.lon - first!.lon)).toBeGreaterThan(0.005);
  expect(await page.evaluate(() => window.__flightTracker!.stats().fleetTrailSegments)).toBeGreaterThan(8);
});
