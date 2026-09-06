import { test, expect } from '@playwright/test';
import { v2Card, importCards, collectErrors, TINY_PNG } from './helpers.js';

test('greetings: add, reorder, set default, delete, undo/redo', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('GreetHam', { alternate_greetings: [] })]);
  await page.locator('.card-list-item').first().click();
  await page.locator('#editorTabs .nav-link[data-bs-target="#tabAdvanced"]').click();
  await page.waitForTimeout(250);

  await page.locator('#btnAddGreeting').click();
  await page.locator('#greetingsList .greeting-textarea').nth(0).fill('greet one');
  await page.waitForTimeout(600);
  await page.locator('#btnAddGreeting').click();
  await page.locator('#greetingsList .greeting-textarea').nth(1).fill('greet two');
  await page.waitForTimeout(600);

  // Move the second greeting above the first.
  await page.locator('#greetingsList .greeting-item').nth(1).locator('.greeting-up').click();
  await page.waitForTimeout(120);
  // Mark the now-first greeting as the default first message.
  await page.locator('#greetingsList .greeting-item').nth(0).locator('.greeting-set-default').click();
  await page.waitForTimeout(150);
  // Delete the trailing greeting.
  await page.locator('#greetingsList .greeting-item').nth(1).locator('.greeting-delete').click();
  await page.waitForTimeout(300);
  // Undo restores it; redo deletes again.
  await page.evaluate(() => window.Editor.undo());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.AppState.activeCard.alternate_greetings.length)).toBe(2);
  await page.evaluate(() => window.Editor.redo());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.AppState.activeCard.alternate_greetings.length)).toBe(1);

  const state = await page.evaluate(() => window.AppState.activeCard);
  expect(state.alternate_greetings[0]).toBe('greet two'); // reorder stuck
  expect(state.first_mes).toBe('greet two'); // default stuck
  expect(errors, 'greetings flow must not throw').toEqual([]);
});

test('lorebook: add, edit, live-search filter, delete', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('LoreHam')]);
  await page.locator('.card-list-item').first().click();
  await page.locator('#editorTabs .nav-link[data-bs-target="#tabLorebook"]').click();
  await page.waitForTimeout(250);

  await page.locator('#btnAddLoreEntry').click();
  await page.waitForTimeout(100);
  const first = page.locator('.lorebook-accordion-item').first();
  await first.locator('[data-lore-toggle]').click();
  await first.locator('textarea[data-lore-idx]').fill('secret lore about dragons');
  await first.locator('input[data-lore-key-idx]').fill('dragon');
  await first.locator('input[data-lore-comment-idx]').fill('The Dragon');
  await page.waitForTimeout(700);

  // Search narrows to matching entries (key match), then to none.
  await page.locator('#lorebookSearchInput').fill('dragon');
  await page.waitForTimeout(400);
  await expect(page.locator('.lorebook-accordion-item')).toHaveCount(1);
  await page.locator('#lorebookSearchInput').fill('zzzz-nope');
  await page.waitForTimeout(400);
  await expect(page.locator('.lorebook-accordion-item')).toHaveCount(0);

  // Clear the search and delete the entry from the persisted card.
  await page.locator('#lorebookSearchInput').fill('');
  await page.waitForTimeout(400);
  await page.locator('.lorebook-accordion-item').first().locator('.lorebook-delete-btn').click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.AppState.activeCard.character_book.entries.length)).toBe(0);
  expect(errors, 'lorebook flow must not throw').toEqual([]);
});

