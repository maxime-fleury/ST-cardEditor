// @ts-check
/* ============================================================
   cardHealth.js — card diagnostics + lorebook activation simulator
   ============================================================
   Two questions this module answers, both about a card's *text* rather than
   about the app:

     analyze(card, opts)      What is wrong or risky in this card?
     simulate(card, haystack) Which lorebook entries would actually fire?

   It is deliberately pure: no DOM, no storage, no I18n lookup at module level.
   Issues carry an i18n key plus pre-computed values, so the same report can be
   rendered in a modal, a toast or a test. The activation rules are an
   approximation of SillyTavern's — see docs/LOREBOOK.md for exactly which
   parts are modelled and which are not. */

import { Tokenizer } from './tokenizer.js';

// Macro names SillyTavern substitutes. Anything else in {{...}} is printed
// literally to the model, so it is worth flagging.
const KNOWN_MACROS = new Set([
  'user', 'char', 'charIfNotGroup', 'group', 'groupNotMuted', 'notChar',
  'random', 'pick', 'roll', 'bias',
  'time', 'date', 'weekday', 'isotime', 'isodate', 'datetimeformat',
  'idleDuration', 'newline', 'input', 'lastMessage', 'lastUserMessage',
  'lastCharMessage', 'original',
  'description', 'personality', 'scenario', 'persona', 'model',
  'maxPrompt', 'maxContext', 'exampleMessage', 'charPrompt', 'charInstruction',
  'chatHistory', 'summary', 'getvar', 'setvar', 'addvar', 'incvar', 'decvar',
]);

