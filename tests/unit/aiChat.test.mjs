import { test, expect, beforeAll, beforeEach, mock } from 'bun:test';

// aiChat.js now imports its dependencies as real ES modules (passe 4), so
// this suite mocks every one of them with mock.module and mutates the stub
// objects per-test (window/document/localStorage remain free globals).
// The apply-queue state lives in ChatState (see chatState.js) — tests poke
// ChatState directly and reset it between tests so no queue/session bleeds
// across cases (that isolation is exactly what the store guarantees).
let AiChat;
let ChatState;
const toasts = [];
const noop = () => {};

const stubs = {
  I18n: { t: (key) => key },
  Ui: {
    showToast: (msg) => toasts.push(msg),
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    debounce: (fn) => fn,
  },
  Editor: { populateEditor: noop, syncEditorToCard: noop, renderGreetings: noop },
  CardManager: { renderCardList: noop },
  CardEngine: { parseJSON: (s) => JSON.parse(s), toJSON: (c) => JSON.stringify(c) },
  AIService: { hasApiKey: () => true, chat: async () => ({ content: '[]' }) },
  CardStorage: {},
  Anims: { staggerFadeIn: noop },
  Settings: { getDefaultPrompt: () => '', refreshCredits: noop },
  Tokenizer: { count: async () => 0, syncCount: () => 0 },
};
mock.module('../../js/i18n.js', () => ({ I18n: stubs.I18n }));
mock.module('../../js/ui.js', () => ({ Ui: stubs.Ui }));
mock.module('../../js/editor.js', () => ({ Editor: stubs.Editor }));
mock.module('../../js/cardManager.js', () => ({ CardManager: stubs.CardManager }));
mock.module('../../js/cardEngine.js', () => ({ CardEngine: stubs.CardEngine }));
mock.module('../../js/aiService.js', () => ({ AIService: stubs.AIService }));
mock.module('../../js/storage.js', () => ({ CardStorage: stubs.CardStorage }));
mock.module('../../js/animations.js', () => ({ Anims: stubs.Anims }));
mock.module('../../js/settings.js', () => ({ Settings: stubs.Settings }));
mock.module('../../js/tokenizer.js', () => ({ Tokenizer: stubs.Tokenizer }));

beforeAll(async () => {
  globalThis.window = globalThis;
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
  AiChat = (await import('../../js/aiChat.js')).AiChat;
  ChatState = (await import('../../js/chatState.js')).ChatState;
});

beforeEach(() => {
  toasts.length = 0;
  ChatState.resetChat();
  ChatState.selectedFields.clear();
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
  ChatState.applyQueue = [
    { applied: true },
    { applied: false },
    { applied: true },
    { applied: false },
  ];
  ChatState.applyIndex = 0;
  expect(AiChat._nextUnappliedIndex()).toBe(1);
  ChatState.applyIndex = 1;
  expect(AiChat._nextUnappliedIndex()).toBe(3);
  ChatState.applyIndex = 3;
  expect(AiChat._nextUnappliedIndex()).toBe(-1); // exhausted
});

test('_applyAllPending applies every remaining change, renames the card and shows one summary toast', () => {
  toasts.length = 0;
  const activeCard = baseCard();
  window.AppState = { activeCard };
  const hidden = { hidden: false };
  ChatState.applyQueue = [
    { el: null, field: 'description', content: elodieCard, applied: false },
    { el: null, field: 'personality', content: elodieCard, applied: false },
    { el: null, field: 'description', content: 'déjà appliqué', applied: true }, // skipped
  ];

  AiChat._applyAllPending({ hide: () => { hidden.hidden = true; } });

  const data = JSON.parse(elodieCard).data;
  expect(activeCard.description).toBe(data.description);
  expect(activeCard.personality).toBe(data.personality);
  expect(activeCard.name).toBe('Elodie'); // rename carried by the card JSON
  expect(ChatState.applyQueue.map((it) => it.applied)).toEqual([true, true, true]);
  expect(hidden.hidden).toBe(true);
  // ONE summary toast (not one per field)
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain('changesApplied');
});

test('_applyAllPending handles items whose response cannot be prepared without crashing', () => {
  toasts.length = 0;
  const activeCard = baseCard();
  window.AppState = { activeCard };
  ChatState.applyQueue = [
    { el: null, field: 'description', content: elodieCard, applied: false },
    { el: null, field: 'description', content: '', applied: false }, // unparseable → skipped
  ];

  AiChat._applyAllPending({ hide: () => {} });

  expect(activeCard.description).toBe(JSON.parse(elodieCard).data.description);
  expect(ChatState.applyQueue[0].applied).toBe(true);
  expect(ChatState.applyQueue[1].applied).toBe(false); // skipped, still marked unapplied
  expect(toasts).toHaveLength(1); // summary counts only the applied one
});

