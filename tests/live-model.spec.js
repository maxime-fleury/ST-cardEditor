import { test, expect } from '@playwright/test';
import { v2Card, importCards, collectErrors, configureCustomProvider } from './helpers.js';

// Opt-in live-model suite: runs the real Suggest-tags and field-edit flows
// against an actual OpenAI-compatible endpoint (e.g. a local llama.cpp server),
// exercising real streaming, token counting, and JSON-array parsing that the
// stubbed smoke tests cannot. The default `bun test` stays hermetic — set
// RUN_LIVE_MODEL=1 to enable, and point at your server with LIVE_MODEL_URL /
// LIVE_MODEL_ID if it differs from the default.
const RUN_LIVE = process.env.RUN_LIVE_MODEL === '1';
const LIVE_URL = process.env.LIVE_MODEL_URL || 'http://172.27.176.1:3007/v1';
const LIVE_MODEL =
  process.env.LIVE_MODEL_ID ||
  'qwen3.5-9b-the-defiant-fable-uncensored-heretic-neo-imatrix-max-mtp';

test.describe('live OpenAI-compatible model', () => {
  test.skip(!RUN_LIVE, 'set RUN_LIVE_MODEL=1 to run against a real model');

  test('suggest-tags quick action merges real model output', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await page.goto('/');
    await importCards(page, [v2Card('TagLive')]);
    await page.locator('.card-list-item').first().click();
    await configureCustomProvider(page, LIVE_URL, LIVE_MODEL);

    await page.locator('.quick-action[data-action="tags"]').click();
    // The diff preview modal appears once the model responds with an array.
    await expect(page.locator('#aiPreviewModal')).toBeVisible({ timeout: 120_000 });
    await page.locator('#btnAcceptAI').click();

    // The curated 'test' tag is kept; the model's suggestions must be added.
    await expect(page.locator('#editTags')).not.toHaveValue('test');
    const tags = await page.evaluate(() => window.AppState.activeCard.tags);
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.length).toBeGreaterThan(1);
    expect(errors, 'live suggest-tags flow must not throw').toEqual([]);
  });

  test('field edit streams and applies against a real model', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await page.goto('/');
    await importCards(page, [v2Card('EditLive')]);
    await page.locator('.card-list-item').first().click();
    await configureCustomProvider(page, LIVE_URL, LIVE_MODEL);

    await page.locator('.ai-field-chip[data-field="description"]').click();
    await page.locator('#aiInput').fill('Rewrite the description in one short, vivid sentence.');
    await page.locator('#btnAiSend').click();

    await expect(page.locator('.multi-field-section.done')).toBeVisible({ timeout: 120_000 });
    await page.locator('.multi-field-section .ai-message-actions button', { hasText: 'Review & Apply' }).click();
    await expect(page.locator('#aiPreviewModal')).toBeVisible({ timeout: 30_000 });
    await page.locator('#btnAcceptAI').click();

    const desc = await page.locator('#editDescription').inputValue();
    expect(desc.trim().length).toBeGreaterThan(0);
    expect(errors, 'live field-edit flow must not throw').toEqual([]);
  });
});