/* ============================================================
   storage.js — localStorage Persistence
   ============================================================ */

const Storage = {
  PREFIX: 'stce_',

  _keys: {
    apiKey: 'apiKey',
    defaultModel: 'defaultModel',
    cards: 'cards',
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

  // ─── Cards ─────────────────────────────────────────────

  /**
   * Get all saved cards.
   */
  getCards() {
    try {
      const raw = localStorage.getItem(this.PREFIX + this._keys.cards);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  /**
   * Save all cards (replaces entire list).
   */
  saveCards(cards) {
    try {
      localStorage.setItem(this.PREFIX + this._keys.cards, JSON.stringify(cards));
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
    const cards = this.getCards();
    const idx = cards.findIndex(c => c._id === card._id);
    if (idx >= 0) {
      cards[idx] = card;
    } else {
      cards.unshift(card);
    }
    this.saveCards(cards);
  },

  /**
   * Delete a card by ID.
   */
  deleteCard(id) {
    const cards = this.getCards().filter(c => c._id !== id);
    this.saveCards(cards);
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
    return this.getCards().find(c => c._id === id) || null;
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
    Object.values(this._keys).forEach(key => {
      localStorage.removeItem(this.PREFIX + key);
    });
  },

  /**
   * Get total storage usage estimate.
   */
  getUsageEstimate() {
    let total = 0;
    Object.values(this._keys).forEach(key => {
      const val = localStorage.getItem(this.PREFIX + key);
      if (val) total += val.length * 2; // rough UTF-16 byte count
    });
    return total;
  },
};

window.Storage = Storage;
