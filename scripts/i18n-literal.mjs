/**
 * i18n-literal.mjs — reading and rewriting JS string literals inside the locale
 * files.
 *
 * The dictionaries are hand-written and disagree on style: most values are raw
 * UTF-8, some lines use `\u2014`, several lines hold two entries, and a value
 * can contain an escaped quote ('l\'aperçu'). Anything that rewrites one of
 * those values has to find the exact literal and re-escape it the same way, so
 * the parsing lives here — pure, no filesystem, no CLI — and is unit-tested
 * rather than trusted.
 */

/** Escape a value so it can be written inside single quotes in a JS literal. */
export const quote = (value) => "'" + String(value)
  .replace(/\\/g, "\\\\")
  .replace(/'/g, "\\'")
  .replace(/\r?\n/g, "\\n") + "'";

/**
 * Decode a JS string literal body back to text. Comparing raw bytes instead
 * would call an escaped English value "already translated" and refuse to touch
 * it — en.js itself mixes both styles.
 */
export function decodeLiteral(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") { out += c; continue; }
    const n = raw[++i];
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "v") out += "\v";
    else if (n === "0") out += "\0";
    else if (n === "x") { out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2; }
    else if (n === "u" && raw[i + 1] === "{") {
      const end = raw.indexOf("}", i);
      out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16));
      i = end;
    } else if (n === "u") {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += n; // \\ \' \" \/ and friends
  }
  return out;
}

/**
 * The `{{var}}` placeholders a value uses, sorted so two values can be compared
 * as sets. I18n.t substitutes exactly these, so a translation that drops one
 * renders wrong and throws nothing.
 */
export const placeholders = (value) =>
  (String(value).match(/\{\{[A-Za-z0-9_]+\}\}/g) || []).slice().sort().join("|");

/**
 * Locate the string literal that follows `'key':` in `source` and return the
 * [start, end) offsets of the literal itself (quotes included), or null.
 */
export function findValueSpan(source, key) {
  for (const q of ["'", '"']) {
    const needle = q + key + q;
    let from = 0;
    for (;;) {
      const at = source.indexOf(needle, from);
      if (at === -1) break;
      from = at + needle.length;
      const before = source[at - 1];
      // A key is preceded by start of file, whitespace, `{` or `,`.
      if (before !== undefined && !/[\s,{]/.test(before)) continue;
      let i = from;
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source[i] !== ":") continue;
      i++;
      while (i < source.length && /\s/.test(source[i])) i++;
      const open = source[i];
      if (open !== "'" && open !== '"') continue;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === open) break;
        j++;
      }
      if (j >= source.length) continue;
      return { start: i, end: j + 1 };
    }
  }
  return null;
}

/** The text a key currently holds in `source`, or undefined if it has none. */
export function readValue(source, key) {
  const span = findValueSpan(source, key);
  if (!span) return undefined;
  return decodeLiteral(source.slice(span.start, span.end).slice(1, -1));
}
