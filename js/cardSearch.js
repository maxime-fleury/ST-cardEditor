// @ts-check
/* ============================================================
   cardSearch.js — full-text index over the card library
   ============================================================
   Library search used to match only name/creator/tags, so finding a card by a
   line of its description, a greeting or a lorebook entry was impossible even
   though every byte of it already lives in IndexedDB.

   This module keeps one in-memory entry per card: every searchable field in a
   normalized form (lowercased, diacritics stripped) plus a truncated raw copy
   for the result snippet. Building it is a by-idle-task job (an IndexedDB read
   per card), and it stays current through the app's single write funnel
   (CardStorage.upsertCard → `stce:card-saved`, see cardManager.js), so a saved
   card is searchable immediately without re-reading anything.

   Memory is the real budget here — this is the only structure that grows with
   the library and is never persisted — so anything derivable is derived instead
   of stored: the folded copy a snippet needs is rebuilt for the handful of
   results actually returned, not kept per field (see foldSameLength), and a
   snippet is built only after the ranked list has been truncated. `stats()`
   reports what is retained, and tests/unit/cardSearch.test.mjs pins a per-card
   ceiling so a future field or cap cannot quietly double it.

   Dependency-free on purpose (CardState only): the loader that reads cards from
   storage is injected by the caller, which keeps this module testable and out
   of the storage/manager import cycle. */

import { CardState } from './cardState.js';
import { fold, foldSameLength } from './textFold.js';

// Bounds. A card's text is user-provided and can be huge (a lorebook with
// hundreds of entries); the index is a convenience, not an archive, so it must
// never be able to balloon the tab's memory.
const MATCH_CAP = 16000;   // normalized chars kept per field for matching
const RAW_CAP = 2000;      // raw chars kept per field for the snippet
const CARD_CAP = 48000;    // normalized+raw chars kept per card across fields
const MAX_RESULTS = 100;
const SNIPPET_PAD = 60;    // raw chars of context kept before the match

/** @typedef {{ id: string, labelKey: string, weight: number, value: (card: CardShape) => string }} SearchField */
/** @typedef {{ norm: string, raw: string }} IndexedField */
/** @typedef {{ id: string, name: string, fields: Map<string, IndexedField> }} IndexEntry */
// SearchHit is declared globally (js/globals.d.ts) so cardManager can type the
// match it renders for each row.

/** Stringify a possibly-missing/typed-whacky card value. */
function str(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

/** All lorebook text (keys, comments, content) joined, so an entry is findable. */
function lorebookText(card) {
  const entries = card.character_book && Array.isArray(card.character_book.entries)
    ? card.character_book.entries
    : [];
  const parts = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const keys = Array.isArray(entry.key) ? entry.key.map(str) : [str(entry.key)];
    const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary.map(str) : [str(entry.keysecondary)];
    parts.push(keys.join(' '), secondary.join(' '), str(entry.comment), str(entry.content));
  }
  return parts.join('\n');
}

// Search fields in descending weight order: the list is ranked by these, so a
// name hit always outranks a body hit. Weights are relative, not absolute.
/** @type {SearchField[]} */
const FIELDS = [
  { id: 'name', labelKey: 'editor.name', weight: 120, value: (c) => str(c.name) },
  { id: 'creator', labelKey: 'editor.creator', weight: 60, value: (c) => str(c.creator) },
  { id: 'tags', labelKey: 'editor.tags', weight: 60, value: (c) => (Array.isArray(c.tags) ? c.tags.map(str).join(' ') : str(c.tags)) },
  { id: 'character_version', labelKey: 'editor.version', weight: 40, value: (c) => str(c.character_version) },
  { id: 'description', labelKey: 'editor.desc', weight: 12, value: (c) => str(c.description) },
  { id: 'personality', labelKey: 'editor.personalitySummary', weight: 12, value: (c) => str(c.personality) },
  { id: 'scenario', labelKey: 'editor.scenario', weight: 12, value: (c) => str(c.scenario) },
  { id: 'first_mes', labelKey: 'editor.firstMes', weight: 10, value: (c) => str(c.first_mes) },
  { id: 'alternate_greetings', labelKey: 'editor.greetings', weight: 8, value: (c) => (Array.isArray(c.alternate_greetings) ? c.alternate_greetings.map(str).join('\n') : '') },
  { id: 'mes_example', labelKey: 'editor.mesExample', weight: 8, value: (c) => str(c.mes_example) },
  { id: 'system_prompt', labelKey: 'editor.systemPrompt', weight: 8, value: (c) => str(c.system_prompt) },
  { id: 'post_history_instructions', labelKey: 'editor.postHistory', weight: 8, value: (c) => str(c.post_history_instructions) },
  { id: 'creator_notes', labelKey: 'editor.creatorNotes', weight: 8, value: (c) => str(c.creator_notes) },
  { id: 'character_book', labelKey: 'editor.lorebookTitle', weight: 6, value: lorebookText },
];

