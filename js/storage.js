/* ============================================================
   storage.js — localStorage Persistence
   ============================================================ */

const Storage = {
  PREFIX: 'stce_',

  _keys: {
    apiKey: 'apiKey',
    defaultModel: 'defaultModel',
    cardIndex: 'cardIndex',
    activeCardId: 'activeCardId',
    aiChatHistory: 'aiChatHistory',
  },

  // ─── API Key ────────────────────────────────────────────

  getApiKey() {
    return localStorage.getItem(this.PREFIX + this._keys.apiKey) || '';
  },

  setApiKey(key) {
    localStorage.setItem(this.PREFIX + this._keys.apiKey, key);
  },

  // ─── Default Model ─────────────────────────────────────

  getDefaultModel() {
    return localStorage.getItem(this.PREFIX + this._keys.defaultModel) || '';
  },

  setDefaultModel(modelId) {
    localStorage.setItem(this.PREFIX + this._keys.defaultModel, modelId);
  },

  // ─── Migration ─────────────────────────────────────────

  _checkMigration() {
    const oldRaw = localStorage.getItem(this.PREFIX + 'cards');
    if (!oldRaw) return;
    try {
      const oldCards = JSON.parse(oldRaw);
      if (!Array.isArray(oldCards)) return;
      const index = [];
      for (const card of oldCards) {
        if (!card || !card._id) continue;
        localStorage.setItem(this.PREFIX + 'card_' + card._id, JSON.stringify(card));
        index.push(this._extractMeta(card));
      }
      localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
      localStorage.removeItem(this.PREFIX + 'cards');
    } catch (e) {
      console.error('Migration failed:', e);
    }
  },

  _extractMeta(card) {
    return {
      _id: card._id,
      name: card.name,
      creator: card.creator,
      tags: card.tags,
      spec_version: card.spec_version,
      _imageBase64: card._imageBase64,
    };
  },

  // ─── Cards ─────────────────────────────────────────────

  /**
   * Get all card metadata for the sidebar list.
   */
  getCards() {
    this._checkMigration();
    try {
      const raw = localStorage.getItem(this.PREFIX + this._keys.cardIndex);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  /**
   * Fetch a single full card by ID.
   */
  getCard(id) {
    this._checkMigration();
    try {
      const raw = localStorage.getItem(this.PREFIX + 'card_' + id);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  /**
   * Save all cards (replaces entire list).
   */
  saveCards(cards) {
    this._checkMigration();
    try {
      const index = [];
      for (const card of cards) {
        localStorage.setItem(this.PREFIX + 'card_' + card._id, JSON.stringify(card));
        index.push(this._extractMeta(card));
      }
      localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        throw new Error('Storage full! Try removing some cards or exporting them.');
      }
      throw e;
    }
  },

  /**
   * Add or update a card in storage.
   */
  upsertCard(card) {
    this._checkMigration();
    localStorage.setItem(this.PREFIX + 'card_' + card._id, JSON.stringify(card));

    const index = this.getCards();
    const idx = index.findIndex(c => c._id === card._id);
    const meta = this._extractMeta(card);
    if (idx >= 0) {
      index[idx] = meta;
    } else {
      index.unshift(meta);
    }
    localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
  },

  /**
   * Delete a card by ID.
   */
  deleteCard(id) {
    this._checkMigration();
    localStorage.removeItem(this.PREFIX + 'card_' + id);
    const index = this.getCards().filter(c => c._id !== id);
    localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
    if (this.getActiveCardId() === id) {
      this.setActiveCardId(null);
    }
  },

  // ─── Active Card ───────────────────────────────────────

  getActiveCardId() {
    return localStorage.getItem(this.PREFIX + this._keys.activeCardId) || null;
  },

  setActiveCardId(id) {
    if (id) {
      localStorage.setItem(this.PREFIX + this._keys.activeCardId, id);
    } else {
      localStorage.removeItem(this.PREFIX + this._keys.activeCardId);
    }
  },

  /**
   * Get the active card object.
   */
  getActiveCard() {
    const id = this.getActiveCardId();
    if (!id) return null;
    return this.getCard(id);
  },

  // ─── AI Chat History ──────────────────────────────────

  getChatHistory() {
    try {
      const raw = localStorage.getItem(this.PREFIX + this._keys.aiChatHistory);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  saveChatHistory(messages) {
    try {
      // Limit to last 50 messages
      const trimmed = messages.slice(-50);
      localStorage.setItem(this.PREFIX + this._keys.aiChatHistory, JSON.stringify(trimmed));
    } catch { /* silently fail */ }
  },

  clearChatHistory() {
    localStorage.removeItem(this.PREFIX + this._keys.aiChatHistory);
  },

  // ─── Utility ───────────────────────────────────────────

  /**
   * Clear ALL stored data.
   */
  clearAll() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(this.PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  },

  /**
   * Get total storage usage estimate.
   */
  getUsageEstimate() {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(this.PREFIX)) {
        const val = localStorage.getItem(key);
        if (val) total += val.length * 2; // rough UTF-16 byte count
      }
    }
    return total;
  },
};

window.Storage = Storage;