test('avatar: set, persist across reload, remove, persist removal', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('Av')]);
  await page.locator('.card-list-item').first().click();
  await page.waitForTimeout(200);

  await page.locator('#avatarInput').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: TINY_PNG });
  await page.waitForTimeout(500);
  const afterSet = await page.evaluate(() => ({
    base64: window.AppState.activeCard._imageBase64,
    hasImage: window.AppState.activeCard._hasImage,
    src: document.querySelector('#charAvatarImg').getAttribute('src'),
  }));
  expect(afterSet.base64).toContain('data:image/png');
  expect(afterSet.hasImage).toBe(true);
  expect(afterSet.src).toContain('data:image/png');

  // The image is restored from IndexedDB after a reload.
  await page.reload();
  await page.locator('.card-list-item').first().click();
  await page.waitForTimeout(200);
  const afterReload = await page.evaluate(() => ({
    base64: window.AppState.activeCard._imageBase64,
    hasImage: window.AppState.activeCard._hasImage,
  }));
  expect(afterReload.base64).toContain('data:image/png');
  expect(afterReload.hasImage).toBe(true);

  // Remove via the Waifu-tab remove button, then verify the removal persists.
  await page.locator('#editorTabs .nav-link[data-bs-target="#tabWaifu"]').click();
  await page.waitForTimeout(250);
  await page.locator('#waifuBtnRemove').click();
  await page.waitForTimeout(300);
  const afterRemove = await page.evaluate(() => ({
    base64: window.AppState.activeCard._imageBase64 ?? null,
    hasImage: window.AppState.activeCard._hasImage,
    imgHidden: document.querySelector('#charAvatarImg').hidden,
  }));
  expect(afterRemove.base64).toBe(null);
  expect(afterRemove.hasImage).toBe(false);
  expect(afterRemove.imgHidden).toBe(true);

  await page.reload();
  await page.locator('.card-list-item').first().click();
  await page.waitForTimeout(200);
  const afterRemoveReload = await page.evaluate(() => ({
    base64: window.AppState.activeCard._imageBase64 ?? null,
    hasImage: window.AppState.activeCard._hasImage,
  }));
  expect(afterRemoveReload.base64).toBe(null);
  expect(afterRemoveReload.hasImage).toBe(false);
  expect(errors, 'avatar lifecycle must not throw').toEqual([]);
});

test('extensions editor: persist valid, reject invalid, undo, round-trip', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('ExHam')]);
  await page.locator('.card-list-item', { hasText: 'ExHam' }).click();
  await page.waitForTimeout(250);
  await page.locator('#editorTabs .nav-link[data-bs-target="#tabAdvanced"]').click();
  await page.waitForTimeout(250);

  const extTa = page.locator('#editExtensions');
  const status = page.locator('#extensionsStatus');

  // Valid JSON persists after the 600ms debounce.
  await extTa.fill('{\n  "project": "st",\n  "nums": [1,2,3]\n}');
  await page.waitForTimeout(1300);
  let ext = await page.evaluate(() => window.AppState.activeCard.extensions);
  expect(ext.project).toBe('st');
  expect(ext.nums).toEqual([1, 2, 3]);
  await expect(extTa).not.toHaveClass(/is-invalid-json/);

  // Invalid JSON is rejected, the old value kept, and the field flagged.
  await extTa.fill('{ "broken": ');
  await page.waitForTimeout(1300);
  ext = await page.evaluate(() => window.AppState.activeCard.extensions);
  expect(ext.project).toBe('st');
  await expect(extTa).toHaveClass(/is-invalid-json/);
  await expect(status).toHaveText(/Invalid JSON/);

  // Blur + refocus so the next edit is a NEW undo burst.
  await page.locator('#editName').click();
  await page.waitForTimeout(250);
  await extTa.click();
  await extTa.fill('{ "second": true }');
  await page.waitForTimeout(1300);
  await page.evaluate(() => window.Editor.undo());
  await page.waitForTimeout(300);
  ext = await page.evaluate(() => window.AppState.activeCard.extensions);
  expect(ext.project).toBe('st');
  expect(await extTa.inputValue()).toContain('"project"');

  // Extensions persist to IndexedDB and survive a reload.
  await page.reload();
  await page.locator('.card-list-item', { hasText: 'ExHam' }).click();
  await page.waitForTimeout(300);
  ext = await page.evaluate(() => window.AppState.activeCard.extensions);
  expect(ext.project).toBe('st');
  expect(errors, 'extensions flow must not throw').toEqual([]);
});

test('token budget badge tracks top-level, greetings, lorebook and extensions', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('Tk', { description: '', personality: '', scenario: '', first_mes: '', mes_example: '', alternate_greetings: [], tags: [] })]);
  await page.locator('.card-list-item', { hasText: 'Tk' }).click();
  await page.waitForTimeout(300);

  const badge = page.locator('#metaTokens');
  await expect(badge).toBeVisible();
  const readNum = async () => {
    const t = await badge.innerText();
    const m = t.match(/([\d.]+k?)\s+tokens/);
    return parseInt(m[1].replace('k', '000'), 10);
  };
  expect(await readNum()).toBeLessThan(40);

  // Top-level field edit.
  await page.locator('#editDescription').fill('word '.repeat(200));
  await page.waitForTimeout(1300);
  const afterDesc = await readNum();
  expect(afterDesc).toBeGreaterThan(100);

  // Greeting edit bumps the total (regression: badge went stale on greeting/lorebook edits).
  await page.locator('#editorTabs .nav-link[data-bs-target="#tabAdvanced"]').click();
  await page.waitForTimeout(250);
  await page.locator('#btnAddGreeting').click();
  await page.locator('#greetingsList .greeting-textarea').nth(0).fill('Hello there, gallant traveler.'.repeat(5));
  await page.waitForTimeout(1300);
  const afterGreet = await readNum();
  expect(afterGreet).toBeGreaterThan(afterDesc);

  // Lorebook content bumps it too.
  await page.locator('#editorTabs .nav-link[data-bs-target="#tabLorebook"]').click();
  await page.waitForTimeout(250);
  await page.locator('#btnAddLoreEntry').click();
  await page.waitForTimeout(200);
  const entry = page.locator('.lorebook-accordion-item').first();
  await entry.locator('[data-lore-toggle]').click();
  await page.waitForTimeout(150);
  await entry.locator('textarea[data-lore-idx]').fill('Deep secret lore about the realm.'.repeat(8));
  await page.waitForTimeout(1300);
  const afterLore = await readNum();
  expect(afterLore).toBeGreaterThan(afterGreet);

  expect(errors, 'budget badge must not throw').toEqual([]);
});

