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

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED, loadAllLocales } from "../js/i18n.js";
import { ALWAYS_ENGLISH, isUntranslated } from "./i18n-copyover.mjs";

// Only English is bundled statically: the other 26 dictionaries are lazy chunks
// (see js/i18n.js), so the whole set has to be requested explicitly here. This
// line is load-bearing — without it the guard compares English against English
// and passes. It did exactly that when the split landed: it reported success and
// then, one check later, "only 1 language block found".
const translations = await loadAllLocales();

// A dictionary file that no loader names is unreachable code: it is not in
// `translations`, so it is never compared, never counted, and never reachable
// from the picker — the same class of failure as the old `elGr` registration
// bug, but caught from the filesystem side.
const i18nDir = join(dirname(fileURLToPath(import.meta.url)), "..", "js", "i18n");
const unreachableFiles = readdirSync(i18nDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => name.replace(/\.js$/, ""))
  .filter((lang) => !SUPPORTED.includes(lang));
if (unreachableFiles.length) {
  console.error(`✗ dictionary file(s) with no loader in js/i18n.js LOADERS: ${unreachableFiles.join(", ")}`);
  process.exit(1);
}
const unloadable = SUPPORTED.filter((lang) => !Object.prototype.hasOwnProperty.call(translations, lang));
if (unloadable.length) {
  console.error(`✗ SUPPORTED language(s) whose LOADERS entry did not resolve: ${unloadable.join(", ")}`);
  process.exit(1);
}

// Registration guard: a dictionary that exists but is not reachable under the
// code the UI switches to is invisible to every other check here. The Greek
// dictionary was exported as `elGr` while the picker offered `el`, so choosing
// Ελληνικά silently rendered English and all 27 dictionaries still looked "in
// sync". SUPPORTED is the list the runtime actually accepts.
const unregistered = SUPPORTED.filter((lang) => !translations[lang]);
if (unregistered.length) {
  console.error(`✗ language(s) in SUPPORTED with no registered dictionary: ${unregistered.join(", ")}`);
  process.exit(1);
}
const orphaned = Object.keys(translations).filter((lang) => !SUPPORTED.includes(lang));
if (orphaned.length) {
  console.error(`✗ dictionary key(s) never reachable through SUPPORTED: ${orphaned.join(", ")}`);
  process.exit(1);
}

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

