import { test, expect, beforeAll, mock } from 'bun:test';

// cardHealth.js imports Tokenizer, which lazily fetches the vendored BPE model
// in the browser. Stubbed with a fixed count so the budget assertions below are
// deterministic and no network is involved.
let CardHealth;

mock.module('../../js/tokenizer.js', () => ({ Tokenizer: { syncCount: (text) => String(text || '').length } }));

beforeAll(async () => {
  CardHealth = (await import('../../js/cardHealth.js')).CardHealth;
});

const card = (over = {}) => ({
  name: 'Aria',
  description: 'A mysterious elf.',
  first_mes: 'Hello there.',
  tags: ['fantasy'],
  spec_version: '2.0',
  character_book: { entries: [] },
  ...over,
});

/** Issue ids only, for terse assertions. */
const ids = (issues) => issues.map((i) => i.id);
const find = (issues, id) => issues.find((i) => i.id === id);

test('analyze reports the serious problems first', () => {
  const issues = CardHealth.analyze({ name: '', description: '', tags: [], character_book: { entries: [] } });
  expect(ids(issues).slice(0, 2)).toEqual(['noName', 'noDescription']);
  expect(find(issues, 'noName').level).toBe('error');
  // Sorted by severity: nothing below a warning can precede a warning.
  const levels = issues.map((i) => i.level);
  expect(levels.indexOf('warning')).toBeLessThan(levels.indexOf('info'));
});

test('analyze flags unknown macros but not the real ones', () => {
  const ok = CardHealth.analyze(card({ description: '{{user}} meets {{char}} at {{random:a,b}} — {{pick}}' }));
  expect(ids(ok)).not.toContain('unknownMacros');

  const bad = CardHealth.analyze(card({ description: 'Hello {{usser}}.' }));
  expect(find(bad, 'unknownMacros').values.names).toBe('usser');
});

test('analyze flags unbalanced macro braces', () => {
  const issues = CardHealth.analyze(card({ description: 'Hello {{user}.' }));
  const issue = find(issues, 'unbalancedMacros');
  expect(issue.values.open).toBe(1);
  expect(issue.values.close).toBe(0);
});

test('analyze turns the greeting budget into a warning when a limit is set', () => {
  const big = card({ first_mes: 'x'.repeat(50), alternate_greetings: ['y'.repeat(60)] });
  expect(ids(CardHealth.analyze(big, { maxTokens: 200 }))).not.toContain('greetingBudget');
  const issue = find(CardHealth.analyze(big, { maxTokens: 50 }), 'greetingBudget');
  expect(issue.values.tokens).toBe(110);
  expect(issue.values.max).toBe(50);
  // No configured limit means no budget opinion at all.
  expect(ids(CardHealth.analyze(big))).not.toContain('greetingBudget');
});

test('analyze counts entries that can never trigger', () => {
  const issues = CardHealth.analyze(card({
    character_book: {
      entries: [
        { key: [], content: 'orphan' },              // no key, not constant
        { constant: true, content: 'always' },        // fine
        { key: 'a, b', content: '' },                 // no content
        { key: 'a', content: 'duplicate key' },
      ],
    },
  }));
  expect(find(issues, 'loreNoKey').values.count).toBe(1);
  expect(find(issues, 'loreNoContent').values.count).toBe(1);
  expect(find(issues, 'loreDuplicateKeys').values.keys).toBe('a');
});

test('analyze says nothing about a healthy card', () => {
  const issues = CardHealth.analyze(card({ character_version: '1.0' }), { maxTokens: 100, hasImage: true });
  expect(ids(issues)).toEqual([]);
});

test('simulate fires constant entries regardless of keys', () => {
  const active = CardHealth.simulate(card({
    character_book: { entries: [{ constant: true, content: 'always', key: '' }] },
  }), 'nothing here');
  expect(active).toHaveLength(1);
  expect(active[0].reason).toBe('constant');
});

