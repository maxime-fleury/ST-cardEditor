import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { v2Card, importCards, collectErrors } from './helpers.js';

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

test('service worker serves the vendored app shell offline', async ({ page, context }) => {
  const errors = collectErrors(page);
  // Nothing at all may leave the origin: Bootstrap, icons, jsdiff, anime.js,
  // marked, DOMPurify *and the typefaces* are all vendored and served
  // same-origin, which is what makes the offline shell (and `script-src
  // 'self'` / `font-src 'self'`) reliable. Google Fonts was the last holdout,
  // so unlike before there is no longer an exemption here — this is the
  // regression guard for the CDN → vendored migration.
  const external = [];
  page.on('request', (req) => {
    const url = req.url();
    if (/^(http:\/\/localhost|data:|blob:)/.test(url)) return;
    external.push(url);
  });

  await page.goto('/');
  // Wait until the SW controls the page and has had time to serve the shell
  // (Bootstrap CSS/JS included) from its precache.
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() =>
      navigator.serviceWorker.controller
        ? true
        : new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', () => res(true), { once: true }); })
    ));
  await page.waitForTimeout(2000);
  expect(external, 'no script, stylesheet or font may be fetched from another origin').toEqual([]);

  // "No external requests" would also pass if the webfonts silently fell back
  // to a system face, so check the files were actually fetched — and exactly
  // once. The count matters: adding <link rel=preload as=font> for these two
  // made Chrome fetch each of them twice (the @font-face fetch did not reuse
  // the preload), so this asserts the single-fetch that motivated dropping the
  // preloads rather than trusting that comment in index.html.
  const fontFetches = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => new URL(entry.name).pathname)
    .filter((path) => path.endsWith('.woff2')));
  const count = (path) => fontFetches.filter((p) => p === path).length;
  for (const face of ['/vendor/fonts/inter-latin.woff2', '/vendor/fonts/plus-jakarta-sans-latin.woff2']) {
    expect(count(face), `${face} must be fetched exactly once`).toBe(1);
  }

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#appContainer')).toBeVisible();

  // The stylesheet came from the precache, so the navbar is still sticky offline.
  const sticky = await page.evaluate(() => getComputedStyle(document.querySelector('#topNav')).position);
  expect(sticky).toBe('sticky');
  // …and the typeface did too, instead of dropping to a fallback face.
  const interLoaded = await page.evaluate(() => document.fonts.check('16px "Inter"'));
  expect(interLoaded, 'the vendored font must still render offline').toBe(true);
  // No JS errors; ignore cosmetic resource-load logs from uncached extras.
  expect(errors.filter((e) => !/Failed to load resource|ERR_|favicon/i.test(e))).toEqual([]);
});

test('language packs load on demand, one at a time', async ({ page }) => {
  // The 26 non-English dictionaries used to be static imports: 845 KB of the
  // 1.2 MB boot chunk, i.e. 71% of the JavaScript every user downloaded so that
  // each user could read one of them. This pins both halves of the replacement —
  // nothing is fetched for English, and choosing a language fetches exactly that
  // language.
  const errors = collectErrors(page);
  const jsRequests = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/js/')) jsRequests.push(path);
  });

  await page.goto('/');
  await expect(page.locator('#cardList')).toBeVisible();
  expect(jsRequests.filter((p) => p.startsWith('/js/i18n/')), 'English is bundled, nothing to fetch').toEqual([]);

  await page.locator('#btnSettings').click();
  await page.locator('#settingsModal.show').waitFor({ timeout: 5_000 });
  await page.locator('#languageSelect').selectOption('fr');

  await expect.poll(() => jsRequests.filter((p) => p.startsWith('/js/i18n/'))).toEqual(['/js/i18n/fr.js']);

  // The DOM really was re-translated, not just the internal state: the title and
  // a data-i18n element show French, and no other locale was fetched.
  await expect(page).toHaveTitle(/Studio de cartes de personnages/);
  await expect(page.locator('[data-i18n="editor.preview"]').first()).toHaveText('Aperçu');
  // The AI welcome screen too. It is HTML aiChat.js generates with I18n.t() and
  // carries no data-i18n attributes, so it is invisible to translateDOM() — it
  // kept the language it was first drawn in until the language-changed hook
  // learned to rebuild it.
  await expect(page.locator('#aiChatMessages .ai-welcome h6')).toHaveText('Assistant IA de cartes');
  await expect(page.locator('#aiChatMessages .quick-action[data-action="translate"]')).toContainText('Traduire');
  expect(await page.evaluate(() => window.I18n.getLang())).toBe('fr');
  expect(errors, 'language switch must not throw').toEqual([]);
});

