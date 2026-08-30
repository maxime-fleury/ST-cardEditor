import { test, expect, beforeAll } from 'bun:test';

// cardEngine.js guards its error strings with a bare `I18n` global; provide a
// stub so the module resolves it (Bun resolves undeclared identifiers via
// globalThis). Static imports are hoisted, so load the module dynamically
// after the stub is in place.
let CardEngine;

beforeAll(async () => {
  globalThis.I18n = { t: (key) => key };
  CardEngine = (await import('../../js/cardEngine.js')).CardEngine;
});

const v2 = (data) => JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data });

test('parseJSON normalizes a v2 card', () => {
  const card = CardEngine.parseJSON(v2({
    name: 'Aria',
    description: 'A mysterious elf.',
    tags: ['fantasy', 'elf'],
    alternate_greetings: ['Greeting one.'],
  }), 'aria.json');
  expect(card.name).toBe('Aria');
  expect(card.spec).toBe('chara_card_v2');
  expect(card.spec_version).toBe('2.0');
  expect(card.tags).toEqual(['fantasy', 'elf']);
  expect(card.alternate_greetings).toEqual(['Greeting one.']);
  expect(card.character_book.entries).toEqual([]);
});

test('normalize maps spec-name lorebook fields and coerces keysecondary', () => {
  const card = CardEngine.normalize({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Lore',
      character_book: {
        entries: [
          { keys: ['k1'], secondary_keys: 'a, b', insertion_order: 5, enabled: false, content: 'C' },
        ],
      },
    },
  }, 'lore.json');
  const e = card.character_book.entries[0];
  expect(e.key).toEqual(['k1']);
  expect(e.keysecondary).toEqual(['a', 'b']);
  expect(e.order).toBe(5);
  expect(e.disable).toBe(true);
});

test('normalize drops non-object lorebook entries safely', () => {
  const card = CardEngine.normalize({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Broken', character_book: { entries: [null, 42, 'x'] } },
  }, 'broken.json');
  expect(card.character_book.entries).toHaveLength(3);
  for (const e of card.character_book.entries) {
    expect(e).toMatchObject({ key: expect.anything(), keysecondary: expect.anything(), content: expect.anything() });
  }
});

test('parseJSON rejects invalid and non-card JSON', () => {
  expect(() => CardEngine.parseJSON('not json', 'x.json')).toThrow();
  expect(() => CardEngine.parseJSON('{"foo":1}', 'x.json')).toThrow();
  expect(() => CardEngine.parseJSON('[1,2]', 'x.json')).toThrow();
});

test('parsePNG extracts chara from a synthetic PNG tEXt chunk', async () => {
  const cardJson = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'CharaPng' } });
  const text = 'chara\0' + cardJson;
  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10, // PNG signature
    0, 0, 0, text.length,             // tEXt chunk length (big-endian)
    ...Array.from('tEXt', (c) => c.charCodeAt(0)),
    ...Array.from(text, (c) => c.charCodeAt(0)),
    0, 0, 0, 0,                       // crc (unused by the parser)
    0, 0, 0, 0,                       // IEND length
    ...Array.from('IEND', (c) => c.charCodeAt(0)),
    0, 0, 0, 0,
  ];
  const card = await CardEngine.parsePNG(new Uint8Array(bytes).buffer, 'chara.png');
  expect(card.name).toBe('CharaPng');
  expect(card.spec).toBe('chara_card_v2');
});

test('parsePNG rejects a non-PNG signature', async () => {
  await expect(
    CardEngine.parsePNG(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, 'x.png')
  ).rejects.toThrow();
});

test('parsePNG returns an empty card for a valid PNG without chara data', async () => {
  const bytes = [
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 0, ...Array.from('IEND', (c) => c.charCodeAt(0)), 0, 0, 0, 0,
  ];
  const card = await CardEngine.parsePNG(new Uint8Array(bytes).buffer, 'plain.png');
  expect(card.name).toBe('plain');
  expect(card._hasImage).toBe(false);
});

test('_readUint32 reads big-endian and is unsigned', () => {
  const b = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
  expect(CardEngine._readUint32(b, 0)).toBe(0x12345678);
  const overflow = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  expect(CardEngine._readUint32(overflow, 0)).toBe(0xffffffff);
});

test('toJSON round-trips through parseJSON', () => {
  const card = CardEngine.parseJSON(v2({ name: 'RT', tags: ['a', 'b'] }), 'rt.json');
  const back = CardEngine.parseJSON(CardEngine.toJSON(card), 'rt.json');
  expect(back.name).toBe('RT');
  expect(back.tags).toEqual(['a', 'b']);
});

test('getTextContent joins non-empty labeled fields', () => {
  const card = CardEngine.parseJSON(v2({
    name: 'T', description: 'Desc', first_mes: 'Hi', personality: '',
  }), 't.json');
  const text = CardEngine.getTextContent(card);
  expect(text).toContain('[Name]');
  expect(text).toContain('Desc');
  expect(text).not.toContain('[Personality]');
});
