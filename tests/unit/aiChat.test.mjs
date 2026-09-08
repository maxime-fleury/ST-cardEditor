import { test, expect, beforeAll } from 'bun:test';

// aiChat.js is a plain object literal (browser-glued methods run only when
// called), so importing it is safe without DOM stubs. _prepareApply touches
// window.AppState / Editor / CardManager / Ui / I18n at call time only.
let AiChat;
const toasts = [];

beforeAll(async () => {
  globalThis.window = globalThis;
  globalThis.I18n = { t: (key) => key };
  globalThis.Ui = { showToast: (msg) => toasts.push(msg), escapeHtml: (s) => String(s) };
  // Minimal DOM for the ready-bar helpers (document.createElement / all()).
  const makeStubEl = () => ({
    className: '',
    type: '',
    innerHTML: '',
    _children: [],
    _handlers: {},
    addEventListener(ev, fn) { this._handlers[ev] = fn; },
    appendChild(c) { this._children.push(c); },
    querySelectorAll() { return this._children; },
  });
  globalThis.document = {
    createElement: () => makeStubEl(),
    querySelectorAll: () => [],
  };
  globalThis.Editor = {
    populateEditor: () => {},
    syncEditorToCard: () => {},
    renderGreetings: () => {},
  };
  globalThis.CardManager = { renderCardList: () => {} };
  AiChat = (await import('../../js/aiChat.js')).AiChat;
});

// A model that ignores the per-field instruction and answers a field request
// with the WHOLE card as JSON (the bug: each section then showed a full card
// blob instead of the field's content, and applying dumped JSON into fields).
const elodieCard = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Elodie',
    description: "Étudiante fauchée qui fait des ménages pour arrondir ses fins de mois.",
    personality: 'Curieuse, observatrice, sarcastique.',
    first_mes: '« Bonjour, c\'est Elodie. »',
    scenario: 'Elle arrive chez {{user}}, c\'est le bordel.',
    mes_example: '<START>\n{{char}}: Salut.',
    alternate_greetings: ['Salut !', 'T\'es chez toi ?'],
    tags: ['student', 'housekeeper'],
    creator: 'Makusu',
    character_version: '1.0',
    character_book: { entries: [] },
    extensions: {},
  },
});

const baseCard = () => ({
  _id: 'c1',
  name: 'Ancien Nom',
  description: 'old desc',
  personality: 'old perso',
  first_mes: 'old first',
  scenario: 'old scenario',
  mes_example: 'old mes',
  alternate_greetings: ['old greeting'],
  tags: ['old-tag'],
});

// ─── name field ───────────────────────────────────────────────────────────

test('FIELD_DEFS exposes name as a selectable target', () => {
  const def = AiChat.FIELD_DEFS.find((d) => d.id === 'name');
  expect(def).toBeDefined();
  expect(def.labelKey).toBe('ai.target.name');
  expect(AiChat.FIELD_DEFS[0].id).toBe('name'); // first chip, like in the card JSON
});

test('_prepareApply applies a plain name response to the card name', () => {
  const activeCard = baseCard();
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('name', 'Elodie');
  expect(prep).not.toBeNull();
  expect(prep.oldVal).toBe('Ancien Nom');
  expect(prep.newVal).toBe('Elodie');
  prep.applyFn();
  expect(activeCard.name).toBe('Elodie');
});

test('_prepareApply extracts the name out of a full-card response', () => {
  const activeCard = baseCard();
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('name', elodieCard);
  expect(prep.newVal).toBe('Elodie');
  prep.applyFn();
  expect(activeCard.name).toBe('Elodie');
});

test('_fieldDisplayContent extracts the name from a full-card response', () => {
  expect(AiChat._fieldDisplayContent('name', elodieCard)).toBe('Elodie');
});

// ─── _extractCard ─────────────────────────────────────────────────────────

test('_extractCard detects a full chara_card_v2 JSON response', () => {
  const card = AiChat._extractCard(elodieCard);
  expect(card).not.toBeNull();
  expect(card.data.name).toBe('Elodie');
});

test('_extractCard handles code fences and surrounding prose', () => {
  expect(AiChat._extractCard('```json\n' + elodieCard + '\n```').data.name).toBe('Elodie');
  expect(AiChat._extractCard('Voici la carte :\n' + elodieCard + '\nVoilà !').data.name).toBe('Elodie');
});

