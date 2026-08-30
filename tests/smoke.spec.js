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

test('switching cards clears stale AI chat and never duplicates history', async ({ page }) => {
  // Regression: renderChatHistory() bailed out with an empty history WITHOUT
  // clearing the DOM or latching _historyRendered, so a card with no chat
  // showed the previous card's messages; cards with history STACKED their
  // transcripts on top of the previous card's, and switching back re-appended
  // the whole history (duplicates).
  const errors = collectErrors(page);
  await page.goto('/');
  await page.evaluate(async () => {
    const seed = async (name, sid, msgs) => {
      const card = CardEngine.createEmptyCard();
      card.name = name;
      await CardStorage.upsertCard(card);
      if (!msgs) return;
      const now = Date.now();
      CardStorage.saveChatSession(card._id, {
        id: sid,
        created: now,
        lastUpdated: now,
        preview: msgs[0].content,
        messageCount: msgs.length,
      });
      CardStorage.saveSessionMessages(card._id, sid, msgs);
    };
    await seed('Aria', 'ses_a_0001', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    await seed('Borin', 'ses_b_0001', [
      { role: 'user', content: 'ola' },
      { role: 'assistant', content: 'hola' },
    ]);
    await seed('Cleo', null, null); // no chat at all
  });
  await page.reload();
  await expect(page.locator('.card-list-item')).toHaveCount(3);

  // Card with history renders its own two messages...
  await page.locator('.card-list-item', { hasText: 'Aria' }).click();
  await expect(page.locator('#aiChatMessages .ai-message')).toHaveCount(2);

  // ...and a second card with history renders ITS OWN two — not Aria's plus
  // its own stacked below.
  await page.locator('.card-list-item', { hasText: 'Borin' }).click();
  await expect(page.locator('#aiChatMessages .ai-message')).toHaveCount(2);

  // A card with no chat must show the welcome, never the previous chat.
  await page.locator('.card-list-item', { hasText: 'Cleo' }).click();
  await expect(page.locator('#aiChatMessages .ai-message')).toHaveCount(0);
  await expect(page.locator('#aiChatMessages .ai-welcome')).toBeVisible();

  // Switching back to a card with history renders it exactly once.
  await page.locator('.card-list-item', { hasText: 'Aria' }).click();
  await expect(page.locator('#aiChatMessages .ai-message')).toHaveCount(2);

  expect(errors, 'card-switch chat flow must not throw').toEqual([]);
});

test('appearance presets and settings apply live without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await page.locator('#btnSettings').click();
  await page.locator('#settingsModal.show').waitFor({ timeout: 5_000 });
  await page.waitForTimeout(500);

  // Curated accent swatch applies in realtime.
  await page.locator('.accent-swatch[title="Magenta"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-accent-custom', 'true');

  // Density, radius and vignette are applied live as CSS variables.
  await page.locator('#glassDensitySelect').selectOption('bold');
  await page.locator('#cardRadiusSelect').selectOption('rounded');
  await page.locator('#vignetteToggle').uncheck();
  const vars = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue('--accent-500').trim(),
      blur: cs.getPropertyValue('--glass-blur').trim(),
      radius: cs.getPropertyValue('--radius-sm').trim(),
      vignette: cs.getPropertyValue('--vignette-opacity').trim(),
    };
  });
  expect(vars.accent).toBe('#ec4899');
  expect(vars.blur).toBe('blur(22px)');
  expect(vars.radius).toBe('10px');
  expect(vars.vignette).toBe('0');

  await page.locator('#btnSaveSettings').click();
  await page.waitForTimeout(300);
  expect(errors, 'appearance flow must not throw').toEqual([]);
});

