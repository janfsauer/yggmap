// @ts-check
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedMap, mm, idOf, focusNode } = require('./helpers');

test('pristine first-visit state survives a stray canvas click', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('.mm-node');

  await expect(page.locator('body')).toHaveClass(/firstvisit/);
  const boot = await mm(page);
  expect(boot.editingId).toBe(boot.rootId);

  // a stray click on empty paper blurs the editor — the pristine look must hold
  await page.mouse.click(100, 300);
  await expect(page.locator('body')).toHaveClass(/firstvisit/);
  await expect(page.locator(`.mm-node[data-id="${boot.rootId}"]`)).toHaveText('');

  // and the map is still usable: typing gives the central idea its text
  await page.keyboard.type('idea');
  await page.keyboard.press('Enter');
  await expect(page.locator(`.mm-node[data-id="${boot.rootId}"]`)).toHaveText('idea');
  await expect(page.locator('body')).not.toHaveClass(/firstvisit/);
});

test('ghosts follow focus: branch offers both, root has no sibling, editing hides them', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);

  await focusNode(page, await idOf(page, 'Star Citizen'));
  await expect(page.locator('.mm-ghost[data-id="ghost:child"]')).toBeVisible();
  await expect(page.locator('.mm-ghost[data-id="ghost:sibling"]')).toBeVisible();

  // the root can't have siblings, so no sibling ghost there
  await focusNode(page, 'n0');
  await expect(page.locator('.mm-ghost[data-id="ghost:child"]')).toBeVisible();
  await expect(page.locator('.mm-ghost[data-id="ghost:sibling"]')).toHaveCount(0);

  // while an editor is open, ghosts step aside entirely
  await page.keyboard.press('F2');
  await expect(page.locator('.mm-ghost')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.mm-ghost[data-id="ghost:child"]')).toBeVisible();
});

test('heavily-used ghosts fade to learn-2 but never vanish', async ({ page }) => {
  // a veteran's counters, far past every fade threshold
  await seedMap(page, 'subscriptions', BRANCHES, {
    'mindmaps.ui.v2': { learn: { tab: 99, enter: 99 } },
  });

  await focusNode(page, await idOf(page, 'Star Citizen'));
  const child = page.locator('.mm-ghost[data-id="ghost:child"]');
  const sibling = page.locator('.mm-ghost[data-id="ghost:sibling"]');
  await expect(child).toHaveClass(/learn-2/);
  await expect(sibling).toHaveClass(/learn-2/);
  await expect(child).toBeAttached();
  await expect(sibling).toBeAttached();
});

test('siblings stack without overlap, children sit beyond their parent', async ({ page }) => {
  await seedMap(page, 'stack', [
    ['branch', [['one'], ['two'], ['three'], ['four']], { side: 'R' }],
  ]);

  const box = async text =>
    (await page.locator('.mm-node', { hasText: text }).boundingBox());
  const parent = await box('branch');
  const kids = await Promise.all(['one', 'two', 'three', 'four'].map(box));

  kids.sort((a, b) => a.y - b.y);
  for (let i = 1; i < kids.length; i++)
    expect(kids[i].y).toBeGreaterThanOrEqual(kids[i - 1].y + kids[i - 1].height);

  const root = await box('stack');
  expect(parent.x).toBeGreaterThanOrEqual(root.x + root.width); // R branch right of root
  for (const k of kids)
    expect(k.x).toBeGreaterThanOrEqual(parent.x + parent.width); // children beyond parent
});
