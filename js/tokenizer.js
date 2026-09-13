// @ts-check
/* ============================================================
   tokenizer.js — Token estimation with a real BPE tokenizer
   ------------------------------------------------------------
   Uses gpt-tokenizer (cl100k_base), vendored under public/vendor/ and fetched
   lazily on first use (~2.7 MB — deliberately NOT part of the precached app
   shell; the service worker caches it at runtime instead). Falls back to a
   multilingual heuristic until it arrives, so the UI never blocks on this.
   ============================================================ */

const Tokenizer = {
  /** @type {((text: string) => number) | null} */
  _lib: null,
  /** @type {Promise<((text: string) => number) | null> | null} */
  _loading: null,
  _lastFail: 0,
  // Relative to the document (not the bundle) so /dev/ deployments resolve it
  // too; see _resolveUrl().
  _libUrl: 'vendor/gpt-tokenizer.js',

  /** Absolute URL of the vendored tokenizer, resolved against the document. */
  _resolveUrl() {
    const base = (typeof document !== 'undefined' && document.baseURI)
      ? document.baseURI
      : (typeof location !== 'undefined' ? location.href : '');
    try { return new URL(this._libUrl, base).href; } catch (_) { return this._libUrl; }
  },

  async _load() {
    if (this._lib !== null) return this._lib;
    if (this._loading) return this._loading;
    if (this._lastFail && Date.now() - this._lastFail < 300000) return null;
    // A computed specifier on purpose: a literal import('vendor/…') is resolved
    // relative to THIS module (js/), and a static string would tempt the bundler
    // into pulling the 2.7 MB library into the app chunk the browser parses on
    // boot (scripts/build.mjs). _resolveUrl() resolves against the document.
    this._loading = import(this._resolveUrl())
      .then(mod => {
        const fn = mod.countTokens
          || (mod.default && mod.default.countTokens)
          || (mod.encode ? (t) => mod.encode(t).length : null)
          || (mod.default && mod.default.encode ? (t) => mod.default.encode(t).length : null);
        // A module that loaded but exposes no usable function is a failure, not
        // a success: without this, `_loading` stays cached forever, the backoff
        // never engages and the real tokenizer is never retried (only a reload
        // would clear it).
        if (typeof fn !== 'function') throw new Error('tokenizer module has no countTokens/encode');
        return fn;
      })
      .catch(() => { this._lastFail = Date.now(); this._loading = null; return null; });
    this._lib = await this._loading;
    // The sync consumers (per-field char counters) must flip from the heuristic
    // to the real BPE at the very moment the async path does, or their numbers
    // would disagree with the context bar until the next re-render.
    if (this._lib && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try { window.dispatchEvent(new CustomEvent('stce:tokenizer-ready')); } catch (_) { /* non-browser runtime */ }
    }
    return this._lib;
  },

  /**
   * Count tokens for a string. Async (may lazy-load the lib once).
   * @param {string} text
   * @returns {Promise<number>}
   */
  async count(text) {
    const fn = await this._load();
    return this._countWith(fn, text);
  },

  /**
   * Synchronous guess used before the lib finishes loading.
   */
  quickCount(text) {
    return this._fallback(text);
  },

  /**
   * Synchronous count that uses the real BPE tokenizer once it has loaded and
   * the heuristic before then. Per-field char counters call this so they agree
   * with the (async) context-bar budget instead of diverging once the real
   * tokenizer arrives.
   */
  syncCount(text) {
    return this._countWith(this._lib, text);
  },

  /**
   * Single estimator core shared by the async `count` and the sync `syncCount`:
   * real BPE when the lib is available, heuristic otherwise. Routing both
   * callers through here guarantees the editor char counters and the context
   * bar can never compute different numbers for the same text.
   */
  _countWith(fn, text) {
    if (fn) {
      try {
        const n = fn(text);
        if (typeof n === 'number' && isFinite(n)) return Math.max(0, Math.floor(n));
      } catch (_) { /* fall through to heuristic */ }
    }
    return this._fallback(text);
  },

  /**
   * Multilingual heuristic: Latin ~4 chars/token, CJK/Korean ~1.5,
   * so a blended ~3 chars/token is a reasonable offline estimate.
   */
  _fallback(text) {
    if (typeof text !== 'string') text = text == null ? '' : String(text);
    if (!text) return 0;
    return Math.ceil(text.length / 3);
  },
};

export { Tokenizer };
// Classic-script consumers (the rest of the app still reads the global); the
// guarded assignment keeps the module importable in non-browser runtimes
// (Bun unit tests) where `window` does not exist.
if (typeof window !== 'undefined') window.Tokenizer = Tokenizer;
