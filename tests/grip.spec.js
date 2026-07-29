// @ts-check
/* The drag tab: a paper folder-tab peeking from behind a node's top edge.
   Desktop: appears only on mouse hover (any node, focus not required).
   Touch: rides the focused node instead — there is no hover to lean on.
   Press-and-drag = drag and drop; press-and-release = grab mode. */
const { test, expect } = require('@playwright/test');
const { seedMap, mm, lsGet, idOf, focusNode } = require('./helpers');

const GRIP_BRANCHES = [
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

/* wait for a locator's box to stop moving (glide/settle animations) */
async function settledBox(page, locator) {
  let prev = null;
  await expect.poll(async () => {
    const b = await locator.boundingBox();
    const same = !!(prev && b && Math.abs(b.x - prev.x) < .5 && Math.abs(b.y - prev.y) < .5);
    prev = b;
    return same;
  }).toBe(true);
  return prev;
}

test('desktop: the tab leans out on hover — any node, focus not required', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES);
  await expect(page.locator('.mm-grip')).toBeHidden();

  // a1 is not focused — hover alone brings the tab out
  await page.locator('.mm-node', { hasText: 'a1' }).hover();
  await expect(page.locator('.mm-grip')).toBeVisible();

  // the root offers no tab
  await page.locator('.mm-node', { hasText: 'grip' }).hover();
  await expect(page.locator('.mm-grip')).toBeHidden();

  // empty paper tucks it away too
  await page.locator('.mm-node', { hasText: 'a1' }).hover();
  await expect(page.locator('.mm-grip')).toBeVisible();
  await page.mouse.move(150, (page.viewportSize()).height / 2);
  await expect(page.locator('.mm-grip')).toBeHidden();
});

test('editing hides the tab even under the mouse', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES);
  const a1 = await idOf(page, 'a1');
  await focusNode(page, a1);
  await page.locator(`.mm-node[data-id="${a1}"]`).hover();
  await expect(page.locator('.mm-grip')).toBeVisible();

  await page.keyboard.press('F2');
  await expect(page.locator('.mm-grip')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mm-grip')).toBeVisible();
});

test('touch: the tab rides the focused node, no hover needed', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES, { 'mindmaps.ui.v2': { forceMobile: true } });
  await expect(page.locator('.mm-grip')).toBeHidden(); // root focused at load

  await focusNode(page, await idOf(page, 'a2'));
  await page.mouse.move(5, 5); // park the mouse — focus alone must carry it
  await expect(page.locator('.mm-grip')).toBeVisible();
});

test('clicking the tab picks the hovered node up — and focuses it', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES);
  const a2 = await idOf(page, 'a2');

  await page.locator(`.mm-node[data-id="${a2}"]`).hover(); // a2 is NOT focused
  await page.locator('.mm-grip').click();
  await expect.poll(async () => (await mm(page)).grabId).toBe(a2);
  expect((await mm(page)).focusId).toBe(a2);

  await page.locator('.mm-node', { hasText: 'beta' }).click();
  await expect.poll(() => childTexts(page, 'beta')).toEqual(['b1', 'a2']);
  expect((await mm(page)).grabId).toBe(null);
});

test('dragging the tab onto a target drops there', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES);
  const a2 = await idOf(page, 'a2');

  await page.locator(`.mm-node[data-id="${a2}"]`).hover();
  const grip = await settledBox(page, page.locator('.mm-grip'));
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 3);
  await page.mouse.down();
  await page.mouse.move(grip.x + 40, grip.y + 40, { steps: 3 }); // cross the threshold
  await expect.poll(async () => (await mm(page)).grabId).toBe(a2);

  const beta = await settledBox(page, page.locator('.mm-node', { hasText: 'beta' }));
  await page.mouse.move(beta.x + beta.width / 2, beta.y + beta.height / 2, { steps: 5 });
  await expect(page.locator('.mm-node', { hasText: 'beta' })).toHaveClass(/is-drop-target/);

  await page.mouse.up();
  await expect.poll(() => childTexts(page, 'beta')).toEqual(['b1', 'a2']);
  expect(await childTexts(page, 'a2')).toEqual(['sub']); // subtree traveled
  expect((await mm(page)).grabId).toBe(null);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);
});