/** Field id → label key, for callers that need to translate a hit's origin. */
const FIELD_LABELS = new Map(FIELDS.map((f) => [f.id, f.labelKey]));

/** Lowercase + strip diacritics, so "elodie" finds "Élodie" (js/textFold.js). */
const normalize = fold;

/** Same normalization for the query, collapsed so multi-space input still hits. */
function normalizeQuery(query) {
  return normalize(String(query || '')).replace(/\s+/g, ' ').trim();
}

/** @type {Map<string, IndexEntry>} */
let index = new Map();

/** Build the index entry for one full card. */
function buildEntry(card) {
  /** @type {Map<string, IndexedField>} */
  const fields = new Map();
  let budget = CARD_CAP;
  for (const field of FIELDS) {
    if (budget <= 0) break;
    const raw = field.value(card);
    if (!raw) continue;
    const norm = normalize(raw).slice(0, Math.min(MATCH_CAP, budget));
    fields.set(field.id, { norm, raw: raw.slice(0, RAW_CAP) });
    budget -= norm.length;
  }
  return { id: String(card._id || ''), name: str(card.name), fields };
}

/**
 * Score one field against the normalized query. Returns null when it does not
 * match — deliberately cheap, because it runs for every field of every indexed
 * card on each keystroke; the snippet is built later, for the few hits that are
 * actually returned.
 * @returns {{ score: number } | null}
 */
function scoreField(field, indexed, query) {
  const at = indexed.norm.indexOf(query);
  if (at < 0) return null;
  let score = field.weight;
  if (at === 0) score += 25;                                       // prefix hit
  else if (!/[a-z0-9]/.test(indexed.norm.charAt(at - 1))) score += 15; // word start
  let count = 1;
  for (let i = indexed.norm.indexOf(query, at + query.length); i >= 0 && count < 5; i = indexed.norm.indexOf(query, i + query.length)) count++;
  score += count * 2;
  return { score };
}

/**
 * Locate the match inside a hit's raw text and cut the snippet window around it,
 * folding the text here rather than keeping a folded copy in the index (see
 * foldSameLength in js/textFold.js). If the fold cannot map the match, the
 * caller's badge still names the field and the snippet falls back to the head of
 * the field — folding is deliberately not stored per field, because that copy
 * cost as much as the raw text again for every field of every card while only
 * the returned hits ever read it.
 * @param {string} raw
 * @param {string} query
 * @returns {{ snippet: string, start: number, length: number }}
 */
function snippetFor(raw, query) {
  const rawAt = foldSameLength(raw).indexOf(query);
  const pos = rawAt >= 0 ? rawAt : 0;
  const len = rawAt >= 0 ? query.length : 0;
  const from = Math.max(0, pos - SNIPPET_PAD);
  // The ellipsis is part of the string, so the match offset must shift by one
  // when it is prepended — otherwise the caller's <mark> would sit one char off.
  const lead = from > 0 ? '…' : '';
  const snippet = lead + raw.slice(from, pos + Math.max(len, 0) + 120).replace(/\s+/g, ' ').trim();
  return { snippet, start: rawAt >= 0 ? pos - from + lead.length : 0, length: len };
}

