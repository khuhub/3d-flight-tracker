import { expect, test, type Page } from '@playwright/test';
import { parseOpenSkyStates, toWire, type SnapshotMessage } from '@flight/shared';
import fixture from '../packages/server/test/fixtures/replay/fixture-0.json' with { type: 'json' };

const searchInput = (page: Page) => page.getByRole('combobox', { name: 'Search aircraft by callsign or ICAO24' });
const canvas = (page: Page) => page.getByTestId('globe-canvas');
const callsign = (page: Page) => page.getByTestId('details-callsign');
const followStatus = (page: Page) => page.getByRole('status').filter({ hasText: /^(Following|Follow paused)/ });

async function blockExternalRequests(page: Page, origin: string): Promise<string[]> {
  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    external.push(url.href);
    return route.abort();
  });
  return external;
}

async function centreOffset(page: Page, icao24: string): Promise<number> {
  const box = (await canvas(page).boundingBox())!;
  const aircraft = await page.evaluate((id) => window.__flightTracker!.aircraft(id), icao24);
  return aircraft ? Math.hypot(aircraft.x - box.width / 2, aircraft.y - box.height / 2) : Infinity;
}

async function clickAircraft(page: Page, icao24: string): Promise<void> {
  const box = (await canvas(page).boundingBox())!;
  const aircraft = await page.evaluate((id) => window.__flightTracker!.aircraft(id), icao24);
  expect(aircraft).not.toBeNull();
  await page.mouse.click(box.x + aircraft!.x, box.y + aircraft!.y);
}

test('search is keyboard accessible and follow stops only on a globe drag or selection change', async ({ page, baseURL }) => {
  const external = await blockExternalRequests(page, new URL(baseURL!).origin);
  await page.goto('/');
  await expect(page.getByTestId('status-count')).toHaveText('8 aircraft');
  await page.evaluate(() => {
    window.__flightTracker!.setAutoRotate(false);
    window.__flightTracker!.lookAt(50, 4, 1.35);
  });
  await expect.poll(() => centreOffset(page, 'a1b2c3')).toBe(Infinity);

  const search = searchInput(page);
  await search.focus();
  await search.fill('gnd001');
  await expect(page.getByRole('status').filter({ hasText: 'No matching aircraft' })).toBeVisible();
  await search.fill('  tSt  ');
  const list = page.getByRole('listbox', { name: 'Matching aircraft' });
  const first = list.getByRole('option', { name: 'TST101 4ca1b2' });
  const last = list.getByRole('option', { name: 'TST808 a1b2c3' });
  await search.press('ArrowDown');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await search.press('ArrowUp');
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(search).toHaveAttribute('aria-activedescendant', (await last.getAttribute('id'))!);
  await search.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(search).toBeFocused();
  await search.press('ArrowUp');
  await search.press('Enter');
  await expect(callsign(page)).toHaveText('TST808');
  await expect(followStatus(page)).toHaveText(/Following TST808/);
  await expect.poll(() => centreOffset(page, 'a1b2c3')).toBeLessThan(1);

  const box = (await canvas(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 60, y + 40);
  await page.mouse.wheel(0, -140);
  await clickAircraft(page, 'a1b2c3');
  // Move a few CSS pixels with the button down, then release over the same plane.
  await page.mouse.down();
  await page.mouse.move(x + 3, y + 2);
  await page.mouse.up();
  await page.mouse.click(x - 60, y + 40); // empty canvas
  await expect(followStatus(page)).toHaveText(/Following TST808/);
  await expect.poll(() => centreOffset(page, 'a1b2c3')).toBeLessThan(1);

  // Even a drag that returns to its starting point must not be interpreted as a click.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 140, y + 40, { steps: 5 });
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.up();
  await expect(followStatus(page)).toHaveCount(0);
  await expect(callsign(page)).toHaveText('TST808');

  // A result can be selected by pointer, including one without a callsign.
  await search.fill('  4CA9F0 ');
  await list.getByRole('option', { name: 'No callsign 4ca9f0' }).click();
  await expect(callsign(page)).toHaveText('No callsign');
  await expect(followStatus(page)).toHaveText(/Following 4ca9f0/);
  await expect.poll(() => centreOffset(page, '4ca9f0')).toBeLessThan(1);
  await search.fill('tst');
  await expect(list).toBeVisible();
  await search.press('Tab');
  await expect(list).toBeHidden();
  await clickAircraft(page, '3c66a1');
  await expect(callsign(page)).toHaveText('TST202');
  await expect(followStatus(page)).toHaveCount(0);
  expect(external).toEqual([]);
});

test('follow pauses for an absent aircraft and resumes by ICAO24 after the fleet changes order', async ({ page, baseURL }) => {
  const external = await blockExternalRequests(page, new URL(baseURL!).origin);
  const snapshot = parseOpenSkyStates(fixture.response).snapshot;
  const aircraft = snapshot.aircraft.map((a) => toWire(a));
  const clockStart = Date.now();
  let message: SnapshotMessage = {
    mode: 'replay',
    sequence: 1,
    replayEpoch: 0,
    time: snapshot.time,
    serverNow: snapshot.time * 1000,
    pollIntervalS: 20,
    aircraft,
    airports: {},
  };
  // Control which fixture aircraft are visible through the real EventSource/FlightStore path.
  await page.route('**/api/stream', (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: `retry: 250\nevent: snapshot\ndata: ${JSON.stringify({
      ...message,
      serverNow: snapshot.time * 1000 + Date.now() - clockStart,
    })}\n\n`,
  }));
  await page.goto('/');
  await expect(page.getByTestId('status-count')).toHaveText('8 aircraft');
  const search = searchInput(page);
  await search.fill('tst101');
  await search.press('Enter');
  await expect(followStatus(page)).toHaveText(/Following TST101/);
  await expect.poll(() => centreOffset(page, '4ca1b2')).toBeLessThan(1);
  await expect.poll(() => centreOffset(page, '3c66a1')).toBeGreaterThan(8);

  message = { ...message, sequence: 2, aircraft: aircraft.filter((a) => a[0] !== '4ca1b2') };
  await expect(followStatus(page)).toHaveText(/Follow paused · 4ca1b2/);
  await expect(page.getByText('4ca1b2 is no longer reported.')).toBeVisible();
  await expect.poll(() => centreOffset(page, '3c66a1')).toBeGreaterThan(8);
  await search.fill('tst101');
  await expect(page.getByRole('status').filter({ hasText: 'No matching aircraft' })).toBeVisible();

  message = { ...message, sequence: 3, aircraft: [...aircraft].reverse() };
  await expect(followStatus(page)).toHaveText(/Following TST101/);
  await expect(callsign(page)).toHaveText('TST101');
  await expect.poll(() => centreOffset(page, '4ca1b2')).toBeLessThan(1);
  await expect(page.getByRole('option', { name: 'TST101 4ca1b2' })).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(followStatus(page)).toHaveCount(0);
  expect(external).toEqual([]);
});
