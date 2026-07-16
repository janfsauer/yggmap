// @ts-check
/* The privacy promise, pinned: the app makes ZERO external requests — fonts
   are self-hosted from assets/fonts, everything else is same-origin. If this
   test ever fails, something started phoning out. */
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedMap } = require('./helpers');

test('fonts come from assets/fonts, no external requests', async ({ page }) => {
  const external = [];
  const localFonts = [];
  page.on('request', r => {
    const u = r.url();
    if (!u.startsWith('http://localhost')) external.push(u);
    if (u.includes('/assets/fonts/')) localFonts.push(u);
  });
  await seedMap(page, 'subscriptions', BRANCHES);
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      hand: document.fonts.check('16px "Patrick Hand"'),
      script: document.fonts.check('700 16px Caveat'),
    };
  });
  expect(loaded.hand).toBe(true);
  expect(loaded.script).toBe(true);
  expect(external).toEqual([]);
  expect(localFonts.length).toBeGreaterThan(0);
});
