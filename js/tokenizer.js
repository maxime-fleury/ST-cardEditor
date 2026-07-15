/* ============================================================
   tokenizer.js — Token estimation with a real BPE tokenizer
   ------------------------------------------------------------
   Uses gpt-tokenizer (cl100k_base) loaded lazily from a CDN.
   Falls back to a multilingual heuristic if the network/CDN
   is unavailable, so the UI never blocks on this.
   ============================================================ */

const Tokenizer = {
  _lib: null,
  _loading: null,
  _cdnUrl: 'https://esm.sh/gpt-tokenizer@3.0.1',

  async _load() {
    if (this._lib !== null) return this._lib;
    if (!this._loading) {
      this._loading = import(this._cdnUrl)
        .then(mod => {
          const fn = mod.countTokens
            || (mod.default && mod.default.countTokens)
            || (mod.encode ? (t) => mod.encode(t).length : null)
            || (mod.default && mod.default.encode ? (t) => mod.default.encode(t).length : null);
          return fn ? fn : null;
        })
        .catch(() => null);
    }
    this._lib = await this._loading;
    return this._lib;
  },

  /**
   * Count tokens for a string. Async (may lazy-load the lib once).
   * @param {string} text
   * @returns {Promise<number>}
   */
  async count(text) {
    const fn = await this._load();
    if (fn) {
      try { return fn(text) | 0; } catch (_) { /* fall through */ }
    }
    return this._fallback(text);
  },

  /**
   * Synchronous guess used before the lib finishes loading.
   */
  quickCount(text) {
    return this._fallback(text);
  },

  /**
   * Multilingual heuristic: Latin ~4 chars/token, CJK/Korean ~1.5,
   * so a blended ~3 chars/token is a reasonable offline estimate.
   */
  _fallback(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3);
  },
};

window.Tokenizer = Tokenizer;