test('2.5.3: preview-mode chips, token-insert undo, persisted collapse, invalid-extensions budget', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [
    v2Card('Annar', { description: '', personality: '', scenario: '', first_mes: '', mes_example: '', alternate_greetings: [], tags: [] }),
    v2Card('Besta', { tags: [] }), v2Card('Coral', { tags: [] }), v2Card('Delta', { tags: [] }),
  ]);
  await page.locator('.card-list-item', { hasText: 'Annar' }).click();
  await page.waitForTimeout(300);

  // 1) Preview mode hides the token-insert chips for that field; Edit shows them again.
  const chips = page.locator('.token-insert-btn[data-target="editFirstMes"]');
  await expect(chips.first()).toBeVisible();
  await page.locator('.field-toggle-group[data-target="editFirstMes"] .field-toggle-btn[data-mode="preview"]').click();
  await page.waitForTimeout(200);
  await expect(chips.first()).toBeHidden();
  await page.locator('.field-toggle-group[data-target="editFirstMes"] .field-toggle-btn[data-mode="edit"]').click();
  await page.waitForTimeout(200);
  await expect(chips.first()).toBeVisible();

  // 2) A token insert is its own undo step: Ctrl+Z reverts exactly the token.
  const field = page.locator('#editFirstMes');
  await field.fill('Hello, adventurer.');
  await page.waitForTimeout(1200);
  // Leave + re-enter the field so the insert opens a fresh undo burst.
  await page.locator('#editScenario').click();
  await page.waitForTimeout(100);
  await field.click();
  await field.press('End');
  await chips.first().click();
  await page.waitForTimeout(1300);
  expect(await field.inputValue()).toBe('Hello, adventurer.{{char}}');
  await field.press('ControlOrMeta+z');
  await page.waitForTimeout(350);
  expect(await field.inputValue()).toBe('Hello, adventurer.');

  // 3) A collapsed letter-group survives a re-render driven by library search.
  await page.locator('#cardSortSelect').selectOption('name-asc');
  await page.locator('#cardSortSelect').dispatchEvent('change');
  await page.waitForTimeout(300);
  await page.locator('.card-group-header[data-letter="A"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator('.card-list-group[data-letter="A"] .card-list-item').first()).toBeHidden();
  await page.locator('#cardSearchInput').fill('a');
  await page.waitForTimeout(400);
  await expect(page.locator('.card-group-header[data-letter="A"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.card-list-group[data-letter="A"] .card-list-item').first()).toBeHidden();
  await page.locator('#cardSearchInput').fill('');

  // 4) Invalid Extensions JSON must not inflate the budget badge.
  const badge = page.locator('#metaTokens');
  const readToks = async () => parseInt((await badge.innerText()).match(/([\d.]+k?)\s+tokens/)[1].replace('k', '000'), 10);
  await page.locator('#editorTabs .nav-link[data-bs-target="#tabAdvanced"]').click();
  await page.waitForTimeout(250);
  const baseBudget = await readToks();
  await page.locator('#editExtensions').fill('{"unclosed": ');
  await page.waitForTimeout(1300);
  await expect(page.locator('#editExtensions')).toHaveClass(/is-invalid-json/);
  expect(await readToks()).toBe(baseBudget);
  await page.locator('#editExtensions').fill('{"config": "' + 'X'.repeat(1500) + '"}');
  await page.waitForTimeout(1300);
  expect(await readToks()).toBeGreaterThan(baseBudget);

  expect(errors, '2.5.3 fixes must not throw').toEqual([]);
});