test('mid-drag, connector lines follow the flying card — never its empty slot', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES);
  await page.locator('.mm-node', { hasText: 'a2' }).hover();

  const grip = await settledBox(page, page.locator('.mm-grip'));
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 3);
  await page.mouse.down();
  await page.mouse.move(grip.x + 220, grip.y + 140, { steps: 8 });
  await page.waitForTimeout(450); // outlive the 360ms post-refresh link animation

  // nearest link terminal must sit at the dragged card, not 200px behind it
  const nearest = await page.evaluate(() => {
    const r = document.querySelector('.mm-node.is-dragging').getBoundingClientRect();
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const m = new DOMMatrix(getComputedStyle(document.getElementById('world')).transform);
    let best = Infinity;
    for (const p of document.querySelectorAll('#links path')) {
      const nums = (p.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g).map(Number);
      for (const [x, y] of [[nums[0], nums[1]], [nums[nums.length - 2], nums[nums.length - 1]]]) {
        const pt = m.transformPoint({ x, y });
        best = Math.min(best, Math.hypot(pt.x - cx, pt.y - cy));
      }
    }
    return best;
  });
  await page.mouse.up();
  expect(nearest).toBeLessThan(120);
});

test('a missed pointerup cannot strand the card mid-air — buttons=0 ends the drag', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES);
  await page.locator('.mm-node', { hasText: 'a2' }).hover();

  const grip = await settledBox(page, page.locator('.mm-grip'));
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 3);
  await page.mouse.down();
  await page.mouse.move(grip.x + 40, grip.y + 40, { steps: 3 });
  await expect.poll(async () => (await mm(page)).grabId).not.toBe(null);

  // the browser lost the pointerup (release outside the window, focus switch…):
  // the next move arrives with no button held — the drag must resolve, here as
  // a drop onto the node under the cursor
  const beta = await settledBox(page, page.locator('.mm-node', { hasText: 'beta' }));
  await page.evaluate(([x, y]) => {
    document.querySelector('.mm-grip').dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: x, clientY: y, buttons: 0, pointerType: 'mouse',
    }));
  }, [beta.x + beta.width / 2, beta.y + beta.height / 2]);

  await expect.poll(async () => (await mm(page)).grabId).toBe(null);
  await expect.poll(() => childTexts(page, 'beta')).toEqual(['b1', 'a2']);
  // and the card is truly back on the paper — no stale translate left behind
  const translate = await page.locator('.mm-node', { hasText: 'a2' }).evaluate(el => el.style.translate);
  expect(translate).toBe('');
  await page.mouse.up(); // let go of Playwright's virtual button
});

test('a drag released over empty paper snaps back, no undo entry', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES);
  await page.locator('.mm-node', { hasText: 'a2' }).hover();

  const grip = await settledBox(page, page.locator('.mm-grip'));
  const size = page.viewportSize();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 3);
  await page.mouse.down();
  await page.mouse.move(40, size.height - 60, { steps: 6 });
  await page.mouse.up();

  expect(await childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);
  const state = await mm(page);
  expect(state.grabId).toBe(null);
  expect(state.undoDepth).toBe(0);
});

test('a drag released over the grabbed subtree itself snaps back', async ({ page }) => {
  await seedMap(page, 'grip', GRIP_BRANCHES);
  const a2 = await idOf(page, 'a2');
  await page.locator(`.mm-node[data-id="${a2}"]`).hover();

  const grip = await settledBox(page, page.locator('.mm-grip'));
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 3);
  await page.mouse.down();
  await page.mouse.move(grip.x + 40, grip.y + 40, { steps: 3 });
  await expect.poll(async () => (await mm(page)).grabId).toBe(a2);

  const sub = await settledBox(page, page.locator('.mm-node', { hasText: 'sub' }));
  await page.mouse.move(sub.x + sub.width / 2, sub.y + sub.height / 2, { steps: 5 });
  await expect(page.locator('.mm-node', { hasText: 'sub' })).not.toHaveClass(/is-drop-target/);
  await page.mouse.up();

  expect(await childTexts(page, 'alpha')).toEqual(['a1', 'a2', 'a3']);
  expect((await mm(page)).undoDepth).toBe(0);
});
