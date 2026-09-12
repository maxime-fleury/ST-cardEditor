import { test, expect, beforeAll, beforeEach } from 'bun:test';

// cardSearch.js only depends on CardState (no storage, no DOM), so the real
// module is exercised here — no mocking.
let CardSearch;
let CardState;

beforeAll(async () => {
  globalThis.window = globalThis;
  CardSearch = (await import('../../js/cardSearch.js')).CardSearch;
  CardState = (await import('../../js/cardState.js')).CardState;
});

beforeEach(() => {
  CardSearch.reset();
  CardState.cards = [];
});

const card = (over = {}) => ({
  _id: 'c1',
  name: 'Elodie',
  creator: 'Makusu',
  tags: ['student', 'housekeeper'],
  description: "Étudiante fauchée qui fait des ménages pour arrondir ses fins de mois.",
  personality: 'Curieuse, observatrice, sarcastique.',
  first_mes: '« Bonjour, je m\u2019appelle Elodie. »',
  scenario: 'Elle arrive chez {{user}}, c\u2019est le bordel.',
  mes_example: '<START>\n{{char}}: Salut.',
  creator_notes: 'Use a low temperature.',
  character_book: { entries: [] },
  ...over,
});

// ─── The capability the old name-only search lacked ────────────────────────

test('finds a card by a word of its description (not just name/tags)', () => {
  CardSearch.remember(card());
  CardState.cards = [{ _id: 'c1' }];

  const hits = CardSearch.search('ménages');
  expect(hits).toHaveLength(1);
  expect(hits[0].field).toBe('description');
  expect(hits[0].labelKey).toBe('editor.desc');
});

test('finds a card by a word of its first message or creator notes', () => {
  CardSearch.remember(card());
  CardState.cards = [{ _id: 'c1' }];

  expect(CardSearch.search('appelle')[0].field).toBe('first_mes');
  expect(CardSearch.search('temperature')[0].field).toBe('creator_notes');
});

test('finds lorebook entries by key, comment or content (V2 array keys)', () => {
  CardSearch.remember(card({
    character_book: {
      entries: [
        { key: ['magie', 'sorcellerie'], comment: 'Aether rules', content: 'Le voile se déchire au crépuscule.' },
        { key: 'avion', keysecondary: ['aéroport'], content: 'Elle a peur de voler.' },
      ],
    },
  }));
  CardState.cards = [{ _id: 'c1' }];

  expect(CardSearch.search('sorcellerie')[0].field).toBe('character_book');
  expect(CardSearch.search('aether')[0].field).toBe('character_book');
  expect(CardSearch.search('crepuscule')[0].field).toBe('character_book');
  expect(CardSearch.search('aeroport')[0].field).toBe('character_book');
});

// ─── Matching rules ───────────────────────────────────────────────────────

test('is diacritic- and case-insensitive', () => {
  CardSearch.remember(card({ name: 'Élodie', description: 'Un café à Vérone.' }));
  CardState.cards = [{ _id: 'c1' }];

  expect(CardSearch.search('elodie')).toHaveLength(1);
  expect(CardSearch.search('CAFE')).toHaveLength(1);
  expect(CardSearch.search('verone')).toHaveLength(1);
});

test('ranks a name hit above a body hit and keeps every match', () => {
  CardSearch.remember(card({ _id: 'body', name: 'Zoe', description: 'élodie est mentionnée ici' }));
  CardSearch.remember(card({ _id: 'name', name: 'Elodie', description: 'aucun rapport' }));
  CardState.cards = [{ _id: 'body' }, { _id: 'name' }];

  const hits = CardSearch.search('elodie');
  expect(hits).toHaveLength(2);
  expect(hits[0].id).toBe('name');
  expect(hits[0].score).toBeGreaterThan(hits[1].score);
});

test('a name prefix outranks a name hit in the middle of the field', () => {
  CardSearch.remember(card({ _id: 'embedded', name: 'Marie Elodie' }));
  CardSearch.remember(card({ _id: 'prefix', name: 'Elodie Dupont' }));
  CardState.cards = [{ _id: 'embedded' }, { _id: 'prefix' }];

  const hits = CardSearch.search('elodie');
  expect(hits.map((h) => h.id)).toEqual(['prefix', 'embedded']);
});

test('returns nothing for an empty or whitespace query', () => {
  CardSearch.remember(card());
  expect(CardSearch.search('')).toEqual([]);
  expect(CardSearch.search('   ')).toEqual([]);
  expect(CardSearch.search(null)).toEqual([]);
});

// ─── Snippets ─────────────────────────────────────────────────────────────

test('reports the match offset inside the snippet so the caller can highlight it', () => {
  CardSearch.remember(card({ description: 'x'.repeat(200) + ' ménages ' + 'y'.repeat(50) }));
  CardState.cards = [{ _id: 'c1' }];

  const hit = CardSearch.search('ménages')[0];
  expect(hit.snippetMatchLength).toBe('ménages'.length);
  const marked = hit.snippet.slice(hit.snippetMatchStart, hit.snippetMatchStart + hit.snippetMatchLength);
  expect(marked).toBe('ménages');
  // The leading ellipsis must not shift the offsets off the match.
  expect(hit.snippet.startsWith('…')).toBe(true);
});

