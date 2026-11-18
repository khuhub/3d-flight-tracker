import { PNG } from 'pngjs';
import { expect, test, type Page } from '@playwright/test';
import type { DebugStats, VisibleAircraft } from '../packages/client/src/debug';

const stats = (page: Page): Promise<DebugStats> => page.evaluate(() => window.__flightTracker!.stats());

function greatCircleMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const s = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(s));
}

/** Mean absolute per-channel difference between two equally sized PNG screenshots. */
function pixelDifference(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  let sum = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    sum += Math.abs(pa.data[i]! - pb.data[i]!) + Math.abs(pa.data[i + 1]! - pb.data[i + 1]!) + Math.abs(pa.data[i + 2]! - pb.data[i + 2]!);
  }
  return sum / ((pa.data.length / 4) * 3);
}

test('replay shows moving airplanes with fixed airport routes and click-to-details', async ({ page, baseURL }) => {
  const external: string[] = [];
  const origin = new URL(baseURL!).origin;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.getByTestId('status-mode')).toHaveText(/Replay/);
  await expect(page.getByTestId('status-connection')).toHaveText('Connected');
  await expect(page.getByTestId('status-count')).toHaveText(/^8 aircraft$/);
  await expect(page.getByTestId('status-updated')).toHaveText(/Updated \d+ s ago/);

  // Routes are shown immediately from the first snapshot: TST101/202/303/808 match the
  // route fixture; TST404's route is on another continent and is rejected.
  await expect(page.getByTestId('route-coverage')).toContainText('Routes known for 4 of 8 aircraft');
  await page.evaluate(() => {
    window.__flightTracker!.setAutoRotate(false);
    window.__flightTracker!.lookAt(50, 4, 1.35);
  });
  const initial = await stats(page);
  expect(initial.aircraft).toBe(8);
  expect(initial.routes).toBe(4);
  expect(initial.routeSegments).toBeGreaterThan(4 * 8);
  expect(initial.drawCalls).toBeLessThanOrEqual(6);

  // Routes are fixed: the next recorded snapshot (20 s later) moves the aircraft but
  // neither grows nor rebuilds the route lines.
  // (A replay loop restarts the data, so look for a snapshot within the same loop.)
  let previous = initial;
  let next = initial;
  await expect
    .poll(
      async () => {
        const s = await stats(page);
        if (s.snapshotSequence !== next.snapshotSequence) {
          previous = next;
          next = s;
        }
        return next.snapshotSequence !== previous.snapshotSequence && next.replayEpoch === previous.replayEpoch;
      },
      { timeout: 70_000 },
    )
    .toBe(true);
  expect(next.routeSegments).toBe(previous.routeSegments);
  expect(next.routesVersion).toBe(previous.routesVersion);

  // Aircraft move continuously by extrapolation, at their reported speed (240 m/s here).
  const sample = async () => ({ at: Date.now(), a: await page.evaluate(() => window.__flightTracker!.aircraft('4ca1b2')) });
  const before = await sample();
  await page.waitForTimeout(3000);
  const after = await sample();
  expect(before.a && after.a).toBeTruthy();
  const speed = greatCircleMetres(before.a!, after.a!) / ((after.at - before.at) / 1000);
  expect(speed).toBeGreaterThan(150);
  expect(speed).toBeLessThan(330);

  // Airplanes and routes are visibly drawn: hiding each changes the image.
  const canvas = page.getByTestId('globe-canvas');
  const shotAll = await canvas.screenshot();
  await page.evaluate(() => window.__flightTracker!.setAircraftVisible(false));
  const shotNoPlanes = await canvas.screenshot();
  expect(pixelDifference(shotAll, shotNoPlanes)).toBeGreaterThan(0.01);
  await page.evaluate(() => window.__flightTracker!.setRoutesVisible(false));
  const shotNoRoutes = await canvas.screenshot();
  expect(pixelDifference(shotNoPlanes, shotNoRoutes)).toBeGreaterThan(0.005);
  await page.evaluate(() => {
    window.__flightTracker!.setRoutesVisible(true);
    window.__flightTracker!.setAircraftVisible(true);
  });

  // Clicking an airplane shows where it is coming from and going to.
  const target = (await page.evaluate(() => window.__flightTracker!.aircraft('3c66a1'))) as VisibleAircraft;
  expect(target).toBeTruthy();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + target.x, box.y + target.y);
  const details = page.getByTestId('details-panel');
  await expect(details).toBeVisible();
  await expect(page.getByTestId('details-callsign')).toHaveText('TST202');
  await expect(page.getByTestId('details-origin')).toHaveText('HAM · Hamburg Airport');
  await expect(page.getByTestId('details-destination')).toHaveText('CDG · Paris Charles de Gaulle Airport');
  await expect(page.getByTestId('details-country')).toHaveText('Germany');
  await expect(page.getByTestId('details-altitude')).toHaveText('31,168 ft (9,500 m)');
  await expect(page.getByTestId('details-speed')).toHaveText('437 kt (810 km/h)');
  await expect(page.getByTestId('details-heading')).toHaveText('200° S');
  await expect.poll(async () => (await stats(page)).selectedSegments).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(details).toBeHidden();

  // An aircraft whose route does not fit its position shows no route rather than a wrong one.
  const other = (await page.evaluate(() => window.__flightTracker!.aircraft('4b1801'))) as VisibleAircraft;
  await page.mouse.click(box.x + other.x, box.y + other.y);
  await expect(page.getByTestId('details-callsign')).toHaveText('TST404');
  await expect(page.getByTestId('details-origin')).toHaveText('Unknown');
  await expect(page.getByTestId('details-destination')).toHaveText('Unknown');
  await expect.poll(async () => (await stats(page)).selectedSegments).toBe(0);

  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
