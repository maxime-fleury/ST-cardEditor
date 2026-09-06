import { test, expect } from '@playwright/test';
import { v2Card, importCards, collectErrors, stubAI, configureCustomProvider } from './helpers.js';

test('AI suggest-tags quick action merges tags via the diff modal', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('TagMe')]);
  await page.locator('.card-list-item').first().click();
  await stubAI(page);
  await configureCustomProvider(page, 'http://127.0.0.1:9/v1', 'test-model');

  await page.locator('.quick-action[data-action="tags"]').click();
  await expect(page.locator('#aiPreviewModal')).toBeVisible();
  await page.locator('#btnAcceptAI').click();

  // Existing tag "test" is kept; suggested tags are merged in (dedupe).
  await expect(page.locator('#editTags')).toHaveValue(/test, fantasy, warrior, elf/);
  const tags = await page.evaluate(() => window.AppState.activeCard.tags);
  expect(tags).toEqual(expect.arrayContaining(['test', 'fantasy', 'warrior', 'elf', 'cyberpunk']));
  expect(errors, 'tag suggestion flow must not throw').toEqual([]);
});

test('translate quick action opens the in-app language dialog', async ({ page }) => {
  // Regression: the Translate flow used window.prompt (native dialog), which
  // is blocked in sandboxed iframes/PWAs. Now it opens the app's own modal
  // with a <select> of all supported languages.
  await page.goto('/');
  await importCards(page, [v2Card('Ling')]);
  await page.locator('.card-list-item').first().click();
  await stubAI(page);
  await configureCustomProvider(page, 'http://127.0.0.1:9/v1', 'test-model');

  await page.locator('.quick-action[data-action="translate"]').click();
  await expect(page.locator('#dialogModal')).toBeVisible();
  await expect(page.locator('#dialogSelect option')).toHaveCount(27);
  await page.locator('#dialogCancel').click();
  await expect(page.locator('#dialogModal')).not.toBeVisible();
});