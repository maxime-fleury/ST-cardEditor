/* ============================================================
   intentLearner.js — Self-learning field-intent vocabulary
   ============================================================
   The regex intent classifier (_inferFields) only knows FR/EN keywords, and
   the LLM classifier costs a request every time. This module persists a
   keyword -> field vocabulary learned from two trusted signals:
     1. the LLM classifier's own judgment (it generalizes across all 27 UI
        languages; the user implicitly accepts it by sending), and
     2. explicit user corrections (toggling a field chip while a prompt is
        typed).
   Recall is free and offline: it runs BEFORE the LLM call, so keyless and
   offline users benefit from every past classification.

   Evidence is counted per keyword per field and recall requires a minimum
   total evidence (>= 2) so a single noisy example never changes behavior.
   Stored in localStorage; degrades silently to an in-memory map when
   localStorage is unavailable (private mode, unit tests). */

// @ts-check

const STORE_KEY = 'stce.intentLearner.v1';
const MIN_WORD_LEN = 4;
const MAX_KEYWORDS = 300;
const MAX_EVIDENCE = 20;

// Common FR/EN stopwords plus roleplay fillers — never signal a field.
// Accented forms are unnecessary: normalize() strips diacritics first.
const STOPWORDS = new Set([
  'alors', 'avec', 'dans', 'dune', 'elle', 'elles', 'leur', 'leurs', 'mais', 'pour',
  'quand', 'quel', 'quelle', 'quels', 'qui', 'sans', 'sur', 'tout', 'toute', 'tous',
  'toutes', 'aussi', 'etre', 'faire', 'fait', 'faites', 'veut', 'chez', 'carte',
  'card', 'that', 'this', 'with', 'from', 'have', 'been', 'were', 'will', 'would',
  'could', 'should', 'about', 'their', 'there', 'these', 'those', 'being',
  'what', 'when', 'where', 'which', 'while', 'your', 'yours', 'them', 'then',
  'than', 'into', 'just', 'like', 'make', 'made', 'more', 'most', 'much',
  'many', 'only', 'other', 'over', 'some', 'such', 'take', 'very', 'want',
  'well', 'also', 'even', 'first', 'last', 'next', 'really',
]);

/** @type {Record<string, Record<string, number>> | null} in-memory cache of the store */
let mem = null;

/** Lowercase, strip diacritics, split on non-letters, drop stopwords/short words. */
function normalize(text) {
  if (!text || typeof text !== 'string') return [];
  return (text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/))
    .filter(w => w.length >= MIN_WORD_LEN && !STOPWORDS.has(w));
}

/** @returns {Record<string, Record<string, number>>} */
function load() {
  if (mem) return mem;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORE_KEY);
      mem = raw ? JSON.parse(raw) : {};
    } else {
      mem = {};
    }
  } catch (_) {
    mem = {};
  }
  return /** @type {Record<string, Record<string, number>>} */ (mem);
}

function save(map) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch (_) {
    // In-memory map still serves recall for this session.
  }
}

/** Drop the least-evidenced keywords once the store exceeds MAX_KEYWORDS. */
function prune(map) {
  const keys = Object.keys(map);
  if (keys.length <= MAX_KEYWORDS) return;
  const total = (k) => Object.values(map[k]).reduce((s, n) => s + n, 0);
  keys.sort((a, b) => total(a) - total(b));
  for (let i = 0; i < keys.length - MAX_KEYWORDS; i++) delete map[keys[i]];
}

const IntentLearner = {
  /**
   * Record that the words of `prompt` signal the given card fields.
   * Evidence is capped per keyword so a repeated prompt cannot dominate.
   */
  learn(prompt, fields) {
    const words = normalize(prompt);
    const fieldSet = new Set((fields || []).filter(f => typeof f === 'string' && f));
    if (!words.length || fieldSet.size === 0) return;
    const map = load();
    let changed = false;
    for (const w of words) {
      const entry = map[w] || (map[w] = {});
      for (const f of fieldSet) {
        entry[f] = Math.min((entry[f] || 0) + 1, MAX_EVIDENCE);
        changed = true;
      }
    }
    if (changed) { prune(map); save(map); }
  },

  /**
   * Fields whose learned keywords appear in `prompt`, ordered by evidence.
   * Returns [] when the evidence is below the confidence threshold (2).
   */
  recall(prompt) {
    const words = normalize(prompt);
    if (!words.length) return [];
    const map = load();
    /** @type {Map<string, number>} */
    const evidence = new Map();
    for (const w of words) {
      const entry = map[w];
      if (!entry) continue;
      for (const [f, c] of Object.entries(entry)) {
        evidence.set(f, (evidence.get(f) || 0) + c);
      }
    }
    if (!evidence.size) return [];
    return [...evidence.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f);
  },

  /** Test-only: drop the persisted vocabulary and the in-memory cache. */
  _reset() {
    mem = null;
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORE_KEY);
    } catch (_) {}
  },
};

export { IntentLearner };
if (typeof window !== 'undefined') window.IntentLearner = IntentLearner;