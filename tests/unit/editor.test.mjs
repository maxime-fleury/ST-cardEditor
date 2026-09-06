import { test, expect, beforeAll } from 'bun:test';

// editor.js is a plain object literal (browser-glued methods run only when
// called), so importing it is safe without DOM stubs.
let Editor;

beforeAll(async () => {
  globalThis.I18n = { t: (key) => key };
  Editor = (await import('../../js/editor.js')).Editor;
});

test('_lorebookEntryMatches does not crash on V2 array-typed keys (the search bug)', () => {
  // Regression for the crash: renderLorebook's search filter used
  // `(entry.key || '').toLowerCase()`, and `key` is an ARRAY per the V2 spec.
  const entry = { key: ['k1', 'k2'], keysecondary: [], content: 'c', comment: '' };
  expect(Editor._lorebookEntryMatches(entry, 'k1')).toBe(true);
  expect(Editor._lorebookEntryMatches(entry, 'k2')).toBe(true);
  expect(Editor._lorebookEntryMatches(entry, 'nope')).toBe(false);
});

test('_lorebookEntryMatches tolerates numeric content/comment values', () => {
  const entry = { key: 'k', keysecondary: [], content: 42, comment: 7 };
  expect(Editor._lorebookEntryMatches(entry, '42')).toBe(true);   // numeric content
  expect(Editor._lorebookEntryMatches(entry, '7')).toBe(true);    // numeric comment
  expect(Editor._lorebookEntryMatches(entry, 'k')).toBe(true);    // string key still matches
});

test('_lorebookEntryMatches is case-insensitive across all fields', () => {
  const entry = { key: ['Alpha'], keysecondary: ['Beta'], content: 'Gamma', comment: 'Delta' };
  for (const q of ['alpha', 'ALPHA', 'beta', 'BETA', 'gamma', 'GAMMA', 'delta', 'DELTA']) {
    expect(Editor._lorebookEntryMatches(entry, q)).toBe(true);
  }
});

test('_lorebookEntryMatches handles null/empty entries without crashing', () => {
  expect(Editor._lorebookEntryMatches({}, 'x')).toBe(false);
  expect(Editor._lorebookEntryMatches(null, 'x')).toBe(false);
  expect(Editor._lorebookEntryMatches({ key: null, keysecondary: null, content: null, comment: null }, 'x')).toBe(false);
});