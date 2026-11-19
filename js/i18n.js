// @ts-check
/**
 * ST Card Editor - Internationalization Module
 * Supports: en, fr, es, de, pt, ja, zh, ko, el, ru, it, pl, tr, nl, uk, vi, id, hi, ar, he, fa, ro, cs, sv, th, pt-pt, tl
 *
 * One translation file per language lives in js/i18n/<lang>.js. Only English is
 * imported statically — it is the dictionary every key falls back through, so it
 * has to be there before the first `t()` call. The other 26 are fetched on demand
 * (see LOADERS): together they were ~845 KB of the ~1.2 MB bundle, i.e. 71% of
 * the JavaScript every user downloaded so that each user could read one of them,
 * and 845 KB of string tables to parse on every load.
 *
 * What that costs: a language works offline once it has been loaded once, since
 * the service worker caches its chunk on the way through (public/sw.js). Loading
 * a language that has never been used while offline therefore falls back to
 * English and says so (see setLanguage) instead of failing.
 */
'use strict';

import en from './i18n/en.js';

const STORAGE_KEY = 'stce_lang';
const SUPPORTED = ['en','fr','es','de','pt','ja','zh','ko','el','ru','it','pl','tr','nl','uk','vi','id','hi','ar','he','fa','ro','cs','sv','th','pt-pt','tl'];
const RTL_LANGS = ['ar','he','fa'];

/**
 * Absolute URL of a locale dictionary.
 *
 * In a browser it is resolved against the document, so the path is also right
 * under /dev/ where the app is served from a subdirectory. Off-browser — the
 * build-time scripts (check-i18n, i18n-add) call loadAllLocales() — it is
 * resolved against this module's own URL instead, which is the same file tree
 * from a different root: 'js/i18n/x.js' from the document, './i18n/x.js' from
 * here. Both land on js/i18n/<lang>.js, and the third branch is only a last
 * resort so a missing URL base cannot throw at module scope.
 * @param {string} lang
 * @returns {string}
 */
function localeUrl(lang) {
  if (typeof document !== 'undefined' && document.baseURI) {
    try { return new URL('js/i18n/' + lang + '.js', document.baseURI).href; } catch (_) { /* fall through */ }
  }
  try { return new URL('./i18n/' + lang + '.js', import.meta.url).href; } catch (_) { return 'js/i18n/' + lang + '.js'; }
}

/**
 * Fetch one dictionary. A dictionary is a dependency-free data module
 * (`export default { … }`), so there is nothing for a bundler to do with it: it
 * is served as-is from js/i18n/, exactly like the vendored tokenizer.
 *
 * The specifier is computed, and that is load-bearing. A literal
 * `import('./i18n/fr.js')` is a specifier the bundler must honour, and 26 of them
 * make it emit 26 chunks *plus* a shared runtime chunk whose name collides with
 * the entry's own chunk under the stable, hash-free naming that public/sw.js
 * precaches by — the build fails outright with "Multiple files share the same
 * output path ./js/app.chunk.js". js/tokenizer.js computes its specifier for the
 * same reason (there, to keep 2.7 MB out of the boot chunk).
 * @param {string} lang
 * @returns {Promise<{ default: Record<string, string> }>}
 */
function loadDict(lang) {
  return import(localeUrl(lang));
}

/**
 * One loader per supported code, keyed by the exact code the UI switches to.
 * Derived from SUPPORTED so the two cannot disagree, and that list is what
 * check-i18n cross-checks against the files in js/i18n/.
 *
 * Keyed lookups also delete a whole bug class. The dictionaries used to be
 * imported as named bindings, and `import elGr from './i18n/el.js'` registered
 * Greek under `elGr` — so choosing Ελληνικά looked up `translations['el']`, found
 * nothing, and silently rendered English while the parity check passed (it only
 * compared the dictionaries that existed). Here the key *is* the file name.
 * @type {Record<string, () => Promise<{ default: Record<string, string> }>>}
 */
const LOADERS = {};
for (const lang of SUPPORTED) {
  LOADERS[lang] = lang === 'en'
    ? () => Promise.resolve({ default: en })
    : () => loadDict(lang);
}

/** Loaded dictionaries, filled in by the loaders. English is always present. */
const translations = { en };

/**
 * Load and register one locale. A no-op for English and for an already-loaded
 * language, so it is safe to call on every boot and every switch.
 * @param {string} lang
 * @returns {Promise<boolean>} false when the pack is unavailable (offline, never fetched)
 */
async function loadLocale(lang) {
  if (translations[lang]) return true;
  const load = LOADERS[lang];
  if (!load) return false;
  try {
    translations[lang] = (await load()).default;
    return true;
  } catch (err) {
    // Deliberately swallowed: a missing language pack must never break the boot,
    // and `t()` already falls back to English. The caller turns `false` into one
    // message for the user (see the language switch in ui.js).
    console.warn('[i18n] language pack unavailable: ' + lang, err);
    return false;
  }
}

