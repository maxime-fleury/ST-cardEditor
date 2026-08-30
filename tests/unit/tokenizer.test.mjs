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
