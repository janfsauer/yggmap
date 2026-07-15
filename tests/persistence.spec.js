// @ts-check
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedStorage, seedMaps, seedMap, mm, lsGet, idOf, focusNode } = require('./helpers');

test('legacy single-map doc is promoted into a real map, not discarded', async ({ page }) => {
  // a user from the single-map era: only the old key exists
  await seedStorage(page, {
    'mindmaps.doc.v1': { v: 1, seq: 2, root: { id: 'n0', text: 'legacy map', children: [] } },
  });
  await page.goto('/index.html');
  await page.waitForSelector('.mm-node[data-id="n0"]');

  await expect(page.locator('.mm-node[data-id="n0"]')).toHaveText('legacy map');

  const index = await lsGet(page, 'mindmaps.index.v1');
  expect(index).toHaveLength(1);
  expect(index[0].title).toBe('legacy map');
  const current = await page.evaluate(() => localStorage.getItem('mindmaps.current.v1'));
  expect(current).toBe(index[0].id);
  const doc = await lsGet(page, 'mindmaps.map.' + current);
  expect(doc.root.text).toBe('legacy map');
});

test('a deleted map is never resurrected by later saves', async ({ page }) => {
  await seedMaps(page, [
    { id: 'test1', rootText: 'map a', branches: BRANCHES },
    { id: 'test2', rootText: 'map b' },
  ]);

  await page.evaluate(() => deleteMap('test1'));
  expect((await mm(page)).currentMapId).toBe('test2');
  expect(await lsGet(page, 'mindmaps.map.test1')).toBeNull();

  // mutate the surviving map so saveDoc runs a few times
  await page.keyboard.press('x');
  await page.keyboard.type('yz');
  await page.keyboard.press('Enter');
  await expect(page.locator('.mm-node[data-id="n0"]')).toHaveText('xyz');

  expect(await lsGet(page, 'mindmaps.map.test1')).toBeNull();
  const index = await lsGet(page, 'mindmaps.index.v1');
  expect(index.map(m => m.id)).toEqual(['test2']);
});

test('switching maps commits the in-flight edit and clears undo history', async ({ page }) => {
  await seedMaps(page, [
    { id: 'test1', rootText: 'map a', branches: BRANCHES },
    { id: 'test2', rootText: 'map b' },
  ]);

  // real undo history on map a...
  await focusNode(page, await idOf(page, 'Elite Pass'));
  await page.keyboard.press('Backspace');
  expect((await mm(page)).undoDepth).toBe(1);

  // ...and an uncommitted rename in progress
  await focusNode(page, await idOf(page, 'SC Pass'));
  await page.keyboard.press('F2');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('edited mid-flight');

  await page.evaluate(() => switchMap('test2'));
  const state = await mm(page);
  expect(state.currentMapId).toBe('test2');
  expect(state.editingId).toBeNull();
  expect(state.undoDepth).toBe(0);

  // undo must not leak map a's history into map b
  await page.keyboard.press('Control+z');
  await expect(page.locator('.mm-node[data-id="n0"]')).toHaveText('map b');

  // the mid-flight edit was committed and saved before the switch
  await page.evaluate(() => switchMap('test1'));
  await expect(page.locator('.mm-node', { hasText: 'edited mid-flight' })).toHaveCount(1);
  const saved = JSON.stringify(await lsGet(page, 'mindmaps.map.test1'));
  expect(saved).toContain('edited mid-flight');
  expect(saved).not.toContain('Elite Pass');
});

test('import fails fast on a newer version and skips broken entries', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);

  // a file from the future must not touch the store at all
  await page.evaluate(() => {
    const bad = JSON.stringify({
      app: 'mindmaps', version: 999,
      maps: [{ title: 'evil', doc: { v: 999, root: { id: 'x', text: 'evil', children: [] } } }],
    });
    importFile(new File([bad], 'bad.json'));
  });
  await expect(page.locator('.mm-toast', { hasText: 'newer version' })).toBeVisible();
  expect((await lsGet(page, 'mindmaps.index.v1')).map(m => m.title)).toEqual(['subscriptions']);

  // a current-version file imports valid maps and skips doc-less ones
  await page.evaluate(() => {
    const ok = JSON.stringify({
      app: 'mindmaps', version: 1,
      maps: [
        { title: 'good', doc: { v: 1, seq: 1, root: { id: 'g0', text: 'good', children: [] } } },
        { title: 'broken', doc: null },
      ],
    });
    importFile(new File([ok], 'ok.json'));
  });
  await expect(page.locator('.mm-toast', { hasText: 'imported 1 map' })).toBeVisible();
  const titles = (await lsGet(page, 'mindmaps.index.v1')).map(m => m.title);
  expect(titles).toContain('good');
  expect(titles).not.toContain('broken');
  expect(titles).toHaveLength(2);
});