test('_extractCard accepts a flat name/description JSON but rejects arbitrary JSON', () => {
  // Flat layout (no spec/data wrapper): the card object is returned as-is.
  const flat = AiChat._extractCard('{"name":"Elodie","description":"D"}');
  expect(flat).not.toBeNull();
  expect(flat.name).toBe('Elodie');
  // JSON without a name is NOT a card — must not be unwrapped.
  expect(AiChat._extractCard('{"description":"just some json"}')).toBeNull();
  expect(AiChat._extractCard('{"data":{"description":"x"}}')).toBeNull();
  // Arrays and plain text are not cards either.
  expect(AiChat._extractCard('["fantasy","warrior"]')).toBeNull();
  expect(AiChat._extractCard('plain text without JSON')).toBeNull();
  expect(AiChat._extractCard('')).toBeNull();
});

// ─── _fieldDisplayContent ─────────────────────────────────────────────────

test('_fieldDisplayContent shows only the requested field, not the JSON blob', () => {
  expect(AiChat._fieldDisplayContent('description', elodieCard)).toBe(JSON.parse(elodieCard).data.description);
  expect(AiChat._fieldDisplayContent('first_mes', elodieCard)).toBe(JSON.parse(elodieCard).data.first_mes);
  expect(AiChat._fieldDisplayContent('alternate_greetings', elodieCard))
    .toBe(JSON.stringify(JSON.parse(elodieCard).data.alternate_greetings, null, 2));
});

test('_fieldDisplayContent leaves non-card content untouched', () => {
  const plain = 'Une description normale, pas de JSON.';
  expect(AiChat._fieldDisplayContent('description', plain)).toBe(plain);
  // Field absent from the detected card → keep the raw response.
  expect(AiChat._fieldDisplayContent('creator_notes', elodieCard)).toBe(elodieCard);
});

// ─── _prepareApply: per-field extraction + auto-rename ────────────────────

test('_prepareApply extracts the field from a full-card response instead of dumping JSON', () => {
  const activeCard = baseCard();
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('description', elodieCard);
  expect(prep).not.toBeNull();
  expect(prep.oldVal).toBe('old desc');
  expect(prep.newVal).toBe(JSON.parse(elodieCard).data.description); // field value, not the card JSON

  prep.applyFn();
  expect(activeCard.description).toBe(JSON.parse(elodieCard).data.description);
  expect(activeCard.name).toBe('Elodie'); // rename carried by the card JSON
});

test('_prepareApply does not rename when the card JSON proposes the current name', () => {
  const activeCard = baseCard();
  activeCard.name = 'Elodie'; // already the proposed name
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('first_mes', elodieCard);
  prep.applyFn();
  expect(activeCard.first_mes).toBe(JSON.parse(elodieCard).data.first_mes);
  expect(activeCard.name).toBe('Elodie'); // unchanged
});

test('_prepareApply extracts alternate_greetings from the card (not the first array in the JSON)', () => {
  const activeCard = baseCard();
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('alternate_greetings', elodieCard);
  expect(prep).not.toBeNull();
  // Must be the card's greetings — NOT the tags array that also appears in the JSON.
  expect(prep.newVal).toBe(JSON.stringify(['Salut !', 'T\'es chez toi ?'], null, 2));
  prep.applyFn();
  expect(activeCard.alternate_greetings).toEqual(['Salut !', 'T\'es chez toi ?']);
  expect(activeCard.name).toBe('Elodie');
});

test('_prepareApply tags branch prefers the card\'s tags over any array in the JSON', () => {
  const activeCard = baseCard();
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('tags', elodieCard);
  expect(prep).not.toBeNull();
  expect(prep.newVal).toBe(JSON.stringify(['old-tag', 'student', 'housekeeper'], null, 2));
  prep.applyFn();
  expect(activeCard.tags).toEqual(['old-tag', 'student', 'housekeeper']);
});

test('_prepareApply keeps normal per-field responses unchanged', () => {
  const activeCard = baseCard();
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('description', 'Une nouvelle description.');
  expect(prep.newVal).toBe('Une nouvelle description.');
  prep.applyFn();
  expect(activeCard.description).toBe('Une nouvelle description.');
  expect(activeCard.name).toBe('Ancien Nom'); // no rename without a card JSON
});

// ─── Apply & next / Apply all ─────────────────────────────────────────────

