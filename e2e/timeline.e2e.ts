import { expect, test } from '@playwright/test';
import type { HistoryIndex, SnapshotMessage } from '@flight/shared';

test('rewinds and plays the presented fleet while the live stream keeps updating', async ({ page, request, baseURL }) => {
  const external: string[] = [];
  const errors: string[] = [];
  const origin = new URL(baseURL!).origin;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  const stats = () => page.evaluate(() => window.__flightTracker!.stats());
  const getIndex = async () => (await (await request.get('/api/history')).json()) as HistoryIndex;
  await page.goto('/');
  const timeline = page.getByRole('region', { name: 'Flight timeline' });
  const range = timeline.getByRole('slider', { name: 'Flight timeline time' });
  const readout = timeline.locator('time');
  await expect(range).toBeEnabled();
  await expect.poll(async () => (await getIndex()).frames.length, { timeout: 35_000 }).toBeGreaterThanOrEqual(2);
  const { generation, frames } = await getIndex();
  const oldest = frames[0]!;
  const second = frames[1]!;
  // Exercise the multi-frame gzip response in Chromium itself, not Node's fetch.
  const decodedSeed = await page.evaluate(async ({ generation, at }) => {
    const response = await fetch(`/api/history/${generation}?at=${at}`);
    const frames = await response.json() as SnapshotMessage[];
    return { encoding: response.headers.get('content-encoding'), sequence: frames.map((f) => f.sequence) };
  }, { generation, at: second.capturedAt });
  expect(decodedSeed).toEqual({ encoding: 'gzip', sequence: [oldest.sequence, second.sequence] });
  await expect.poll(async () => (await stats()).snapshotSequence).toBeGreaterThan(oldest.sequence);

  const canvas = page.getByTestId('globe-canvas');
  const canvasNode = (await canvas.elementHandle())!;
  await page.evaluate(() => {
    window.__flightTracker!.setAutoRotate(false);
    window.__flightTracker!.lookAt(50, 4, 1.35);
  });
  const plane = () => page.evaluate(() => window.__flightTracker!.aircraft('3c66a1'));
  await expect.poll(plane).not.toBeNull();
  const beforeSeek = (await plane())!;
  await expect.poll(async () => {
    if (await page.getByTestId('details-callsign').textContent({ timeout: 100 }).catch(() => null) === 'TST202') return true;
    const target = await plane();
    const box = await canvas.boundingBox();
    if (target && box) await page.mouse.click(box.x + target.x, box.y + target.y);
    return (await stats()).selected === '3c66a1';
  }).toBe(true);
  await expect(page.getByTestId('details-callsign')).toHaveText('TST202');

  await range.press('Home');
  await expect(timeline.getByRole('status')).toHaveText('Paused');
  await expect.poll(async () => (await stats()).snapshotSequence).toBe(oldest.sequence);
  await expect(readout).toHaveAttribute('datetime', new Date(oldest.capturedAt).toISOString());
  await expect(page.getByTestId('details-callsign')).toHaveText('TST202');
  await expect(page.getByTestId('details-origin')).toContainText('Hamburg Airport');
  await expect.poll(async () => (await plane())?.lat).not.toBe(beforeSeek.lat);
  const position = async () => {
    const aircraft = (await plane())!;
    return { lat: aircraft.lat, lon: aircraft.lon };
  };
  const frozen = await position();
  const liveSequenceWhilePaused = (await getIndex()).frames.at(-1)!.sequence;
  await expect.poll(async () => (await getIndex()).frames.at(-1)!.sequence, { timeout: 30_000 })
    .toBeGreaterThan(liveSequenceWhilePaused);
  // The camera can finish damping; freezing refers to aircraft coordinates rather than screen pixels.
  expect(await position()).toEqual(frozen);
  expect((await stats()).snapshotSequence).toBe(oldest.sequence);
  await expect(page.getByTestId('status-connection')).toHaveText('Connected');

  const frameRequest = page.waitForResponse((res) => /\/api\/history\/[^/]+\/\d+$/.test(res.url()) && res.ok());
  await timeline.getByRole('combobox', { name: 'Playback speed' }).selectOption('4');
  await timeline.getByRole('button', { name: 'Play' }).click();
  await frameRequest;
  await expect.poll(async () => (await stats()).snapshotSequence).toBeGreaterThan(oldest.sequence);
  await expect(page.getByTestId('details-callsign')).toHaveText('TST202');

  await timeline.getByRole('button', { name: 'Go live' }).click();
  await expect(timeline.getByRole('status')).toHaveText('At live edge');
  const newest = (await getIndex()).frames.at(-1)!.sequence;
  await expect.poll(async () => (await stats()).snapshotSequence).toBeGreaterThanOrEqual(newest);
  expect(await canvasNode.evaluate((element) => element.isConnected)).toBe(true);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('leaves the synthetic stress path independent of timeline and SSE', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/')) apiRequests.push(req.url());
  });
  await page.goto('/?stress=8');
  await expect(page.getByTestId('status-mode')).toContainText('Synthetic stress test');
  await expect(page.getByTestId('status-count')).toHaveText('8 aircraft');
  await expect(page.getByRole('region', { name: 'Flight timeline' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__flightTracker!.stats().aircraft)).toBe(8);
  expect(apiRequests).toEqual([]);
});
