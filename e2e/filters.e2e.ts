import { expect, test } from '@playwright/test';

test('flight filters update the rendered fleet, routes, counts, and selection', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === 'data:') return route.continue();
    external.push(url.href);
    return route.abort();
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const count = page.getByTestId('status-count');
  const coverage = page.getByTestId('route-coverage');
  const stats = () => page.evaluate(() => window.__flightTracker!.stats());
  await expect(count).toHaveText('8 aircraft');
  await page.evaluate(() => {
    window.__flightTracker!.setAutoRotate(false);
    window.__flightTracker!.lookAt(50, 4, 1.35);
  });

  const summary = page.locator('summary').filter({ hasText: /^Filters/ });
  await summary.click();
  const altitude = page.getByLabel('Altitude band');
  const country = page.getByLabel('Origin country (registration)');
  const known = page.getByRole('checkbox', { name: 'Known routes only' });
  const reset = page.getByRole('button', { name: 'Reset filters' });

  await altitude.selectOption({ label: '30,000 ft and above' });
  await expect(count).toHaveText('4 aircraft');
  await expect(coverage).toContainText('Routes known for 3 of 4 aircraft');
  await known.check();
  await expect(count).toHaveText('3 aircraft');
  await country.selectOption({ label: 'Germany' });
  await expect(summary).toHaveText('Filters (1 of 8)');
  await expect(coverage).toContainText('Routes known for 1 of 1 aircraft');
  await expect.poll(async () => {
    const { aircraft, routes } = await stats();
    return { aircraft, routes };
  }).toEqual({ aircraft: 1, routes: 1 });
  const target = await page.evaluate(() => window.__flightTracker!.aircraft('3c66a1'));
  expect(target).not.toBeNull();
  const box = (await page.getByTestId('globe-canvas').boundingBox())!;
  await page.mouse.click(box.x + target!.x, box.y + target!.y);
  await expect(page.getByTestId('details-callsign')).toHaveText('TST202');
  await expect(page.getByTestId('details-origin')).toHaveText('HAM · Hamburg Airport');
  await expect.poll(async () => (await stats()).selectedSegments).toBeGreaterThan(0);

  // Keep one instance but change its identity: the old position/index is no longer pickable.
  await country.selectOption({ label: 'Ireland' });
  await expect(page.getByTestId('details-panel')).toBeHidden();
  await expect(page.getByText('3c66a1 is no longer reported.')).toBeHidden();
  await expect.poll(async () => {
    const { selected, selectedSegments } = await stats();
    return { selected, selectedSegments };
  }).toEqual({ selected: null, selectedSegments: 0 });
  await page.mouse.click(box.x + target!.x, box.y + target!.y);
  await expect(page.getByTestId('details-panel')).toBeHidden();
  await reset.click();
  await expect(count).toHaveText('8 aircraft');
  await expect(coverage).toContainText('Routes known for 4 of 8 aircraft');
  await expect(page.getByTestId('details-panel')).toBeHidden();

  await page.setViewportSize({ width: 375, height: 600 });
  const titleBounds = (await page.locator('.title').boundingBox())!;
  expect((await summary.boundingBox())!.y).toBeGreaterThan(titleBounds.y + titleBounds.height);
  await expect(reset).toBeInViewport();
  await altitude.selectOption({ label: 'Unknown altitude' });
  await expect(count).toHaveText('1 aircraft');
  await expect(coverage).toContainText('Routes known for 0 of 1 aircraft');
  await known.check();
  await expect(count).toHaveText('0 aircraft');
  await expect(page.getByText('No aircraft match these filters.')).toBeVisible();
  await expect(coverage).toContainText('Routes known for 0 of 0 aircraft');
  await expect.poll(async () => {
    const { aircraft, routes } = await stats();
    return { aircraft, routes };
  }).toEqual({ aircraft: 0, routes: 0 });
  await reset.click();
  await expect(count).toHaveText('8 aircraft');
  expect(await stats()).toMatchObject({ selected: null });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
