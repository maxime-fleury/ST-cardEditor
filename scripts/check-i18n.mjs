/**
 * check-i18n.mjs — i18n drift guard.
 *
 * Parses js/i18n.js and verifies every language dictionary has exactly the
 * same keys as English. Exits non-zero (for CI) when any language is missing
 * a key or carries an extra one.
 *
 * Usage:  bun scripts/check-i18n.mjs   (or:  npm run i18n:check)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "js", "i18n.js"), "utf8");

// Each dictionary is assigned as `translations.<lang> = { ... };` inside an IIFE.
const re = /translations\.([a-z]{2}(?:-[A-Z]{2})?)\s*=\s*\{/g;
const names = [];
let m;
while ((m = re.exec(src))) names.push({ name: m[1], start: m.index + m[0].length });

if (names.length < 10) {
  console.error(`check-i18n: only ${names.length} language blocks found — parser may be out of date.`);
  process.exit(1);
}

// Slice each dictionary with brace matching (strings-aware), so the last
// block never overshoots into the trailing module code.
const blocks = {};
for (const { name, start } of names) {
  let depth = 1, i = start, inStr = false, quote = "", esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; quote = c; }
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  blocks[name] = src.slice(start, i);
}

const keysOf = (block) => {
  const keys = new Set();
  const dupes = new Set();
  for (const km of block.matchAll(/'([^']+)'\s*:/g)) {
    const k = km[1];
    if (keys.has(k)) dupes.add(k);
    keys.add(k);
  }
  return { keys, dupes };
};

const { keys: en, dupes: enDupes } = keysOf(blocks.en);
let failures = 0;

if (enDupes.size) {
  failures++;
  console.error(`✗ en: duplicate keys: ${[...enDupes].sort().join(", ")}`);
}

for (const { name } of names) {
  const { keys, dupes } = keysOf(blocks[name]);
  const missing = [...en].filter((k) => !keys.has(k)).sort();
  const extra = [...keys].filter((k) => !en.has(k)).sort();
  if (missing.length || extra.length) {
    failures++;
    console.error(`✗ ${name}:`);
    if (missing.length) console.error(`    missing (${missing.length}): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`);
    if (extra.length) console.error(`    extra   (${extra.length}): ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? "…" : ""}`);
  } else if (dupes.size) {
    failures++;
    console.error(`✗ ${name}: duplicate keys: ${[...dupes].sort().join(", ")}`);
  } else {
    console.log(`✓ ${name} (${keys.size} keys)`);
  }
}

if (failures) {
  console.error(`\ncheck-i18n: ${failures} language(s) out of sync with English.`);
  process.exit(1);
}
console.log(`\ncheck-i18n: all ${names.length} languages in sync with English (${en.size} keys).`);