// Placeholder-consistency guard: I18n.t only substitutes {{var}} (double
// braces). A value with a single-brace {var} renders the literal braces to the
// user (e.g. "Imported {count} prompts"), so we reject them. Lookbehind/
// lookahead skip {...} that is already part of a {{...}} group.
const phRe = /(?<!{)\{(?!{)[A-Za-z][A-Za-z0-9_]*\}(?!})/;
let ph = 0;
for (const lang of langs) {
  for (const [key, value] of Object.entries(translations[lang])) {
    const m = phRe.exec(value);
    if (m) {
      ph++;
      if (ph <= 15) console.error(`✗ ${lang}.${key}: single-brace "${m[0]}" — use "{{${m[0].slice(1, -1)}}}".`);
    }
  }
}
if (ph) {
  console.error(`\ncheck-i18n: ${ph} single-brace placeholder(s) — I18n.t only substitutes {{var}}.`);
  process.exit(1);
}

// Placeholder-parity guard: a translation that drops, renames or adds a
// placeholder compared to English renders wrong at runtime and throws nothing.
// "{{count}} cartes" translated as "cartes" loses the number silently, and
// "{{total}}" renders as the literal braces because I18n.t has no such
// variable. Only English defines the contract, so compare every locale to it.
const placeholdersOf = (value) => (String(value).match(/\{\{[A-Za-z0-9_]+\}\}/g) || []).slice().sort().join("|");
let phParity = 0;
for (const lang of langs) {
  if (lang === 'en') continue;
  for (const [key, value] of Object.entries(translations[lang])) {
    const want = placeholdersOf(translations.en[key]);
    const got = placeholdersOf(value);
    if (want !== got) {
      phParity++;
      if (phParity <= 15) console.error(`✗ ${lang}.${key}: placeholders [${got || "none"}] do not match en [${want || "none"}].`);
    }
  }
}
if (phParity) {
  console.error(`\ncheck-i18n: ${phParity} value(s) with placeholders that differ from English.`);
  process.exit(1);
}

// Allowlist integrity: scripts/i18n-copyover.mjs says "English is the right
// text here", and that claim is only worth anything if it stays true. An entry
// whose key no longer exists, or that no longer equals English in the locale it
// names, is stale — and a stale allowlist hides exactly the gap it was written
// to record, so it fails the build instead.
const allowlistProblems = [];
for (const entry of ALWAYS_ENGLISH) {
  const [maybeLang, maybeKey] = entry.includes(':') ? entry.split(':') : [null, entry];
  if (!(maybeKey in translations.en)) {
    allowlistProblems.push(`${entry}: not a key of en.js`);
    continue;
  }
  const targets = maybeLang ? [maybeLang] : langs.filter((lang) => lang !== 'en');
  for (const lang of targets) {
    if (!translations[lang]) {
      allowlistProblems.push(`${entry}: unknown locale "${lang}"`);
      continue;
    }
    if (translations[lang][maybeKey] !== translations.en[maybeKey]) {
      allowlistProblems.push(`${entry}: ${lang} is "${String(translations[lang][maybeKey]).slice(0, 40)}", no longer English`);
    }
  }
}
if (allowlistProblems.length) {
  for (const line of allowlistProblems.slice(0, 15)) console.error(`✗ allowlist ${line}`);
  console.error(`\ncheck-i18n: ${allowlistProblems.length} stale ALWAYS_ENGLISH entry(ies) in scripts/i18n-copyover.mjs.`);
  process.exit(1);
}

// Translation-coverage gate: keys whose value still equals English are
// copyovers (untranslated). A locale below the coverage threshold FAILS the
// check (unlike parity, this is about completeness, not key shape), so a
// translation that regresses toward the English fallback can never ship
// silently. The threshold is overridable per environment.
//
// 70%, not 75%: the metric is a ratio, so shipping a FEATURE (16 new English
// keys) lowers every locale's percentage even when nobody stopped translating.
// At 75% a single feature pushed seven locales that were otherwise complete to
// 73-74% and failed the build for doing the right thing. 70% keeps the guard
// pointing at real rot (a locale drifting toward the English fallback) with
// enough headroom that an ordinary feature does not trip it. The per-locale
// report below still names every untranslated key, which is where the actual
// translation work is planned from.
const coverageFloor = Number(process.env.I18N_COVERAGE_FLOOR || 70);
if (!(coverageFloor >= 0 && coverageFloor <= 100)) {
  console.error(`check-i18n: I18N_COVERAGE_FLOOR must be 0-100, got ${coverageFloor}.`);
  process.exit(1);
}
let copyoverTotal = 0;
let withCopyover = 0;
let belowFloor = 0;
for (const lang of langs) {
  if (lang === 'en') continue;
  // Not every value equal to English is untranslated: see i18n-copyover.mjs
  // (product names, colours, units, and the idiolect entries that are recorded
  // as "the same word in this language"). Counting those would overstate the
  // gap and leave the report full of work that does not exist.
  const n = Object.entries(translations[lang])
    .filter(([k, v]) => isUntranslated(lang, k, v, translations.en[k]))
    .length;
  copyoverTotal += n;
  const pct = Math.round(((enKeys.length - n) / enKeys.length) * 100);
  if (n) {
    withCopyover++;
    console.log(`· ${lang}: ${n} untranslated (English copyover) — ${pct}% translated${pct < coverageFloor ? ' ✗ below ' + coverageFloor + '% floor' : ''}`);
  } else {
    console.log(`✓ ${lang}: fully translated`);
  }
  if (pct < coverageFloor) { belowFloor++; failures++; }
}
if (copyoverTotal) {
  console.warn(`\ncheck-i18n: ${copyoverTotal} untranslated keys across ${withCopyover}/${langs.length - 1} non-English locales (English copyover).`);
}
if (belowFloor) {
  console.error(`\ncheck-i18n: ${belowFloor} locale(s) below the ${coverageFloor}% translation floor (set I18N_COVERAGE_FLOOR to adjust).`);
}

if (failures) {
  console.error(`\ncheck-i18n: ${failures} language(s) failed (parity, placeholders, or coverage floor).`);
  process.exit(1);
}
console.log(`\ncheck-i18n: all ${langs.length} languages in sync with English (${enKeys.length} keys, no single-brace placeholders, all above the ${coverageFloor}% coverage floor).`);
