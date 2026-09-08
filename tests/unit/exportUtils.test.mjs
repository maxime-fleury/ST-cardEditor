import { test, expect, beforeAll, mock } from 'bun:test';

// exportUtils.js now imports its dependencies as real ES modules (passe 4):
// CardEngine stays REAL (embedCharaChunk exercises its PNG parsing); I18n /
// Ui / CardStorage / Editor are mocked with mock.module.
let CardEngine;
let ExportUtils;
const noop = () => {};

const stubs = {
  I18n: { t: (key) => key },
  Ui: {},
  CardStorage: {},
  Editor: { syncEditorToCard: async () => {} },
};
mock.module('../../js/i18n.js', () => ({ I18n: stubs.I18n }));
mock.module('../../js/ui.js', () => ({ Ui: stubs.Ui }));
mock.module('../../js/storage.js', () => ({ CardStorage: stubs.CardStorage }));
mock.module('../../js/editor.js', () => ({ Editor: stubs.Editor }));

beforeAll(async () => {
  CardEngine = (await import('../../js/cardEngine.js')).CardEngine;
  ExportUtils = (await import('../../js/exportUtils.js')).ExportUtils;
});

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const chunkBytes = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
};

const mkPng = (...chunks) => {
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  out.set(PNG_SIG, 0);
  let pos = 8;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
};

const minimalPng = () => mkPng(chunkBytes('IEND', new Uint8Array(0)));

const cardJson = (name, tags) => JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: { name, tags: tags || [], description: '' },
});

test('embedCharaChunk embeds JSON that parsePNG reads back (round-trip)', async () => {
  const exported = ExportUtils.embedCharaChunk(minimalPng(), cardJson('RT', ['fantasy', 'elf']));
  // The result is a valid PNG: signature preserved and IEND still present, so
  // the re-import path (parsePNG) recovers the embedded card.
  const back = await CardEngine.parsePNG(exported.buffer, 'rt.png');
  expect(back.spec).toBe('chara_card_v2');
  expect(back.name).toBe('RT');
  expect(back.tags).toEqual(['fantasy', 'elf']);
});

test('re-exporting strips the previous chara chunk (never duplicates)', async () => {
  const first = ExportUtils.embedCharaChunk(minimalPng(), cardJson('Dup', []));
  const second = ExportUtils.embedCharaChunk(first, cardJson('Dup', []));

  const bytes = new Uint8Array(second);
  let offset = 8, charaCount = 0, iendCount = 0;
  while (offset + 12 <= bytes.length) {
    const len = CardEngine._readUint32(bytes, offset);
    if (offset + 12 + len > bytes.length) break;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === 'tEXt') {
      const nullIdx = bytes.indexOf(0, offset + 8);
      const kw = nullIdx >= 0 ? String.fromCharCode(...bytes.subarray(offset + 8, nullIdx)) : '';
      if (kw === 'chara') charaCount++;
    }
    if (type === 'IEND') { iendCount++; break; }
    offset += 12 + len;
  }
  expect(charaCount).toBe(1); // old chara chunk replaced, not appended
  expect(iendCount).toBe(1);
});

test('embedCharaChunk returns the PNG unchanged when it has no IEND chunk', async () => {
  const base = new Uint8Array(PNG_SIG); // signature only, no IEND
  const out = ExportUtils.embedCharaChunk(base, cardJson('X', []));
  expect([...out]).toEqual([...base]); // no crash, no partial embed
});