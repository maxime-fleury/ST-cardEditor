/* ============================================================
   storage.js — localStorage + IndexedDB Persistence
   ============================================================ */

const CardStorage = {
  PREFIX: 'stce_',
  CHAT_HISTORY_LIMIT: 100,

  /**
   * IndexedDB wrapper for storing large card data and images.
   * localStorage is limited to ~5MB, so full cards and images are offloaded here.
   */
  DB: {
    dbName: 'stce_data',
    version: 1,
    stores: { cards: 'cards', images: 'images' },
    _db: null,
    _dbPromise: null,

    async init() {
      if (this._db) return this._db;
      if (!this._dbPromise) {
        this._dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open(this.dbName, this.version);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(this.stores.cards)) {
              db.createObjectStore(this.stores.cards);
            }
            if (!db.objectStoreNames.contains(this.stores.images)) {
              db.createObjectStore(this.stores.images);
            }
          };
          req.onsuccess = () => {
            this._db = req.result;
            this._db.onclose = () => { this._db = null; this._dbPromise = null; };
            resolve(this._db);
          };
          req.onerror = () => { this._dbPromise = null; reject(req.error); };
        });
      }
      return this._dbPromise;
    },
    async get(store, id) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async set(store, id, data) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).put(data, id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },
    async delete(store, id) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },
    async clear(store) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },
  },

  _keys: {
    apiKey: 'apiKey',
    defaultModel: 'defaultModel',
    cardIndex: 'cardIndex',
    activeCardId: 'activeCardId',
    aiChatHistory: 'aiChatHistory',
    maxTokens: 'maxTokens',
    injectCopyright: 'injectCopyright',
    provider: 'provider',
    customApiUrl: 'customApiUrl',
    customApiKey: 'customApiKey',
    customModelId: 'customModelId',
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

  // ─── Max Tokens ─────────────────────────────────────

  getMaxTokens() {
    const val = localStorage.getItem(this.PREFIX + this._keys.maxTokens);
    return val ? parseInt(val, 10) : 0;
  },

  setMaxTokens(tokens) {
    localStorage.setItem(this.PREFIX + this._keys.maxTokens, String(tokens));
  },

  getInjectCopyright() {
    const val = localStorage.getItem(this.PREFIX + this._keys.injectCopyright);
    return val === null ? true : val === 'true';
  },

  // ─── Provider ───────────────────────────────────────

  getProvider() {
    return localStorage.getItem(this.PREFIX + this._keys.provider) || 'openrouter';
  },

  setProvider(provider) {
    localStorage.setItem(this.PREFIX + this._keys.provider, provider);
  },

  getCustomApiUrl() {
    return localStorage.getItem(this.PREFIX + this._keys.customApiUrl) || '';
  },

  setCustomApiUrl(url) {
    localStorage.setItem(this.PREFIX + this._keys.customApiUrl, url);
  },

  getCustomApiKey() {
    return localStorage.getItem(this.PREFIX + this._keys.customApiKey) || '';
  },

  setCustomApiKey(key) {
    localStorage.setItem(this.PREFIX + this._keys.customApiKey, key);
  },

  getCustomModelId() {
    return localStorage.getItem(this.PREFIX + this._keys.customModelId) || '';
  },

  setCustomModelId(id) {
    localStorage.setItem(this.PREFIX + this._keys.customModelId, id);
  },

  setInjectCopyright(val) {
    localStorage.setItem(this.PREFIX + this._keys.injectCopyright, String(val));
  },

  // ─── Migration ─────────────────────────────────────────

  _migrationDone: false,

  async _checkMigration() {
    if (this._migrationDone) return;
    const oldRaw = localStorage.getItem(this.PREFIX + 'cards');
    if (!oldRaw) { this._migrationDone = true; return; }
    try {
      const oldCards = JSON.parse(oldRaw);
      if (!Array.isArray(oldCards)) { this._migrationDone = true; return; }
      const index = [];
      for (const card of oldCards) {
        if (!card || !card._id) continue;
        await this.DB.set(this.DB.stores.cards, card._id, card);
        index.push(this._extractMeta(card));
      }
      localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
      localStorage.removeItem(this.PREFIX + 'cards');
      this._migrationDone = true;
    } catch (e) {
      console.error('Migration failed:', e);
    }
  },

  /**
   * Migrate any full cards still stored in localStorage to IndexedDB.
   * This is run once at startup.
   */
  async migrateCardsToIndexedDB() {
    const keysToMigrate = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(this.PREFIX + 'card_') && key !== this.PREFIX + this._keys.cardIndex) {
        keysToMigrate.push(key);
      }
    }

    if (keysToMigrate.length === 0) return;

    for (const key of keysToMigrate) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const card = JSON.parse(raw);
        if (!card || !card._id) continue;
        await this.DB.set(this.DB.stores.cards, card._id, card);
        localStorage.removeItem(key);
      } catch (e) {
        console.error('Failed to migrate card to IndexedDB:', key, e);
      }
    }
  },

  _extractMeta(card) {
    return {
      _id: card._id,
      name: card.name,
      creator: card.creator,
      tags: card.tags,
      spec_version: card.spec_version,
      _thumbnail: card._thumbnail,
      _createdAt: card._createdAt || 0,
      _fileSize: card._fileSize || 0,
    };
  },

  // ─── Cards ─────────────────────────────────────────────

  /**
   * Get all card metadata for the sidebar list.
   */
  getCards() {
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
  async getCard(id) {
    try {
      const card = await this.DB.get(this.DB.stores.cards, id);
      if (card) return card;
      // Fallback to localStorage for cards not yet migrated
      const raw = localStorage.getItem(this.PREFIX + 'card_' + id);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  /**
   * Save the card metadata index array (preserving sidebar card order).
   */
  saveCardIndex(index) {
    try {
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
   * The full card is stored in IndexedDB; only lightweight metadata lives in localStorage.
   * The localStorage index is updated synchronously so the UI can refresh immediately.
   */
  async upsertCard(card) {
    const toSave = { ...card };
    delete toSave._imageBase64;

    // Persist the full card to IndexedDB first, then update the lightweight
    // localStorage index so the two stores stay consistent.
    await this.DB.set(this.DB.stores.cards, card._id, toSave);

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
    const index = this.getCards().filter(c => c._id !== id);
    localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
    this.deleteImage(id).catch(() => {});
    this.DB.delete(this.DB.stores.cards, id).catch(() => {});
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
  async getActiveCard() {
    const id = this.getActiveCardId();
    if (!id) return null;
    return this.getCard(id);
  },

  // ─── AI Chat History (per-card) ────────────────────────

  _chatKey(cardId) {
    return this.PREFIX + this._keys.aiChatHistory + '_' + (cardId || 'global');
  },

  _sessionKey(cardId) {
    return this.PREFIX + 'chatSessions_' + (cardId || 'global');
  },

  getChatHistory(cardId) {
    try {
      const raw = localStorage.getItem(this._chatKey(cardId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  saveChatHistory(messages, cardId) {
    try {
      if (messages.length > this.CHAT_HISTORY_LIMIT) {
        console.warn('Chat history truncated to last ' + this.CHAT_HISTORY_LIMIT + ' messages for card ' + (cardId || 'global'));
      }
      const trimmed = messages.slice(-this.CHAT_HISTORY_LIMIT);
      localStorage.setItem(this._chatKey(cardId), JSON.stringify(trimmed));
    } catch { /* silently fail */ }
  },

  clearChatHistory(cardId) {
    if (cardId) {
      localStorage.removeItem(this._chatKey(cardId));
      localStorage.removeItem(this._sessionKey(cardId));
    } else {
      localStorage.removeItem(this._chatKey('global'));
      localStorage.removeItem(this._sessionKey('global'));
    }
  },

  // ─── Chat Sessions (grouped by time) ───────────────────

  getChatSessions(cardId) {
    try {
      const raw = localStorage.getItem(this._sessionKey(cardId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  saveChatSession(cardId, session) {
    try {
      const sessions = this.getChatSessions(cardId);
      const idx = sessions.findIndex(s => s.id === session.id);
      if (idx >= 0) {
        sessions[idx] = session;
      } else {
        sessions.unshift(session);
      }
      localStorage.setItem(this._sessionKey(cardId), JSON.stringify(sessions));
    } catch { /* silently fail */ }
  },

  deleteChatSession(cardId, sessionId) {
    try {
      const sessions = this.getChatSessions(cardId).filter(s => s.id !== sessionId);
      localStorage.setItem(this._sessionKey(cardId), JSON.stringify(sessions));
    } catch { /* silently fail */ }
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
    this.DB.clear(this.DB.stores.cards).catch(() => {});
    this.DB.clear(this.DB.stores.images).catch(() => {});
  },

  // ─── Image Storage Helpers ─────────────────────────────

  getImage(id) { return this.DB.get(this.DB.stores.images, id); },
  saveImage(id, base64) { return this.DB.set(this.DB.stores.images, id, base64); },
  deleteImage(id) { return this.DB.delete(this.DB.stores.images, id); },

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

window.CardStorage = CardStorage;