test('panel collapse, focus mode and dirty indicator work without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('DirtyTest')]);
  await page.locator('.card-list-item').first().click();
  await page.waitForTimeout(250);

  // Collapse the left panel.
  await page.locator('#btnCollapseLeft').click();
  await expect(page.locator('#appContainer')).toHaveClass(/side-left-collapsed/);

  // Focus mode collapses both.
  await page.locator('#btnFocusMode').click();
  await expect(page.locator('#appContainer')).toHaveClass(/side-left-collapsed/);
  await expect(page.locator('#appContainer')).toHaveClass(/side-right-collapsed/);

  // The edge chevron re-expands the left panel.
  await page.locator('#edgeExpandLeft').click();
  await expect(page.locator('#appContainer')).not.toHaveClass(/side-left-collapsed/);

  // Editing shows the modified dot on the active card row + Save dirty state.
  await page.locator('#editName').fill('Changed');
  await expect(page.locator('.card-list-item.active .card-modified-dot')).toBeVisible();
  await expect(page.locator('#btnSaveCard.is-dirty')).toBeVisible();
  await page.locator('#btnSaveCard').click();
  await expect(page.locator('.card-list-item.active .card-modified-dot')).toHaveCount(0);

  expect(errors, 'collapse/focus/dirty flow must not throw').toEqual([]);
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

test('server sends CSP headers and gates the proxy by Origin', async ({ request }) => {
  // Security postures that would silently regress (dropped CSP, open relay).
  const page = await request.get('/');
  const csp = page.headers()['content-security-policy'] || '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain('script-src');
  expect(csp).toContain('connect-src');

  // A cross-origin Origin must be rejected without proxying upstream.
  const evil = await request.get('/api/models', { headers: { origin: 'https://evil.example' } });
  expect(evil.status()).toBe(403);
});

test('cards persist across reload (IndexedDB)', async ({ page }) => {
  await page.goto('/');
  await importCards(page, ['Persist']);
  // Await the debounced IndexedDB write completes.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  await expect(page.locator('.card-list-name')).toHaveText(/Persist/);
});

test('service worker serves the app shell offline with cached CDN', async ({ page, context }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  // Wait until the SW controls the page and has had time to runtime-cache the
  // CDN assets (Bootstrap CSS/JS). Growing the list hides controls; this page
  // is the default empty state but the navbar + sheets still load CDN.
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() =>
      navigator.serviceWorker.controller
        ? true
        : new Promise((res) => navigator.serviceWorker.addEventListener('controllerchange', () => res(true), { once: true }))
    ));
  await page.waitForTimeout(2000);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#appContainer')).toBeVisible();

  // Bootstrap CSS was cached by the SW, so the navbar is still sticky offline.
  const sticky = await page.evaluate(() => getComputedStyle(document.querySelector('#topNav')).position);
  expect(sticky).toBe('sticky');
  // No JS errors; ignore cosmetic resource-load logs from uncached extras.
  expect(errors.filter((e) => !/Failed to load resource|ERR_|favicon/i.test(e))).toEqual([]);
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
  await expect(page.locator('#dialogSelect option')).toHaveCount(21);
  await page.locator('#dialogCancel').click();
  await expect(page.locator('#dialogModal')).not.toBeVisible();
});

// 1×1 red PNG — enough for the avatar pipeline (FileReader + canvas thumbnail).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// ─── Editor interaction coverage (greetings / lorebook / duplicate / avatar) ─

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

test('duplicate card then delete with confirm', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [v2Card('DupSource')]);
  await page.locator('.card-list-item').first().click();
  await page.locator('#btnDuplicateCard').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.card-list-item')).toHaveCount(2);
  // The clone becomes active with a "(Copy)" suffix.
  expect(await page.evaluate(() => window.AppState.activeCard.name)).toContain('Copy');

  // Reselect the original (exact name — the clone contains "DupSource" too) and
  // delete it through the in-app confirm dialog.
  await page.locator('.card-list-item').filter({ has: page.getByText('DupSource', { exact: true }) }).click();
  await page.waitForTimeout(150);
  await page.locator('#btnDeleteCard').click();
  await page.locator('#dialogOk').click();
  await page.waitForTimeout(400);
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  expect(await page.evaluate(() => window.AppState.cards[0].name)).toContain('Copy');
  expect(errors, 'duplicate/delete flow must not throw').toEqual([]);
});

