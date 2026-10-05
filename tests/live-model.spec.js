import { test, expect } from '@playwright/test';
import { v2Card, importCards, collectErrors, configureCustomProvider } from './helpers.js';

// OpenAI-compatible model suite. By default it runs hermetically against the
// scripted mock server (tests/mock-ai-server.mjs, started by playwright.config),
// exercising real streaming, token counting, and JSON-array parsing that the
// stubbed smoke tests cannot. Set RUN_LIVE_MODEL=1 to run against an actual
// endpoint (e.g. a local llama.cpp server) via LIVE_MODEL_URL / LIVE_MODEL_ID.
const RUN_LIVE = process.env.RUN_LIVE_MODEL === '1';
const LIVE_URL = RUN_LIVE
  ? (process.env.LIVE_MODEL_URL || 'http://172.27.176.1:3007/v1')
  : `http://localhost:${process.env.MOCK_AI_PORT || '9900'}/v1`;
const LIVE_MODEL = RUN_LIVE
  ? (process.env.LIVE_MODEL_ID || 'qwen3.5-9b-the-defiant-fable-uncensored-heretic-neo-imatrix-max-mtp')
  : 'mock-model';

test.describe('OpenAI-compatible model', () => {

  test('suggest-tags quick action merges model output', async ({ page }) => {
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
    const tags = await page.evaluate(() => window.CardState.activeCard.tags);
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.length).toBeGreaterThan(1);
    expect(errors, 'live suggest-tags flow must not throw').toEqual([]);
  });

  test('Test Connection reports the round trip and names the endpoint it cannot reach', async ({ page }) => {
    test.setTimeout(120_000);
    // This test deliberately aims at a dead port for the failure case, so drop
    // exactly that expected connection-refused noise and keep everything else.
    const errors = collectErrors(page).filter((e) => !/ERR_CONNECTION_REFUSED|Failed to load resource/i.test(e));
    await page.goto('/');
    await configureCustomProvider(page, LIVE_URL, LIVE_MODEL);

    await page.locator('#btnSettings').click();
    await page.locator('#settingsModal.show').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(700); // openSettings() repopulates asynchronously

    const result = page.locator('#testConnectionResult');
    await page.locator('#btnTestConnection').click();
    // Success names the model, the round-trip time and the timeout in effect.
    await expect(result).toContainText(LIVE_MODEL, { timeout: 60_000 });
    await expect(result).toContainText('answered in');
    await expect(page.locator('#btnTestConnection')).toBeEnabled();

    // A different failure must be recognizable as such: an endpoint that refuses
    // connections is reported as unreachable, with the URL that was tried —
    // not as one generic "AI Error".
    await page.locator('#customApiUrlInput').fill('http://localhost:1/v1');
    await page.locator('#btnTestConnection').click();
    await expect(result).toContainText('Cannot reach http://localhost:1/v1', { timeout: 30_000 });

    expect(errors, 'the connection test must not throw').toEqual([]);
  });

  test('a dead endpoint is named in the chat instead of a generic AI error', async ({ page }) => {
    test.setTimeout(150_000);
    // The endpoint is deliberately dead here; only its expected
    // connection-refused noise is filtered out.
    const errors = collectErrors(page).filter((e) => !/ERR_CONNECTION_REFUSED|Failed to load resource/i.test(e));
    await page.goto('/');
    await importCards(page, [v2Card('DeadEndpoint')]);
    await page.locator('.card-list-item').first().click();
    // Configure normally first (that is what selects the model in the navbar,
    // which needs a reachable /models), then point the endpoint at a closed port.
    await configureCustomProvider(page, LIVE_URL, LIVE_MODEL);
    await page.locator('#btnSettings').click();
    await page.locator('#settingsModal.show').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(700);
    await page.locator('#customApiUrlInput').fill('http://localhost:1/v1');
    await page.locator('#btnSaveSettings').click();
    await expect(page.locator('#settingsModal')).not.toHaveClass(/show/, { timeout: 10_000 });

    await page.locator('.ai-field-chip[data-field="description"]').click();
    await page.locator('#aiInput').fill('Rewrite the description.');
    await page.locator('#btnAiSend').click();

    // The failing section says which endpoint could not be reached — not
    // "Error: Failed to fetch".
    const section = page.locator('.multi-field-section.error').first();
    await expect(section).toBeVisible({ timeout: 60_000 });
    await expect(section).toContainText('Cannot reach http://localhost:1/v1');
    expect(errors, 'a failed generation must not throw').toEqual([]);
  });

  test('field edit streams and applies', async ({ page }) => {
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
    await page.locator('.multi-field-section .multi-field-actions button', { hasText: 'Review & Apply' }).click();
    await expect(page.locator('#aiPreviewModal')).toBeVisible({ timeout: 30_000 });
    await page.locator('#btnAcceptAI').click();

    const desc = await page.locator('#editDescription').inputValue();
    expect(desc.trim().length).toBeGreaterThan(0);
    expect(errors, 'live field-edit flow must not throw').toEqual([]);
  });
});