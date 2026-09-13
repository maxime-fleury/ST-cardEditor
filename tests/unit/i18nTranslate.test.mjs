import { test, expect } from 'bun:test';
import { decodeLiteral, findValueSpan, placeholders, quote, readValue } from '../../scripts/i18n-literal.mjs';
import { ALWAYS_ENGLISH, isUntranslated, isWordless } from '../../scripts/i18n-copyover.mjs';
import { loadAllLocales } from '../../js/i18n.js';

// The locale files are hand-written and inconsistent, which is the whole reason
// this parsing exists. These cases are the inconsistencies, so a future rewrite
// of the applier cannot quietly lose one of them.

test('quote/decodeLiteral round-trips the text a translating patch supplies', () => {
  const cases = [
    'Ce pack n\u2019est pas encore disponible \u2014 anglais affich\u00e9',
    "l'aper\u00e7u",
    'une barre \\ et un $ et un backtick `',
    'premi\u00e8re ligne\n{{char}}: bonjour',
    'guillemets "doubles" et \u00e9chapp\u00e9 \\\'',
    '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', // Arabic, raw UTF-8
    '<START>\n{{user}}: ok',
  ];
  for (const value of cases) {
    expect(decodeLiteral(quote(value).slice(1, -1))).toBe(value);
  }
});

test('decodeLiteral understands escapes a hand-written file may use', () => {
  expect(decodeLiteral('Langue mise \\u00e0 jour')).toBe('Langue mise \u00e0 jour');
  expect(decodeLiteral('a\\tb\\nc')).toBe('a\tb\nc');
  expect(decodeLiteral('\\x41\\u{1F600}')).toBe('A\u{1F600}');
  expect(decodeLiteral('l\\\'aper\\u00e7u')).toBe("l'aper\u00e7u");
});

test('findValueSpan handles two entries on one line', () => {
  const source = `export default {\n  'a.one': 'premier',  'a.two': 'second',\n  'a.three': 'troisi\u00e8me',\n};\n`;
  expect(readValue(source, 'a.one')).toBe('premier');
  expect(readValue(source, 'a.two')).toBe('second');
  expect(readValue(source, 'a.three')).toBe('troisi\u00e8me');
});

test('findValueSpan is not fooled by a key name appearing inside a value', () => {
  const source = `export default {\n  'note': 'mentions editor.tags in prose',\n  'editor.tags': 'Tags',\n};\n`;
  expect(readValue(source, 'editor.tags')).toBe('Tags');
  expect(findValueSpan(source, 'editor.tags').start).toBeGreaterThan(source.indexOf('mentions'));
});

test('findValueSpan finds a value that contains an escaped quote', () => {
  const source = `export default {\n  'preview.open': 'Voir l\\'aper\u00e7u',\n  'x': 'y',\n};\n`;
  expect(readValue(source, 'preview.open')).toBe("Voir l'aper\u00e7u");
});

test('findValueSpan returns null for a key the file does not have', () => {
  expect(findValueSpan("export default {\n  'a': 'b',\n};\n", 'missing')).toBeNull();
  expect(readValue("export default {\n  'a': 'b',\n};\n", 'missing')).toBeUndefined();
});

test('placeholders compares sets, not order', () => {
  expect(placeholders('{{count}} cartes sur {{total}}')).toBe(placeholders('{{total}} / {{count}}'));
  expect(placeholders('cartes')).toBe('');
  expect(placeholders('{{count}} cartes')).not.toBe(placeholders('{{total}} cartes'));
});

test('isWordless covers values that have nothing to translate', () => {
  for (const value of ['#64748B', 'http://localhost:1234/v1', '{{count}}', ' KB', ' MB', ' B', '\u2191\u2193']) {
    expect(isWordless(value)).toBe(true);
    expect(isUntranslated('de', 'any.key', value, value)).toBe(false);
  }
  expect(isWordless('Ready')).toBe(false);
});

test('isUntranslated only reports real work: not allowlisted, not wordless, not translated', () => {
  expect(isUntranslated('de', 'health.title', 'Card health', 'Card health')).toBe(true);
  expect(isUntranslated('de', 'health.title', 'Karten-Gesundheit', 'Card health')).toBe(false);
  expect(isUntranslated('de', 'nav.brand', 'ST Card Editor', 'ST Card Editor')).toBe(false);
  expect(isUntranslated('de', 'editor.tags', 'Tags', 'Tags')).toBe(false);   // in the allowlist
  expect(isUntranslated('ja', 'editor.tags', 'Tags', 'Tags')).toBe(true);    // and not for Japanese
});

test('every ALWAYS_ENGLISH claim is still true in the dictionaries it names', async () => {
  const all = await loadAllLocales();
  const broken = [];
  for (const entry of ALWAYS_ENGLISH) {
    const [maybeLang, maybeKey] = entry.includes(':') ? entry.split(':') : [null, entry];
    if (!(maybeKey in all.en)) { broken.push(`${entry}: no such key`); continue; }
    const targets = maybeLang ? [maybeLang] : Object.keys(all).filter((l) => l !== 'en');
    for (const lang of targets) {
      if (all[lang][maybeKey] !== all.en[maybeKey]) {
        broken.push(`${entry}: ${lang} is "${String(all[lang][maybeKey]).slice(0, 30)}"`);
      }
    }
  }
  expect(broken).toEqual([]);
});

test('no locale drops or renames a placeholder English defines', async () => {
  const all = await loadAllLocales();
  const broken = [];
  for (const [lang, dict] of Object.entries(all)) {
    if (lang === 'en') continue;
    for (const [key, value] of Object.entries(dict)) {
      if (placeholders(value) !== placeholders(all.en[key])) broken.push(`${lang}.${key}`);
    }
  }
  expect(broken).toEqual([]);
});
