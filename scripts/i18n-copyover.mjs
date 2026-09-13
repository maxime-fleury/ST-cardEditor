/**
 * i18n-copyover.mjs — what "still in English" means, for both the guard and the
 * translation tooling.
 *
 * check-i18n.mjs counts copyovers and i18n-translate.mjs hands them out to be
 * translated; if the two disagreed, the guard would report a number the tooling
 * cannot act on and the gap would look unfixable. They share this module so a
 * locale at "0 untranslated" is exactly a locale with nothing to translate.
 *
 * Two categories are deliberately NOT copyovers:
 *  - values with no words in them — a colour, a URL, a lone "{{count}}". The
 *    only correct translation of "#64748B" is "#64748B", and reporting it as
 *    missing work inflates the gap and invites someone to "fix" it.
 *  - strings that must stay in English on purpose, listed by key below. The
 *    product name is the obvious one: localising it would break the brand, and
 *    it is byte-identical in every locale by design, so it would otherwise be
 *    the single largest block of "untranslated" text in the project.
 */

/**
 * Keys whose English value is correct by design, as `lang:key` (or bare `key`
 * for every locale).
 *
 * This list is the record of a human decision, not a shortcut: everything here
 * has been looked at and the English text is the right text. Keep it that
 * short — a growing allowlist is how a coverage metric stops meaning anything.
 * check-i18n.mjs re-verifies every entry (it must still be byte-identical to
 * English), so a stale line fails the build instead of hiding a real gap.
 */
