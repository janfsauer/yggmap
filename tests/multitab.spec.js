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

  // the cancelled placeholder must not ride back in on the adopted doc
  const stored = await lsGet(tab2, 'mindmaps.map.test1');
  const blanks = (function count(n) {
    return (n.text ? 0 : 1) + n.children.reduce((a, c) => a + count(c), 0);
  })(stored.root);
  expect(blanks).toBe(0);
});

test('undo after adopting a remote change is one step back, not a time warp', async ({ page }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'alpha', branches: BRANCHES }]);
  const tab2 = await secondTab(page);

  await addChild(page, 'mine');
  await expect(tab2.locator('.mm-node', { hasText: 'mine' })).toHaveCount(1);
  await addChild(tab2, 'theirs');
  await expect(page.locator('.mm-node', { hasText: 'theirs' })).toHaveCount(1);

  // ⌘Z in tab 1 reverts to what it had before the remote write —
  // 'theirs' goes (deliberate, redoable), but 'mine' must survive
  await page.keyboard.press('Control+z');
  await expect(page.locator('.mm-node', { hasText: 'theirs' })).toHaveCount(0);
  await expect(page.locator('.mm-node', { hasText: 'mine' })).toHaveCount(1);
  await expect(tab2.locator('.mm-node', { hasText: 'mine' })).toHaveCount(1);
});

test('an open drawer stays honest when the current map is deleted remotely', async ({ page }) => {
  await seedMaps(page, [
    { id: 'test1', rootText: 'alpha', branches: BRANCHES },
    { id: 'test2', rootText: 'beta' },
  ]);
  const tab2 = await secondTab(page);
  await tab2.locator('#mapsbtn').click();
  await expect(tab2.locator('.map-row')).toHaveCount(2);

  await deleteFromDrawer(page, 'alpha');

  // the drawer re-renders: no dead row, current highlight on the survivor
  await tab2.waitForFunction(() => window.__mm().currentMapId === 'test2');
  await expect(tab2.locator('.map-row')).toHaveCount(1);
  await expect(tab2.locator('.map-row.current .mtitle')).toHaveText('beta');
});

test('deleting the last map converges every tab on one fresh untitled', async ({ page }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'alpha', branches: BRANCHES }]);
  const tab2 = await secondTab(page);

  await deleteFromDrawer(page, 'alpha');

  // both tabs land on the same successor — no orphaned doc blobs anywhere
  await tab2.waitForFunction(() => window.__mm().currentMapId !== 'test1');
  expect((await mm(tab2)).currentMapId).toBe((await mm(page)).currentMapId);
  const mapKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => k.startsWith('mindmaps.map.')));
  expect(mapKeys).toHaveLength(1);
  expect(await lsGet(page, 'mindmaps.index.v1')).toHaveLength(1);
});

test('a doc written in a newer format becomes read-only, not clobbered', async ({ page }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'alpha', branches: BRANCHES }]);
  const tab2 = await secondTab(page);
  const original = await lsGet(page, 'mindmaps.map.test1');

  // simulate a newer app version writing this map from another tab
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('mindmaps.map.test1'));
    d.v = 99; d.futureField = 'do not lose me';
    localStorage.setItem('mindmaps.map.test1', JSON.stringify(d));
  });
  await expect(tab2.locator('.mm-toast')).toContainText('newer version');

  // tab 2 refuses to adopt what it can't parse — and refuses to write over it
  await addChild(tab2, 'stale edit');
  const stored = await lsGet(tab2, 'mindmaps.map.test1');
  expect(stored.v).toBe(99);
  expect(stored.futureField).toBe('do not lose me');

  // a second newer-version write must not stack a second toast
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('mindmaps.map.test1'));
    d.futureField = 'still newer';
    localStorage.setItem('mindmaps.map.test1', JSON.stringify(d));
  });

  // a compatible write lifts the latch: tab 2 adopts and can save again
  original.root.text = 'alpha unlatched';
  await page.evaluate(d =>
    localStorage.setItem('mindmaps.map.test1', JSON.stringify(d)), original);
  await expect(tab2.locator('.mm-node', { hasText: 'unlatched' })).toHaveCount(1);
  await expect(tab2.locator('.mm-toast')).toHaveCount(1); // only the first latch toasted

  await addChild(tab2, 'recovered');
  const after = await lsGet(tab2, 'mindmaps.map.test1');
  expect(after.v).toBe(1);
  expect(JSON.stringify(after)).toContain('recovered');
});