const CardSearch = {
  /**
   * (Re)index one full card. Called for every save through the
   * `stce:card-saved` event, so an edited card is searchable immediately.
   */
  remember(card) {
    if (!card || !card._id) return;
    index.set(String(card._id), buildEntry(card));
  },

  forget(id) {
    index.delete(String(id));
  },

  reset() {
    index = new Map();
  },

  /** Ids present in the library but not indexed yet (index cold or card added). */
  missingIds() {
    const cards = CardState.cards || [];
    const missing = [];
    for (const meta of cards) {
      const id = meta && meta._id ? String(meta._id) : '';
      if (id && !index.has(id)) missing.push(id);
    }
    return missing;
  },

  get size() { return index.size; },

  /** Hits returned when the caller passes no explicit `limit`. */
  MAX_RESULTS,

  /**
   * Index every card that is not indexed yet, using the caller's loader (which
   * owns the storage dependency). Reads are batched so a big library does not
   * fire hundreds of IndexedDB transactions at once.
   * @param {(id: string) => Promise<CardShape | null>} loader
   */
  async ensure(loader) {
    const missing = this.missingIds();
    if (missing.length === 0) return 0;
    let indexed = 0;
    const BATCH = 8;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const cards = await Promise.all(batch.map((id) => loader(id).catch(() => null)));
      for (const card of cards) {
        if (!card) continue;
        this.remember(card);
        indexed++;
      }
    }
    return indexed;
  },

  /** Drop entries whose card no longer exists (after a delete/bulk import). */
  prune() {
    const alive = new Set((CardState.cards || []).map((c) => String(c && c._id ? c._id : '')));
    for (const id of [...index.keys()]) {
      if (!alive.has(id)) index.delete(id);
    }
  },

  /**
   * Ranked full-text hits for `query`.
   * @param {string} query
   * @param {{ allow?: Set<string> | null, limit?: number }} [options]
   *        `allow` restricts hits to those ids (the tag-filtered set).
   * @returns {SearchHit[]}
   */
  search(query, options) {
    const needle = normalizeQuery(query);
    if (!needle) return [];
    const allow = options && options.allow ? options.allow : null;
    const limit = (options && options.limit) || MAX_RESULTS;
    // Two passes on purpose: rank first (cheap, every matching card), then build
    // snippets only for the ones that survive the limit. Snippets used to be cut
    // for every match, i.e. up to the whole library per keystroke, and thrown
    // away by the slice.
    /** @type {{ id: string, field: SearchField, score: number, raw: string }[]} */
    const ranked = [];
    for (const entry of index.values()) {
      if (allow && !allow.has(entry.id)) continue;
      /** @type {{ score: number } | null} */
      let best = null;
      /** @type {SearchField | null} */
      let bestField = null;
      let bestRaw = '';
      for (const field of FIELDS) {
        const indexed = entry.fields.get(field.id);
        if (!indexed || !indexed.norm) continue;
        const scored = scoreField(field, indexed, needle);
        if (scored && (!best || scored.score > best.score)) { best = scored; bestField = field; bestRaw = indexed.raw; }
      }
      if (best && bestField) ranked.push({ id: entry.id, field: bestField, score: best.score, raw: bestRaw });
    }
    ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return ranked.slice(0, limit).map(({ id, field, score, raw }) => {
      const { snippet, start, length } = snippetFor(raw, needle);
      return {
        id,
        field: field.id,
        labelKey: field.labelKey,
        score,
        snippet,
        snippetMatchStart: start,
        snippetMatchLength: length,
      };
    });
  },

  /**
   * What the index currently retains: `chars` is the total text held (the one
   * structure that grows with the library and is never written back to disk),
   * and `keys` counts the stored strings so a test can pin that each indexed
   * field keeps exactly two (see stats() callers in
   * tests/unit/cardSearch.test.mjs) — a derived third copy is how this index
   * got twice as big as it needed to be before.
   */
  stats() {
    let chars = 0;
    let keys = 0;
    for (const entry of index.values()) {
      for (const field of entry.fields.values()) {
        chars += field.norm.length + field.raw.length;
        keys += Object.keys(field).length;
      }
    }
    return { entries: index.size, chars, keys };
  },

  /** Label key for a field id (used by the palette to jump to a field). */
  labelKeyFor(fieldId) {
    return FIELD_LABELS.get(fieldId) || 'editor.desc';
  },

  // Exposed for tests.
  _normalize: normalize,
  _fields: FIELDS,
  _max: { MATCH_CAP, RAW_CAP, CARD_CAP, MAX_RESULTS },
};

export { CardSearch };
if (typeof window !== 'undefined') window.CardSearch = CardSearch;