test('_prepareApply silent option suppresses the per-item success toast', () => {
  toasts.length = 0;
  const activeCard = baseCard();
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('description', elodieCard, { silent: true });
  prep.applyFn();
  expect(toasts).toEqual([]); // no fieldUpdated / cardRenamed toast

  const loud = AiChat._prepareApply('description', 'Autre description.', {});
  loud.applyFn();
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain('fieldUpdated');
});

test('_nextUnappliedIndex skips already-applied changes', () => {
  AiChat._applyQueue = [
    { applied: true },
    { applied: false },
    { applied: true },
    { applied: false },
  ];
  AiChat._applyIndex = 0;
  expect(AiChat._nextUnappliedIndex()).toBe(1);
  AiChat._applyIndex = 1;
  expect(AiChat._nextUnappliedIndex()).toBe(3);
  AiChat._applyIndex = 3;
  expect(AiChat._nextUnappliedIndex()).toBe(-1); // exhausted
});

test('_applyAllPending applies every remaining change, renames the card and shows one summary toast', () => {
  toasts.length = 0;
  const activeCard = baseCard();
  window.AppState = { activeCard };
  const hidden = { hidden: false };
  AiChat._applyQueue = [
    { el: null, field: 'description', content: elodieCard, applied: false },
    { el: null, field: 'personality', content: elodieCard, applied: false },
    { el: null, field: 'description', content: 'déjà appliqué', applied: true }, // skipped
  ];

  AiChat._applyAllPending({ hide: () => { hidden.hidden = true; } });

  const data = JSON.parse(elodieCard).data;
  expect(activeCard.description).toBe(data.description);
  expect(activeCard.personality).toBe(data.personality);
  expect(activeCard.name).toBe('Elodie'); // rename carried by the card JSON
  expect(AiChat._applyQueue.map((it) => it.applied)).toEqual([true, true, true]);
  expect(hidden.hidden).toBe(true);
  // ONE summary toast (not one per field)
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain('changesApplied');
});

test('_applyAllPending handles items whose response cannot be prepared without crashing', () => {
  toasts.length = 0;
  const activeCard = baseCard();
  window.AppState = { activeCard };
  AiChat._applyQueue = [
    { el: null, field: 'description', content: elodieCard, applied: false },
    { el: null, field: 'description', content: '', applied: false }, // unparseable → skipped
  ];

  AiChat._applyAllPending({ hide: () => {} });

  expect(activeCard.description).toBe(JSON.parse(elodieCard).data.description);
  expect(AiChat._applyQueue[0].applied).toBe(true);
  expect(AiChat._applyQueue[1].applied).toBe(false); // skipped, still marked unapplied
  expect(toasts).toHaveLength(1); // summary counts only the applied one
});

// ─── Ready-bar (footer) ───────────────────────────────────────────────────

test('_firstUnappliedIndex finds the first pending change', () => {
  AiChat._applyQueue = [
    { applied: true },
    { applied: false },
    { applied: true },
  ];
  expect(AiChat._firstUnappliedIndex()).toBe(1);
  AiChat._applyQueue = [{ applied: true }];
  expect(AiChat._firstUnappliedIndex()).toBe(-1);
});

test('_finalizeGroupedCard appends a ready-bar whose Apply-all applies every change', () => {
  toasts.length = 0;
  const activeCard = baseCard();
  window.AppState = { activeCard };
  const makeSection = () => ({
    dataset: {},
    classList: { add() {}, remove() {} },
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
  });
  const sections = [makeSection(), makeSection()];
  const groupedCard = {
    header: { innerHTML: '' },
    footer: null,
    querySelector(sel) { return sel === '.multi-field-header' ? this.header : null; },
    querySelectorAll(sel) {
      if (sel.includes('.multi-field-section.done')) return sections;
      if (sel.includes('.multi-field-section.error')) return [];
      return [];
    },
    appendChild(el) { this.footer = el; },
  };
  AiChat._applyQueue = [
    { el: sections[0], field: 'description', content: elodieCard, applied: false },
    { el: sections[1], field: 'personality', content: elodieCard, applied: false },
  ];
  AiChat._applyElMap.set(sections[0], AiChat._applyQueue[0]);
  AiChat._applyElMap.set(sections[1], AiChat._applyQueue[1]);

  AiChat._finalizeGroupedCard(groupedCard, 2);

  expect(groupedCard.footer).not.toBeNull();
  expect(groupedCard.footer.className).toBe('multi-field-footer');
  const [viewBtn, applyAllBtn] = groupedCard.footer._children;
  expect(applyAllBtn.innerHTML).toContain('diff.applyAll');
  expect(viewBtn.innerHTML).toContain('ai.reviewApply');

  applyAllBtn._handlers.click();
  const data = JSON.parse(elodieCard).data;
  expect(activeCard.description).toBe(data.description);
  expect(activeCard.personality).toBe(data.personality);
  expect(activeCard.name).toBe('Elodie');
  expect(AiChat._applyQueue.every((it) => it.applied)).toBe(true);
  expect(toasts).toHaveLength(1); // single summary toast
});

