import { test, expect } from 'bun:test';

// _detectLanguage reads localStorage (saved lang) and navigator.language;
// setLanguage applies to the document and announces on window.
//
// `document.baseURI` is deliberately ABSENT: with one, js/i18n.js resolves a
// dictionary to http://localhost/js/i18n/… and Bun would try to fetch it — this
// suite has no server. Without one it takes the off-browser branch and resolves
// against its own file URL, which is the path the build scripts use. The browser
// branch is covered end to end by tests/shell.spec.js.
const savedValues = new Map();
globalThis.localStorage = {
  getItem: (k) => (savedValues.has(k) ? savedValues.get(k) : null),
  setItem: (k, v) => savedValues.set(k, String(v)),
  removeItem: (k) => savedValues.delete(k),
};
globalThis.window = { dispatchEvent: () => {} };
globalThis.document = {
  documentElement: {},
  title: '',
  querySelectorAll: () => [],
  getElementById: () => null,
};

globalThis.navigator = { language: 'en-US' };

let I18n;
let loadLocale;
let loadAllLocales;
let SUPPORTED;
test('module loads with stubbed globals', async () => {
  ({ I18n, loadLocale, loadAllLocales, SUPPORTED } = await import('../../js/i18n.js'));
  expect(I18n).toBeDefined();
});

// The split itself, asserted at the unit level: the other 26 dictionaries used to
// be static imports, i.e. 845 KB of the 1.2 MB bundle. If one comes back, the
// chunk grows for every user and the app still works — so nothing else fails.
// scripts/check-assets.mjs checks the same thing on the built artifact.
test('only English is loaded on import', () => {
  expect(I18n._loadedLanguages()).toEqual(['en']);
});

test('a language is fetched on demand and applied', async () => {
  expect(I18n._loadedLanguages()).not.toContain('fr');
  expect(await I18n.setLanguage('fr')).toBe(true);
  expect(I18n.getLang()).toBe('fr');
  expect(I18n._loadedLanguages()).toContain('fr');
  expect(I18n.t('editor.name')).toBe('Nom du personnage');
  expect(document.documentElement.lang).toBe('fr');
});

test('a pack that cannot be fetched falls back to English and says so', async () => {
  // The offline path: no test can reach it by browsing (it needs a language that
  // was never cached), so it is reached by swapping one loader for a rejection.
  expect(I18n._loadedLanguages()).not.toContain('de');
  const original = I18n._loaders.de;
  I18n._loaders.de = () => Promise.reject(new Error('offline'));
  try {
    expect(await I18n.setLanguage('de')).toBe(false);
    // The choice is kept, so the next online load fetches the pack and the UI
    // translates then — the app heals itself instead of forgetting the setting.
    expect(I18n.getLang()).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    // Every key resolves through English in the meantime.
    expect(I18n.t('editor.name')).toBe('Character Name');
  } finally {
    I18n._loaders.de = original;
  }
});

test('an unknown or unsupported language is refused, not half-applied', async () => {
  const before = I18n.getLang();
  expect(await I18n.setLanguage('xx')).toBe(false);
  expect(await loadLocale('xx')).toBe(false);
  expect(I18n.getLang()).toBe(before);
});

test('loadAllLocales resolves every dictionary off-browser', async () => {
  // The contract the build scripts depend on (check-i18n, i18n-add): they compare
  // all 27 locales against English. When the dictionaries became lazy these two
  // scripts kept importing `translations` directly — i18n-add then iterated a
  // one-entry object and cheerfully reported "nothing to add" while every locale
  // was missing the new keys. This test is what makes that regression loud.
  const all = await loadAllLocales();
  expect(Object.keys(all).sort()).toEqual([...SUPPORTED].sort());
  expect(all.fr['editor.name']).toBe('Nom du personnage');
  expect(all.en['editor.name']).toBe('Character Name');
});

test('preload fetches the detected language without applying it', async () => {
  savedValues.set('stce_lang', 'en');
  globalThis.navigator = { language: 'en-US' };
  expect(await I18n.preload()).toBe(true);
  savedValues.clear();
  globalThis.navigator = { language: 'fr-FR' };
  expect(await I18n.preload()).toBe(true);
});

test('auto-detection prefers the full regional code (pt-PT -> pt-pt)', () => {
  savedValues.clear(); // no saved preference
  globalThis.navigator = { language: 'pt-PT' };
  expect(I18n._detectLanguage()).toBe('pt-pt');

  savedValues.clear();
  globalThis.navigator = { language: 'pt-BR' };
  expect(I18n._detectLanguage()).toBe('pt');

  savedValues.clear();
  globalThis.navigator = { language: 'fr-FR' };
  expect(I18n._detectLanguage()).toBe('fr');
});

test('a saved preference always wins over the browser language', () => {
  savedValues.set('stce_lang', 'de');
  globalThis.navigator = { language: 'en-US' };
  expect(I18n._detectLanguage()).toBe('de');
});

test('unsupported languages fall back to English', () => {
  savedValues.clear();
  globalThis.navigator = { language: 'xx-XX' };
  expect(I18n._detectLanguage()).toBe('en');
});