// ─── Ready-bar (footer) ───────────────────────────────────────────────────

test('_firstUnappliedIndex finds the first pending change', () => {
  ChatState.applyQueue = [
    { applied: true },
    { applied: false },
    { applied: true },
  ];
  expect(AiChat._firstUnappliedIndex()).toBe(1);
  ChatState.applyQueue = [{ applied: true }];
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
  ChatState.applyQueue = [
    { el: sections[0], field: 'description', content: elodieCard, applied: false },
    { el: sections[1], field: 'personality', content: elodieCard, applied: false },
  ];
  ChatState.applyElMap.set(sections[0], ChatState.applyQueue[0]);
  ChatState.applyElMap.set(sections[1], ChatState.applyQueue[1]);

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
  expect(ChatState.applyQueue.every((it) => it.applied)).toBe(true);
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
  stubs.CardEngine.parseJSON = (s) => { const p = JSON.parse(s); return { ...(p.data || p) }; };
  stubs.CardEngine.toJSON = (c) => JSON.stringify(c);
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

// ─── LLM intent detection (passe 3) ───────────────────────────────────────

test('_classifyFields parses a JSON field list and keeps only valid ids', async () => {
  stubs.AIService.hasApiKey = () => true;
  stubs.AIService.chat = async () => ({ content: '["name","description","nonsense"]' });
  const out = await AiChat._classifyFields('Renomme la carte en Elodie');
  expect(out).toEqual(['name', 'description']); // invalid id filtered, FIELD_DEFS order kept
});

test('_classifyFields returns [] on garbage, empty lists and failures', async () => {
  stubs.AIService.hasApiKey = () => true;
  stubs.AIService.chat = async () => ({ content: 'not json' });
  expect(await AiChat._classifyFields('x')).toEqual([]);

  stubs.AIService.chat = async () => ({ content: '[]' });
  expect(await AiChat._classifyFields('x')).toEqual([]);

  stubs.AIService.chat = async () => ({ content: '{"field": "name"}' }); // object, not array
  expect(await AiChat._classifyFields('x')).toEqual([]);

  stubs.AIService.chat = async () => { throw new Error('timeout'); };
  expect(await AiChat._classifyFields('x')).toEqual([]); // never throws
});

test('_resolveTargetFields prefers the LLM result over the regex fallback', async () => {
  stubs.AIService.hasApiKey = () => true;
  stubs.AIService.chat = async () => ({ content: '["scenario"]' });
  // The regex would say name (+ description); the LLM wins when it answers.
  const out = await AiChat._resolveTargetFields('Renomme la carte en Elodie');
  expect(out).toEqual(['scenario']);
});

test('_resolveTargetFields falls back to regex when the LLM is empty or keyless', async () => {
  stubs.AIService.hasApiKey = () => true;
  stubs.AIService.chat = async () => ({ content: '[]' });
  const out = await AiChat._resolveTargetFields(
    'Renomme la carte en Elodie, elle est étudiante fauchée'
  );
  expect(out).toContain('name');
  expect(out).toContain('description');

  // Keyless: the LLM is never called, regex still works offline.
  let called = false;
  stubs.AIService.hasApiKey = () => false;
  stubs.AIService.chat = async () => { called = true; return { content: '["name"]' }; };
  const out2 = await AiChat._resolveTargetFields('Renomme la carte en Elodie');
  expect(called).toBe(false);
  expect(out2).toContain('name');
});

test('_resolveTargetFields dedupes concurrent classifications', async () => {
  let calls = 0;
  stubs.AIService.hasApiKey = () => true;
  stubs.AIService.chat = async () => {
    calls++;
    await new Promise((r) => { setTimeout(r, 10); });
    return { content: '["name"]' };
  };
  const [a, b] = await Promise.all([
    AiChat._resolveTargetFields('x'),
    AiChat._resolveTargetFields('x'),
  ]);
  expect(calls).toBe(1);
  expect(a).toEqual(['name']);
  expect(b).toEqual(['name']);
});

test('_classifyFields passes the selected model to the classifier request', async () => {
  stubs.AIService.hasApiKey = () => true;
  let seenModel = null;
  stubs.AIService.chat = async (prompt, system, model) => {
    seenModel = model;
    return { content: '["name"]' };
  };
  const out = await AiChat._classifyFields('Renomme la carte en Elodie', 'acme/model-9');
  expect(out).toEqual(['name']);
  expect(seenModel).toBe('acme/model-9'); // the navbar selection, not ''
});

test('_classifyFields tolerates a missing model (falls back gracefully)', async () => {
  stubs.AIService.hasApiKey = () => true;
  let seenModel = null;
  stubs.AIService.chat = async (prompt, system, model) => {
    seenModel = model;
    return { content: '["scenario"]' };
  };
  const out = await AiChat._classifyFields('Arrive chez quelqu\'un');
  expect(out).toEqual(['scenario']);
  expect(seenModel).toBe('');
});

// ─── STORED-JSON UNWRAPPING (legacy damage repair) ────────────────────────

test('_unwrapStoredJSON extracts a field out of a whole card JSON stored in that field', () => {
  // Legacy damage: the old broken editor dumped the WHOLE card JSON into a
  // single field. The helper must pull the field's own value back out.
  expect(AiChat._unwrapStoredJSON('description', elodieCard))
    .toBe(JSON.parse(elodieCard).data.description);
  expect(AiChat._unwrapStoredJSON('first_mes', elodieCard))
    .toBe(JSON.parse(elodieCard).data.first_mes);
  expect(AiChat._unwrapStoredJSON('name', elodieCard)).toBe('Elodie');
  expect(AiChat._unwrapStoredJSON('alternate_greetings', elodieCard))
    .toBe(JSON.stringify(JSON.parse(elodieCard).data.alternate_greetings, null, 2));
});

test('_unwrapStoredJSON leaves plain text and foreign JSON untouched', () => {
  expect(AiChat._unwrapStoredJSON('description', 'Une description normale.')).toBe('Une description normale.');
  // JSON that is not a card (no name) is NOT unwrapped — same guard as _extractCard.
  expect(AiChat._unwrapStoredJSON('description', '{"description":"just some json"}'))
    .toBe('{"description":"just some json"}');
  expect(AiChat._unwrapStoredJSON('description', '')).toBe('');
  expect(AiChat._unwrapStoredJSON('description', null)).toBeNull();
  // Field absent from the detected card → raw value kept.
  expect(AiChat._unwrapStoredJSON('creator_notes', elodieCard)).toBe(elodieCard);
});

test('_cleanCardForPrompt unwraps every polluted text field of a card copy', () => {
  const dirty = {
    name: 'Old Name',
    description: elodieCard,          // whole card JSON dumped here
    personality: elodieCard,
    first_mes: 'salut {user}',        // clean field stays as-is (normalization is separate)
  };
  const clean = AiChat._cleanCardForPrompt(dirty);
  expect(clean.description).toBe(JSON.parse(elodieCard).data.description);
  expect(clean.personality).toBe(JSON.parse(elodieCard).data.personality);
  expect(clean.first_mes).toBe('salut {user}');
  // The original card is never mutated (copy semantics).
  expect(dirty.description).toBe(elodieCard);
});

test('_repairStoredCardJSON unwraps polluted fields in place and reports the count', () => {
  const card = {
    name: 'Old',
    description: elodieCard,
    personality: 'propre',
    first_mes: elodieCard,
  };
  const repaired = AiChat._repairStoredCardJSON(card);
  expect(repaired).toBe(2);
  expect(card.description).toBe(JSON.parse(elodieCard).data.description);
  expect(card.first_mes).toBe(JSON.parse(elodieCard).data.first_mes);
  expect(card.personality).toBe('propre'); // untouched
});

test('_repairStoredCardJSON returns 0 for clean cards and non-objects', () => {
  expect(AiChat._repairStoredCardJSON({ name: 'X', description: 'propre' })).toBe(0);
  expect(AiChat._repairStoredCardJSON(null)).toBe(0);
  expect(AiChat._repairStoredCardJSON('nope')).toBe(0);
});

test('_prepareApply shows the unwrapped stored JSON as the diff oldVal', () => {
  const activeCard = baseCard();
  activeCard.description = elodieCard; // legacy damage already in the card
  window.AppState = { activeCard };

  const prep = AiChat._prepareApply('description', 'Nouvelle description propre.');
  expect(prep).not.toBeNull();
  expect(prep.oldVal).toBe(JSON.parse(elodieCard).data.description); // not the JSON blob
  expect(prep.newVal).toBe('Nouvelle description propre.');
});

test('buildSystemPrompt unwraps stored JSON before sending Current to the model', () => {
  const activeCard = baseCard();
  activeCard.description = elodieCard; // legacy damage
  window.AppState = { activeCard };
  stubs.CardStorage.getPrompt = () => 'Rewrite the {field} field. Current: {current}';
  stubs.Settings.getDefaultPrompt = () => '';

  const prompt = AiChat.buildSystemPrompt('description');
  expect(prompt).toContain(JSON.parse(elodieCard).data.description); // clean text reaches the model
  expect(prompt).not.toContain('chara_card_v2'); // the JSON blob itself is gone
  delete stubs.CardStorage.getPrompt;
});