export const ALWAYS_ENGLISH = new Set([
  // The product name, in every locale (see also README/navbar badge).
  'nav.brand',
  // (No bare 'export.minimalPngLabel' or 'dialog.ok' here: the integrity check
  // in check-i18n.mjs rejected both — Italian says "Scheda ST", Turkish says
  // "Tamam". Locales that do keep them English are listed below, and the entry
  // is only valid while the file agrees.)
  'de:dialog.ok',
  'pt:dialog.ok',
  'el:dialog.ok',

  // Locales that already use the English term elsewhere in their dictionary:
  // translating one occurrence would contradict the rest of the file. Verified
  // against the existing entries (see the note in i18n-same.mjs).
  'de:editor.tags',        // de.js: 'left.filterTags': 'Nach Tags filtern'
  'de:editor.tab.lorebook',// de.js: 'editor.lorebookTitle': 'Charakter-Lorebook-Einträge'
  'de:wizard.tagsLabel',   // same label as editor.tags
  'de:ai.target.tags',
  'de:wizard.summary.tags',
  'de:ai.target.name',     // German "Name" is the word already.
  'de:wizard.summary.name',
  'de:wizard.type.anime',  // "Anime / Manga" is the German term.
  'de:wizard.type.vtuber',
  'de:wizard.summary.genres',
  'de:wizard.chip.fantasy',
  'de:wizard.chip.horror',
  'de:wizard.chip.mystery',
  'de:wizard.chip.cyberpunk',
  'de:wizard.chip.modern',
  'de:wizard.chip.surreal',
  'de:wizard.language.hi',  // "Hindi" is the German word too.
  'de:wizard.language.tl',  // "Filipino" likewise.
  'de:batch.compareVs',     // German uses "vs" as well.

  // el — "Lorebook" is kept as the technical term, and the genre/format names
  // below are written in Latin script in Greek fandom usage.
  'el:editor.tab.lorebook',
  'el:wizard.type.vtuber',
  'el:wizard.chip.cyberpunk',
  'el:wizard.chip.action',  // "In Media Res" is Latin.
  'el:ai.streamLive',       // "{{tokens}} tokens · {{secs}}": "tokens" is a loanword.

  // fr — words French shares with English. The dictionary already says "tags"
  // and "lorebook" elsewhere, and the rest are either French words as they
  // stand (Description, Compact, Concept, Notes, Genres, Type, Action) or the
  // Latin tag "In Media Res".
  'fr:editor.tab.lorebook',
  'fr:editor.desc',
  'fr:editor.tags',
  'fr:wizard.tagsLabel',
  'fr:wizard.summary.tags',
  'fr:ai.target.description',
  'fr:settings.radiusCompact',
  'fr:wizard.step.concept',
  'fr:wizard.summary.type',
  'fr:wizard.summary.genres',
  'fr:wizard.summary.notes',
  'fr:wizard.chip.fantasy',
  'fr:wizard.chip.romance',
  'fr:wizard.chip.cyberpunk',
  'fr:wizard.chip.intense',
  'fr:wizard.chip.action',
  'fr:wizard.type.anime',
  'fr:wizard.type.vtuber',
  'fr:palette.kind.action',
  'fr:ai.contextLabel',     // "tokens" is what fr.js uses everywhere else.
  'fr:ai.streamLive',
  'fr:ai.tokensCtx',        // "ctx" is the French abbreviation too.
  'fr:batch.compareVs',     // French writes "vs" as well.
  'fr:dialog.ok',
  'fr:nav.notificationsAria',
  'fr:editor.extensions',   // "Extensions" is the French word.
  'fr:editor.loreConstant', // "Constant" likewise.
  'fr:wizard.language.hi',  // "Hindi" is the French spelling.
  'fr:wizard.language.tl',  // "Filipino" likewise.

  // es — same idea: the list/status labels below are Spanish words unchanged
  // (Manual, General, Romance) or the vocabulary es.js already uses (etiquetas
  // for tags, but "lorebook" and "tokens" stay).
  'es:left.sort.manual',
  'es:settings.generalTab',
  'es:editor.tab.lorebook',
  'es:wizard.type.anime',
  'es:wizard.type.vtuber',
  'es:wizard.chip.romance',
  'es:wizard.chip.cyberpunk',
  'es:wizard.chip.action',
  'es:ai.errorPrefix',      // Spanish says "Error" too.
  'es:ai.contextLabel',
  'es:ai.streamLive',
  'es:ai.toneDefault',
  'es:batch.compareVs',
  'es:dialog.ok',
  'es:wizard.language.hi',
  'es:wizard.language.tl',

  // pt — the dictionary already says "por tags" / "busca ... por tag", and
  // "backup", "vs", "In Media Res" and the genre names are Brazilian usage.
  'pt:left.sort.manual',
  'pt:editor.tab.lorebook',
  'pt:editor.tags',
  'pt:ai.target.tags',
  'pt:wizard.tagsLabel',
  'pt:wizard.summary.tags',
  'pt:ai.contextLabel',      // "— / — tokens": "tokens" is the Brazilian term.
  'pt:wizard.type.vtuber',
  'pt:wizard.chip.romance',
  'pt:wizard.chip.cyberpunk',
  'pt:wizard.chip.surreal',
  'pt:wizard.chip.action',
  'pt:batch.compareVs',
  'pt:settings.backup',
  'pt:wizard.language.tl',   // "Filipino" is the Portuguese word too.
  'pt:ai.streamLive',        // "tokens" is the Brazilian term.
  'pt:ai.toneDefault',       // "formal" is the Portuguese word.

  // ── The same rule for the other 21 locales ─────────────────────────────
  // These are NOT shortcuts: each line is a word the language spells exactly
  // as English, and translating it would be wrong. Where the language has its
  // own word (ru "Сценарий", pl "Tagi", tr "Etiketler", cs "Štítky"), the
  // dictionary carries the translation and the key is deliberately absent
  // here. Two groups, both verified against the locale file:
  //   · single words spelled the same — Scenario, Tags, Type, Genres, Concept,
  //     Compact, Constant, Opening, Provider, Lorebook;
  //   · genre and tech loanwords in common use — Cyberpunk, Fantasy, Horror,
  //     Modern, Sci-Fi, Anime / Manga, VTuber / Streamer, Fan Fiction;
  //   · the two token-meter labels ("— / — tokens", "{{tokens}} tokens ·
  //     {{secs}}"), where "tokens" is the local term — the same call already
  //     recorded for fr/es/pt/el above.

  // nl — Dutch keeps "tags", "provider", "lorebook" and the genre words, and
  // spells Scenario/Type/Genres/Concept/Compact/Constant/Opening the same way.
  'nl:ai.contextLabel',
  'nl:ai.streamLive',
  'nl:ai.target.scenario',
  'nl:ai.target.tags',
  'nl:editor.loreConstant',
  'nl:editor.scenario',
  'nl:editor.tab.lorebook',
  'nl:editor.tags',
  'nl:settings.provider',
  'nl:settings.radiusCompact',
  'nl:wizard.chip.cyberpunk',
  'nl:wizard.chip.fantasy',
  'nl:wizard.chip.horror',
  'nl:wizard.chip.modern',
  'nl:wizard.chip.scifi',
  'nl:wizard.language.hi',   // "Hindi" is the Dutch spelling.
  'nl:wizard.step.concept',
  'nl:wizard.step.scenario',
  'nl:wizard.summary.genres',
  'nl:wizard.summary.opening',
  'nl:wizard.summary.scenario',
  'nl:wizard.summary.tags',
  'nl:wizard.summary.type',
  'nl:wizard.tagsLabel',
  'nl:wizard.type.anime',
  'nl:wizard.type.vtuber',

  // sv — Swedish spells Scenario/Modern the same, keeps "lorebook" and the
  // genre words, and uses the loanword "tokens" in the two meters. Where it has
  // its own word the dictionary carries it: "hindi" (lower-case language name),
  // "Fanfiction", "mot" for vs, "Okej" for OK.
  'sv:ai.contextLabel',
  'sv:ai.streamLive',
  'sv:ai.target.scenario',
  'sv:editor.scenario',
  'sv:editor.tab.lorebook',
  'sv:wizard.chip.cyberpunk',
  'sv:wizard.chip.fantasy',
  'sv:wizard.chip.modern',
  'sv:wizard.chip.scifi',
  'sv:wizard.step.scenario',
  'sv:wizard.summary.scenario',
  'sv:wizard.type.anime',

  // id — Indonesian spells these the same; where it has its own word the
  // dictionary carries it ("Sunting" for Edit, "Sasaran" for Target,
  // "Batal"/"Oke", "Jenis kelamin" for Gender, "Tidak tersedia" for N/A).
  'id:editor.tab.lorebook',
  'id:left.sort.manual',
  'id:wizard.chip.cyberpunk',
  'id:wizard.chip.modern',
  'id:wizard.language.hi',  // "Hindi" is the Indonesian spelling.
  'id:wizard.language.tl',  // "Filipino" likewise.
  'id:wizard.type.anime',
  'id:wizard.type.vtuber',

  // it — Italian spells Scenario the same and uses these loanwords as they are
  // (the file already says "tag", "lorebook", "backup" and "Fan fiction").
  'it:ai.target.scenario',
  'it:editor.scenario',
  'it:editor.tab.lorebook',
  'it:settings.backup',
  'it:wizard.chip.cyberpunk',
  'it:wizard.chip.fantasy',
  'it:wizard.chip.horror',
  'it:wizard.language.hi',  // "Hindi" is the Italian spelling.
  'it:wizard.language.th',  // "Thai" likewise.
  'it:wizard.step.scenario',
  'it:wizard.summary.scenario',
  'it:wizard.type.anime',
  'it:wizard.type.vtuber',

  // vi — Vietnamese keeps "Lorebook" and "Cyberpunk" as the technical terms and
  // writes the two card types the same way. Everything else has a Vietnamese
  // form in the dictionary ("Đồng ý" for OK, "Hủy"/"Xóa", "Tình trạng thẻ").
  'vi:editor.tab.lorebook',
  'vi:wizard.chip.cyberpunk',
  'vi:wizard.type.anime',
  'vi:wizard.type.vtuber',

  // pl — Polish keeps "Lorebook" and the genre words, and spells "Hindi" as it
  // is. "Kontra" (vs), "Dobrze" (OK), "Automatycznie" (Auto) are translated.
  'pl:editor.tab.lorebook',
  'pl:wizard.chip.cyberpunk',
  'pl:wizard.chip.fantasy',
  'pl:wizard.chip.horror',
  'pl:wizard.chip.scifi',
  'pl:wizard.language.hi',  // "Hindi" is the Polish spelling.
  'pl:wizard.type.anime',
  'pl:wizard.type.vtuber',

  // tr — Turkish keeps "Lorebook" and "Modern"/"Anime / Manga" as they are,
  // but spells the rest its own way ("Siberpunk", "Karşı", "Hintçe").
  'tr:editor.tab.lorebook',
  'tr:wizard.chip.modern',
  'tr:wizard.type.anime',

  // tl — Filipino borrows these technical and genre words wholesale (the file
  // already says "Mag-browse", "I-save", "Custom", "Romansa", "Mapanuligso").
  // The words it does render its own way are in the dictionary: "Siberpunk",
  // "Fantasiya", "Atmosperiko", "Estoiko", "Sige" for OK, "Susi ng API".
  'tl:palette.kind.field',
  'tl:editor.tab.lorebook',
  'tl:settings.backup',
  'tl:wizard.chip.horror',
  'tl:wizard.chip.scifi',
  'tl:wizard.language.hi',  // "Hindi" is the Filipino spelling.
  'tl:wizard.language.th',  // "Thai" likewise.
  'tl:wizard.language.tl',  // "Filipino" is the language's own name.
  'tl:wizard.type.anime',
  'tl:wizard.type.vtuber',

  // ro — Romanian spells Card/Manual/General/Compact/Concept the same way and
  // keeps the genre words. "Aldin" (Bold), "Autor" (Creator), "Permanent"
  // (Constant), "Ficțiune de fani" (Fan Fiction) and "oficial" are translated.
  'ro:palette.kind.card',
  'ro:left.sort.manual',
  'ro:settings.generalTab',
  'ro:settings.radiusCompact',
  'ro:wizard.chip.cyberpunk',
  'ro:wizard.chip.fantasy',
  'ro:wizard.chip.horror',
  'ro:wizard.chip.modern',
  'ro:wizard.chip.romantic',
  'ro:wizard.chip.sarcastic',
  'ro:wizard.chip.scifi',
  'ro:wizard.chip.stoic',
  'ro:wizard.step.concept',
  'ro:wizard.type.anime',
  'ro:wizard.type.vtuber',

  // pt-pt — same calls pt already recorded above, applied to European
  // Portuguese; where it differs from pt-BR the dictionary carries the
  // European form ("Cartão ST", "Ciberpunk", "mens.", " vs. ").
  'pt-pt:ai.contextLabel',
  'pt-pt:ai.streamLive',
  'pt-pt:ai.toneDefault',
  'pt-pt:dialog.ok',
  'pt-pt:editor.tab.lorebook',
  'pt-pt:left.sort.manual',
  'pt-pt:wizard.chip.romance',
  'pt-pt:wizard.type.anime',
  'pt-pt:wizard.type.vtuber',

  // cs — Czech keeps "Lorebook" and writes the two card types the same way;
  // it spells the genre chips its own way ("Kyberpunk", "Fantazie").
  'cs:editor.tab.lorebook',
  'cs:wizard.type.anime',
  'cs:wizard.type.vtuber',

  // Language names below are the ones the file's own picker already capitalises
  // (sv "Engelska", pt-pt "Inglês", ro "Română"), so matching the list means
  // keeping the English spelling rather than the native lower-case one.
  'sv:wizard.language.hi',
  'pt-pt:wizard.language.hi',
  'pt-pt:wizard.language.tl',
  'ro:wizard.language.hi',
]);

/** True when a string has no words to translate (colour, URL, unit, placeholder). */
export function isWordless(value) {
  return (
    /^#[0-9a-fA-F]{3,8}$/.test(value) ||          // #64748B
    /^https?:\/\/\S*$/.test(value) ||             // http://localhost:1234/v1
    /^(?:\{\{[A-Za-z0-9_]+\}\})+$/.test(value) || // "{{count}}"
    // A measurement suffix is an SI-style symbol: " KB" is " KB" in every
    // locale, and 26 translations of "MB" would be 26 ways to be wrong.
    /^\s*(?:B|kB|KB|MB|GB|TB|ms)\s*$/.test(value) ||
    !/[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/.test(value)
  );
}

/** True when the allowlist says English is the right text for this key. */
export function isAlwaysEnglish(lang, key) {
  return ALWAYS_ENGLISH.has(key) || ALWAYS_ENGLISH.has(`${lang}:${key}`);
}

/**
 * True when `value` is an English copyover for `key` in locale `lang` — i.e.
 * real translation work, not one of the exceptions above.
 */
export function isUntranslated(lang, key, value, enValue) {
  if (value !== enValue) return false;
  if (isAlwaysEnglish(lang, key)) return false;
  if (isWordless(enValue)) return false;
  return true;
}
