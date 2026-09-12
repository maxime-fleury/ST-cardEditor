import { test, expect } from '@playwright/test';
import { v2Card, importCards, collectErrors } from './helpers.js';

// Ctrl/Cmd+K palette: open a card, jump to a field of the current card, or run
// an action. Each entry reuses the same code path as the button it mirrors.

test('palette opens with Ctrl+K, selects a card and runs an action', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('Aurora'), v2Card('Bishop')]);
  // Card rows in the palette come from the full-text index, which is built in an
  // idle callback after the first render. Wait for it explicitly: under a loaded
  // machine the query could otherwise run against a cold index, find no card and
  // rank an action first — a flake that looks like a palette bug.
  await page.waitForFunction(() => window.CardSearch && window.CardSearch.size >= 2, null, { timeout: 10_000 });

  // Opens from anywhere — including from inside a text field, where "go to
  // another field" is the whole point.
  await page.locator('.card-list-item', { hasText: 'Aurora' }).click();
  await page.locator('#editName').click();
  await expect(page.locator('#editName')).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(page.locator('#commandPalette.show')).toBeVisible();
  await expect(page.locator('#paletteInput')).toBeFocused();

  // A card name is found by the full-text index; Enter opens the card.
  await page.locator('#paletteInput').fill('bishop');
  await expect(page.locator('.palette-item').first()).toContainText('Bishop');
  await page.keyboard.press('Enter');
  await expect(page.locator('#commandPalette.show')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.CardState.activeCard?.name)).toBe('Bishop');

  // An action runs the same code as its button: the theme toggle is observable.
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.keyboard.press('Control+k');
  await page.locator('#paletteInput').fill('Toggle theme');
  await page.locator('.palette-item').first().click();
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).not.toBe(before);

  // A field entry switches to the tab that owns the field and focuses it.
  await page.keyboard.press('Control+k');
  await page.locator('#paletteInput').fill('scenario');
  await expect(page.locator('.palette-item').first()).toContainText('Scenario');
  await page.locator('.palette-item').first().click();
  await expect(page.locator('#editScenario')).toBeFocused();

  expect(errors, 'palette flow must not throw').toEqual([]);
});

test('palette ranks fields and actions and reports an empty query result', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('Solo')]);
  await page.locator('.card-list-item').first().click();

  await page.keyboard.press('Control+k');
  // Arrow keys move the highlight without touching the query.
  await page.locator('#paletteInput').fill('export');
  const first = await page.locator('.palette-item').first().innerText();
  expect(first.toLowerCase()).toContain('export');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.palette-item').nth(1)).toHaveClass(/active/);

  // Nothing matches: the palette says so instead of showing stale rows.
  await page.locator('#paletteInput').fill('zzzzz-nothing-matches');
  await expect(page.locator('.palette-empty')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#commandPalette.show')).toHaveCount(0);

  expect(errors, 'palette empty-state flow must not throw').toEqual([]);
});
