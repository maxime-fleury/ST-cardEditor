/**
 * i18n-translate.mjs — the translation work order, and its application.
 *
 * check-i18n.mjs says how many keys a locale still holds in English. This script
 * is what moves that number.
 *
 *   bun scripts/i18n-translate.mjs --list de > de.json   # work order
 *   # …fill de.json with translations, then:
 *   bun scripts/i18n-translate.mjs --apply de de.json    # write them back
 *
 * `--list` prints a JSON object of the keys whose value is still English, mapped
 * to their English text, so the patch is self-contained and readable.
 * `--apply` rewrites those values in js/i18n/<lang>.js, in place, preserving key
 * order, indentation and the file's existing quoting.
 *
 * Each locale's patch is validated in full before that file is written, so a
 * rejected patch never leaves a half-updated dictionary. (In a batch, locales
 * that passed are already written when a later one is rejected — the batch is
 * not one transaction, the file is.)
 *   - a key the locale does not have, or a value that is empty, is refused;
 *   - a value that is still equal to English is refused — the round trip exists
 *     to produce translations, and accepting a copyover would silently defeat it;
 *   - a key that is no longer a copyover is refused unless --force, so a stale
 *     patch cannot overwrite translation work that landed in the meantime;
 *   - placeholders must match English exactly ({{count}}, {{names}}…), because a
 *     dropped or renamed one renders wrong with no error anywhere.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllLocales } from "../js/i18n.js";
import { isAlwaysEnglish, isUntranslated } from "./i18n-copyover.mjs";
import { decodeLiteral, findValueSpan, placeholders, quote, readValue } from "./i18n-literal.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const i18nDir = join(root, "js", "i18n");

// Only English is a static import (the rest are lazy chunks, see js/i18n.js), so
// the whole set has to be requested explicitly: reading `translations` directly
// would show one locale and this tool would find nothing to do.
const translations = await loadAllLocales();
const en = translations.en;
if (!en) {
  console.error("i18n-translate: js/i18n.js exposes no `en` dictionary.");
  process.exit(1);
}


const fail = (lines) => {
  for (const line of lines) console.error(line);
  console.error(`\ni18n-translate: nothing was written.`);
  process.exit(1);
};

const listLang = (lang) => {
  const dict = translations[lang];
  if (!dict) {
    console.error(`i18n-translate: unknown locale "${lang}". Known: ${Object.keys(translations).join(", ")}`);
    process.exit(1);
  }
  const patch = {};
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== "string") continue;
    if (isUntranslated(lang, key, dict[key], value)) patch[key] = value;
  }
  if (process.argv.includes("--count")) {
    console.log(`${lang}: ${Object.keys(patch).length} untranslated key(s)`);
    return;
  }
  console.log(JSON.stringify(patch, null, 2));
};

const applyPatch = (lang, patchOrPath) => {
  const dict = translations[lang];
  if (!dict) {
    console.error(`i18n-translate: unknown locale "${lang}".`);
    process.exit(1);
  }
  const patch = typeof patchOrPath === "string" ? readJson(patchOrPath) : patchOrPath;
  const file = join(i18nDir, `${lang}.js`);
  const source = readFileSync(file, "utf8");
  const force = process.argv.includes("--force");
  const problems = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!(key in en)) {
      problems.push(`✗ ${key}: not a key of en.js — refusing to add new keys (use scripts/i18n-add.mjs).`);
      continue;
    }
    const span = findValueSpan(source, key);
    if (!span) {
      problems.push(`✗ ${key}: no literal found for it in js/i18n/${lang}.js.`);
      continue;
    }
    const current = decodeLiteral(source.slice(span.start, span.end).slice(1, -1));

    if (isAlwaysEnglish(lang, key)) {
      // The allowlist says English is correct here. A patch that also says so
      // is a no-op (it was probably generated before the entry was added), and
      // one that translates anyway contradicts the record — say so, loudly.
      if (value === en[key]) continue;
      problems.push(`✗ ${key}: scripts/i18n-copyover.mjs says English is correct in ${lang} — remove the entry first if that changed.`);
      continue;
    }
    if (!force && !isUntranslated(lang, key, current, en[key])) {
      // Already holds what this patch asks for: a re-run, not a clobber. Batches
      // have to be idempotent — one locale of a batch failing must not make the
      // whole batch un-runnable afterwards.
      if (current === value) continue;
      problems.push(`✗ ${key}: already translated ("${current.slice(0, 40)}") — refusing to overwrite (--force to override).`);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      problems.push(`✗ ${key}: empty translation.`);
      continue;
    }
    // The only values allowed to equal English are the wordless ones and the
    // ALWAYS_ENGLISH allowlist — isUntranslated() encodes exactly that.
    if (isUntranslated(lang, key, value, en[key])) {
      problems.push(`✗ ${key}: the patch value is still the English text.`);
      continue;
    }
    const enPh = placeholders(en[key]);
    const newPh = placeholders(value);
    if (enPh !== newPh) {
      problems.push(`✗ ${key}: placeholders differ — en has [${enPh || "none"}], patch has [${newPh || "none"}].`);
      continue;
    }
  }

  if (problems.length) fail(problems);

  // Skip the no-ops too (they were validated above), then apply from the end so
  // earlier offsets stay valid.
  const edits = Object.entries(patch)
    .filter(([key, value]) => readValue(source, key) !== value)
    .map(([key, value]) => ({ span: findValueSpan(source, key), value }))
    .sort((a, b) => b.span.start - a.span.start);
  if (!edits.length) {
    console.log(`✓ ${lang}: already applied — nothing to change.`);
    return 0;
  }
  let updated = source;
  for (const { span, value } of edits) {
    updated = updated.slice(0, span.start) + quote(value) + updated.slice(span.end);
  }
  writeFileSync(file, updated, "utf8");

  // Count against the dictionary as it now stands, not against the patch: keys
  // the patch did not mention keep whatever value they already had.
  const merged = { ...dict, ...patch };
  const left = Object.entries(en)
    .filter(([key, value]) => typeof value === "string" && isUntranslated(lang, key, merged[key], value))
    .length;
  console.log(`↳ ${lang}: ${edits.length} key(s) written to js/i18n/${lang}.js — ${left} untranslated left.`);
  return edits.length;
};

const readJson = (path) => {
  if (!existsSync(path)) {
    console.error(`i18n-translate: patch file not found: ${path}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`i18n-translate: ${path} is not valid JSON — ${err.message}`);
    process.exit(1);
  }
};

/** A batch file is `{ lang: { key: translation } }`. */
const applyAll = (patchPath) => {
  const batches = readJson(patchPath);
  let total = 0;
  for (const [lang, patch] of Object.entries(batches)) {
    total += applyPatch(lang, patch);
  }
  console.log(`\ni18n-translate: ${total} key(s) across ${Object.keys(batches).length} locale(s) written from ${patchPath}.`);
};

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