/** Extract `{{macro}}` / `{{macro:arg}}` names from a block of text. */
function macroNames(text) {
  const names = [];
  const re = /\{\{\s*([a-zA-Z_][\w-]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) names.push(m[1]);
  return names;
}

/** Split a lorebook `key` value (string or array) into trimmed entries. */
function toKeys(value) {
  if (Array.isArray(value)) return value.map(k => String(k == null ? '' : k).trim()).filter(Boolean);
  if (value == null) return [];
  return String(value).split(',').map(k => k.trim()).filter(Boolean);
}

/** Escape a string for use inside a RegExp. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `entry`'s key list match `haystack`? `matchWholeWords` uses word
 * boundaries, otherwise a plain (optionally case-sensitive) substring test —
 * the two switches SillyTavern exposes on every entry.
 */
function keysMatch(keys, haystack, entry) {
  if (!keys.length || !haystack) return false;
  const caseSensitive = !!entry.caseSensitive;
  const hay = caseSensitive ? haystack : haystack.toLowerCase();
  return keys.some((key) => {
    const needle = caseSensitive ? key : key.toLowerCase();
    if (!needle) return false;
    if (entry.matchWholeWords) {
      return new RegExp('\\b' + escapeRe(needle) + '\\b', caseSensitive ? '' : 'i').test(haystack);
    }
    return hay.includes(needle);
  });
}

const CardHealth = {
  KNOWN_MACROS,
  _macroNames: macroNames,
  _toKeys: toKeys,
  _keysMatch: keysMatch,

  /**
   * Text of a card the model can see without any chat happening, used as the
   * default haystack. Alternate greetings are included (they are alternatives to
   * `first_mes`, and `analyze` already scans them for macros); lorebook content
   * is not, because nothing scans the lorebook for its own keys.
   */
  cardText(card) {
    return [
      card.name, card.description, card.personality, card.scenario,
      card.first_mes, ...(card.alternate_greetings || []),
      card.mes_example, card.system_prompt,
      card.post_history_instructions,
    ].filter(Boolean).join('\n');
  },

  /**
   * Diagnostics for one card, most severe first. `opts.maxTokens` (0/absent =
   * unlimited) turns the greeting budget into a warning; `opts.hasImage` lets
   * the caller report the artwork state it already knows.
   */
  analyze(card, opts) {
    const options = opts || {};
    /** @type {Array<{ id: string, level: string, labelKey: string, values: any }>} */
    const issues = [];
    if (!card) return issues;
    const add = (id, level, labelKey, values) => issues.push({ id, level, labelKey, values: values || {} });

    if (!String(card.name || '').trim()) add('noName', 'error', 'health.noName');
    else if (String(card.name).length > 50) add('longName', 'info', 'health.longName', { length: String(card.name).length });

    if (!String(card.description || '').trim()) add('noDescription', 'warning', 'health.noDescription');
    if (!String(card.first_mes || '').trim() && !(card.alternate_greetings || []).length) {
      add('noFirstMes', 'warning', 'health.noFirstMes');
    }
    if (!(card.tags || []).length) add('noTags', 'info', 'health.noTags');

    // Macros: an unknown name is printed verbatim to the model.
    const text = this.cardText(card)
      + (card.alternate_greetings || []).join('\n')
      + this.lorebookText(card);
    const unknown = [...new Set(macroNames(text).filter(n => !KNOWN_MACROS.has(n)))];
    if (unknown.length) add('unknownMacros', 'warning', 'health.unknownMacros', { names: unknown.join(', ') });

    const open = (text.match(/\{\{/g) || []).length;
    const close = (text.match(/\}\}/g) || []).length;
    if (open !== close) add('unbalancedMacros', 'warning', 'health.unbalancedMacros', { open, close });

    // Token budget across every greeting: they are alternatives, but the model's
    // context is sized for one of them plus the protagonist's, so a runaway
    // greeting is worth knowing about before it surprises someone mid-chat.
    const maxTokens = Number(options.maxTokens) || 0;
    const greetings = [card.first_mes, ...(card.alternate_greetings || [])].filter(Boolean);
    const greetingTokens = greetings.reduce((sum, g) => sum + Tokenizer.syncCount(String(g)), 0);
    if (maxTokens > 0 && greetingTokens > maxTokens) {
      add('greetingBudget', 'warning', 'health.greetingBudget', { tokens: greetingTokens, max: maxTokens });
    }

    if (!card.spec_version) add('noSpec', 'info', 'health.noSpec');
    if (!options.hasImage) add('noImage', 'info', 'health.noImage');

    this.lorebookIssues(card, add);

    const rank = { error: 0, warning: 1, info: 2 };
    return issues.sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
  },

  /** Concatenated lorebook content, part of the macro scan. */
  lorebookText(card) {
    const entries = (card.character_book && card.character_book.entries) || [];
    return entries.map(e => [e && e.comment, e && e.content].filter(Boolean).join(' ')).join('\n');
  },

  /** Lorebook-specific problems: entries that can never fire, or fire twice. */
  lorebookIssues(card, add) {
    const entries = (card.character_book && card.character_book.entries) || [];
    if (!entries.length) return;
    let noKey = 0;
    let noContent = 0;
    const seen = new Map();
    const duplicates = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (!toKeys(entry.key).length && !entry.constant) noKey++;
      if (!String(entry.content || '').trim()) noContent++;
      for (const key of toKeys(entry.key)) {
        const norm = key.toLowerCase();
        if (seen.has(norm)) duplicates.add(key);
        else seen.set(norm, true);
      }
    }
    if (noKey) add('loreNoKey', 'warning', 'health.loreNoKey', { count: noKey });
    if (noContent) add('loreNoContent', 'warning', 'health.loreNoContent', { count: noContent });
    if (duplicates.size) add('loreDuplicateKeys', 'info', 'health.loreDuplicateKeys', { keys: [...duplicates].join(', ') });
  },

  /**
   * Which lorebook entries fire for `haystack` (the recent chat by default, the
   * card's own text for a static report).
   *
   * Rules modelled: `disable` beats everything, `constant` always fires,
   * otherwise at least one primary key must match, and `selective` additionally
   * requires a secondary key match. `order` decides insertion order (ascending,
   * tie-break on declaration order) because that is the order entries end up in
   * the prompt; `position` groups them into before/after-char blocks.
   */
  simulate(card, haystack) {
    const entries = (card && card.character_book && card.character_book.entries) || [];
    const text = haystack == null ? this.cardText(card) : String(haystack);
    /** @type {Array<{ index: number, entry: any, reason: string, order: number }>} */
    const active = [];
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || entry.disable) return;
      if (entry.constant) { active.push({ index, entry, reason: 'constant', order: Number(entry.order) || 0 }); return; }
      const primary = toKeys(entry.key);
      if (!keysMatch(primary, text, entry)) return;
      if (entry.selective && !keysMatch(toKeys(entry.keysecondary), text, entry)) return;
      active.push({ index, entry, reason: entry.selective ? 'selective' : 'key', order: Number(entry.order) || 0 });
    });
    return active.sort((a, b) => (a.order - b.order) || (a.index - b.index));
  },

  /**
   * The exact text a triggered lorebook would add to the prompt, in insertion
   * order, split by where it goes relative to the character definition — the
   * "what would the model actually see" view.
   */
  injection(card, haystack) {
    const active = this.simulate(card, haystack);
    const before = [];
    const after = [];
    const atDepth = [];
    for (const { entry } of active) {
      const content = String(entry.content || '').trim();
      if (!content) continue;
      if (entry.position === 'before_char' || entry.position === 0) before.push(content);
      else if (typeof entry.position === 'number' && entry.position >= 3) atDepth.push(content);
      else after.push(content);
    }
    return { before, after, atDepth, total: before.length + after.length + atDepth.length };
  },
};

export { CardHealth };
if (typeof window !== 'undefined') window.CardHealth = CardHealth;
