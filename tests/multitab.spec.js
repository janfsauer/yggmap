// @ts-check
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedMaps, mm, lsGet } = require('./helpers');

/* Two tabs = two pages in one browser context: they share localStorage and
   receive each other's 'storage' events, exactly like real browser tabs. */
async function secondTab(page) {
  const tab = await page.context().newPage();
  await tab.goto('/index.html');
  await tab.waitForSelector('.mm-node[data-id="n0"]');
  return tab;
}

/* grow a child under the focused node and commit it */
async function addChild(page, text) {
  await page.keyboard.press('Tab');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/* delete a map from the drawer (two clicks: arm, then confirm) */
async function deleteFromDrawer(page, title) {
  await page.locator('#mapsbtn').click();
  const del = page.locator('.map-row', { hasText: title }).locator('.mdel');
  await del.click();
  await del.click();
}

test('a map created in one tab is not erased by an edit in another', async ({ page }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'alpha', branches: BRANCHES }]);
  const tab2 = await secondTab(page);

  // tab 1 creates a fresh map…
  await page.locator('#mapsbtn').click();
  await page.locator('#newmapbtn').click();
  await page.keyboard.type('beta');
  await page.keyboard.press('Enter');

  // …then tab 2 (whose in-memory index predates it) saves an edit
  await addChild(tab2, 'survives');

  const index = await lsGet(tab2, 'mindmaps.index.v1');
  expect(index.map(m => m.title).sort()).toEqual(['alpha', 'beta']);
});

test('a map deleted in one tab stays deleted after an edit in another', async ({ page }) => {
  await seedMaps(page, [
    { id: 'test1', rootText: 'alpha', branches: BRANCHES },
    { id: 'test2', rootText: 'beta' },
  ]);
  const tab2 = await secondTab(page);

  await deleteFromDrawer(page, 'beta');
  await addChild(tab2, 'still here');

  const index = await lsGet(tab2, 'mindmaps.index.v1');
  expect(index.map(m => m.title)).toEqual(['alpha']);
  expect(await lsGet(tab2, 'mindmaps.map.test2')).toBeNull();
});

test('deleting the map another tab is viewing switches that tab away', async ({ page }) => {
  await seedMaps(page, [
    { id: 'test1', rootText: 'alpha', branches: BRANCHES },
    { id: 'test2', rootText: 'beta' },
  ]);
  const tab2 = await secondTab(page);

  await deleteFromDrawer(page, 'alpha');

  // tab 2 lands on the surviving map instead of resurrecting the dead one
  await tab2.waitForFunction(() => window.__mm().currentMapId === 'test2');
  await expect(tab2.locator('.mm-node[data-id="n0"]')).toHaveText('beta');

  await addChild(tab2, 'after the fact');
  expect(await lsGet(tab2, 'mindmaps.map.test1')).toBeNull();
  expect((await lsGet(tab2, 'mindmaps.index.v1')).map(m => m.title)).toEqual(['beta']);
});

test('edits appear live in a second tab viewing the same map', async ({ page }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'alpha', branches: BRANCHES }]);
  const tab2 = await secondTab(page);

  await addChild(page, 'fresh thought');
  await expect(tab2.locator('.mm-node', { hasText: 'fresh thought' })).toHaveCount(1);

  // and the other direction, on top of the state it just adopted
  await addChild(tab2, 'a reply');
  await expect(page.locator('.mm-node', { hasText: 'a reply' })).toHaveCount(1);
  expect((await mm(tab2)).currentMapId).toBe('test1');
});

test('a remote update parked during a local edit lands once the edit ends', async ({ page }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'alpha', branches: BRANCHES }]);
  const tab2 = await secondTab(page);

  // tab 2 is mid-edit — the remote change must not yank the editor away
  await tab2.keyboard.press('Tab');
  expect((await mm(tab2)).editingId).not.toBeNull();

  await addChild(page, 'from tab one');
  await tab2.waitForFunction(() => window.__mm().parked);
  await expect(tab2.locator('.mm-node', { hasText: 'from tab one' })).toHaveCount(0);

  // the commit was a no-op (cancelled empty node) — the parked doc lands now
  await tab2.keyboard.press('Escape');
  await expect(tab2.locator('.mm-node', { hasText: 'from tab one' })).toHaveCount(1);
});
