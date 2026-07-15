// @ts-check
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedMap, mm, idOf, focusNode } = require('./helpers');

test('escape and empty commit discard the new node and its undo snapshot', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);

  // a real prior action the undo stack must keep protecting
  await focusNode(page, await idOf(page, 'Elite Pass'));
  await page.keyboard.press('Backspace');
  expect((await mm(page)).undoDepth).toBe(1);
  const nodeCount = await page.locator('.mm-node').count();

  const pass = await idOf(page, 'SC Pass');
  await focusNode(page, pass);

  // escape cancels the fresh child: node gone, creation snapshot popped
  await page.keyboard.press('Tab');
  expect((await mm(page)).editingId).not.toBeNull();
  expect((await mm(page)).undoDepth).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.mm-node')).toHaveCount(nodeCount);
  expect(await mm(page)).toMatchObject({ focusId: pass, editingId: null, undoDepth: 1 });

  // committing without text does the same
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('.mm-node')).toHaveCount(nodeCount);
  expect((await mm(page)).undoDepth).toBe(1);

  // undo now restores the deleted node — not a phantom empty one
  await page.keyboard.press('Control+z');
  await expect(page.locator('.mm-node', { hasText: 'Elite Pass' })).toHaveCount(1);
  await expect(page.locator('.mm-node')).toHaveCount(nodeCount + 1);
});

test('renaming a node is a single undo that restores the old text', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  const pass = await idOf(page, 'SC Pass');
  const node = page.locator(`.mm-node[data-id="${pass}"]`);

  await focusNode(page, pass);
  await page.keyboard.press('F2');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Renamed Pass');
  await page.keyboard.press('Enter');

  await expect(node).toHaveText('Renamed Pass');
  expect((await mm(page)).undoDepth).toBe(1);

  // one undo brings the text back — it must not delete the node
  await page.keyboard.press('Control+z');
  await expect(node).toHaveText('SC Pass');
  expect((await mm(page)).undoDepth).toBe(0);
});

test('typing on a focused node replaces its text, not appends', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);
  const pass = await idOf(page, 'SC Pass');
  const node = page.locator(`.mm-node[data-id="${pass}"]`);

  await focusNode(page, pass);
  await page.keyboard.press('x');
  expect((await mm(page)).editingId).toBe(pass);
  await expect(node).toHaveText('x'); // old text already replaced in the editor

  await page.keyboard.type('yz');
  await page.keyboard.press('Enter');
  await expect(node).toHaveText('xyz');
});
