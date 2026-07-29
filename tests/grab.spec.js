// @ts-check
/* Grab mode: M (or the mobile action bar) lifts the focused node, the map
   stays fully navigable, then Enter / tap / click on a target adopts the
   subtree as its last child. Esc cancels. */
const { test, expect } = require('@playwright/test');
const { seedMap, mm, lsGet, idOf, focusNode } = require('./helpers');

const GRAB_BRANCHES = [
  ['alpha', [['a1'], ['a2', [['sub']]], ['a3']], { side: 'R', color: 'pink' }],
  ['beta', [['b1']], { side: 'R', color: 'blue' }],
  ['gamma', [], { side: 'L', color: 'green' }],
];

const savedDoc = page => lsGet(page, 'mindmaps.map.test1');
function findNode(node, text) {
  if (node.text === text) return node;
  for (const c of node.children) { const hit = findNode(c, text); if (hit) return hit; }
  return null;
}
const childTexts = async (page, text) =>
  findNode((await savedDoc(page)).root, text).children.map(c => c.text);
const grabOf = async page => (await mm(page)).grabId;

test('M grabs, arrows aim, Enter drops as last child, ⌘Z undoes', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  const a2 = await idOf(page, 'a2');
  await focusNode(page, a2);

  await page.keyboard.press('m');
  await expect.poll(() => grabOf(page)).toBe(a2);
  await expect(page.locator(`.mm-node[data-id="${a2}"]`)).toHaveClass(/is-dragging/);

  await page.keyboard.press('ArrowLeft');  // aim: up to alpha…
  await page.keyboard.press('ArrowDown');  // …and over to beta
  await expect.poll(async () => (await mm(page)).focusId).toBe(await idOf(page, 'beta'));

  await page.keyboard.press('Enter');
  await expect.poll(() => childTexts(page, 'beta')).toEqual(['b1', 'a2']);
  expect(await childTexts(page, 'a2')).toEqual(['sub']); // subtree traveled
  expect(await childTexts(page, 'alpha')).toEqual(['a1', 'a3']);
  expect(await grabOf(page)).toBe(null);
  expect((await mm(page)).focusId).toBe(a2);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);
});

test('Esc cancels a grab without touching the doc', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  await focusNode(page, await idOf(page, 'a2'));

  await page.keyboard.press('m');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  await expect.poll(() => grabOf(page)).toBe(null);
  expect(await childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);
  expect((await mm(page)).undoDepth).toBe(0);
});

test('a branch refuses to drop into its own subtree', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  const alpha = await idOf(page, 'alpha');
  await focusNode(page, alpha);

  await page.keyboard.press('m');
  await page.keyboard.press('ArrowRight'); // aim descends into alpha's own child
  await page.keyboard.press('Enter');
  await expect(page.locator('.mm-toast')).toContainText('itself');
  expect(await childTexts(page, 'grab')).toEqual(['alpha', 'beta', 'gamma']);
  expect(await grabOf(page)).toBe(alpha); // still holding it
  expect((await mm(page)).undoDepth).toBe(0);
});

test('dropping on the root makes a branch: lighter side, family color', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  await focusNode(page, await idOf(page, 'sub'));

  await page.keyboard.press('m');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft'); // climb to root
  await expect.poll(async () => (await mm(page)).focusId).toBe('n0');

  await page.keyboard.press('Enter');
  await expect.poll(() => childTexts(page, 'grab')).toEqual(['alpha', 'beta', 'gamma', 'sub']);
  const sub = findNode((await savedDoc(page)).root, 'sub');
  expect(sub.side).toBe('L');       // the right side is far heavier
  expect(sub.color).toBe('pink');   // colorless — adopts its old family hue
});

test('clicking a target drops there (mouse flow)', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  await focusNode(page, await idOf(page, 'a2'));

  await page.keyboard.press('m');
  await page.locator('.mm-node', { hasText: 'beta' }).click();
  await expect.poll(() => childTexts(page, 'beta')).toEqual(['b1', 'a2']);
  expect(await grabOf(page)).toBe(null);
});

test('mobile: action-bar move button, tap a target to drop', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES, { 'mindmaps.ui.v2': { forceMobile: true } });
  await focusNode(page, await idOf(page, 'a2'));

  await page.locator('#actionbar button', { hasText: 'move' }).click();
  await expect.poll(() => grabOf(page)).not.toBe(null);
  await expect(page.locator('#actionbar button', { hasText: 'cancel' })).toBeVisible();

  await page.locator('.mm-node', { hasText: 'beta' }).click();
  await expect.poll(() => childTexts(page, 'beta')).toEqual(['b1', 'a2']);
  expect(await grabOf(page)).toBe(null);
});

test('ghosts hide while grabbing and return after', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  await focusNode(page, await idOf(page, 'a2'));
  await expect(page.locator('.mm-ghost')).not.toHaveCount(0);

  await page.keyboard.press('m');
  await expect(page.locator('.mm-ghost')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.mm-ghost')).not.toHaveCount(0);
});

test('the root cannot be grabbed', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  await focusNode(page, 'n0');
  await page.keyboard.press('m');
  expect(await grabOf(page)).toBe(null);
});

test('grab mode is modal: create/edit/delete keys do nothing', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  await focusNode(page, await idOf(page, 'a2'));
  await page.keyboard.press('m');

  await page.keyboard.press('Tab');
  await page.keyboard.press('x');
  await page.keyboard.press('Backspace');
  expect((await mm(page)).editingId).toBe(null);
  expect(await grabOf(page)).not.toBe(null);
  expect(await childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);
  expect(await childTexts(page, 'grab')).toEqual(['alpha', 'beta', 'gamma']);
});

test('an undo that removes the grabbed node cancels the grab', async ({ page }) => {
  await seedMap(page, 'grab', GRAB_BRANCHES);
  await focusNode(page, await idOf(page, 'a1'));

  // grow a fresh node, grab it, then undo it out from under the grab
  await page.keyboard.press('Tab');
  await page.keyboard.type('temp');
  await page.keyboard.press('Enter');
  await expect.poll(async () => findNode((await savedDoc(page)).root, 'temp')).not.toBe(null);
  await focusNode(page, await idOf(page, 'temp'));

  await page.keyboard.press('m');
  await expect.poll(() => grabOf(page)).not.toBe(null);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ControlOrMeta+z');
    if (!findNode((await savedDoc(page)).root, 'temp')) break;
  }
  await expect.poll(async () => findNode((await savedDoc(page)).root, 'temp')).toBe(null);
  expect(await grabOf(page)).toBe(null);
});
