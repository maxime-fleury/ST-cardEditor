/**
 * check-i18n.mjs — i18n drift guard.
 *
 * Imports the actual i18n module (js/i18n.js) and verifies every language
 * dictionary has exactly the same keys as English. Exits non-zero (for CI)
 * when any language is missing a key or carries an extra one.
 *
 * Importing the module means the check operates on the exact object the app
 * ships, so the guard can never drift from runtime behavior (no source
 * parsing to get out of date).
 *
 * Usage:  bun scripts/check-i18n.mjs   (or:  npm run i18n:check)
 */

import { translations } from "../js/i18n.js";

const langs = Object.keys(translations);
if (langs.length < 10) {
  console.error(`check-i18n: only ${langs.length} language blocks found — i18n.js export may be out of date.`);
  process.exit(1);
}

const enKeys = Object.keys(translations.en);
let failures = 0;

for (const lang of langs) {
  const keys = Object.keys(translations[lang]);
  const missing = enKeys.filter((k) => !keys.includes(k)).sort();
  const extra = keys.filter((k) => !enKeys.includes(k)).sort();
  if (missing.length || extra.length) {
    failures++;
    console.error(`✗ ${lang}:`);
    if (missing.length) console.error(`    missing (${missing.length}): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`);
    if (extra.length) console.error(`    extra   (${extra.length}): ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? "…" : ""}`);
  } else {
    console.log(`✓ ${lang} (${keys.length} keys)`);
  }
}

if (failures) {
  console.error(`\ncheck-i18n: ${failures} language(s) out of sync with English.`);
  process.exit(1);
}
console.log(`\ncheck-i18n: all ${langs.length} languages in sync with English (${enKeys.length} keys).`);
