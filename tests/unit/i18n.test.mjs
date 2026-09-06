import { test, expect } from 'bun:test';

// _detectLanguage reads localStorage (saved lang) and navigator.language.
// Stub them, import the module, then restore.
const savedValues = new Map();
globalThis.localStorage = {
  getItem: (k) => (savedValues.has(k) ? savedValues.get(k) : null),
  setItem: (k, v) => savedValues.set(k, String(v)),
  removeItem: (k) => savedValues.delete(k),
};

let I18n;
test('module loads with stubbed globals', async () => {
  I18n = (await import('../../js/i18n.js')).I18n;
  expect(I18n).toBeDefined();
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