// @ts-check
/* Offline mode: after one online visit the service worker holds a coherent
   snapshot of the app shell, and the whole app — data layer included —
   works with the network gone. Chromium only (Playwright drives SW network
   emulation only there; the suite is Chromium-only anyway). */
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedMap, lsGet } = require('./helpers');

/* SW active AND controlling AND snapshot primed — going offline any earlier
   would test the HTTP cache, not the worker.
   NOTE: async predicates passed to page.waitForFunction are NOT awaited by
   Playwright (the returned Promise is truthy) — always poll with expect.poll
   + page.evaluate instead. */
async function waitForOfflineReady(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise(res => navigator.serviceWorker.addEventListener(
        'controllerchange', res, { once: true }));
  });
  await expect.poll(() => page.evaluate(async () =>
    !!(await caches.match('/', { cacheName: 'snap-live' })))).toBe(true);
}

test('the app loads and renders offline after one online visit', async ({ page, context }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  await waitForOfflineReady(page);
  await context.setOffline(true);

  const response = await page.reload();
  expect(response.ok()).toBeTruthy();
  // from the worker's snapshot, not Chromium's HTTP cache
  expect(response.fromServiceWorker()).toBe(true);

  // the real map renders — shell AND data layer survived the reload
  await expect(page.locator('.mm-node', { hasText: 'subscriptions' })).toHaveCount(1);
  await expect(page.locator('.mm-node', { hasText: 'Star Citizen' })).toHaveCount(1);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px "Patrick Hand"');
  });
  expect(fonts).toBe(true);

  // negative control: we really are offline
  const bust = await page.evaluate(() =>
    fetch('/nope-' + Date.now()).then(() => 'ok', () => 'failed'));
  expect(bust).toBe('failed');
});

test('a snapshot-served navigation still converges on the deployed version', async ({ page, context }) => {
  test.setTimeout(60000); // the lie-fi delays below are real seconds
  await seedMap(page, 'subscriptions', BRANCHES);
  await waitForOfflineReady(page);

  // lie-fi: every HTML request answers only after the 3s race is lost
  // (the page navigates to /index.html; the worker's refresh fetches /)
  const marker = '<!doctype html><title>v2-marker</title><div id="nodes"></div>';
  await context.route(u => ['/', '/index.html'].includes(new URL(u).pathname), async route => {
    await new Promise(r => setTimeout(r, 4000));
    await route.fulfill({ body: marker, contentType: 'text/html' });
  });

  // the navigation loses the race and falls back to the snapshot —
  // the OLD app renders (not the marker page)
  const t0 = Date.now();
  const response = await page.reload();
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2900); // it really raced the timeout
  expect(response.fromServiceWorker()).toBe(true);
  await expect(page.locator('.mm-node', { hasText: 'subscriptions' })).toHaveCount(1);

  // …but the catch-branch refresh is untimed, so the deploy lands in snap-live
  await expect.poll(() => page.evaluate(async () => {
    const hit = await caches.match('/', { cacheName: 'snap-live' });
    return hit ? (await hit.text()).includes('v2-marker') : false;
  }), { timeout: 30000 }).toBe(true);
});

test('scratch caches orphaned by a killed refresh get swept', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  await waitForOfflineReady(page);

  // plant an ancient orphan (timestamp 1 — hard-kill leftover shape)
  await page.evaluate(() => caches.open('snap-tmp-1-leftover'));

  // any successful navigation refresh sweeps it
  await page.reload();
  await expect.poll(() => page.evaluate(() =>
    caches.has('snap-tmp-1-leftover'))).toBe(false);

  // …and the live snapshot is untouched
  expect(await page.evaluate(async () =>
    !!(await caches.match('/', { cacheName: 'snap-live' })))).toBe(true);
});

test('a slow non-shell request arrives late instead of failing', async ({ page, context }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  await waitForOfflineReady(page);

  // 4s > the worker's 3s race — pre-worker this succeeded late, and must still
  await context.route('**/slowfile.json', async route => {
    await new Promise(r => setTimeout(r, 4000));
    await route.fulfill({ body: 'late-but-fine', contentType: 'text/plain' });
  });
  const body = await page.evaluate(() =>
    fetch('/slowfile.json').then(r => r.text()));
  expect(body).toBe('late-but-fine');
});

test('editing and cross-tab sync keep working offline', async ({ page, context }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  const tab2 = await context.newPage();
  await tab2.goto('/index.html');
  await tab2.waitForSelector('.mm-node[data-id="n0"]');
  await waitForOfflineReady(page);
  await context.setOffline(true);

  await page.keyboard.press('Tab');
  await page.keyboard.type('made offline');
  await page.keyboard.press('Enter');

  // storage events are not network — the other tab follows live
  await expect(tab2.locator('.mm-node', { hasText: 'made offline' })).toHaveCount(1);
  expect(JSON.stringify(await lsGet(page, 'mindmaps.map.test1'))).toContain('made offline');
});
