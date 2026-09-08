/**
 * ST Card Editor - Internationalization Module
 * Supports: en, fr, es, de, pt, ja, zh, ko, el, ru, it, pl, tr, nl, uk, vi, id, hi, ar, he, fa, ro, cs, sv, th, pt-pt, tl
 *
 * One translation file per language lives in js/i18n/<lang>.js; this module
 * assembles them into the `translations` map and exposes the I18n engine.
 */
'use strict';

import en from './i18n/en.js';
import fr from './i18n/fr.js';
import es from './i18n/es.js';
import de from './i18n/de.js';
import pt from './i18n/pt.js';
import ja from './i18n/ja.js';
import zh from './i18n/zh.js';
import ko from './i18n/ko.js';
import elGr from './i18n/el.js';
import ru from './i18n/ru.js';
import it from './i18n/it.js';
import pl from './i18n/pl.js';
import tr from './i18n/tr.js';
import nl from './i18n/nl.js';
import uk from './i18n/uk.js';
import vi from './i18n/vi.js';
import id from './i18n/id.js';
import hi from './i18n/hi.js';
import ar from './i18n/ar.js';
import he from './i18n/he.js';
import fa from './i18n/fa.js';
import ro from './i18n/ro.js';
import cs from './i18n/cs.js';
import sv from './i18n/sv.js';
import th from './i18n/th.js';
import ptPt from './i18n/pt-pt.js';
import tl from './i18n/tl.js';

const STORAGE_KEY = 'stce_lang';
const SUPPORTED = ['en','fr','es','de','pt','ja','zh','ko','el','ru','it','pl','tr','nl','uk','vi','id','hi','ar','he','fa','ro','cs','sv','th','pt-pt','tl'];
const RTL_LANGS = ['ar','he','fa'];

const translations = {
  en, fr, es, de, pt, ja, zh, ko, elGr, ru, it, pl, tr, nl, uk, vi, id, hi, ar, he, fa,
  ro, cs, sv, th, 'pt-pt': ptPt, tl
};

const I18n = {
  _lang: 'en',

  getLang() {
    return this._lang;
  },

  _detectLanguage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved)) return saved;
    const browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
    // Prefer the full regional code ("pt-pt") before falling back to the
    // base language ("pt"), so e.g. a pt-PT browser gets the Portuguese
    // (Portugal) translation instead of the Brazilian one.
    if (SUPPORTED.includes(browserLang)) return browserLang;
    const short = browserLang.split('-')[0];
    return SUPPORTED.includes(short) ? short : 'en';
  },

  init() {
    this._lang = this._detectLanguage();
    document.documentElement.lang = this._lang;
    document.documentElement.dir = RTL_LANGS.includes(this._lang) ? 'rtl' : 'ltr';
    this._applyBootstrapDir();
    document.title = this.t('app.title');
    const langSel = document.getElementById('languageSelect');
    if (langSel) langSel.value = this._lang;
    this.translateDOM();
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

  setLanguage(lang) {
    if (!SUPPORTED.includes(lang)) return;
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
  }
};

export { I18n, translations };
if (typeof window !== 'undefined') window.I18n = I18n;