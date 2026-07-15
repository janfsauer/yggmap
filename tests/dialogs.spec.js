// @ts-check
const { test, expect } = require('@playwright/test');
const { BRANCHES, seedMap } = require('./helpers');

test('about panel opens from the help panel and hands over cleanly', async ({ page }) => {
  await seedMap(page, 'subscriptions', BRANCHES);

  await page.keyboard.press('?');
  await expect(page.locator('#backdrop')).toHaveClass(/open/);

  // the about link swaps panels: help closes, about opens — no stacking
  await page.locator('#aboutlink').click();
  await expect(page.locator('#backdrop')).not.toHaveClass(/open/);
  await expect(page.locator('#aboutbackdrop')).toHaveClass(/open/);
  await expect(page.locator('.mm-about')).toContainText('love letter');

  await page.keyboard.press('Escape');
  await expect(page.locator('#aboutbackdrop')).not.toHaveClass(/open/);

  // the map is usable again — Escape didn't leave a dialog swallowing keys
  await page.keyboard.press('Tab');
  await expect(page.locator('.mm-node.is-editing')).toHaveCount(1);
  await page.keyboard.press('Escape');
});