test('simulate needs a primary key match and honours disable', () => {
  const entries = [
    { key: 'dragon', content: 'fire' },
    { key: 'dragon', content: 'disabled', disable: true },
    { key: 'unicorn', content: 'sparkles' },
  ];
  const hit = CardHealth.simulate(card({ character_book: { entries } }), 'I saw a Dragon today');
  expect(hit).toHaveLength(1); // case-insensitive, and the disabled twin is out
  expect(hit[0].entry.content).toBe('fire');
  expect(CardHealth.simulate(card({ character_book: { entries } }), 'I saw a griffin')).toHaveLength(0);
});

test('simulate requires a secondary key when selective', () => {
  const entries = [{ key: 'dragon', keysecondary: 'cave', selective: true, content: 'in the cave' }];
  const book = card({ character_book: { entries } });
  expect(CardHealth.simulate(book, 'a dragon')).toHaveLength(0);
  expect(CardHealth.simulate(book, 'a dragon in a cave')).toHaveLength(1);
});

test('simulate honours matchWholeWords and caseSensitive', () => {
  const whole = card({ character_book: { entries: [{ key: 'cat', matchWholeWords: true, content: 'x' }] } });
  expect(CardHealth.simulate(whole, 'concatenate')).toHaveLength(0);
  expect(CardHealth.simulate(whole, 'a cat sat')).toHaveLength(1);

  const exact = card({ character_book: { entries: [{ key: 'Aria', caseSensitive: true, content: 'x' }] } });
  expect(CardHealth.simulate(exact, 'aria')).toHaveLength(0);
  expect(CardHealth.simulate(exact, 'Aria')).toHaveLength(1);
});

test('simulate orders by order, then declaration order', () => {
  const entries = [
    { key: 'k', content: 'third', order: 100 },
    { key: 'k', content: 'first', order: 10 },
    { key: 'k', content: 'second', order: 10 },
  ];
  const active = CardHealth.simulate(card({ character_book: { entries } }), 'k');
  expect(active.map((a) => a.entry.content)).toEqual(['first', 'second', 'third']);
});

test('simulate defaults to the card text when no haystack is given', () => {
  const entries = [
    { key: 'Aria', content: 'named after the character' },
    { key: 'moonlight', content: 'only in chat' },
  ];
  const book = card({ character_book: { entries } });
  const active = CardHealth.simulate(book, null);
  expect(active).toHaveLength(1);
  expect(active[0].entry.content).toBe('named after the character');
  // Explicit empty text is not the same as "no haystack": nothing matches.
  expect(CardHealth.simulate(book, '')).toHaveLength(0);
});

test('simulate scans alternate greetings, not just the first message', () => {
  const entries = [{ key: 'meteor', content: 'only in a greeting' }];
  const book = card({ character_book: { entries }, alternate_greetings: ['A meteor falls.'] });
  expect(CardHealth.simulate(book, null)).toHaveLength(1);
  expect(CardHealth.simulate(card({ character_book: { entries } }), null)).toHaveLength(0);
});

test('injection splits entries by position and drops empty content', () => {
  const entries = [
    { key: 'k', content: 'before text', position: 'before_char', order: 1 },
    { key: 'k', content: 'after text', position: 'after_char', order: 2 },
    { key: 'k', content: 'deep text', position: 4, order: 3 },
    { key: 'k', content: '   ', order: 4 },
  ];
  const { before, after, atDepth, total } = CardHealth.injection(card({ character_book: { entries } }), 'k');
  expect(before).toEqual(['before text']);
  expect(after).toEqual(['after text']);
  expect(atDepth).toEqual(['deep text']);
  expect(total).toBe(3);
});

test('analyze and simulate tolerate malformed cards', () => {
  expect(CardHealth.analyze(null)).toEqual([]);
  expect(CardHealth.analyze({}).length).toBeGreaterThan(0);
  expect(CardHealth.simulate({}, 'anything')).toEqual([]);
  expect(CardHealth.simulate({ character_book: { entries: [null, 42, 'x'] } }, 'x')).toEqual([]);
  const messy = CardHealth.analyze({ tags: null, alternate_greetings: null, character_book: { entries: [null] } });
  expect(Array.isArray(messy)).toBe(true);
});
