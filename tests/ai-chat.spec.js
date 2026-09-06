import { test, expect } from '@playwright/test';
import { v2Card, importCards, stubAI, configureCustomProvider } from './helpers.js';

test('one chat message creates exactly one session', async ({ page }) => {
  // Regression: _updateSession() refreshed the stale session AND created a new
  // one, forking two identical conversations into the history panel.
  await page.goto('/');
  await importCards(page, [v2Card('Sessy')]);
  await page.locator('.card-list-item').first().click();
  await stubAI(page);
  await configureCustomProvider(page, 'http://127.0.0.1:9/v1', 'test-model');

  await page.locator('.ai-field-chip[data-field="description"]').click();
  await page.locator('#aiInput').fill('Make her more mysterious.');
  await page.locator('#btnAiSend').click();

  await expect(page.locator('.multi-field-section.done')).toBeVisible({ timeout: 15_000 });
  await page.locator('#btnChatHistory').click();
  await expect(page.locator('#aiHistoryList .ai-history-item')).toHaveCount(1);
});