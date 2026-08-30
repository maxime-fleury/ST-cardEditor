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
        req.onerror = () => reject(req.error && req.error.name === 'QuotaExceededError'
          ? new Error((I18n.t ? I18n.t('error.storageFull') : 'Storage full! Try removing some cards or exporting them.'))
          : req.error);
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
    async getAll(store) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
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
    providerApiKeys: 'providerApiKeys',
    darkAccent: 'darkAccent',
    lightAccent: 'lightAccent',
    glassDensity: 'glassDensity',
    vignette: 'vignette',
    cardRadius: 'cardRadius',
    promptAssistant: 'promptAssistant',
    promptFullCard: 'promptFullCard',
    promptWizard: 'promptWizard',
    promptEnhance: 'promptEnhance',
    promptPersonality: 'promptPersonality',
    promptFirstmes: 'promptFirstmes',
    promptScenario: 'promptScenario',
    promptShorten: 'promptShorten',
    promptTone: 'promptTone',
    promptGrammar: 'promptGrammar',
    promptGreetings: 'promptGreetings',
    promptSystemprompt: 'promptSystemprompt',
    promptTranslate: 'promptTranslate',
    promptTags: 'promptTags',
    promptTagsSystem: 'promptTagsSystem',
    promptFullCardInstr: 'promptFullCardInstr',
    promptFieldsEdit: 'promptFieldsEdit',
    promptGreetingsSystem: 'promptGreetingsSystem',
  },

  // ─── Theme accents ─────────────────────────────────────

  getAccent(theme) {
    const key = theme === 'light' ? this._keys.lightAccent : this._keys.darkAccent;
    return localStorage.getItem(this.PREFIX + key) || '';
  },

  setAccent(theme, color) {
    const key = theme === 'light' ? this._keys.lightAccent : this._keys.darkAccent;
    if (color) localStorage.setItem(this.PREFIX + key, color);
    else localStorage.removeItem(this.PREFIX + key);
  },

  getPrompt(name) {
    if (!name || typeof name !== 'string' || !name.length) return '';
    const key = this._keys['prompt' + name[0].toUpperCase() + name.slice(1)];
    if (!key) return '';
    return localStorage.getItem(this.PREFIX + key) || '';
  },

  setPrompt(name, value) {
    const key = this._keys['prompt' + name[0].toUpperCase() + name.slice(1)];
    localStorage.setItem(this.PREFIX + key, value || '');
  },

  // ─── Secrets (API keys) ─────────────────────────
  //
  // API keys are encrypted at rest (AES-GCM) so they don't sit in plaintext in
  // localStorage. A key is deterministic per page origin: derived with PBKDF2
  // from location.origin, so same-origin reloads decrypt fine, while a dump of
  // localStorage alone can't be read directly. Because the key is derived from
  // the origin, moving the server to another port/host makes stored keys
  // undecryptable; we surface that with a toast and leave the ciphertext intact.
  // Legacy plaintext keys are auto-migrated to ciphertext on first unlock.
  _secrets: { apiKey: '', customApiKey: '', providerKeys: {} },
  _secretWarn: { apiKey: false, customApiKey: false },
  _secretUnlocked: false,

  _encSecretPrefix: 'encv1:',

  _bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  },
  _b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  },

  async _deriveSecretKey() {
    const enc = new TextEncoder();
    const base = (typeof location !== 'undefined' && location.origin) ? location.origin : 'st-card-editor';
    const importKey = await crypto.subtle.importKey(
      'raw', enc.encode('st-card-editor-secret:' + base),
      'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('stce-salt:' + base), iterations: 200000, hash: 'SHA-256' },
      importKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  },

  async _encryptSecret(plain) {
    const key = await this._deriveSecretKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key, new TextEncoder().encode(plain));
    return this._encSecretPrefix + JSON.stringify({
      v: 1,
      iv: this._bufToB64(iv),
      ct: this._bufToB64(ct),
    });
  },

  async _decryptSecret(stored) {
    if (typeof stored !== 'string' || !stored.startsWith(this._encSecretPrefix)) {
      return null; // not in our format
    }
    try {
      const obj = JSON.parse(stored.slice(this._encSecretPrefix.length));
      const key = await this._deriveSecretKey();
      const iv = this._b64ToBuf(obj.iv);
      const ct = this._b64ToBuf(obj.ct);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return new TextDecoder().decode(plain);
    } catch (err) {
      // Key changed (different origin/port) or data corrupted — treat as unrecoverable.
      return null;
    }
  },

  // Unlock (and self-migrate) both stored keys. Populates the in-memory cache so
  // the synchronous getters below can serve plaintext. Legacy plaintext values are
  // migrated to ciphertext on the fly. Callers may inspect this._secretWarn.* to
  // notify the user when a stored key could not be decrypted on this address.
  async _unlockKeys() {
    if (this._secretUnlocked) return;
    this._secretUnlocked = true;
    for (const name of ['apiKey', 'customApiKey']) {
      const rawKey = this.PREFIX + this._keys[name];
      const raw = localStorage.getItem(rawKey);
      this._secretWarn[name] = false;
      if (!raw) { this._secrets[name] = ''; continue; }
      if (!raw.startsWith(this._encSecretPrefix)) {
        // Legacy plaintext — encrypt in place, keep plaintext in memory. If we
        // can't encrypt here (e.g. running on a non-secure LAN origin where
        // crypto.subtle is unavailable), leave the stored value untouched and
        // expose it as-is so the app keeps working.
        try {
          const enc = await this._encryptSecret(raw);
          localStorage.setItem(rawKey, enc);
          this._secrets[name] = raw;
        } catch (_) {
          this._secrets[name] = raw;
        }
        continue;
      }
      const plain = await this._decryptSecret(raw);
      if (plain !== null) {
        this._secrets[name] = plain;
      } else {
        // Decrypt failed (origin/port moved or key changed). Surface a warning,
        // leave the ciphertext in place, and treat as unset so the user re-enters.
        this._secrets[name] = '';
        this._secretWarn[name] = true;
      }
    }
    await this._unlockProviderKeys();
  },

  // Per-provider API keys (one slot per named provider). Stored as a single
  // JSON object mapping provider id -> ciphertext; decrypted into the same
  // _secrets.providerKeys shape on unlock.
  async _unlockProviderKeys() {
    const rawKey = this.PREFIX + this._keys.providerApiKeys;
    const raw = localStorage.getItem(rawKey);
    this._secrets.providerKeys = {};
    if (!raw) return;
    let map;
    try { map = JSON.parse(raw); } catch (_) { localStorage.removeItem(rawKey); return; }
    if (!map || typeof map !== 'object') return;
    for (const provider of Object.keys(map)) {
      const stored = map[provider];
      if (typeof stored !== 'string' || !stored.startsWith(this._encSecretPrefix)) {
        // Legacy plaintext entry within the map.
        this._secrets.providerKeys[provider] = stored;
        continue;
      }
      const plain = await this._decryptSecret(stored);
      if (plain !== null) this._secrets.providerKeys[provider] = plain;
    }
  },

  async _persistProviderKeys() {
    const map = {};
    for (const provider of Object.keys(this._secrets.providerKeys)) {
      const plain = this._secrets.providerKeys[provider];
      if (!plain) continue;
      try {
        map[provider] = await this._encryptSecret(plain);
      } catch (_) {
        map[provider] = plain; // encryption unavailable — fail open
      }
    }
    const rawKey = this.PREFIX + this._keys.providerApiKeys;
    if (!Object.keys(map).length) { localStorage.removeItem(rawKey); return; }
    try { localStorage.setItem(rawKey, JSON.stringify(map)); } catch (_) {}
  },

  getProviderKey(provider) {
    return this._secrets.providerKeys[provider] || '';
  },

  async setProviderKey(provider, key) {
    const clean = key || '';
    if (clean) this._secrets.providerKeys[provider] = clean;
    else delete this._secrets.providerKeys[provider];
    await this._persistProviderKeys();
  },

  getApiKey() {
    return this._secrets.apiKey;
  },

  async setApiKey(key) {
    const clean = key || '';
    this._secrets.apiKey = clean;
    if (!clean) { localStorage.removeItem(this.PREFIX + this._keys.apiKey); return; }
    try {
      localStorage.setItem(this.PREFIX + this._keys.apiKey, await this._encryptSecret(clean));
    } catch (_) {
      // Encryption unavailable — fail open to keep the editor working.
      try { localStorage.setItem(this.PREFIX + this._keys.apiKey, clean); } catch (_) {}
    }
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

  // ─── Appearance ─────────────────────────────────────

  // Glass density: 'subtle' | 'default' | 'bold'.
  getGlassDensity() {
    return localStorage.getItem(this.PREFIX + this._keys.glassDensity) || 'default';
  },

  setGlassDensity(density) {
    localStorage.setItem(this.PREFIX + this._keys.glassDensity, String(density));
  },

  // Edge vignette overlay (boolean).
  getVignette() {
    const val = localStorage.getItem(this.PREFIX + this._keys.vignette);
    return val === null ? true : val === 'true';
  },

  setVignette(on) {
    localStorage.setItem(this.PREFIX + this._keys.vignette, String(!!on));
  },

  // Card corner radius: 'compact' | 'rounded' | 'pill'.
  getCardRadius() {
    return localStorage.getItem(this.PREFIX + this._keys.cardRadius) || 'compact';
  },

  setCardRadius(radius) {
    localStorage.setItem(this.PREFIX + this._keys.cardRadius, String(radius));
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
    return this._secrets.customApiKey;
  },

  async setCustomApiKey(key) {
    const clean = key || '';
    this._secrets.customApiKey = clean;
    if (!clean) { localStorage.removeItem(this.PREFIX + this._keys.customApiKey); return; }
    try {
      localStorage.setItem(this.PREFIX + this._keys.customApiKey, await this._encryptSecret(clean));
    } catch (_) {
      try { localStorage.setItem(this.PREFIX + this._keys.customApiKey, clean); } catch (_) {}
    }
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
      this._migrationDone = true;
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
        throw new Error((I18n.t ? I18n.t('error.storageFull') : 'Storage full! Try removing some cards or exporting them.'));
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
    try {
      localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        throw new Error((I18n.t ? I18n.t('error.storageFull') : 'Storage full! Try removing some cards or exporting them.'));
      }
      throw e;
    }
  },

  /**
   * Delete a card by ID.
   */
  async deleteCard(id) {
    // Delete the IndexedDB records FIRST, and only drop the localStorage index
    // after they succeed — otherwise a failed IDB delete leaves an orphaned
    // full card + image while the UI already considers the card gone.
    await Promise.all([
      this.deleteImage(id),
      this.DB.delete(this.DB.stores.cards, id),
    ]);
    // Remove the card's chat history + sessions so they don't outlive the card.
    this.clearChatHistory(id);
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
  async getActiveCard() {
    const id = this.getActiveCardId();
    if (!id) return null;
    return this.getCard(id);
  },

  // ─── AI Chat History (per-card) ────────────────────────

  _chatKey(cardId) {
    return this.PREFIX + this._keys.aiChatHistory + '_' + (cardId || 'global');
  },

  _storageFullWarnedAt: 0,
  _notifyStorageFull(e) {
    // Chat-history writes used to fail silently on quota, silently losing the
    // conversation (#34). Surface it like the rest of the codebase — throttled
    // so repeated saves during a long generation don't spam the toast.
    console.error('Chat history write failed:', e);
    const now = Date.now();
    if (now - this._storageFullWarnedAt < 5000) return;
    this._storageFullWarnedAt = now;
    if (window.Ui && typeof window.Ui.showToast === 'function') {
      Ui.showToast(I18n.t ? I18n.t('error.storageFull') : 'Storage full! Try removing some cards or exporting them.', 'danger');
    }
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
    } catch (e) { this._notifyStorageFull(e); }
  },

  clearChatHistory(cardId) {
    if (cardId) {
      localStorage.removeItem(this._chatKey(cardId));
      const sessions = this.getChatSessions(cardId);
      sessions.forEach(s => localStorage.removeItem(this._sessionMsgKey(cardId, s.id)));
      localStorage.removeItem(this._sessionKey(cardId));
    } else {
      localStorage.removeItem(this._chatKey('global'));
      const sessions = this.getChatSessions('global');
      sessions.forEach(s => localStorage.removeItem(this._sessionMsgKey('global', s.id)));
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
    } catch (e) { this._notifyStorageFull(e); }
  },

  deleteChatSession(cardId, sessionId) {
    try {
      const sessions = this.getChatSessions(cardId).filter(s => s.id !== sessionId);
      localStorage.setItem(this._sessionKey(cardId), JSON.stringify(sessions));
      // Also remove the session's messages
      localStorage.removeItem(this._sessionMsgKey(cardId, sessionId));
    } catch { /* silently fail */ }
  },

  // ─── Per-Session Messages ──────────────────────────────

  _sessionMsgKey(cardId, sessionId) {
    return this.PREFIX + 'sessionMsgs_' + (cardId || 'global') + '_' + sessionId;
  },

  getSessionMessages(cardId, sessionId) {
    try {
      const raw = localStorage.getItem(this._sessionMsgKey(cardId, sessionId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  saveSessionMessages(cardId, sessionId, messages) {
    try {
      const trimmed = messages.slice(-this.CHAT_HISTORY_LIMIT);
      localStorage.setItem(this._sessionMsgKey(cardId, sessionId), JSON.stringify(trimmed));
    } catch (e) { this._notifyStorageFull(e); }
  },

  deleteSessionMessages(cardId, sessionId) {
    try {
      localStorage.removeItem(this._sessionMsgKey(cardId, sessionId));
    } catch { /* silently fail */ }
  },

  // ─── Utility ───────────────────────────────────────────

  /**
   * Clear ALL stored data.
   */
  async clearAll() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(this.PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    await Promise.all([
      this.DB.clear(this.DB.stores.cards).catch(() => {}),
      this.DB.clear(this.DB.stores.images).catch(() => {}),
    ]);
    // Reset in-memory state too — the keys above only touch localStorage/IDB,
    // so without this the decrypted API keys survive a "clear all" until reload
    // and get re-persisted on the next setApiKey call.
    this._secrets = { apiKey: '', customApiKey: '', providerKeys: {} };
    this._secretWarn = { apiKey: false, customApiKey: false };
    this._secretUnlocked = false;
    this._migrationDone = false;
  },

  // ─── Image Storage Helpers ─────────────────────────────

  getImage(id) { return this.DB.get(this.DB.stores.images, id); },
  saveImage(id, base64) { return this.DB.set(this.DB.stores.images, id, base64); },
  deleteImage(id) { return this.DB.delete(this.DB.stores.images, id); },

  /**
   * Estimate total storage usage (localStorage + IndexedDB card/image data).
   */
  async getUsageEstimate() {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(this.PREFIX)) {
        const val = localStorage.getItem(key);
        if (val) total += val.length * 2; // rough UTF-16 byte count
      }
    }
    // IndexedDB holds full card JSON and base64 images, which dominate usage.
    try {
      for (const store of Object.values(this.DB.stores)) {
        const records = await this.DB.getAll(store);
        for (const rec of records) {
          if (typeof rec === 'string') {
            total += rec.length * 2;
          } else if (rec && typeof rec === 'object') {
            total += JSON.stringify(rec).length * 2;
          }
        }
      }
    } catch (_) { /* ignore IDB enumeration errors */ }
    return total;
  },
};

export { CardStorage };
if (typeof window !== 'undefined') window.CardStorage = CardStorage;