test('a language works offline once used, and falls back with a message otherwise', async ({ page, context }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  // The service worker has to be in control before the switch, or the dictionary
  // is fetched straight from the network and never enters the runtime cache.
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() =>
      navigator.serviceWorker.controller
        ? true
        : new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', () => res(true), { once: true }); })
    ));

  await page.locator('#btnSettings').click();
  await page.locator('#settingsModal.show').waitFor({ timeout: 5_000 });
  await page.locator('#languageSelect').selectOption('fr');
  await expect.poll(() => page.evaluate(() => window.I18n.getLang())).toBe('fr');
  await page.waitForTimeout(500); // let the SW finish writing its runtime cache

  // Offline, the chosen language still loads — from the cache, not the network.
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#appContainer')).toBeVisible();
  expect(await page.evaluate(() => window.I18n.t('editor.name'))).toBe('Nom du personnage');
  await expect(page).toHaveTitle(/Studio de cartes de personnages/);

  // A language that was never fetched cannot be, offline. The UI stays English
  // and the user is told why, instead of being left with an unexplained English
  // page and a picker that says Deutsch.
  await page.locator('#btnSettings').click();
  await page.locator('#settingsModal.show').waitFor({ timeout: 5_000 });
  await page.locator('#languageSelect').selectOption('de');
  await expect(page.locator('.toast-body')).toContainText('not available offline', { timeout: 10_000 });
  expect(await page.evaluate(() => window.I18n.t('editor.name'))).toBe('Character Name');
  // The choice is kept, so the app heals on the next online load.
  expect(await page.evaluate(() => window.I18n.getLang())).toBe('de');

  // Boot says the same thing: the stored choice is German, its pack is not in the
  // cache, so the app explains why it is showing English instead of silently
  // ignoring the setting.
  await page.reload();
  await expect(page.locator('.toast-body')).toContainText('not available offline', { timeout: 10_000 });
  expect(await page.evaluate(() => window.I18n.t('editor.name'))).toBe('Character Name');

  expect(errors.filter((e) => !/Failed to load resource|ERR_|favicon/i.test(e))).toEqual([]);
});

test('lazy wizard chunk is precached and opens offline', async ({ page, context }) => {
  // Regression guard for the code-split bundle: wizard.js is a lazy chunk, so
  // it must be precached by the SW shell (not only fetched on demand) — a
  // first open while offline must still work.
  const errors = collectErrors(page);
  await page.goto('/');
  await page.evaluate(() =>
    navigator.serviceWorker.ready.then(() =>
      navigator.serviceWorker.controller
        ? true
        : new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', () => res(true), { once: true }); })
    ));
  await page.waitForTimeout(1500);

  // The chunk must NOT be loaded before the wizard is opened.
  const loadedBefore = await page.evaluate(() => !!window.Wizard);
  expect(loadedBefore).toBe(false);

  await context.setOffline(true);
  await page.locator('#btnWizardNav').click();
  await expect(page.locator('#wizardModal.show')).toBeVisible({ timeout: 15_000 });
  expect(errors, 'lazy wizard open must not throw').toEqual([]);
});