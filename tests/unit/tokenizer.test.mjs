import { test, expect } from 'bun:test';
import { Tokenizer } from '../../js/tokenizer.js';

test('quickCount returns 0 for empty, null and undefined input', () => {
  expect(Tokenizer.quickCount('')).toBe(0);
  expect(Tokenizer.quickCount(null)).toBe(0);
  expect(Tokenizer.quickCount(undefined)).toBe(0);
});

test('quickCount blends to ~1 token per 3 characters (Latin)', () => {
  expect(Tokenizer.quickCount('hello world')).toBe(Math.ceil(11 / 3));
  expect(Tokenizer.quickCount('a'.repeat(300))).toBe(100);
  expect(Tokenizer.quickCount('x')).toBe(1);
});

test('count falls back to the heuristic when the CDN lib is unavailable', async () => {
  // Force the lazy loader to skip the network (recent failure backoff) so the
  // test never touches esm.sh; count() must degrade to the offline estimate.
  Tokenizer._lastFail = Date.now();
  Tokenizer._lib = null;
  Tokenizer._loading = null;
  const text = 'some text here';
  const n = await Tokenizer.count(text);
  expect(n).toBe(Math.ceil(text.length / 3));
});

test('the fallback estimator is deterministic and non-negative', () => {
  expect(Tokenizer._fallback('你好世界')).toBe(Math.ceil(4 / 3));
  expect(Tokenizer._fallback(42)).toBe(Math.ceil(String(42).length / 3));
});

test('syncCount uses the heuristic before the CDN lib loads', () => {
  Tokenizer._lib = null;
  Tokenizer._loading = null;
  Tokenizer._lastFail = 0;
  expect(Tokenizer.syncCount('hello world')).toBe(Math.ceil(11 / 3));
  expect(Tokenizer.syncCount('')).toBe(0);
  expect(Tokenizer.syncCount(null)).toBe(0);
});

test('syncCount uses the real tokenizer once loaded (and falls back on garbage)', () => {
  Tokenizer._lib = (t) => String(t).length * 2; // deterministic fake BPE
  Tokenizer._loading = null;
  expect(Tokenizer.syncCount('abcd')).toBe(8);
  expect(Tokenizer.syncCount(123)).toBe(6);
  expect(Tokenizer.syncCount('')).toBe(0);
  // A lib returning NaN must degrade to the heuristic, never propagate NaN.
  Tokenizer._lib = () => NaN;
  expect(Tokenizer.syncCount('hello')).toBe(Math.ceil(5 / 3));
  Tokenizer._lib = null;
});

test('count() recovers after a backoff window expires', async () => {
  // Simulate the backoff state set by a failed CDN load, then expire it so the
  // next count() attempt can retry instead of being stuck forever.
  Tokenizer._lib = null;
  Tokenizer._loading = null;
  Tokenizer._lastFail = Date.now() - 301000; // older than the 300s window
  const n = await Tokenizer.count('some text here');
  expect(n).toBe(Math.ceil('some text here'.length / 3)); // no crash, heuristic
});

test('count and syncCount agree once the lib is loaded (shared estimator)', async () => {
  Tokenizer._lib = (t) => String(t).length * 2; // deterministic fake BPE
  Tokenizer._loading = null;
  Tokenizer._lastFail = 0;
  for (const text of ['hello world', '', 'héllo wörld', 'a', 'ab']) {
    expect(await Tokenizer.count(text)).toBe(Tokenizer.syncCount(text));
  }
  Tokenizer._lib = null;
});

test('count and syncCount agree in heuristic mode (no lib)', async () => {
  Tokenizer._lib = null;
  Tokenizer._loading = null;
  Tokenizer._lastFail = Date.now(); // backoff: count() cannot load the CDN
  for (const text of ['hello world', '', '你好世界', 42, null]) {
    expect(await Tokenizer.count(text)).toBe(Tokenizer.syncCount(text));
  }
  Tokenizer._lastFail = 0;
});
