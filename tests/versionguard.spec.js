// @ts-check
/* A doc stamped by a NEWER app version must never be edited — or silently
   re-written — by this code. The storage-event path already latches
   (adoptRemoteDoc); these tests pin the LOAD path (boot, map switch) and the
   places stale code could still launder a newer doc (import, parked commits).
   Without the guards, old code re-saves a v>DOC_VERSION doc with its own
   semantics while keeping the newer stamp — silent corruption. */
const { test, expect } = require('@playwright/test');
const { BRANCHES, buildDoc, seedStorage, seedMaps, mm, lsGet } = require('./helpers');

function futureDoc(rootText, branches = []) {
  const d = buildDoc(rootText, branches);
  d.v = 99;
  d.futureField = 'do not lose me';
  return d;
}

async function seedFutureCurrent(page, rootText, branches) {
  const future = futureDoc(rootText, branches);
  await seedStorage(page, {
    'mindmaps.index.v1': [{ id: 'fut1', title: rootText || 'untitled', updated: 1 }],
    'mindmaps.current.v1': 'fut1',
    'mindmaps.map.fut1': future,
  });
  await page.goto('/index.html');
  await page.waitForSelector('.mm-node[data-id="n0"]');
  return future;
}

test('a newer-version doc boots read-only: renders, refuses edits, never writes', async ({ page }) => {
  const future = await seedFutureCurrent(page, 'from the future', BRANCHES);

  // the map is visible and the latch announced itself
  await expect(page.locator('.mm-node', { hasText: 'Star Citizen' })).toHaveCount(1);
  await expect(page.locator('.mm-toast')).toContainText('newer version');

  // every mutation path is refused: create, edit-by-typing, delete, undo
  await page.keyboard.press('Tab');
  await page.keyboard.type('stale');
  await page.keyboard.press('Delete');
  expect((await mm(page)).editingId).toBe(null);
  await expect(page.locator('.mm-node.is-editing')).toHaveCount(0);

  // blocked keypresses must not stack a toast per keystroke
  await expect(page.locator('.mm-toast')).toHaveCount(1);

  // and the stored doc is exactly what the future version wrote
  expect(await lsGet(page, 'mindmaps.map.fut1')).toEqual(future);
});

test('read-only still lets you expand a collapsed branch (view state, not a mutation)', async ({ page }) => {
  const future = await seedFutureCurrent(page, 'from the future', [
    ['Star Citizen', [['SC Pass'], ['All major SC products']], { side: 'R', collapsed: true }],
  ]);

  // collapsed children start hidden
  await expect(page.locator('.mm-node', { hasText: 'SC Pass' })).toHaveCount(0);

  // expanding must work — read-only may never mean "parts of your map are invisible"
  await page.locator('.mm-node', { hasText: 'Star Citizen' }).click();
  await page.keyboard.press('.');
  await expect(page.locator('.mm-node', { hasText: 'SC Pass' })).toHaveCount(1);

  // …and it stays view-only: the stored doc is untouched
  expect(await lsGet(page, 'mindmaps.map.fut1')).toEqual(future);
});

test('a pristine newer-version doc does not boot into the editor', async ({ page }) => {
  await seedFutureCurrent(page, '');
  expect((await mm(page)).editingId).toBe(null);
  await expect(page.locator('.mm-node.is-editing')).toHaveCount(0);
  // …and the chrome doesn't invite typing that would only be refused
  await expect(page.locator('body')).not.toHaveClass(/firstvisit/);
});

test('the latch is per map: switching to a newer map latches, back unlatches', async ({ page }) => {
  const future = futureDoc('future map', []);
  await seedStorage(page, { 'mindmaps.map.fut1': future });
  await seedMaps(page, [
    { id: 'test1', rootText: 'present map', branches: BRANCHES },
    { id: 'fut1', rootText: 'future map' },
  ]);

  // switch to the future map via the drawer — latched, no edits
  await page.locator('#mapsbtn').click();
  await page.locator('.map-row', { hasText: 'future map' }).click();
  await page.waitForFunction(() => window.__mm().currentMapId === 'fut1');
  await page.keyboard.press('Tab');
  expect((await mm(page)).editingId).toBe(null);
  expect(await lsGet(page, 'mindmaps.map.fut1')).toEqual(future);

  // switching back to the present-day map is writable again
  await page.locator('#mapsbtn').click();
  await page.locator('.map-row', { hasText: 'present map' }).click();
  await page.waitForFunction(() => window.__mm().currentMapId === 'test1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('still editable');
  await page.keyboard.press('Enter');
  expect(JSON.stringify(await lsGet(page, 'mindmaps.map.test1'))).toContain('still editable');
});

test('import keeps the maps it understands and skips newer-version ones', async ({ page }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'home', branches: [] }]);
  const payload = {
    app: 'mindmaps', version: 1, exported: 'x',
    maps: [
      { title: 'fine', doc: buildDoc('fine', []) },
      { title: 'too new', doc: futureDoc('too new') },
    ],
  };
  await page.locator('#mapsbtn').click();
  await page.locator('#importfile').setInputFiles({
    name: 'export.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(page.locator('.mm-toast')).toContainText('imported 1 map');
  const index = await lsGet(page, 'mindmaps.index.v1');
  expect(index.map(m => m.title)).not.toContain('too new');
});

test('a commit with real changes still yields to a parked newer-version write', async ({ page, context }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'alpha', branches: BRANCHES }]);
  const tab2 = await context.newPage();
  await tab2.goto('/index.html');
  await tab2.waitForSelector('.mm-node[data-id="n0"]');

  // tab 2 is mid-edit with REAL text when a newer-version write arrives
  await tab2.keyboard.press('Tab');
  await tab2.keyboard.type('my important thought');
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('mindmaps.map.test1'));
    d.v = 99; d.futureField = 'do not lose me';
    localStorage.setItem('mindmaps.map.test1', JSON.stringify(d));
  });
  await tab2.waitForFunction(() => window.__mm().parked);

  // committing must NOT make tab 2 the newest writer over a doc it can't parse
  await tab2.keyboard.press('Enter');
  const stored = await lsGet(tab2, 'mindmaps.map.test1');
  expect(stored.v).toBe(99);
  expect(stored.futureField).toBe('do not lose me');
  expect(JSON.stringify(stored)).not.toContain('my important thought');
});