test('rapid card switching never cross-writes debounced edits', async ({ page }) => {
  // Regression for #75: a debounced editor sync firing mid card-switch must not
  // persist one card's values into another.
  const errors = collectErrors(page);
  await page.goto('/');
  // Import one card with description filled, plus five that stay empty.
  const withDesc = v2Card('Hold');
  await importCards(page, [withDesc, v2Card('Empty2'), v2Card('Empty3'), v2Card('Empty4'), v2Card('Empty5'), v2Card('Empty6')]);
  await page.locator('.card-list-item', { hasText: 'Hold' }).click();
  await page.locator('#editName').fill('Hold Renamed');
  for (let i = 2; i <= 6; i++) {
    await page.locator('.card-list-item', { hasText: 'Empty' + i }).click();
  }
  await page.waitForTimeout(1000); // let the 500ms debounce (and its guard) run

  // Every OTHER card must still hold its own data: no name drift and no card
// absorbed the "Hold" text typed into the previous card (its own template
// description legitimately contains "Hold is a test character…").
  const contaminated = await page.evaluate(async () => {
    const bad = [];
    for (const meta of CardStorage.getCards()) {
      if (meta.name === 'Hold Renamed') continue;
      const full = await CardStorage.getCard(meta._id);
      if (!full) continue;
      if (full.name !== meta.name) bad.push('name:' + meta.name);
      if ((full.description || '').includes('Hold')) bad.push('desc:' + meta.name);
    }
    return bad;
  });
  expect(contaminated, 'no cross-card write contamination').toEqual([]);
  // And the intended card kept its edit (proves the writes aren't just lost).
  const heldName = await page.evaluate(async () => {
    const meta = CardStorage.getCards().find((c) => c.name === 'Hold Renamed');
    if (!meta) return null;
    const full = await CardStorage.getCard(meta._id);
    return full ? full.name : null;
  });
  expect(heldName).toBe('Hold Renamed');
  expect(errors, 'rapid-switch flow must not throw').toEqual([]);
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

// ─── 2.5.1 features: Extensions editor, token budget, grouped library ───────

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

test('grouped library: letter groups, collapse, tag chips, persisted sort', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await importCards(page, [
    v2Card('Alpha', { tags: ['rpg'] }), v2Card('Bravado', { tags: ['rpg'] }),
    v2Card('Citroen', { tags: ['modern'] }), v2Card('delta', { tags: ['modern'] }),
    v2Card('Zed', { tags: [] }), v2Card('1Nine', { tags: [] }), v2Card('.hidden', { tags: [] }),
  ]);

  await page.locator('#cardSortSelect').selectOption('name-asc');
  await page.locator('#cardSortSelect').dispatchEvent('change');
  await page.waitForTimeout(300);
  const letters = await page.evaluate(() =>
    [...document.querySelectorAll('.card-group-header')].map((h) => h.dataset.letter)
  );
  expect(letters[0]).toBe('#');
  expect(letters).toEqual(['#', '1', 'A', 'B', 'C', 'D', 'Z']);

  // Collapse/expand the A group.
  await page.locator('.card-group-header[data-letter="A"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator('.card-group-header[data-letter="A"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.card-list-group[data-letter="A"] .card-list-item').first()).toBeHidden();
  await page.locator('.card-group-header[data-letter="A"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator('.card-group-header[data-letter="A"]')).toHaveAttribute('aria-expanded', 'true');

  // Under name-asc sorting a drop must not reshuffle the (invisible) manual order.
  const orderBefore = await page.evaluate(() => window.AppState.cards.map((c) => c.name));
  await page.locator('.card-drag-handle[data-card-id]').first().dispatchEvent('dragstart');
  await page.locator('.card-list-item', { hasText: 'Bravado' }).dispatchEvent('dragover');
  await page.locator('.card-list-item', { hasText: 'Bravado' }).dispatchEvent('drop');
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.AppState.cards.map((c) => c.name))).toEqual(orderBefore);

  // Tag chips filter the library.
  await page.locator('#tagChipStrip .tag-chip-strip-chip[data-tag="modern"]').first().click();
  await page.waitForTimeout(250);
  await expect(page.locator('.card-list-item')).toHaveCount(2);

  // Sort mode persists after a reload.
  await page.locator('#cardSortSelect').selectOption('name-desc');
  await page.locator('#cardSortSelect').dispatchEvent('change');
  await page.reload();
  await expect(page.locator('#cardSortSelect')).toHaveValue('name-desc');
  expect(await page.locator('.card-list-item .card-list-name').first().innerText()).toBe('Zed');

  expect(errors, 'grouped library must not throw').toEqual([]);
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