test('a refused adoption never mutates the local map (parked newer-version write + cancel)', async ({ page }) => {
  await seedMaps(page, [{ id: 'test1', rootText: 'alpha', branches: BRANCHES }]);
  const tab2 = await secondTab(page);

  // tab 2 holds an empty placeholder open while a newer-version write arrives
  await tab2.keyboard.press('Tab');
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('mindmaps.map.test1'));
    d.v = 99;
    localStorage.setItem('mindmaps.map.test1', JSON.stringify(d));
  });
  await tab2.waitForFunction(() => window.__mm().parked);

  // cancelling must only drop the placeholder — never a real branch
  await tab2.keyboard.press('Escape');
  await expect(tab2.locator('.mm-node', { hasText: 'Star Citizen' })).toHaveCount(1);
  await expect(tab2.locator('.mm-node', { hasText: 'Elite Dangerous' })).toHaveCount(1);
  await expect(tab2.locator('.mm-node', { hasText: 'Elite Pass' })).toHaveCount(1);
});

test('importing a share link never publishes an empty index (pristine first visit)', async ({ page }) => {
  // fresh-install shape: one pristine untitled map, open in two tabs
  await seedMaps(page, [{ id: 'test1', rootText: '' }]);
  const tab2 = await secondTab(page);
  await tab2.evaluate(() => {
    window.__idxEvents = [];
    addEventListener('storage', e => {
      if (e.key === 'mindmaps.index.v1') window.__idxEvents.push(e.newValue);
    });
  });

  // tab 1 imports a shared map — prunes the pristine untitled in the same breath
  await page.evaluate(() => {
    addSharedMap({ v: 1, seq: 1, root: { id: 's0', text: 'shared thing', children: [] } }, false);
  });

  // tab 2 follows to the imported map instead of racing to mint a replacement
  await tab2.waitForFunction(() => window.__mm().currentMapId !== 'test1');
  await expect(tab2.locator('.mm-node', { hasText: 'shared thing' })).toHaveCount(1);
  expect((await mm(tab2)).currentMapId).toBe((await mm(page)).currentMapId);

  // no observer ever saw an empty index, and nothing was orphaned
  const events = await tab2.evaluate(() => window.__idxEvents);
  for (const v of events) expect(JSON.parse(v).length).toBeGreaterThan(0);
  const index = await lsGet(page, 'mindmaps.index.v1');
  expect(index).toHaveLength(1);
  expect(index[0].title).toBe('shared thing');
  const mapKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => k.startsWith('mindmaps.map.')));
  expect(mapKeys).toHaveLength(1);
});

test('an armed delete button survives remote index churn', async ({ page }) => {
  await seedMaps(page, [
    { id: 'test1', rootText: 'alpha', branches: BRANCHES },
    { id: 'test2', rootText: 'beta' },
  ]);
  const tab2 = await secondTab(page);

  await tab2.locator('#mapsbtn').click();
  const del = tab2.locator('.map-row', { hasText: 'beta' }).locator('.mdel');
  await del.click();
  await expect(del).toHaveText('sure?');

  // a commit in tab 1 re-renders tab 2's open drawer — arming must carry over
  await addChild(page, 'churn');
  await expect(tab2.locator('.mm-node', { hasText: 'churn' })).toHaveCount(1);
  await expect(del).toHaveText('sure?');
  await del.click();
  await expect(tab2.locator('.map-row')).toHaveCount(1);
});