/**
 * Every dictionary at once. For the build-time scripts (check-i18n, i18n-add),
 * which compare all locales against English — the browser only ever loads the
 * active one.
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
async function loadAllLocales() {
  const all = { ...translations };
  for (const lang of Object.keys(LOADERS)) {
    if (all[lang]) continue;
    await loadLocale(lang);
    const dict = translations[lang];
    if (dict) all[lang] = dict;
  }
  return all;
}

const I18n = {
  _lang: 'en',

  getLang() {
    return this._lang;
  },

  _detectLanguage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved)) return saved;
    // userLanguage is a legacy IE property absent from lib.dom — read it via a
    // narrow cast so old browsers that only expose it still get language detection.
    const browserLang = (navigator.language || (/** @type {{ userLanguage?: string }} */ (navigator)).userLanguage || '').toLowerCase();
    // Prefer the full regional code ("pt-pt") before falling back to the
    // base language ("pt"), so e.g. a pt-PT browser gets the Portuguese
    // (Portugal) translation instead of the Brazilian one.
    if (SUPPORTED.includes(browserLang)) return browserLang;
    const short = browserLang.split('-')[0] || '';
    return SUPPORTED.includes(short) ? short : 'en';
  },

  /**
   * Boot: detect the language, load its pack, then translate. Async because the
   * first paint must already be in the right language — translating in English
   * and swapping a moment later is the flash the split would otherwise add.
   * @returns {Promise<string>} the language actually in use. It is 'en' when the
   *   detected pack could not be loaded — the caller compares it with getLang()
   *   and tells the user, instead of leaving them to wonder why their chosen
   *   language renders English.
   */
  async init() {
    this._lang = this._detectLanguage();
    document.documentElement.lang = this._lang;
    document.documentElement.dir = RTL_LANGS.includes(this._lang) ? 'rtl' : 'ltr';
    this._applyBootstrapDir();
    const loaded = await loadLocale(this._lang);
    document.title = this.t('app.title');
    const langSel = document.getElementById('languageSelect');
    if (langSel) langSel.value = this._lang;
    this.translateDOM();
    return loaded ? this._lang : 'en';
  },

  /**
   * Fetch the detected language's pack without applying anything. The boot in
   * ui.js starts this before its storage reads so the one network round-trip of
   * the boot overlaps them instead of queueing behind them.
   * @returns {Promise<boolean>}
   */
  preload() {
    return loadLocale(this._detectLanguage());
  },

  t(key, vars) {
    let str = translations[this._lang] && translations[this._lang][key];
    if (str === undefined) {
      str = translations.en && translations.en[key];
    }
    if (str === undefined) {
      console.warn('[i18n] Missing translation key: ' + key);
      return key;
    }
    if (vars && typeof str === 'string') {
      Object.keys(vars).forEach(function(k) {
        str = str.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), function () { return vars[k]; });
      });
    }
    return str;
  },

  /**
   * Switch language. Async because the pack may still have to be fetched: the UI
   * is re-translated only once it is available, so a switch is one update rather
   * than an English flash followed by the real language.
   *
   * Returns false when the pack could not be loaded (offline, never fetched).
   * The choice is persisted anyway and `_lang` still changes, which keeps the app
   * self-healing — the next online boot fetches it and the UI is translated then.
   * Until that happens every key resolves through the English fallback in `t()`,
   * and the caller tells the user rather than leaving it to be noticed.
   * @param {string} lang
   * @returns {Promise<boolean>}
   */
  async setLanguage(lang) {
    if (!SUPPORTED.includes(lang)) return false;
    const loaded = await loadLocale(lang);
    this._lang = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL_LANGS.includes(lang) ? 'rtl' : 'ltr';
    this._applyBootstrapDir();
    document.title = this.t('app.title');
    this.translateDOM();
    // Let controllers re-render their dynamic (translated) content — e.g. the
    // card counter and tag cloud — which plain data-i18n translation cannot touch.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('stce:language-changed', { detail: { lang } }));
    }
    return loaded;
  },

  _applyBootstrapDir() {
    const rtl = RTL_LANGS.includes(this._lang);
    const ltr = document.getElementById('bootstrapLtr');
    const rtlSheet = document.getElementById('bootstrapRtl');
    if (ltr) ltr.disabled = rtl;
    if (rtlSheet) rtlSheet.disabled = !rtl;
  },

  translateDOM() {
    const self = this;
    document.querySelectorAll('[data-i18n]').forEach(function(node) {
      const key = node.getAttribute('data-i18n');
      const translated = self.t(key);
      if (translated) node.textContent = translated;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function(node) {
      const key = node.getAttribute('data-i18n-placeholder');
      const translated = self.t(key);
      if (translated) node.placeholder = translated;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function(node) {
      const key = node.getAttribute('data-i18n-title');
      const translated = self.t(key);
      if (translated) node.title = translated;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function(node) {
      const key = node.getAttribute('data-i18n-aria');
      const translated = self.t(key);
      if (translated) node.setAttribute('aria-label', translated);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function(node) {
      const key = node.getAttribute('data-i18n-html');
      const translated = self.t(key);
      if (translated) node.innerHTML = translated;
    });
  },

  // Test hooks (see tests/unit/i18n.test.mjs). The offline fallback lives in a
  // catch block that no browsing test can reach — a pack only fails to load when
  // it is missing from the cache, which the unit test reproduces by swapping a
  // loader for one that rejects.
  _loaders: LOADERS,
  _loadedLanguages() {
    return Object.keys(translations);
  }
};

export { I18n, translations, SUPPORTED, loadLocale, loadAllLocales };
if (typeof window !== 'undefined') window.I18n = I18n;