test('an accent-insensitive hit still highlights the accented original', () => {
  CardSearch.remember(card({ name: 'Zoe', description: 'Rien à voir, seulement Élodie.' }));
  CardState.cards = [{ _id: 'c1' }];

  const hit = CardSearch.search('elodie')[0];
  expect(hit.field).toBe('description');
  expect(hit.snippetMatchLength).toBe('elodie'.length);
  expect(hit.snippet.slice(hit.snippetMatchStart, hit.snippetMatchStart + hit.snippetMatchLength)).toBe('Élodie');
});

// ─── Index lifecycle ──────────────────────────────────────────────────────

test('ensure() loads only the cards that are not indexed yet', async () => {
  CardSearch.remember(card({ _id: 'known' }));
  CardState.cards = [{ _id: 'known' }, { _id: 'missing' }];
  const asked = [];
  const loader = async (id) => { asked.push(id); return card({ _id: id, description: 'from storage' }); };

  const indexed = await CardSearch.ensure(loader);
  expect(indexed).toBe(1);
  expect(asked).toEqual(['missing']);
  expect(CardSearch.search('storage')).toHaveLength(1);

  // Second call is a no-op.
  expect(await CardSearch.ensure(loader)).toBe(0);
  expect(asked).toEqual(['missing']);
});

test('ensure() survives a loader that rejects or returns null', async () => {
  CardState.cards = [{ _id: 'broken' }, { _id: 'gone' }, { _id: 'ok' }];
  const loader = async (id) => {
    if (id === 'broken') throw new Error('idb down');
    if (id === 'gone') return null;
    return card({ _id: 'ok', description: 'present' });
  };

  expect(await CardSearch.ensure(loader)).toBe(1);
  expect(CardSearch.search('present')).toHaveLength(1);
});

test('remember/forget/reset/prune keep the index aligned with the library', () => {
  CardSearch.remember(card({ _id: 'a', description: 'unique-alpha' }));
  CardSearch.remember(card({ _id: 'b', description: 'unique-beta' }));
  expect(CardSearch.size).toBe(2);

  CardSearch.forget('a');
  expect(CardSearch.search('unique-alpha')).toEqual([]);

  CardSearch.remember(card({ _id: 'c', description: 'unique-gamma' }));
  CardState.cards = [{ _id: 'c' }];
  CardSearch.prune();
  expect(CardSearch.size).toBe(1);
  expect(CardSearch.search('unique-gamma')).toHaveLength(1);

  CardSearch.reset();
  expect(CardSearch.size).toBe(0);
});

test('re-indexing a card replaces its previous text', () => {
  CardSearch.remember(card({ description: 'ancienne description' }));
  CardSearch.remember(card({ description: 'nouvelle description' }));
  expect(CardSearch.search('ancienne')).toEqual([]);
  expect(CardSearch.search('nouvelle')).toHaveLength(1);
});

// ─── Bounds & options ─────────────────────────────────────────────────────

test('search({ allow }) restricts hits to the given ids (tag filter composes)', () => {
  CardSearch.remember(card({ _id: 'a', description: 'shared keyword' }));
  CardSearch.remember(card({ _id: 'b', description: 'shared keyword' }));
  CardState.cards = [{ _id: 'a' }, { _id: 'b' }];

  expect(CardSearch.search('keyword')).toHaveLength(2);
  expect(CardSearch.search('keyword', { allow: new Set(['b']) }).map((h) => h.id)).toEqual(['b']);
  expect(CardSearch.search('keyword', { allow: new Set() })).toEqual([]);
});

test('results are capped so a broad query cannot render an unbounded list', () => {
  for (let i = 0; i < CardSearch._max.MAX_RESULTS + 25; i++) {
    CardSearch.remember(card({ _id: 'c' + i, description: 'commonword here' }));
  }
  CardSearch.reset();
  for (let i = 0; i < CardSearch._max.MAX_RESULTS + 25; i++) {
    CardSearch.remember(card({ _id: 'c' + i, description: 'commonword here' }));
  }
  expect(CardSearch.search('commonword')).toHaveLength(CardSearch._max.MAX_RESULTS);
});

test('a huge lorebook cannot blow the per-card memory budget', () => {
  const entries = [];
  for (let i = 0; i < 400; i++) {
    entries.push({ key: ['k' + i], content: 'c'.repeat(500) + ' sentinel' + i });
  }
  CardSearch.remember(card({ character_book: { entries } }));

  // Whatever fits inside CARD_CAP is indexed...
  const suffix = 'sentinel0';
  expect(CardSearch.search(suffix).length).toBeLessThanOrEqual(1);
  // ...and a field far past the budget is dropped rather than kept in memory.
  expect(CardSearch.search('sentinel399')).toEqual([]);
});

test('tolerates malformed cards (null fields, numeric tags, missing ids)', () => {
  CardSearch.remember({ _id: 'weird', name: null, tags: [42, null], description: undefined, character_book: { entries: [null, 'nope'] } });
  CardState.cards = [{ _id: 'weird' }];

  expect(() => CardSearch.search('42')).not.toThrow();
  expect(CardSearch.search('42')).toHaveLength(1);
  expect(() => CardSearch.remember({ name: 'no id' })).not.toThrow();
  expect(() => CardSearch.remember(null)).not.toThrow();
});
