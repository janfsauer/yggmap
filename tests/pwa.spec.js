// @ts-check
/* PWA behaviors: the standalone separate-storage notice, the one-shot
   persist() request, and the share-sheet export fallback for iOS
   home-screen apps (where a[download] opens a stuck preview). The iOS-only
   signals (navigator.standalone, share sheet) are stubbed via init scripts. */
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedStorage, seedMap, mm } = require('./helpers');

const standaloneStub = `Object.defineProperty(navigator, 'standalone', { get: () => true });`;

test('first pristine standalone run shows the separate-storage notice once', async ({ page }) => {
  await page.addInitScript(standaloneStub);
  await page.goto('/index.html'); // true first visit: pristine untitled map
  await page.waitForSelector('.mm-node[data-id="n0"]');

  const notice = page.locator('.mm-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('separate from the browser');

  await notice.locator('.mm-notice-btn').click();
  await expect(notice).toHaveCount(0);

  // never again — the flag persists across launches
  await page.reload();
  await page.waitForSelector('.mm-node[data-id="n0"]');
  await expect(page.locator('.mm-notice')).toHaveCount(0);
});

test('a standalone run with existing content shows no notice', async ({ page }) => {
  await page.addInitScript(standaloneStub);
  await seedMap(page, 'subscriptions', BRANCHES);
  await expect(page.locator('.mm-notice')).toHaveCount(0);
});

test('persist() is requested once, after real content exists', async ({ page }) => {
  await page.addInitScript(`
    window.__persistCalls = 0;
    StorageManager.prototype.persist = function () {
      window.__persistCalls++;
      return Promise.resolve(true);
    };
  `);
  await seedMap(page, 'seedling', []);

  // three committed children cross the engagement bar
  for (const text of ['one', 'two', 'three', 'four']) {
    await page.keyboard.press('Escape'); // make sure focus is settled on a node
    await page.locator('.mm-node[data-id="n0"]').click();
    await page.keyboard.press('Tab');
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => window.__persistCalls > 0);
  expect(await page.evaluate(() => window.__persistCalls)).toBe(1);

  // more edits never re-ask
  await page.locator('.mm-node[data-id="n0"]').click();
  await page.keyboard.press('Tab');
  await page.keyboard.type('five');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__persistCalls)).toBe(1);
});

test('export in iOS standalone goes through the share sheet, not a[download]', async ({ page }) => {
  await page.addInitScript(standaloneStub + `
    window.__shared = null;
    navigator.canShare = () => true;
    navigator.share = (data) => { window.__shared = data; return Promise.resolve(); };
  `);
  await seedMap(page, 'subscriptions', BRANCHES);

  await page.locator('#mapsbtn').click();
  await page.locator('#exportbtn').click();

  const shared = await page.evaluate(async () => {
    const d = window.__shared;
    if (!d || !d.files || !d.files[0]) return null;
    return { name: d.files[0].name, text: await d.files[0].text() };
  });
  expect(shared).not.toBeNull();
  expect(shared.name).toBe('mindmaps-export.json');
  expect(shared.text).toContain('subscriptions');
});
