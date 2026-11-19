// @ts-check
/* ============================================================
   textFold.js — diacritic-insensitive text folding
   ============================================================
   Three modules had grown their own copy of "lowercase, then strip combining
   marks": the library's full-text index, the Ctrl+K palette and the intent
   learner. That is exactly how a matching rule drifts — teach one of them that
   "ø" or "ß" should fold and the other two keep their own answer, invisible
   until a user reports that a card is findable in one box but not the other.

   So the primitive lives here, pure and dependency-free (no DOM, no storage, no
   state), together with the two shapes the callers need: a plain fold, and an
   offset-preserving one that the search snippets use to highlight the accented
   original. Keeping the pair side by side is the point — the second is subtle
   enough that three copies of it would be three different bugs. */

/**
 * Lowercase and strip diacritics: "Élodie" → "elodie", "Ménages" → "menages".
 * Nullish input folds to the empty string, so callers never need a guard.
 * @param {unknown} text
 * @returns {string}
 */
function fold(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Fold a string character by character, keeping the result the SAME LENGTH as
 * the input, so a match position in the folded text is also valid in the raw
 * text. That is what lets an accent-insensitive query ("elodie") highlight the
 * accented original ("Élodie") instead of falling back to a head snippet.
 *
 * Characters whose fold changes the length (ß → ss, İ → i̇) are kept unfolded
 * rather than mapped: their offsets can't be trusted, so they read as a
 * non-match here. A caller that also keeps a normalized copy still matches them
 * for scoring, which is why this is a separate function and not the only one.
 * @param {string} text
 * @returns {string}
 */
function foldSameLength(text) {
  let out = '';
  for (const ch of text) {
    const folded = fold(ch);
    out += folded.length === ch.length ? folded : ch;
  }
  return out;
}

/**
 * Fold, then split on anything that is not a letter or digit. Used for
 * keyword extraction (the intent learner), where the input may not be a string
 * at all, so non-strings yield no words instead of throwing.
 * @param {unknown} text
 * @param {number} [minLength] drop shorter words (stopword-ish noise)
 * @returns {string[]}
 */
function foldWords(text, minLength = 1) {
  if (typeof text !== 'string') return [];
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= minLength);
}

export { fold, foldSameLength, foldWords };
