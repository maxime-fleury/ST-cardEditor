import { expect } from '@playwright/test';

// Stub the OpenAI-compatible endpoint: the custom provider is pointed at a
// dead loopback port (127.0.0.1:9) and Playwright answers instead. Shared by
// the AI-chat and quick-actions specs.
export async function stubAI(page) {
  await page.route('http://127.0.0.1:9/v1/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'test-model', object: 'model', owned_by: 'test' }] }),
    });
  });
  await page.route('http://127.0.0.1:9/v1/**', async (route) => {
    // ONE JSON array streamed across two chunks (a real model streams the
    // array progressively; two separate arrays would parse as the first only).
    const body =
      'data: {"choices":[{"delta":{"content":"[\\"fantasy\\", \\"warrior\\", "}}]}\n' +
      'data: {"choices":[{"delta":{"content":"\\"elf\\", \\"cyberpunk\\"]"}}]}\n' +
      '\ndata: [DONE]\n\n';
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
}

// 1×1 red PNG — enough for the avatar pipeline (FileReader + canvas thumbnail).
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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
  // touching the provider select, or a late repopulation clobbers the position.
  await page.locator('#settingsModal.show').waitFor({ timeout: 5_000 });
  await page.waitForTimeout(700);
  await page.locator('#providerSelect').selectOption('custom');
  await expect(page.locator('#providerSelect')).toHaveValue('custom');
  await page.locator('#customApiUrlInput').fill(baseUrl);
  await page.locator('#customModelInput').fill(modelId);
  await page.locator('#btnSaveSettings').click();
  // <option> elements have no bounding box, so count them instead of toBeVisible.
  await expect(page.locator(`#aiModelSelect option[value="${modelId}"]`)).toHaveCount(1, { timeout: 120_000 });  await page.locator('#aiModelSelect').selectOption(modelId);
}
