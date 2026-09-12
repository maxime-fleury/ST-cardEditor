/**
 * i18n-add.mjs — propagate new English keys into every locale file.
 *
 * `check-i18n.mjs` enforces strict key parity across all 27 locales, which is
 * the right guard (a missing key renders as the raw key to the user) but makes
 * every new UI string cost 27 file edits. This script does that mechanical part:
 * any key present in `js/i18n/en.js` and missing from a locale is appended with
 * the English value as a placeholder.
 *
 * Placeholders are exactly what `check-i18n.mjs` reports as "English copyover",
 * so the coverage report keeps pointing at the work a human translator still
 * has to do — this script never pretends a string is translated.
 *
 * Usage:
 *   bun scripts/i18n-add.mjs            # add missing keys to every locale
 *   bun scripts/i18n-add.mjs --dry-run  # list what would be added
 *   bun scripts/i18n-add.mjs --check    # exit 1 when any locale is out of sync
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { translations } from "../js/i18n.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const i18nDir = join(root, "js", "i18n");

const dryRun = process.argv.includes("--dry-run");
const checkOnly = process.argv.includes("--check");

/** Escape a value so it can be written inside single quotes in a JS literal. */
const quote = (value) => "'" + String(value)
  .replace(/\\/g, "\\\\")
  .replace(/'/g, "\\'")
  .replace(/\r?\n/g, "\\n") + "'";

const en = translations.en;
if (!en) {
  console.error("i18n-add: js/i18n.js exposes no `en` dictionary.");
  process.exit(1);
}

// en.js is the source of the *order* too, so new keys land in the same sequence
// as English and the diff stays readable.
const enKeys = Object.keys(en);
const langs = Object.keys(translations).filter((lang) => lang !== "en");

let outOfSync = 0;
let addedTotal = 0;

for (const lang of langs) {
  const file = join(i18nDir, `${lang}.js`);
  if (!existsSync(file)) {
    console.error(`✗ ${lang}: js/i18n/${lang}.js is missing (is it imported by js/i18n.js?).`);
    outOfSync++;
    continue;
  }
  const dict = translations[lang] || {};
  const missing = enKeys.filter((key) => !(key in dict));
  if (missing.length === 0) continue;
  outOfSync++;

  const label = missing.length > 6
    ? `${missing.slice(0, 6).join(", ")}, … (+${missing.length - 6})`
    : missing.join(", ");

  if (dryRun || checkOnly) {
    console.error(`✗ ${lang}: ${missing.length} missing key(s): ${label}`);
    continue;
  }

  const source = readFileSync(file, "utf8");
  // The dictionary is `export default { … };` — append before the final `};`.
  // (Last occurrence, so a `};` inside a string value cannot confuse us.)
  const closeIdx = source.lastIndexOf("};");
  if (closeIdx < 0) {
    console.error(`✗ ${lang}: could not find the closing "};" in js/i18n/${lang}.js — add the keys by hand.`);
    outOfSync++;
    continue;
  }
  const additions = missing.map((key) => `  ${quote(key)}: ${quote(en[key])},\n`).join("");
  // The last entry of a dictionary often has NO trailing comma (hand-written
  // files differ here), and appending after it produces invalid JS. Add the
  // separator only when the preceding entry does not already have one.
  const head = source.slice(0, closeIdx).replace(/\s+$/, "");
  const separator = /[,{]/.test(head.slice(-1)) ? "" : ",";
  const updated = head + separator + "\n" + additions + source.slice(closeIdx);
  if (!dryRun) writeFileSync(file, updated, "utf8");
  addedTotal += missing.length;
  console.log(`↳ ${lang}: +${missing.length} key(s) (${label})`);
}

if (checkOnly) {
  if (outOfSync) {
    console.error(`\ni18n-add: ${outOfSync} locale(s) out of sync with en.js — run \`bun scripts/i18n-add.mjs\`.`);
    process.exit(1);
  }
  console.log("i18n-add: every locale has the full English key set.");
} else if (dryRun) {
  console.log(outOfSync
    ? `\ni18n-add --dry-run: ${outOfSync} locale(s) would receive new keys.`
    : "\ni18n-add --dry-run: nothing to add.");
} else if (addedTotal === 0) {
  console.log("i18n-add: nothing to add — every locale already matches en.js.");
} else {
  console.log(`\ni18n-add: added ${addedTotal} key(s) across ${outOfSync} locale(s) as English placeholders.`);
  console.log("Verify with `bun run i18n:check` (they count as untranslated until a human/AI translates them).");
}
