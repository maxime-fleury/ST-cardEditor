import { test, expect, beforeAll, mock } from 'bun:test';

// storage.js imports I18n, Ui and CardEngine as ES modules. The version-history
// logic under test is pure, but importing the module still evaluates those
// imports, so the two DOM-facing ones are stubbed (CardEngine is real: the
// signature it produces is the whole point of the dedup).
let CardStorage;
let CardEngine;

mock.module('../../js/i18n.js', () => ({ I18n: { t: (key) => key } }));
mock.module('../../js/ui.js', () => ({ Ui: {} }));

beforeAll(async () => {
  CardEngine = (await import('../../js/cardEngine.js')).CardEngine;
  CardStorage = (await import('../../js/storage.js')).CardStorage;
});

/** Minimal card for signature/history purposes. */
const card = (over = {}) => ({
  _id: 'c1',
  name: 'Aria',
  description: 'A mysterious elf.',
  first_mes: 'Hello.',
  tags: ['fantasy'],
  ...over,
});

test('pushVersion records the replaced content, newest first', () => {
  const before = card();
  const after = card({ description: 'A changed elf.' });
  const versions = CardStorage.pushVersion([], before, after);

  expect(versions).toHaveLength(1);
  expect(versions[0].data.description).toBe('A mysterious elf.');
  expect(versions[0].signature).toBe(CardEngine.cardSignature(before));
  expect(versions[0].at).toBeGreaterThan(0);
});

test('pushVersion ignores a save that changes nothing', () => {
  const before = card();
  // Autosave fires on every debounced keystroke: identical content must not
  // fill the history with copies of itself.
  expect(CardStorage.pushVersion([], before, card())).toBeNull();
});

test('pushVersion ignores a repeat of the newest stored version', () => {
  const before = card();
  const versions = CardStorage.pushVersion([], before, card({ description: 'B' }));
  // Undoing back to the same content then saving again: already on top.
  expect(CardStorage.pushVersion(versions, before, card({ description: 'C' }))).toBeNull();
});

test('pushVersion drops the image bytes but keeps the text', () => {
  const before = card({ _imageBase64: 'data:image/png;base64,AAAA', _thumbnail: 'data:image/png;base64,BBBB' });
  const versions = CardStorage.pushVersion([], before, card({ description: 'B' }));

  expect(versions[0].data._imageBase64).toBeUndefined();
  expect(versions[0].data._thumbnail).toBeUndefined();
  expect(versions[0].data.description).toBe('A mysterious elf.');
});

test('pushVersion caps the history at the limit, keeping the newest', () => {
  let versions = [];
  for (let i = 0; i < 25; i++) {
    versions = CardStorage.pushVersion(versions, card({ description: 'v' + i }), card({ description: 'v' + (i + 1) }));
  }
  expect(versions).toHaveLength(20);
  // Newest first: the last recorded change is the one that survives.
  expect(versions[0].data.description).toBe('v24');
  expect(versions[19].data.description).toBe('v5');
});

test('pushVersion tolerates a corrupt stored record', () => {
  expect(CardStorage.pushVersion(null, card(), card({ description: 'B' }))).toHaveLength(1);
  expect(CardStorage.pushVersion(undefined, card(), card({ description: 'B' }))).toHaveLength(1);
  expect(CardStorage.pushVersion([], null, card({ description: 'B' }))).toBeNull();
});
