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
import el from './i18n/el.js';
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
  en, fr, es, de, pt, ja, zh, ko, el, ru, it, pl, tr, nl, uk, vi, id, hi, ar, he, fa,
  ro, cs, sv, th, 'pt-pt': ptPt, tl
};

const I18n = {
  _lang: 'en',

  getLang() {
    return this._lang;
  },

  init() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved)) {
      this._lang = saved;
    } else {
      const browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
      const short = browserLang.split('-')[0];
      this._lang = SUPPORTED.includes(short) ? short : 'en';
    }
    document.documentElement.lang = this._lang;
    document.documentElement.dir = RTL_LANGS.includes(this._lang) ? 'rtl' : 'ltr';
    this._applyBootstrapDir();
    document.title = this.t('app.title');
    var langSel = document.getElementById('languageSelect');
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
  },

  _applyBootstrapDir() {
    var rtl = RTL_LANGS.includes(this._lang);
    var ltr = document.getElementById('bootstrapLtr');
    var rtlSheet = document.getElementById('bootstrapRtl');
    if (ltr) ltr.disabled = rtl;
    if (rtlSheet) rtlSheet.disabled = !rtl;
  },

  translateDOM() {
    var self = this;
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      var translated = self.t(key);
      if (translated) el.textContent = translated;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-placeholder');
      var translated = self.t(key);
      if (translated) el.placeholder = translated;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-title');
      var translated = self.t(key);
      if (translated) el.title = translated;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-aria');
      var translated = self.t(key);
      if (translated) el.setAttribute('aria-label', translated);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-html');
      var translated = self.t(key);
      if (translated) el.innerHTML = translated;
    });
  }
};

export { I18n, translations };
if (typeof window !== 'undefined') window.I18n = I18n;