// ─── Natural language + macro normalization ───────────────────────────────

test('_normalizePlaceholders converts user/char references to SillyTavern macros', () => {
  expect(AiChat._normalizePlaceholders("elle arrive chez {user} c'est le bordel"))
    .toBe("elle arrive chez {{user}} c'est le bordel");
  expect(AiChat._normalizePlaceholders('{User} et {char}')).toBe('{{user}} et {{char}}');
  expect(AiChat._normalizePlaceholders('{{User}} et {{CHAR}}')).toBe('{{user}} et {{char}}');
  expect(AiChat._normalizePlaceholders('bonjour {{user}}')).toBe('bonjour {{user}}'); // already correct
  expect(AiChat._normalizePlaceholders('{random} {field} {count}')).toBe('{random} {field} {count}'); // not user/char
  expect(AiChat._normalizePlaceholders('« Bonjour, c\'est Elodie »')).toBe('« Bonjour, c\'est Elodie »'); // untouched
  expect(AiChat._normalizePlaceholders(null)).toBeNull();
  expect(AiChat._normalizePlaceholders('')).toBe('');
});

test('_inferFields detects the fields of the Elodie request', () => {
  const fields = AiChat._inferFields(
    "Renomme la carte en Elodie, elle est étudiante fauchée et veut se faire de l'argent "
    + "elle arrive chez {user} c'est le bordel, et elle dit « Bonjour, c'est Elodie » "
    + "puis c'est au tour du joueur de continuer, comme elle est femme de ménage étudiante, elle voit tout du joueur"
  );
  expect(fields).toContain('name');
  expect(fields).toContain('description');
  expect(fields).toContain('first_mes');
  expect(fields).toContain('scenario');
});

test('_inferFields returns nothing for empty or unrelated prompts', () => {
  expect(AiChat._inferFields('')).toEqual([]);
  expect(AiChat._inferFields('combien font 2+2')).toEqual([]);
});

test('_prepareApply normalizes {user} in field content before applying', () => {
  const activeCard = baseCard();
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('first_mes', 'Bonjour {user}, bienvenue chez moi.');
  expect(prep.newVal).toBe('Bonjour {{user}}, bienvenue chez moi.');
  prep.applyFn();
  expect(activeCard.first_mes).toBe('Bonjour {{user}}, bienvenue chez moi.');
});

test('_prepareApply full-card normalizes {user} in every text field', () => {
  toasts.length = 0;
  const activeCard = baseCard();
  window.AppState = { activeCard };
  globalThis.CardEngine = {
    parseJSON: (s) => { const p = JSON.parse(s); return { ...(p.data || p) }; },
    toJSON: (c) => JSON.stringify(c),
  };
  const cardWithUser = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Elodie',
      description: 'Salue {user} en arrivant.',
      first_mes: 'Bonjour {user}',
      alternate_greetings: ['Coucou {user}', 'Salut {char}'],
    },
  });

  const prep = AiChat._prepareApply('full', cardWithUser);
  expect(prep).not.toBeNull();
  prep.applyFn();
  expect(activeCard.description).toBe('Salue {{user}} en arrivant.');
  expect(activeCard.first_mes).toBe('Bonjour {{user}}');
  expect(activeCard.alternate_greetings).toEqual(['Coucou {{user}}', 'Salut {{char}}']);
});

test('_finalizeGroupedCard adds no ready-bar when nothing completed', () => {
  const groupedCard = {
    header: { innerHTML: '' },
    footer: null,
    querySelector(sel) { return sel === '.multi-field-header' ? this.header : null; },
    querySelectorAll(sel) {
      if (sel.includes('.multi-field-section.done')) return [];
      return [];
    },
    appendChild(el) { this.footer = el; },
  };
  AiChat._finalizeGroupedCard(groupedCard, 3);
  expect(groupedCard.footer).toBeNull();
});