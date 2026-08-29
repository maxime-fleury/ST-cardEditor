import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { v2Card, importCards, collectErrors, configureCustomProvider } from './helpers.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

// Stub the OpenAI-compatible endpoint: the custom provider is pointed at a
// dead loopback port (127.0.0.1:9) and Playwright answers instead.
async function stubAI(page) {
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

// ─── Tests ─────────────────────────────────────────────────────────────────

test('app boots with zero console errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#cardList')).toBeVisible();
  await expect(page.locator('#cardCount')).toHaveText(/0 cards/);
  await expect(page.locator('.quick-action[data-action="tags"]')).toBeVisible();
  await page.waitForTimeout(1200);
  expect(errors, 'unexpected console/page errors on boot').toEqual([]);
});

test('all 7 sort modes render without page errors', async ({ page }) => {
  // Regression: `const sorted` reassignment in the Manual sort branch crashed
  // every subsequent render (bun refused to compile the file).
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, ['Aria', 'Borin', 'Cael', 'Duna']);
  const select = page.locator('#cardSortSelect');
  await expect(select).toBeVisible();
  for (const value of ['manual', 'name-asc', 'name-desc', 'newest', 'oldest', 'largest', 'smallest']) {
    await select.selectOption(value);
    await page.waitForTimeout(150);
    await expect(page.locator('.card-list-item')).toHaveCount(4);
    expect(errors, `errors after switching to sort mode "${value}"`).toEqual([]);
  }
});

test('toast burst does not throw (Bootstrap dispose race)', async ({ page }) => {
  // Regression: evicting a shown toast called Bootstrap dispose(), which nulls
  // _element while the deferred show() transition callback still dereferences
  // it — every eviction crashed ~300ms later and cascaded through the error
  // boundary.
  const errors = collectErrors(page);
  await page.goto('/');
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    for (let i = 0; i < 8; i++) window.Ui.showToast('burst ' + i, 'info');
  });
  await page.waitForTimeout(2500);
  expect(errors, 'toast eviction must not throw').toEqual([]);
});

test('lorebook renders with numeric order and string keysecondary', async ({ page }) => {
  // Regression: escapeAttr() called .replace() on the numeric `order` field
  // (crashing every card with lore entries); string keysecondary also crashed.
  const errors = collectErrors(page);
  await page.goto('/');
  const loreNormal = [
    {
      keys: ['alpha'],
      keysecondary: ['beta'],
      content: 'Lore entry A',
      comment: 'Entry A',
      constant: false,
      selective: false,
      order: 100, // V2 spec: order is a NUMBER
      position: 'before_char',
      disable: false,
      exclude_recursion: false,
      probability: 100,
      useProbability: true,
    },
  ];
  await importCards(page, [
    v2Card('Normal', { character_book: { entries: loreNormal } }),
    v2Card('Malformed', {
      character_book: {
        entries: [{ keys: ['x'], keysecondary: 'not-an-array', order: '50', content: 'S' }],
      },
    }),
  ]);

  await page.locator('.card-list-item', { hasText: 'Normal' }).click();
  await page.locator('[data-bs-target="#tabLorebook"]').click();
  await expect(page.locator('#lorebookEntries .lorebook-accordion-item')).toHaveCount(1);
  await expect(page.locator('.lorebook-key-tag.primary', { hasText: 'alpha' })).toBeVisible();

  await page.locator('.card-list-item', { hasText: 'Malformed' }).click();
  await expect(page.locator('#lorebookEntries .lorebook-accordion-item')).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(errors, 'lorebook render must not throw').toEqual([]);
});

test('PNG export is a valid, re-importable PNG', async ({ page }) => {
  // Regression: the chara-dedupe rewrite dropped the 8-byte PNG signature, so
  // every exported PNG was rejected by viewers, SillyTavern, and the app's own
  // parser.
  await page.goto('/');
  await importCards(page, [v2Card('Picard')]);
  await page.locator('.card-list-item').first().click();

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#btnExportPng').click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const buf = readFileSync(filePath);

  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // The app's own parser must accept the file and recover the embedded card.
  // parsePNG is async and returns a NORMALIZED (flattened) card — name/spec
  // live at the top, not under data.
  const parsed = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const card = await window.CardEngine.parsePNG(bytes.buffer, 'roundtrip.png');
    return { name: card.name, spec: card.spec, spec_version: card.spec_version };
  }, buf.toString('base64'));
  expect(parsed.name).toBe('Picard');
  expect(parsed.spec).toBe('chara_card_v2');
  expect(parsed.spec_version).toBe('2.0');
});

test('wizard creates a blank card from name only', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btnWizardNav').click();
  await page.locator('#wizName').fill('Elara');
  for (let i = 0; i < 4; i++) {
    await page.locator('#wizBtnNext').click();
    await page.waitForTimeout(250);
  }
  await expect(page.locator('#wizBtnBlank')).toBeVisible();
  await page.locator('#wizBtnBlank').click();
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  await expect(page.locator('.card-list-name')).toHaveText(/Elara/);
});

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

test('PWA manifest and icons are served', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest.webmanifest');

  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');

  const icon = await request.get('/icons/icon-192.png');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toBe('image/png');
});
