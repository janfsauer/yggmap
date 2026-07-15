// @ts-check
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedMap, mm, idOf, focusNode, arrow } = require('./helpers');

test('fresh install: root editor is open, Enter commits the central idea', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('.mm-node');

  const boot = await mm(page);
  expect(boot.editingId).toBe(boot.rootId);

  await page.keyboard.type('hello world');
  await page.keyboard.press('Enter');

  const after = await mm(page);
  expect(after.editingId).toBeNull();
  expect(after.focusId).toBe(after.rootId);
  await expect(page.locator(`.mm-node[data-id="${after.rootId}"]`)).toHaveText('hello world');
});

test('arrows follow the tree, not the pixels', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  const id = {
    root: 'n0',
    sc: await idOf(page, 'Star Citizen'),
    scAll: await idOf(page, 'All major SC products'),
    ed: await idOf(page, 'Elite Dangerous'),
  };

  // the reported bug: Left from a depth-2 node on the right side must
  // climb to its parent, not jump across the map to the left branch
  await focusNode(page, id.scAll);
  expect(await arrow(page, 'ArrowLeft')).toBe(id.sc);
  expect(await arrow(page, 'ArrowLeft')).toBe(id.root);

  // from the root, each horizontal direction enters that side
  expect(await arrow(page, 'ArrowRight')).toBe(id.sc);
  await focusNode(page, id.root);
  expect(await arrow(page, 'ArrowLeft')).toBe(id.ed);

  // on the left side the directions mirror: Left descends, Right climbs
  const child = await arrow(page, 'ArrowLeft');
  expect([await idOf(page, 'Elite Pass'), await idOf(page, 'All major ED products')])
    .toContain(child);
  expect(await arrow(page, 'ArrowRight')).toBe(id.ed);
});

test('up/down step between siblings in rendered order', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  const pass = await idOf(page, 'SC Pass');
  const all = await idOf(page, 'All major SC products');

  const y = async sel =>
    (await page.locator(`.mm-node[data-id="${sel}"]`).boundingBox()).y;
  const [upper, lower] = (await y(pass)) < (await y(all)) ? [pass, all] : [all, pass];

  await focusNode(page, upper);
  expect(await arrow(page, 'ArrowDown')).toBe(lower);
  expect(await arrow(page, 'ArrowUp')).toBe(upper);
});

test('wrapped node text stays centered', async ({ page }) => {
  await seedMap(page, 'wrap check', [
    ['this is a long label that certainly wraps onto several lines', [], { side: 'R' }],
  ]);
  const node = page.locator('.mm-node', { hasText: 'certainly wraps' });
  await expect(node).toHaveCSS('text-align', 'center');
  const box = await node.boundingBox();
  expect(box.width).toBeLessThanOrEqual(280); // max-width: 260px + border/padding
  expect(box.height).toBeGreaterThan(50); // actually wrapped, not one line
});

test('leaf styling is dead-end semantics, not level-based', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  const sc = await idOf(page, 'Star Citizen');
  const scAll = await idOf(page, 'All major SC products');

  await expect(page.locator('.mm-node[data-id="n0"]')).toHaveClass(/mm-node--root/);
  await expect(page.locator(`.mm-node[data-id="${sc}"]`)).not.toHaveClass(/mm-node--leaf/);
  await expect(page.locator(`.mm-node[data-id="${scAll}"]`)).toHaveClass(/mm-node--leaf/);

  // give the leaf a child: it stops being a dead end, the child becomes one
  await focusNode(page, scAll);
  await page.keyboard.press('Tab');
  await page.keyboard.type('kid');
  await page.keyboard.press('Enter');

  await expect(page.locator(`.mm-node[data-id="${scAll}"]`)).not.toHaveClass(/mm-node--leaf/);
  await expect(page.locator('.mm-node', { hasText: 'kid' })).toHaveClass(/mm-node--leaf/);
});

test('delete and undo restore the map', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  const pass = await idOf(page, 'Elite Pass');

  await focusNode(page, pass);
  await page.keyboard.press('Backspace');
  await expect(page.locator(`.mm-node[data-id="${pass}"]`)).toHaveCount(0);

  await page.keyboard.press('Control+z');
  await expect(page.locator(`.mm-node[data-id="${pass}"]`)).toHaveText('Elite Pass');
});

test('edits survive a reload', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  await focusNode(page, await idOf(page, 'SC Pass'));
  await page.keyboard.press('Tab');
  await page.keyboard.type('persisted child');
  await page.keyboard.press('Enter');

  await page.reload();
  await expect(page.locator('.mm-node', { hasText: 'persisted child' })).toHaveCount(1);
});
