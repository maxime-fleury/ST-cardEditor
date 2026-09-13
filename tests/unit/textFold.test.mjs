import { test, expect } from 'bun:test';
import { fold, foldSameLength, foldWords } from '../../js/textFold.js';

// The shared fold. Three modules used to carry their own copy, so these tests
// are also the contract those callers rely on: the library's search index, the
// Ctrl+K palette and the intent learner.

test('fold lowercases and strips diacritics', () => {
  expect(fold('Élodie')).toBe('elodie');
  expect(fold('MÉNAGES')).toBe('menages');
  expect(fold('Ménages')).toBe('menages');
  expect(fold('Étudiante fauchée')).toBe('etudiante fauchee');
  // Letters that are not accented versions of another letter have no canonical
  // decomposition, so they deliberately survive: folding "Æ" to "ae" (or "ß" to
  // "ss") is case-folding, not diacritic stripping, and the search index's
  // promise is only the latter.
  expect(fold('Æon')).toBe('æon');
  expect(fold('Straße')).toBe('straße');
});

test('fold never throws on non-string input', () => {
  expect(fold(null)).toBe('');
  expect(fold(undefined)).toBe('');
  expect(fold(42)).toBe('42');
  expect(fold({})).toBe('[object object]');
});

test('foldSameLength preserves character offsets', () => {
  // The property the search snippets depend on: an index into the folded string
  // is a valid index into the original.
  for (const text of ['Élodie arrive', 'Ménages', 'plain ascii', 'Mañana']) {
    expect(foldSameLength(text)).toHaveLength(text.length);
  }
  expect(foldSameLength('Élodie').indexOf('elodie')).toBe('Élodie'.indexOf('É'));
  expect(foldSameLength('Élodie').indexOf('elodie')).toBe(0);
});

test('foldSameLength leaves length-changing characters alone', () => {
  // A lone combining mark (U+0344 is two marks stacked) normalizes to nothing,
  // and a precomposed Devanagari letter (U+0958) expands to base + mark. Both
  // break the "one character in, one character out" contract, so the character is
  // kept unfolded rather than shifting every offset after it — a caller's
  // scoring path still matches it through the fully folded copy.
  const standaloneMark = 'e\u0344';
  expect(fold(standaloneMark)).toBe('e');
  expect(foldSameLength(standaloneMark)).toBe(standaloneMark);
  expect(foldSameLength(standaloneMark)).toHaveLength(standaloneMark.length);

  // Everything after a kept character keeps its offset too, which is the whole
  // point: the match position stays valid in the raw text.
  expect(foldSameLength('e\u0344lodie').indexOf('lodie')).toBe(2);
});

test('foldWords splits, lowercases and honours minLength', () => {
  expect(foldWords('Un Chevalier Très Fort')).toEqual(['un', 'chevalier', 'tres', 'fort']);
  expect(foldWords('Ménage à trois')).toEqual(['menage', 'a', 'trois']);
  expect(foldWords('Ménage à trois', 3)).toEqual(['menage', 'trois']);
  expect(foldWords("l'épée, le bouclier!")).toEqual(['l', 'epee', 'le', 'bouclier']);
  expect(foldWords('   ')).toEqual([]);
  expect(foldWords(null)).toEqual([]);
  expect(foldWords(42)).toEqual([]);
});

test('foldWords keeps non-latin scripts out, as the intent learner expects', () => {
  // The learner's vocabulary is FR/EN keywords; a CJK prompt yields no keywords
  // rather than garbage tokens. Pinned because it is a deliberate limitation,
  // not an accident of the regex.
  expect(foldWords('エロディ')).toEqual([]);
});
