// @ts-check
/* ⌥+arrows move the focused node: reorder among siblings, demote into a
   neighbor, promote next to the former parent, flip sides at depth 1.
   All spatial — "toward root" depends on which side of the map you're on. */
const { test, expect } = require('@playwright/test');
const { seedMap, mm, lsGet, idOf, focusNode } = require('./helpers');

/* alpha/beta share the right side (gamma alone on the left), so depth-1
   reorder can prove it skips over the other side's branches */
const MOVE_BRANCHES = [
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

test('⌥↓/⌥↑ reorder among siblings, focus stays, edges are no-ops', async ({ page }) => {
  await seedMap(page, 'move', MOVE_BRANCHES);
  const a1 = await idOf(page, 'a1');
  await focusNode(page, a1);

  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a2', 'a1', 'a3']);
  expect((await mm(page)).focusId).toBe(a1);

  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);

  // at the top of the run there's nowhere to go — and no undo entry either
  const { undoDepth } = await mm(page);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);
  expect((await mm(page)).undoDepth).toBe(undoDepth);
});

test('depth-1 reorder stays within one side of the map', async ({ page }) => {
  await seedMap(page, 'move', MOVE_BRANCHES);
  await focusNode(page, await idOf(page, 'alpha'));

  // alpha swaps past beta (same side) even though gamma sits between-ish in the array
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => childTexts(page, 'move')).toEqual(['beta', 'alpha', 'gamma']);

  // alpha is now the last right-side branch — gamma (left) is not a target
  const { undoDepth } = await mm(page);
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => childTexts(page, 'move')).toEqual(['beta', 'alpha', 'gamma']);
  expect((await mm(page)).undoDepth).toBe(undoDepth);
});

test('⌥→ demotes into the sibling above, subtree intact', async ({ page }) => {
  await seedMap(page, 'move', MOVE_BRANCHES);
  await focusNode(page, await idOf(page, 'a2'));

  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a1', 'a3']);
  expect(await childTexts(page, 'a1')).toEqual(['a2']);
  expect(await childTexts(page, 'a2')).toEqual(['sub']); // subtree traveled

  // ⌘Z puts the whole structure back
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);
  expect(await childTexts(page, 'a1')).toEqual([]);
});

test('⌥→ on a first sibling falls back to the one below, as first child', async ({ page }) => {
  await seedMap(page, 'move', MOVE_BRANCHES);
  await focusNode(page, await idOf(page, 'a1'));

  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a2', 'a3']);
  expect(await childTexts(page, 'a2')).toEqual(['a1', 'sub']);
});

test('demoting into a collapsed sibling expands it', async ({ page }) => {
  const branches = [['alpha', [['a1'], ['a2', [['sub']], { collapsed: true }]], { side: 'R', color: 'pink' }]];
  await seedMap(page, 'move', branches);
  await expect(page.locator('.mm-node', { hasText: 'sub' })).toHaveCount(0);
  await focusNode(page, await idOf(page, 'a1'));

  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => childTexts(page, 'a2')).toEqual(['a1', 'sub']);
  await expect(page.locator('.mm-node', { hasText: 'sub' })).toBeVisible();
  expect(findNode((await savedDoc(page)).root, 'a2').collapsed).toBeFalsy();
});

test('⌥← promotes to a sibling right after the former parent', async ({ page }) => {
  await seedMap(page, 'move', MOVE_BRANCHES);
  await focusNode(page, await idOf(page, 'sub'));

  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'sub', 'a3']);
  expect(await childTexts(page, 'a2')).toEqual([]);
});

test('promoting to depth 1 inherits the branch side and color', async ({ page }) => {
  await seedMap(page, 'move', MOVE_BRANCHES);
  await focusNode(page, await idOf(page, 'a2'));

  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => childTexts(page, 'move')).toEqual(['alpha', 'a2', 'beta', 'gamma']);
  const a2 = findNode((await savedDoc(page)).root, 'a2');
  expect(a2.side).toBe('R');
  expect(a2.color).toBe('pink'); // colorless before — adopts the family hue
  expect(a2.children.map(c => c.text)).toEqual(['sub']);
});

test('left side mirrors: ⌥← demotes, ⌥→ promotes', async ({ page }) => {
  const branches = [['gamma', [['g1'], ['g2']], { side: 'L', color: 'green' }]];
  await seedMap(page, 'move', branches);
  await focusNode(page, await idOf(page, 'g2'));

  await page.keyboard.press('Alt+ArrowLeft'); // away from root on the left side
  await expect.poll(() => childTexts(page, 'g1')).toEqual(['g2']);

  await page.keyboard.press('Alt+ArrowRight'); // and back toward the root
  await expect.poll(() => childTexts(page, 'gamma')).toEqual(['g1', 'g2']);
});

test('⌥ toward root at depth 1 flips the branch to the other side', async ({ page }) => {
  await seedMap(page, 'move', MOVE_BRANCHES);
  await focusNode(page, await idOf(page, 'beta'));

  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(async () => findNode((await savedDoc(page)).root, 'beta').side).toBe('L');

  // flipping is undoable like any other move
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => findNode((await savedDoc(page)).root, 'beta').side).toBe('R');
});

test('the root cannot be moved', async ({ page }) => {
  await seedMap(page, 'move', MOVE_BRANCHES);
  await focusNode(page, 'n0');

  for (const key of ['Alt+ArrowUp', 'Alt+ArrowDown', 'Alt+ArrowLeft', 'Alt+ArrowRight'])
    await page.keyboard.press(key);
  await expect.poll(() => childTexts(page, 'move')).toEqual(['alpha', 'beta', 'gamma']);
  expect((await mm(page)).undoDepth).toBe(0);
});
