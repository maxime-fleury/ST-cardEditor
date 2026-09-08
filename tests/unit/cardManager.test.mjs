import { test, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';

// cardManager.js now imports its dependencies as real ES modules (passe 4),
// so this suite mocks every one of them with mock.module and mutates the
// stub objects per-test (window/document/localStorage remain free globals).
let CardManager;
// Tests that exercise _doSelect stub out renderCardList (it needs a real DOM);
// restore the original afterwards so the tag-path tests run it for real.
let realRenderCardList;

const noop = () => {};

const makeEl = () => ({
  innerHTML: '',
  textContent: '',
  value: '',
  style: {},
  dataset: {},
  classList: {
    add: noop, remove: noop, toggle: () => false, contains: () => false,
  },
  addEventListener: noop,
  removeEventListener: noop,
  querySelectorAll: () => [],
  querySelector: () => null,
  appendChild: noop,
  setAttribute: noop,
  focus: noop,
  closest: () => null,
});

// Fake document answering only the selectors renderCardList touches; any
// unlisted selector returns null so optional elements are skipped.
function makeDom(ids) {
  const els = new Map(ids.map((id) => [id, makeEl()]));
  return {
    els,
    querySelector(sel) { return els.get(sel) || null; },
  };
}

const stubs = {
  I18n: { t: (k) => k },
  Ui: {
    $(sel) { return globalThis.document.querySelector(sel); },
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    setDirty: noop,
    updateUIState: noop,
    showToast: noop,
    debounce: (fn) => fn,
  },
  Anims: { staggerFadeIn: noop, _disabled: () => true },
  Editor: { syncEditorToCard: async () => {}, populateEditor: noop },
  CardStorage: {},
  AiChat: {},
  CardEngine: {},
  ExportUtils: {},
};
mock.module('../../js/i18n.js', () => ({ I18n: stubs.I18n }));
mock.module('../../js/ui.js', () => ({ Ui: stubs.Ui }));
mock.module('../../js/animations.js', () => ({ Anims: stubs.Anims }));
mock.module('../../js/editor.js', () => ({ Editor: stubs.Editor }));
mock.module('../../js/storage.js', () => ({ CardStorage: stubs.CardStorage }));
mock.module('../../js/cardEngine.js', () => ({ CardEngine: stubs.CardEngine }));
mock.module('../../js/exportUtils.js', () => ({ ExportUtils: stubs.ExportUtils }));
mock.module('../../js/aiChat.js', () => ({ AiChat: stubs.AiChat }));
// NOTE: cardManager.js itself is NOT mocked — the suite exercises the real
// module; only its dependencies above are stubbed.

beforeAll(async () => {
  globalThis.window = globalThis;
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.document = makeDom([]);
  CardManager = (await import('../../js/cardManager.js')).CardManager;
  realRenderCardList = CardManager.renderCardList;
});

const LIST_DOM = ['#cardList', '#emptyState', '#cardSearchWrap', '#libraryControls', '#cardCount'];

beforeEach(() => {
  window.AppState = { cards: [], activeCard: null, isAiLoading: false, chatHistory: [] };
  CardManager._searchQuery = '';
  CardManager._activeTagFilters = new Set();
  CardManager._selectedIds = new Set();
  CardManager._sortMode = 'manual';
  CardManager._collapsedGroups.clear();
  CardManager._cardListBound = false;
});

afterEach(() => {
  CardManager.renderCardList = realRenderCardList;
});

const baseCardStorage = () => ({
  getCard: async (id) => ({ _id: id, name: id, tags: [], description: '' }),
  setActiveCardId: noop,
  getImage: async () => null,
  getChatHistory: () => [],
  getChatSessions: () => [],
  getSessionMessages: () => [],
  saveSessionMessages: noop,
});

// AiChat's mutable state lives in ChatState (see chatState.js); _doSelect only
// drives it through the accessor methods below, so the mock records calls.
const baseAiChat = () => ({
  _abortAll: noop,
  _bumpGen: noop,
  updateSendButton: noop,
  _resetChat: noop,
  _setCurrentSession: noop,
  renderChatHistory: noop,
  updateContextBar: noop,
});

// ─── CARD SWITCH: session / apply-queue reset ─────────────────────────────

test('switching cards aborts AI and clears the apply queue and session id', async () => {
  const rendered = { list: false, history: false };
  CardManager.renderCardList = () => { rendered.list = true; };
  window.AppState.activeCard = { _id: 'A' };
  window.AppState.isAiLoading = true;

  Object.assign(stubs.CardStorage, baseCardStorage(), {
    getChatHistory: (id) => ['history for ' + id],
    getChatSessions: () => [],
  });
  Object.assign(stubs.AiChat, baseAiChat(), {
    _abortAll: () => { rendered.aborted = true; },
    _bumpGen: () => { rendered.genBumped = true; return 8; },
    _resetChat: () => { rendered.resetChat = true; }, // clears queue + session + render flag
    _setCurrentSession: () => { rendered.sessionSet = true; },
    renderChatHistory: () => { rendered.history = true; },
  });
  const populated = [];
  Object.assign(stubs.Editor, { syncEditorToCard: async () => {}, populateEditor: (c) => populated.push(c) });

  await CardManager._doSelect({ _id: 'B' });

  expect(rendered.aborted).toBe(true);
  expect(rendered.genBumped).toBe(true); // aborted run's callbacks invalidated
  expect(rendered.resetChat).toBe(true); // stale apply queue never survives a switch
  expect(rendered.sessionSet).toBeUndefined(); // no sessions: session stays cleared
  expect(rendered.history).toBe(true);
  expect(rendered.list).toBe(true);
  expect(window.AppState.isAiLoading).toBe(false);
  expect(window.AppState.activeCard._id).toBe('B');
  expect(window.AppState.chatHistory).toEqual(['history for B']); // THIS card's history
  expect(populated[0]._id).toBe('B');
});

test('restores the latest session messages and keeps its session id', async () => {
  CardManager.renderCardList = noop;
  const saves = [];
  Object.assign(stubs.CardStorage, baseCardStorage(), {
    getChatHistory: (id) => ['legacy ' + id],
    getChatSessions: () => [{ id: 's9' }], // sessions are sorted newest first
    getSessionMessages: () => ['msg-a', 'msg-b'],
    saveSessionMessages: (...args) => saves.push(args),
  });
  const session = { id: null };
  Object.assign(stubs.AiChat, baseAiChat(), {
    _setCurrentSession: (id) => { session.id = id; },
  });

  await CardManager._doSelect({ _id: 'B' });

  expect(window.AppState.chatHistory).toEqual(['msg-a', 'msg-b']);
  expect(session.id).toBe('s9');
  expect(saves).toHaveLength(0); // nothing migrated: real messages exist
});

test('session fallback migrates only the new card\'s own history', async () => {
  CardManager.renderCardList = noop;
  const saves = [];
  Object.assign(stubs.CardStorage, baseCardStorage(), {
    getChatHistory: (id) => ['history for ' + id],
    getChatSessions: () => [{ id: 's1' }],
    getSessionMessages: () => [],
    saveSessionMessages: (...args) => saves.push(args),
  });
  const session = { id: null };
  Object.assign(stubs.AiChat, baseAiChat(), {
    _setCurrentSession: (id) => { session.id = id; },
  });
  window.AppState.chatHistory = ['history for A']; // stale leftover from the previous card

  await CardManager._doSelect({ _id: 'B' });

  // The fallback must write B's own history into B's session — never A's.
  expect(saves).toEqual([['B', 's1', ['history for B']]]);
  expect(window.AppState.chatHistory).toEqual(['history for B']);
  expect(session.id).toBe('s1');
});

// ─── HARDENED TAG PATHS ───────────────────────────────────────────────────

test('_tagSet normalizes malformed tag values to trimmed lowercase strings', () => {
  const set = CardManager._tagSet({ tags: [' Fantasy ', 42, null, undefined, '', '  ', {}, ['x']] });
  expect([...set].sort()).toEqual(['42', '[object object]', 'fantasy', 'x']);
});

test('_tagSet tolerates missing or null tags', () => {
  expect(CardManager._tagSet({}).size).toBe(0);
  expect(CardManager._tagSet({ tags: null }).size).toBe(0);
});

test('_cardSignature is stable across tag case/whitespace and normalizes malformed tags', () => {
  const base = { name: 'X', description: 'D' };
  const a = CardManager._cardSignature({ ...base, tags: ['Fantasy', ' Elf '] });
  const b = CardManager._cardSignature({ ...base, tags: ['fantasy', 'elf'] });
  expect(a).toBe(b); // case + surrounding whitespace are ignored

  const c = CardManager._cardSignature({ ...base, tags: [42, null, {}] });
  const d = CardManager._cardSignature({ ...base, tags: ['42', '[object Object]'] });
  expect(c).toBe(d); // numeric/object tags are string-coerced identically

  expect(a).not.toBe(c); // genuinely different tags still differ
});

test('search matches malformed tags without crashing', () => {
  globalThis.document = makeDom(LIST_DOM);
  window.AppState.cards = [
    { _id: '1', name: 'Elara', tags: ['Fantasy', 'Elf'] },
    { _id: '2', name: 'Grom', tags: [42, null, undefined, '', ['orc']] },
    { _id: '3', name: 'Mira', tags: [{}] },
  ];

  CardManager._searchQuery = 'elf';
  CardManager.renderCardList();
  let html = document.els.get('#cardList').innerHTML;
  expect(html).toContain('Elara');   // matched via its tags
  expect(html).not.toContain('Grom');
  expect(html).not.toContain('Mira');

  CardManager._searchQuery = '42';   // numeric tag is searchable (string-coerced)
  CardManager.renderCardList();
  html = document.els.get('#cardList').innerHTML;
  expect(html).toContain('Grom');
  expect(html).not.toContain('Elara');

  CardManager._searchQuery = 'object'; // object tag is searchable (never a crash)
  CardManager.renderCardList();
  html = document.els.get('#cardList').innerHTML;
  expect(html).toContain('Mira');
  expect(html).not.toContain('Elara');
});

test('tag filter is case-insensitive and matches numeric tags', () => {
  globalThis.document = makeDom(LIST_DOM);
  window.AppState.cards = [
    { _id: '1', name: 'Elara', tags: ['Fantasy', 'Elf'] },
    { _id: '2', name: 'Grom', tags: [42] },
  ];

  CardManager._activeTagFilters = new Set(['fantasy']);
  CardManager.renderCardList();
  let html = document.els.get('#cardList').innerHTML;
  expect(html).toContain('Elara');
  expect(html).not.toContain('Grom');

  CardManager._activeTagFilters = new Set(['42']);
  CardManager.renderCardList();
  html = document.els.get('#cardList').innerHTML;
  expect(html).toContain('Grom');
  expect(html).not.toContain('Elara');
});

test('tag filter requires every selected tag and renders the no-match state', () => {
  globalThis.document = makeDom(LIST_DOM);
  window.AppState.cards = [
    { _id: '1', name: 'Elara', tags: ['fantasy', 'elf'] },
    { _id: '2', name: 'Mira', tags: ['fantasy'] },
  ];

  CardManager._activeTagFilters = new Set(['fantasy', 'elf']); // AND semantics
  CardManager.renderCardList();
  let html = document.els.get('#cardList').innerHTML;
  expect(html).toContain('Elara');
  expect(html).not.toContain('Mira');

  CardManager._activeTagFilters = new Set(['fantasy', 'nope']);
  CardManager.renderCardList();
  html = document.els.get('#cardList').innerHTML;
  expect(html).toContain('gen.noMatch'); // I18n stub returns the key
  expect(document.els.get('#emptyState').style.display).toBe('none');
});

test('search and tag filter compose', () => {
  globalThis.document = makeDom(LIST_DOM);
  window.AppState.cards = [
    { _id: '1', name: 'Elara', tags: ['fantasy', 'elf'] },
    { _id: '2', name: 'Mira', tags: ['fantasy'] },
  ];

  CardManager._searchQuery = 'el';
  CardManager._activeTagFilters = new Set(['fantasy']);
  CardManager.renderCardList();
  const html = document.els.get('#cardList').innerHTML;
  expect(html).toContain('Elara');
  expect(html).not.toContain('Mira');
});