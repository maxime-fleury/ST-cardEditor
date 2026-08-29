import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

export function v2Card(name, extra = {}) {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: `${name} is a test character with a mysterious past and a love of cats.`,
      personality: 'Brave but shy.',
      scenario: 'A rainy neon city.',
      first_mes: 'Hello, {{user}}. Welcome.',
      mes_example: '<START>\n{{char}}: Hi there.',
      creator_notes: 'Test card',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: ['Greeting one.'],
      tags: ['test'],
      creator: 'Tester',
      character_version: '1.0',
      extensions: {},
      ...extra,
    },
  });
}

export async function importCards(page, cards) {
  // Accept either card NAMES (wrapped here) or pre-built JSON strings (passed
  // through untouched — re-wrapping a JSON string would name the card after
  // its own JSON and silently drop any extra fields like character_book).
  const jsons = cards.map((c) => (typeof c === 'string' && !c.trim().startsWith('{') ? v2Card(c) : c));
  await page.setInputFiles(
    '#fileInput',
    jsons.map((json, i) => ({
      name: `card-${i}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(json),
    })),
  );
  await expect(page.locator('.card-list-item')).toHaveCount(jsons.length);
}

export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

// Point the custom provider at a live OpenAI-compatible endpoint via the real
// settings modal and select the model in the chat dropdown.
export async function configureCustomProvider(page, baseUrl, modelId) {
  await page.locator('#btnSettings').click();
  // openSettings() runs on shown.bs.modal and re-populates the form from saved
  // settings (after an async key unlock); give it time to finish before
  // touching the provider select, or a late repopulation clobbers the choice.
  await page.locator('#settingsModal.show').waitFor({ timeout: 5_000 });
  await page.waitForTimeout(700);
  await page.locator('#providerSelect').selectOption('custom');
  await expect(page.locator('#providerSelect')).toHaveValue('custom');
  await page.locator('#customApiUrlInput').fill(baseUrl);
  await page.locator('#customModelInput').fill(modelId);
  await page.locator('#btnSaveSettings').click();
  // <option> elements have no bounding box, so count them instead of toBeVisible.
  await expect(page.locator(`#aiModelSelect option[value="${modelId}"]`)).toHaveCount(1, { timeout: 120_000 });
  await page.locator('#aiModelSelect').selectOption(modelId);
}

export { readFileSync };