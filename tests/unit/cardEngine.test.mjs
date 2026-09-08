import { test, expect, beforeAll, mock } from 'bun:test';

// cardEngine.js imports I18n as an ES module (passe 4); mock it so the
// guard strings resolve without a real translation table.
let CardEngine;

mock.module('../../js/i18n.js', () => ({ I18n: { t: (key) => key } }));

beforeAll(async () => {
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

// base64 of a UTF-8 string, as SillyTavern v2 cards store their chara chunks.
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const enc = (s) => new TextEncoder().encode(s);

test('parsePNG reads a base64 UTF-8 chara value from a tEXt chunk (full path)', async () => {
  const cardJson = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Zoé', description: 'héllo' } });
  const tEXt = chunkBytes('tEXt', enc('chara\0' + b64(cardJson)));
  const png = pngBytes(tEXt, chunkBytes('IEND', new Uint8Array(0)));
  const card = await CardEngine.parsePNG(png.buffer, 'zoe.png');
  expect(card.name).toBe('Zoé');
  expect(card.description).toBe('héllo');
});

test('_decodeCharaValue decodes base64-encoded UTF-8 JSON', () => {
  const json = JSON.stringify({ name: 'Zoé', desc: 'héllo wörld' });
  expect(CardEngine._decodeCharaValue(b64(json))).toBe(json);
});

test('_decodeCharaValue passes plain JSON through untouched', () => {
  const json = JSON.stringify({ name: 'Plain' });
  expect(CardEngine._decodeCharaValue(json)).toBe(json);
});

test('_decodeCharaValue returns the raw value when nothing decodes', () => {
  expect(CardEngine._decodeCharaValue('not json, not base64')).toBe('not json, not base64');
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

test('_readUint32 returns 0 when the offset overruns the buffer', () => {
  // Used by the PNG chunk walk / exportUtils: out-of-bounds reads must yield 0
  // so a corrupt length can never index past the end.
  expect(CardEngine._readUint32(new Uint8Array(4), 100)).toBe(0);
  expect(CardEngine._readUint32(new Uint8Array([0x12]), 0)).toBe(0); // only 1 byte
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

test('normalize preserves the raw extensions object (nested + arrays)', () => {
  const extensions = {
    nsfw: false,
    example: { nested: [1, 2, 3], ok: true },
    tags: ['a', 'b'],
    nullable: null,
  };
  const card = CardEngine.normalize({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Ext', extensions },
  }, 'ext.json');
  expect(card.extensions).toEqual(extensions);
  // Deep-cloned, not a shared reference.
  extensions.example.nested.push(99);
  expect(card.extensions.example.nested).not.toContain(99);
});

test('extensions default to an empty object when absent', () => {
  const card = CardEngine.normalize({
    spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'NoExt' },
  }, 'noext.json');
  expect(card.extensions).toEqual({});
});

test('extensions survive a toJSON -> parseJSON round-trip (V2 and V3)', () => {
  const extensions = { deep: { arr: ['x', 'y'], n: 3 }, flag: true };
  for (const version of ['2.0', '3.0']) {
    const spec = version === '3.0' ? 'chara_card_v3' : 'chara_card_v2';
    const card = CardEngine.normalize({ spec, spec_version: version, data: { name: 'RT', extensions } }, 'rt.json');
    const back = CardEngine.parseJSON(CardEngine.toJSON(card), 'rt.json');
    expect(back.spec).toBe(spec);
    expect(back.spec_version).toBe(version);
    expect(back.extensions).toEqual(extensions);
  }
});

test('character_book is deep-copied so the source object is not mutated', () => {
  const source = { entries: [{ key: 'k', content: 'c' }] };
  const card = CardEngine.normalize({
    spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'CB', character_book: source },
  }, 'cb.json');
  card.character_book.entries.push({ key: 'extra' });
  expect(source.entries).toHaveLength(1);
});

test('normalize maps V3 spec directly to 3.0 when spec_version is omitted', () => {
  const card = CardEngine.normalize({ spec: 'chara_card_v3', data: { name: 'V3' } }, 'v3.json');
  expect(card.spec).toBe('chara_card_v3');
  expect(card.spec_version).toBe('3.0');
});

test('normalize coerces malformed tags to trimmed non-empty strings', () => {
  const card = CardEngine.normalize({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'Taggy', tags: [' fantasy ', 42, null, undefined, '', {}, ['x']] },
  }, 'tags.json');
  // 42 -> "42", ["x"] -> "x", {} -> "[object Object]" (string-coerced, never a crash)
  expect(card.tags).toEqual(['fantasy', '42', '[object Object]', 'x']);
});

test('normalize treats a non-array tags field as empty', () => {
  const card = CardEngine.normalize({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: 'Tagless', tags: 'not-an-array' },
  }, 'tagless.json');
  expect(card.tags).toEqual([]);
});

// ─── Truncated / corrupt chunk handling (must terminate, never hang) ───────
// A previous audit probe showed the chunk walk can be fed hostile lengths and
// truncated payloads; these lock in that every malformed shape terminates.
// The per-test `timeout` turns a future regression (an infinite loop) into a
// fast failure instead of stalling the whole suite.

const chunkBytes = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
};

const pngBytes = (...chunks) => {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let pos = 8;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
};

test('parsePNG terminates on a file truncated to just the PNG signature', async () => {
  const card = await CardEngine.parsePNG(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer, 'sig.png');
  expect(card.name).toBe('sig');
}, { timeout: 2000 });

test('parsePNG terminates on an iTXt chunk whose language tag is never null-terminated', async () => {
  // keyword\0 + compression flag 0 + method 0 + partial language tag ('en',
  // no trailing \0) — the parser must skip the malformed chunk and carry on.
  const iTXt = chunkBytes('iTXt', new TextEncoder().encode('chara\0\x00\x00en'));
  const png = pngBytes(iTXt, chunkBytes('IEND', new Uint8Array(0)));
  const card = await CardEngine.parsePNG(png.buffer, 'trunc.png');
  expect(card.name).toBe('trunc'); // image-only fallback, no hang
}, { timeout: 2000 });

test('parsePNG terminates on a chunk declaring an absurd ~4GB length', async () => {
  const bad = new Uint8Array([
    ...pngBytes().subarray(0, 8), // PNG signature
    0xff, 0xff, 0xff, 0xfe, 0x74, 0x45, 0x58, 0x74, // len ~4GB, type tEXt
  ]);
  const card = await CardEngine.parsePNG(bad.buffer, 'huge.png');
  expect(card.name).toBe('huge');
}, { timeout: 2000 });

test('parsePNG terminates when a chunk overruns the end of the file', async () => {
  // tEXt claims 100 bytes of data but only 'chara\0' (6 bytes) follow.
  const over = new Uint8Array([
    ...pngBytes().subarray(0, 8),
    0, 0, 0, 100, 0x74, 0x45, 0x58, 0x74,
    ...Array.from('chara\0', (c) => c.charCodeAt(0)),
  ]);
  // The keyword is found but its value is empty -> decode fails cleanly with
  // an error rather than hanging or silently dropping the card data.
  await expect(CardEngine.parsePNG(over.buffer, 'over.png')).rejects.toThrow();
}, { timeout: 2000 });

test('parsePNG terminates on an uninflatable zTXt chara chunk', async () => {
  const zTXt = chunkBytes('zTXt', new TextEncoder().encode('chara\0\x01not-actually-zlib-data'));
  const png = pngBytes(zTXt, chunkBytes('IEND', new Uint8Array(0)));
  // Data is present but cannot be decompressed -> explicit error, never a hang.
  await expect(CardEngine.parsePNG(png.buffer, 'badz.png')).rejects.toThrow();
}, { timeout: 2000 });

test('computeFileSize adds decoded image bytes to the export-shaped JSON size', () => {
  const card = CardEngine.normalize({ name: 'Aria', description: 'x' }, 'aria.json');
  const noImage = CardEngine.computeFileSize(card);
  // JSON part is the export shape (no internal _id/_filename fields).
  expect(noImage).toBe(JSON.stringify(CardEngine.toJSON(card)).length);
  // 120 base64 payload chars decode to exactly 90 bytes.
  card._imageBase64 = 'data:image/png;base64,' + 'A'.repeat(120);
  expect(CardEngine.computeFileSize(card) - noImage).toBe(90);
});

// Bun rejects the 'zlib' DecompressionStream format (verified ERR_INVALID_ARG_VALUE),
// so this exercises the raw-deflate fallback path on every run.
test('_inflate decodes zlib-wrapped data even where the zlib format is unsupported', async () => {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    console.warn('compression streams unavailable; skipping _inflate fallback test');
    return;
  }
  const plain = new TextEncoder().encode('héllo wörld — zlib-wrapped data for the card chunk');

  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  await writer.write(plain);
  await writer.close();
  const deflated = new Uint8Array(await new Response(cs.readable).arrayBuffer());

  // Wrap as a standard zlib stream: 2-byte header + raw deflate + adler32 (BE).
  let a = 1, b = 0;
  for (let i = 0; i < plain.length; i++) {
    a = (a + plain[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  const wrapped = new Uint8Array(2 + deflated.length + 4);
  wrapped.set([0x78, 0x9c], 0);
  wrapped.set(deflated, 2);
  new DataView(wrapped.buffer).setUint32(2 + deflated.length, adler, false);

  const out = await CardEngine._inflate(wrapped);
  expect(out).not.toBeNull();
  expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(plain));
});