if (flagValue("--list")) {
  listLang(flagValue("--list"));
} else if (args.includes("--list-all")) {
  const all = {};
  for (const lang of Object.keys(translations)) {
    if (lang === "en") continue;
    const patch = {};
    for (const [key, value] of Object.entries(en)) {
      if (typeof value === "string" && isUntranslated(lang, key, translations[lang][key], value)) patch[key] = value;
    }
    if (Object.keys(patch).length) all[lang] = patch;
  }
  console.log(JSON.stringify(all, null, 2));
} else if (flagValue("--apply")) {
  const lang = flagValue("--apply");
  const patchPath = args[args.indexOf("--apply") + 2];
  if (!lang || !patchPath) {
    console.error("usage: bun scripts/i18n-translate.mjs --apply <lang> <patch.json> [--force]");
    process.exit(1);
  }
  applyPatch(lang, patchPath);
} else if (flagValue("--apply-all")) {
  applyAll(flagValue("--apply-all"));
} else {
  console.log(`usage:
  bun scripts/i18n-translate.mjs --list <lang> [--count]  # work order for one locale (key -> English text)
  bun scripts/i18n-translate.mjs --list-all               # every locale's work order in one document
  bun scripts/i18n-translate.mjs --apply <lang> <patch>   # write one locale back (patch: { key: translation })
  bun scripts/i18n-translate.mjs --apply-all <patch>      # same, for a batch: { lang: { key: translation } }

Locales: ${Object.keys(translations).join(", ")}`);
  process.exit(1);
}
