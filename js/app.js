(() => {
  // js/tokenizer.js
  var Tokenizer2 = {
    _lib: null,
    _loading: null,
    _lastFail: 0,
    _cdnUrl: "https://esm.sh/gpt-tokenizer@3.0.1",
    async _load() {
      if (this._lib !== null)
        return this._lib;
      if (this._loading)
        return this._loading;
      if (this._lastFail && Date.now() - this._lastFail < 300000)
        return null;
      this._loading = import(this._cdnUrl).then((mod) => {
        const fn = mod.countTokens || mod.default && mod.default.countTokens || (mod.encode ? (t) => mod.encode(t).length : null) || (mod.default && mod.default.encode ? (t) => mod.default.encode(t).length : null);
        return fn ? fn : null;
      }).catch(() => {
        this._lastFail = Date.now();
        this._loading = null;
        return null;
      });
      this._lib = await this._loading;
      return this._lib;
    },
    async count(text) {
      const fn = await this._load();
      if (fn) {
        try {
          const n = fn(text);
          if (typeof n === "number" && isFinite(n))
            return Math.max(0, Math.floor(n));
        } catch (_) {}
      }
      return this._fallback(text);
    },
    quickCount(text) {
      return this._fallback(text);
    },
    _fallback(text) {
      if (typeof text !== "string")
        text = text == null ? "" : String(text);
      if (!text)
        return 0;
      return Math.ceil(text.length / 3);
    }
  };
  if (typeof window !== "undefined")
    window.Tokenizer = Tokenizer2;

  // js/cardEngine.js
  var CardEngine2 = {
    _utf8Decoder: new TextDecoder("utf-8"),
    THUMBNAIL_MAX_SIZE: 128,
    THUMBNAIL_JPEG_QUALITY: 0.8,
    async parseFile(file) {
      const ext = file.name.split(".").pop().toLowerCase();
      if (ext === "json") {
        const text = await file.text();
        return this.parseJSON(text, file.name);
      }
      if (ext === "png") {
        const buffer = await file.arrayBuffer();
        const card = await this.parsePNG(buffer, file.name);
        if (!card._imageBase64) {
          const blob = new Blob([buffer], { type: "image/png" });
          card._imageBase64 = await this._blobToBase64(blob);
        }
        card._hasImage = true;
        card._thumbnail = await this._createThumbnail(card._imageBase64);
        return card;
      }
      if (ext === "webp") {
        const buffer = await file.arrayBuffer();
        const card = this._createEmptyCard(file.name);
        const blob = new Blob([buffer], { type: "image/webp" });
        card._imageBase64 = await this._blobToBase64(blob);
        card._hasImage = true;
        card._thumbnail = await this._createThumbnail(card._imageBase64);
        return card;
      }
      throw new Error(I18n.t ? I18n.t("error.unsupportedFile", { ext }) : "Unsupported file type: ." + ext);
    },
    _uniqueId() {
      if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return "card_" + crypto.randomUUID();
      }
      return "card_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    },
    parseJSON(jsonStr, filename) {
      filename = filename || "untitled.json";
      let raw;
      try {
        raw = JSON.parse(jsonStr);
      } catch (e) {
        throw new Error(I18n.t ? I18n.t("error.invalidJson", { message: e.message || "parse error" }) : "Invalid JSON: " + (e.message || "parse error"));
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(I18n.t ? I18n.t("error.unknownFormat") : "Unknown card format — not a SillyTavern character card");
      }
      return this.normalize(raw, filename);
    },
    async parsePNG(buffer, filename) {
      filename = filename || "untitled.png";
      const bytes = new Uint8Array(buffer);
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      for (let i = 0;i < 8; i++) {
        if (bytes[i] !== sig[i])
          throw new Error(I18n.t ? I18n.t("error.notPng") : "Not a valid PNG file");
      }
      let offset = 8;
      let charaRaw = null;
      let ccv3Raw = null;
      let cardChunkUnreadable = false;
      while (offset + 12 <= bytes.length) {
        const len = this._readUint32(bytes, offset);
        offset += 4;
        const type = this._utf8Decoder.decode(bytes.slice(offset, offset + 4));
        offset += 4;
        if (type === "tEXt") {
          const chunkData = bytes.slice(offset, offset + len);
          const nullIdx = chunkData.indexOf(0);
          if (nullIdx >= 0) {
            const keyword = this._utf8Decoder.decode(chunkData.slice(0, nullIdx)).toLowerCase();
            if (keyword === "chara") {
              charaRaw = chunkData.slice(nullIdx + 1);
            } else if (keyword === "ccv3") {
              ccv3Raw = chunkData.slice(nullIdx + 1);
            }
          }
        } else if (type === "iTXt" || type === "zTXt") {
          const chunkData = bytes.slice(offset, offset + len);
          const nullIdx = chunkData.indexOf(0);
          if (nullIdx >= 0) {
            const keyword = this._utf8Decoder.decode(chunkData.slice(0, nullIdx)).toLowerCase();
            let valueBytes = null;
            if (type === "iTXt") {
              let p = nullIdx + 1;
              const compressionFlag = chunkData[p];
              p += 1;
              p += 1;
              const langEnd = chunkData.indexOf(0, p);
              if (langEnd < 0) {
                offset += len + 4;
                continue;
              }
              p = langEnd + 1;
              const transEnd = chunkData.indexOf(0, p);
              if (transEnd < 0) {
                offset += len + 4;
                continue;
              }
              p = transEnd + 1;
              valueBytes = chunkData.slice(p);
              if (compressionFlag === 1)
                valueBytes = await this._inflate(valueBytes);
            } else {
              const p = nullIdx + 2;
              valueBytes = await this._inflate(chunkData.slice(p));
            }
            if (valueBytes) {
              if (keyword === "chara")
                charaRaw = valueBytes;
              else if (keyword === "ccv3")
                ccv3Raw = valueBytes;
            } else if (keyword === "chara" || keyword === "ccv3") {
              cardChunkUnreadable = true;
            }
          }
        } else if (type === "IEND") {
          break;
        }
        offset += len + 4;
      }
      const rawBytes = charaRaw || ccv3Raw;
      if (rawBytes) {
        const rawStr = this._utf8Decoder.decode(rawBytes);
        const jsonStr = this._decodeCharaValue(rawStr);
        return this.parseJSON(jsonStr, filename);
      }
      if (cardChunkUnreadable) {
        throw new Error(I18n.t ? I18n.t("error.pngInflateFailed") : "This PNG contains character data that could not be decompressed.");
      }
      return this._createEmptyCard(filename);
    },
    async _inflate(bytes) {
      let writer = null;
      try {
        if (typeof DecompressionStream === "undefined")
          return null;
        const ds = new DecompressionStream("zlib");
        writer = ds.writable.getWriter();
        await writer.write(bytes);
        await writer.close();
        const ab = await new Response(ds.readable).arrayBuffer();
        return new Uint8Array(ab);
      } catch (e) {
        console.error("zlib inflate failed", e);
        return null;
      } finally {
        if (writer && typeof writer.releaseLock === "function") {
          try {
            writer.releaseLock();
          } catch (_) {}
        }
      }
    },
    normalize(raw, filename) {
      const card = {
        _id: "",
        _filename: filename,
        _hasImage: false,
        _imageBase64: null
      };
      let source;
      if (raw.spec === "chara_card_v2" || raw.spec === "chara_card_v3") {
        card.spec = raw.spec;
        card.spec_version = raw.spec_version || (raw.spec === "chara_card_v3" ? "3.0" : "2.0");
        source = raw.data || {};
      } else if (raw.name !== undefined && !raw.spec) {
        card.spec = "chara_card_v2";
        card.spec_version = "2.0";
        source = raw;
      } else {
        throw new Error(I18n.t ? I18n.t("error.unknownFormat") : "Unknown card format — not a SillyTavern character card");
      }
      const fields = [
        "name",
        "description",
        "personality",
        "scenario",
        "first_mes",
        "mes_example",
        "creator_notes",
        "system_prompt",
        "post_history_instructions",
        "creator",
        "character_version"
      ];
      for (const f of fields)
        card[f] = source[f] || "";
      card.alternate_greetings = Array.isArray(source.alternate_greetings) ? [...source.alternate_greetings] : [];
      card.tags = Array.isArray(source.tags) ? [...source.tags] : [];
      card.character_book = source.character_book ? JSON.parse(JSON.stringify(source.character_book)) : { entries: [] };
      card.extensions = source.extensions ? JSON.parse(JSON.stringify(source.extensions)) : {};
      if (!card.character_book || !Array.isArray(card.character_book.entries)) {
        card.character_book = { entries: [] };
      } else {
        card.character_book.entries = card.character_book.entries.map((e) => {
          if (!e || typeof e !== "object") {
            return { key: "", keysecondary: [], content: "", order: 100, constant: false, selective: false, position: "after_char", comment: "" };
          }
          if (e.keys != null && e.key == null)
            e.key = e.keys;
          if (e.secondary_keys != null && e.keysecondary == null)
            e.keysecondary = e.secondary_keys;
          if (e.insertion_order != null && e.order == null)
            e.order = e.insertion_order;
          if (e.enabled != null && e.disable == null)
            e.disable = !e.enabled;
          if (!Array.isArray(e.keysecondary)) {
            e.keysecondary = e.keysecondary == null ? [] : String(e.keysecondary).split(",").map((s) => s.trim()).filter(Boolean);
          }
          if (e.key != null && !Array.isArray(e.key) && typeof e.key !== "string") {
            e.key = String(e.key);
          }
          return e;
        });
      }
      card._id = this._uniqueId();
      card._createdAt = Date.now();
      card._fileSize = JSON.stringify(card).length;
      return card;
    },
    createEmptyCard(name) {
      name = name || (I18n.t ? I18n.t("gen.newCharacter") : "New Character");
      const card = {
        _id: this._uniqueId(),
        _filename: name + ".json",
        _hasImage: false,
        _imageBase64: null,
        _createdAt: Date.now(),
        _fileSize: 0,
        spec: "chara_card_v2",
        spec_version: "2.0",
        name,
        description: "",
        personality: "",
        scenario: "",
        first_mes: "",
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: [],
        tags: [],
        creator: "",
        character_version: "1.0",
        character_book: { entries: [] },
        extensions: {}
      };
      card._fileSize = JSON.stringify(card).length;
      return card;
    },
    toJSON(card) {
      return JSON.stringify({
        spec: card.spec || "chara_card_v2",
        spec_version: card.spec_version || "2.0",
        data: {
          name: card.name || "",
          description: card.description || "",
          personality: card.personality || "",
          scenario: card.scenario || "",
          first_mes: card.first_mes || "",
          mes_example: card.mes_example || "",
          creator_notes: card.creator_notes || "",
          system_prompt: card.system_prompt || "",
          post_history_instructions: card.post_history_instructions || "",
          alternate_greetings: card.alternate_greetings || [],
          tags: card.tags || [],
          creator: card.creator || "",
          character_version: card.character_version || "",
          character_book: card.character_book || { entries: [] },
          extensions: card.extensions || {}
        }
      }, null, 2);
    },
    getTextContent(card, field) {
      if (field && card[field] !== undefined)
        return card[field] || "";
      const fields = [
        ["Name", card.name],
        ["Description", card.description],
        ["Personality", card.personality],
        ["Scenario", card.scenario],
        ["First Message", card.first_mes],
        ["Example Messages", card.mes_example],
        ["System Prompt", card.system_prompt],
        ["Post-History Instructions", card.post_history_instructions]
      ];
      return fields.filter(([_, v]) => v && v.trim()).map(([label, value]) => `[${label}]
${value}`).join(`

`);
    },
    _decodeCharaValue(rawValue) {
      try {
        JSON.parse(rawValue);
        return rawValue;
      } catch (_) {}
      try {
        const binStr = atob(rawValue);
        const bytes = Uint8Array.from(binStr, (c) => c.charCodeAt(0));
        const decoded = this._utf8Decoder.decode(bytes);
        JSON.parse(decoded);
        return decoded;
      } catch (_) {}
      return rawValue;
    },
    _readUint32(bytes, offset) {
      if (offset + 4 > bytes.length)
        return 0;
      return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
    },
    _createEmptyCard(filename) {
      return this.normalize({ name: filename.replace(/\.[^.]+$/, "") }, filename);
    },
    _blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader;
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    },
    _createThumbnail(base64) {
      return new Promise((resolve) => {
        if (!base64)
          return resolve(null);
        const img = new Image;
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            const MAX = this.THUMBNAIL_MAX_SIZE;
            let { width: w, height: h } = img;
            if (w > h) {
              if (w > MAX) {
                h = Math.round(h * MAX / w);
                w = MAX;
              }
            } else {
              if (h > MAX) {
                w = Math.round(w * MAX / h);
                h = MAX;
              }
            }
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(img, 0, 0, w, h);
            img.removeAttribute("src");
            img.onload = null;
            img.onerror = null;
            resolve(canvas.toDataURL("image/jpeg", this.THUMBNAIL_JPEG_QUALITY));
          } catch (_) {
            img.removeAttribute("src");
            img.onload = null;
            img.onerror = null;
            resolve(null);
          }
        };
        img.onerror = () => {
          img.removeAttribute("src");
          img.onload = null;
          img.onerror = null;
          resolve(null);
        };
        img.src = base64;
      });
    }
  };
  if (typeof window !== "undefined")
    window.CardEngine = CardEngine2;

  // js/animations.js
  var Anims2 = {
    get _reducedMotion() {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    },
    _disabled() {
      return this._reducedMotion || typeof anime === "undefined";
    },
    staggerFadeIn(selector, opts) {
      if (this._disabled())
        return;
      let els = typeof selector === "string" ? document.querySelectorAll(selector) : selector;
      if (els && typeof els.length !== "number")
        els = [els];
      if (!els || !els.length)
        return;
      anime({
        targets: els,
        opacity: [0, 1],
        translateY: [opts?.from || 8, 0],
        duration: opts?.duration || 250,
        delay: anime.stagger(opts?.stagger || 30),
        easing: opts?.easing || "easeOutCubic"
      });
    },
    _slideToken: 0,
    _activeTimeline: null,
    slideStep(outEl, inEl, direction, onDone) {
      if (this._activeTimeline) {
        this._activeTimeline.pause();
        this._activeTimeline = null;
      }
      if (this._pendingOutEl && this._pendingOutEl !== inEl && !this._pendingOutEl.classList.contains("d-none")) {
        this._pendingOutEl.classList.add("d-none");
        this._pendingOutEl.style.opacity = "";
        this._pendingOutEl.style.transform = "";
      }
      this._pendingOutEl = outEl;
      const token = ++this._slideToken;
      if (outEl) {
        outEl.style.opacity = "";
        outEl.style.transform = "";
      }
      if (inEl) {
        inEl.style.opacity = "";
        inEl.style.transform = "";
      }
      if (this._disabled()) {
        if (outEl)
          outEl.classList.add("d-none");
        if (inEl)
          inEl.classList.remove("d-none");
        this._pendingOutEl = null;
        if (onDone)
          onDone();
        return;
      }
      const xOut = direction === "next" ? -20 : 20;
      const xIn = direction === "next" ? 20 : -20;
      const tl = anime.timeline({ easing: "easeOutCubic" });
      this._activeTimeline = tl;
      const finish = () => {
        if (token !== this._slideToken)
          return;
        if (this._activeTimeline === tl)
          this._activeTimeline = null;
        if (onDone)
          onDone();
      };
      if (outEl) {
        tl.add({ targets: outEl, opacity: [1, 0], translateX: [0, xOut], duration: 180, complete: () => {
          if (token === this._slideToken)
            outEl.classList.add("d-none");
          if (!inEl) {
            finish();
          }
        } });
      }
      if (inEl) {
        inEl.classList.remove("d-none");
        inEl.style.opacity = "0";
        tl.add({ targets: inEl, opacity: [0, 1], translateX: [xIn, 0], duration: 220, complete: () => {
          if (inEl)
            inEl.style.opacity = "";
          if (this._pendingOutEl === outEl)
            this._pendingOutEl = null;
          finish();
        } }, outEl ? "-=60" : 0);
      } else if (!outEl) {
        finish();
      }
    },
    pulseIcon(el) {
      if (this._disabled() || !el)
        return;
      anime({ targets: el, scale: [1, 1.25, 1], duration: 300, easing: "easeOutCubic" });
    },
    shakeElement(el) {
      if (this._disabled() || !el)
        return;
      anime({ targets: el, translateX: [0, -6, 6, -4, 4, -2, 2, 0], duration: 400, easing: "easeOutCubic" });
    },
    scaleClick(el) {
      if (this._disabled() || !el)
        return;
      anime({ targets: el, scale: [1, 0.96, 1], duration: 150, easing: "easeOutCubic" });
    },
    progressBounce(el) {
      if (this._disabled() || !el)
        return;
      anime({ targets: el, scale: [1, 1.08, 1], duration: 350, easing: "easeOutElastic(1, .6)" });
    },
    chevronRotate(el, isOpen) {
      if (this._disabled() || !el)
        return;
      anime({ targets: el, rotateZ: isOpen ? 180 : 0, duration: 250, easing: "easeOutCubic" });
    },
    iconSpin(el) {
      if (this._disabled() || !el)
        return;
      anime({ targets: el, rotateZ: 360, duration: 400, easing: "easeOutCubic" });
    },
    skeletonReveal(selector) {
      if (this._disabled())
        return;
      let els = typeof selector === "string" ? document.querySelectorAll(selector) : selector;
      if (els && typeof els.length !== "number")
        els = [els];
      if (!els || !els.length)
        return;
      anime({
        targets: els,
        opacity: [0, 1],
        translateY: [6, 0],
        duration: 200,
        delay: anime.stagger(50),
        easing: "easeOutCubic"
      });
    },
    toastEnter(el) {
      if (this._disabled() || !el)
        return;
      anime({ targets: el, translateX: [40, 0], opacity: [0, 1], duration: 250, easing: "easeOutCubic" });
    }
  };
  if (typeof window !== "undefined")
    window.Anims = Anims2;

  // js/aiService.js
  var AIService2 = {
    DEFAULT_TEMPERATURE: 0.7,
    DEFAULT_MAX_TOKENS: 16384,
    PROVIDERS: {
      openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", requiresKey: true },
      nanogpt: { name: "NanoGPT", baseUrl: "https://api.nano-gpt.com/api/v1", requiresKey: true },
      xai: { name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", requiresKey: true },
      zai: { name: "Z.AI (GLM)", baseUrl: "https://api.z.ai/api/paas/v4", requiresKey: true },
      chutes: { name: "Chutes", baseUrl: "https://llm.chutes.ai/v1", requiresKey: true },
      deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", requiresKey: true },
      custom: { name: "Custom", baseUrl: "", requiresKey: false }
    },
    FREE_MODEL_PATTERNS: [":free", "openrouter/free"],
    _provider: "openrouter",
    _apiKey: "",
    _customApiUrl: "",
    getProviderInfo(id) {
      return this.PROVIDERS[id] || this.PROVIDERS.custom;
    },
    setProvider(provider, customKey) {
      this._provider = provider || "openrouter";
      this._apiKey = customKey || "";
      this._customApiUrl = "";
    },
    _getBaseUrl() {
      const info = this.getProviderInfo(this._provider);
      if (this._provider === "custom") {
        return (this._customApiUrl || CardStorage.getCustomApiUrl() || "").replace(/\/+$/, "");
      }
      return info.baseUrl;
    },
    _getApiKeyForProvider() {
      if (this._apiKey)
        return this._apiKey;
      if (this._provider === "openrouter")
        return CardStorage.getApiKey();
      if (this._provider === "custom")
        return CardStorage.getCustomApiKey();
      return CardStorage.getProviderKey(this._provider);
    },
    _resolveModel(model) {
      return model || CardStorage.getCustomModelId() || "";
    },
    async setApiKey(key) {
      this._apiKey = key;
      if (this._provider === "openrouter")
        await CardStorage.setApiKey(key);
      else if (this._provider === "custom")
        await CardStorage.setCustomApiKey(key);
      else
        await CardStorage.setProviderKey(this._provider, key);
    },
    getApiKey() {
      return this._getApiKeyForProvider();
    },
    hasApiKey() {
      const info = this.getProviderInfo(this._provider);
      if (!info.requiresKey)
        return true;
      return !!this._getApiKeyForProvider();
    },
    _isFreeModelId(modelId, pricing) {
      const pPrompt = pricing?.prompt;
      const pCompletion = pricing?.completion;
      if (parseFloat(pPrompt) === 0 && parseFloat(pCompletion) === 0)
        return true;
      if (modelId && this.FREE_MODEL_PATTERNS.some((p) => modelId.includes(p)))
        return true;
      return false;
    },
    _parsePrice(val) {
      if (val === null || val === undefined)
        return null;
      const num = typeof val === "string" ? parseFloat(val) : val;
      if (isNaN(num))
        return null;
      return num * 1e6;
    },
    async fetchModels() {
      if (this._provider === "custom") {
        return this._fetchCustomModels();
      }
      if (!this._getApiKeyForProvider())
        throw new Error(I18n.t("error.apiKeyNotSet"));
      const resp = await fetch(`${this._getBaseUrl()}/models`, {
        headers: {
          Authorization: `Bearer ${this._getApiKeyForProvider()}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(30000)
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const models = (data.data || []).map((m) => {
        const pricing = m.pricing || {};
        const promptPrice = this._parsePrice(pricing.prompt);
        const completionPrice = this._parsePrice(pricing.completion);
        return {
          id: m.id,
          name: m.name || m.id,
          description: m.description || "",
          context_length: m.context_length || 0,
          max_output_tokens: m.top_provider?.max_completion_tokens || m.max_completion_tokens || 0,
          pricing: {
            prompt: promptPrice,
            completion: completionPrice
          },
          is_free: this._isFreeModelId(m.id, pricing),
          provider: (m.id || "").split("/")[0]
        };
      }).sort((a, b) => {
        if (a.is_free !== b.is_free)
          return a.is_free ? -1 : 1;
        const aPrice = (a.pricing.prompt || 0) + (a.pricing.completion || 0);
        const bPrice = (b.pricing.prompt || 0) + (b.pricing.completion || 0);
        return aPrice - bPrice;
      });
      return models;
    },
    async _fetchCustomModels() {
      const baseUrl = this._getBaseUrl();
      if (!baseUrl)
        throw new Error(I18n.t ? I18n.t("error.customUrlNotSet") : "Custom API base URL is not set");
      const apiBaseUrl = this._v1BaseUrl(baseUrl);
      const headers = { "Content-Type": "application/json" };
      const apiKey = this._getApiKeyForProvider();
      if (apiKey)
        headers["Authorization"] = "Bearer " + apiKey;
      let resp;
      try {
        resp = await fetch(apiBaseUrl + "/models", {
          headers,
          signal: AbortSignal.timeout(15000)
        });
      } catch (err) {
        throw new Error(I18n.t ? I18n.t("error.customUnreachable", { url: apiBaseUrl }) : "Cannot reach " + apiBaseUrl + ". Check the URL and that the server is running.");
      }
      if (resp.status === 404) {
        const alternateUrl = apiBaseUrl.slice(0, -3) + "/models";
        try {
          resp = await fetch(alternateUrl, {
            headers,
            signal: AbortSignal.timeout(15000)
          });
        } catch (err) {
          throw new Error(I18n.t ? I18n.t("error.customUnreachable", { url: alternateUrl }) : "Cannot reach " + alternateUrl + ".");
        }
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err.error?.message)
          throw new Error(err.error.message);
        if (resp.status === 401 || resp.status === 403) {
          throw new Error(I18n.t ? I18n.t("error.customAuthFailed", { status: resp.status }) : "Authentication failed (HTTP " + resp.status + "). Check the API key for this endpoint.");
        }
        if (resp.status === 404) {
          throw new Error(I18n.t ? I18n.t("error.customPathNotFound") : "Endpoint not found (HTTP 404). Check that the API Base URL includes /v1.");
        }
        throw new Error(I18n.t ? I18n.t("error.fetchModelsFailed", { status: resp.status }) : "Failed to fetch models (HTTP " + resp.status + ")");
      }
      const data = await resp.json().catch(() => ({}));
      if (data.error) {
        const msg = (typeof data.error === "string" ? data.error : data.error.message) || "";
        throw new Error(I18n.t ? I18n.t("error.customServerError", { detail: msg }) : "The server returned an error: " + msg);
      }
      const customModelId = CardStorage.getCustomModelId();
      const returnedModels = Array.isArray(data.data) ? data.data : [];
      if (returnedModels.length) {
        return returnedModels.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          description: m.description || "",
          context_length: m.context_length || m.max_context_length || 0,
          max_output_tokens: m.max_output_tokens || m.max_tokens || 0,
          pricing: { prompt: null, completion: null },
          is_free: true,
          provider: "custom"
        }));
      }
      if (customModelId) {
        return [{ id: customModelId, name: customModelId, description: I18n.t ? I18n.t("settings.customModelDesc") : "Custom model", context_length: 0, max_output_tokens: 0, pricing: { prompt: null, completion: null }, is_free: true, provider: "custom" }];
      }
      return [];
    },
    async fetchKeyInfo() {
      if (this._provider !== "openrouter")
        throw new Error(I18n.t ? I18n.t("gen.notAvailable") : "N/A");
      if (!this._getApiKeyForProvider())
        throw new Error(I18n.t("error.apiKeyNotSet"));
      const resp = await fetch(`${this._getBaseUrl()}/key`, {
        headers: {
          Authorization: `Bearer ${this._getApiKeyForProvider()}`,
          "Content-Type": "application/json"
        },
        signal: this._withTimeout(null)
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const key = data.data || {};
      return {
        label: key.label || "Unknown",
        limit: key.limit ?? null,
        limit_remaining: key.limit_remaining ?? null,
        usage: key.usage || 0,
        is_free_tier: key.is_free_tier || false
      };
    },
    _buildRequestBody(model, messages, { jsonMode = false, stream = false } = {}) {
      const body = {
        model,
        messages,
        temperature: this.DEFAULT_TEMPERATURE,
        stream
      };
      const userMax = CardStorage.getMaxTokens();
      if (userMax > 0)
        body.max_tokens = userMax;
      if (jsonMode)
        body.response_format = { type: "json_object" };
      if (stream)
        body.stream_options = { include_usage: true };
      return body;
    },
    _extractApiError(err, status) {
      if (err && typeof err === "object") {
        const e = err.error;
        if (typeof e === "string")
          return e;
        if (e && typeof e === "object" && e.message)
          return e.message;
      }
      return `HTTP ${status}`;
    },
    _isUnsupportedFormatError(errMsg) {
      if (!errMsg)
        return false;
      const lower = errMsg.toLowerCase();
      if (!lower.includes("response_format"))
        return false;
      return lower.includes("unsupported") || lower.includes("not support") || lower.includes("invalid") || lower.includes("not allowed") || lower.includes("does not support") || lower.includes("must be") || lower.includes("only supports");
    },
    _buildMessages(systemPrompt, prompt, history = []) {
      const messages = [];
      if (systemPrompt)
        messages.push({ role: "system", content: systemPrompt });
      for (const msg of history) {
        if (msg.role === "user" || msg.role === "assistant") {
          messages.push({ role: msg.role, content: msg.content || "" });
        }
      }
      messages.push({ role: "user", content: prompt });
      return messages;
    },
    _v1BaseUrl(baseUrl) {
      return baseUrl.endsWith("/v1") ? baseUrl : baseUrl + "/v1";
    },
    _withTimeout(signal) {
      const timeout = AbortSignal.timeout(120000);
      if (!signal)
        return timeout;
      if (typeof AbortSignal.any === "function")
        return AbortSignal.any([signal, timeout]);
      return signal;
    },
    _getChatBaseUrl() {
      const baseUrl = this._getBaseUrl();
      if (this._provider === "custom")
        return this._v1BaseUrl(baseUrl);
      return baseUrl;
    },
    async chat(prompt, systemPrompt = "", model = "", opts = {}) {
      const safeOpts = typeof opts === "object" && opts !== null ? opts : {};
      const { jsonMode = false, signal, history = [] } = safeOpts;
      const apiKey = this._getApiKeyForProvider();
      const info = this.getProviderInfo(this._provider);
      if (!apiKey && info.requiresKey)
        throw new Error(I18n.t("error.apiKeyNotSet"));
      const messages = this._buildMessages(systemPrompt, prompt, history);
      const useModel = this._resolveModel(model);
      if (!useModel)
        throw new Error(I18n.t("error.noModel"));
      const baseUrl = this._getBaseUrl();
      if (!baseUrl)
        throw new Error(I18n.t ? I18n.t("error.customUrlNotSet") : "Custom API base URL is not set");
      const apiBaseUrl = this._getChatBaseUrl();
      const headers = { "Content-Type": "application/json" };
      if (apiKey)
        headers["Authorization"] = "Bearer " + apiKey;
      if (this._provider === "openrouter") {
        headers["HTTP-Referer"] = "https://github.com/st-card-editor";
        headers["X-Title"] = "ST Card Editor";
      }
      const fetchChat = async (useJsonMode) => {
        const resp = await fetch(`${apiBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(this._buildRequestBody(useModel, messages, { jsonMode: useJsonMode, stream: false })),
          signal: this._withTimeout(signal)
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          if (resp.status === 402)
            throw new Error(I18n.t("error.insufficientCredits"));
          throw new Error(this._extractApiError(err, resp.status));
        }
        return resp.json();
      };
      let data;
      try {
        data = await fetchChat(jsonMode);
      } catch (e) {
        if (jsonMode && this._isUnsupportedFormatError(e.message)) {
          data = await fetchChat(false);
        } else {
          throw e;
        }
      }
      const choice = data.choices?.[0];
      if (!choice)
        throw new Error(I18n.t ? I18n.t("error.noChoices") : "API returned no response choices");
      return {
        content: choice?.message?.content || "",
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0,
          total_tokens: data.usage.total_tokens || 0,
          cost: data.usage.cost || 0
        } : null,
        model: data.model || useModel
      };
    },
    formatPrice(perMillion) {
      if (perMillion === null || perMillion === undefined)
        return "—";
      const n = Number(perMillion);
      if (!isFinite(n))
        return "—";
      if (n === 0)
        return I18n.t ? I18n.t("gen.free") : "Free";
      if (n < 0.001)
        return `$${n.toFixed(6)}/M`;
      return `$${n.toFixed(3)}/M`;
    },
    async chatStream(prompt, systemPrompt = "", model = "", onChunk, signal, jsonMode = false, history = []) {
      const apiKey = this._getApiKeyForProvider();
      const info = this.getProviderInfo(this._provider);
      if (!apiKey && info.requiresKey)
        throw new Error(I18n.t("error.apiKeyNotSet"));
      const messages = this._buildMessages(systemPrompt, prompt, history);
      const useModel = this._resolveModel(model);
      if (!useModel)
        throw new Error(I18n.t("error.noModelSimple"));
      const baseUrl = this._getBaseUrl();
      if (!baseUrl)
        throw new Error(I18n.t ? I18n.t("error.customUrlNotSet") : "Custom API base URL is not set");
      const apiBaseUrl = this._getChatBaseUrl();
      const headers = { "Content-Type": "application/json" };
      if (apiKey)
        headers["Authorization"] = "Bearer " + apiKey;
      if (this._provider === "openrouter") {
        headers["HTTP-Referer"] = "https://github.com/st-card-editor";
        headers["X-Title"] = "ST Card Editor";
      }
      const doStream = async (useJsonMode) => {
        const resp2 = await fetch(`${apiBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(this._buildRequestBody(useModel, messages, { jsonMode: useJsonMode, stream: true })),
          signal: this._withTimeout(signal)
        });
        if (!resp2.ok) {
          const err = await resp2.json().catch(() => ({}));
          if (resp2.status === 402)
            throw new Error(I18n.t("error.insufficientCredits"));
          throw new Error(this._extractApiError(err, resp2.status));
        }
        return resp2;
      };
      let resp;
      try {
        resp = await doStream(jsonMode);
      } catch (e) {
        if (jsonMode && this._isUnsupportedFormatError(e.message)) {
          resp = await doStream(false);
        } else {
          throw e;
        }
      }
      if (!resp.body)
        throw new Error(I18n.t ? I18n.t("error.emptyResponse") : "Empty response from API (no body)");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder;
      let full = "";
      let usage = null;
      let eventType = "";
      let streamDone = false;
      try {
        let bufferStr = "";
        while (!streamDone) {
          const { done, value } = await reader.read();
          if (done)
            break;
          bufferStr += decoder.decode(value, { stream: true });
          const lines = bufferStr.split(`
`);
          bufferStr = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
              continue;
            if (trimmed.startsWith("event: ")) {
              eventType = trimmed.slice(7).trim();
              continue;
            }
            if (trimmed.startsWith(":"))
              continue;
            if (!trimmed.startsWith("data: "))
              continue;
            const data = trimmed.slice(6).trim();
            if (data === "[DONE]") {
              eventType = "";
              streamDone = true;
              break;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                full += delta;
                onChunk(full, delta);
              }
              if (parsed.usage)
                usage = parsed.usage;
              if (eventType === "error") {
                const msg = parsed.error?.message || parsed.detail || data;
                throw new Error(msg);
              }
            } catch (e) {
              if (e instanceof SyntaxError) {
                console.warn("aiService: dropped unparseable SSE chunk:", data);
              } else {
                throw e;
              }
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
      return {
        content: full,
        usage: usage ? {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
          cost: usage.cost || 0
        } : null,
        model: useModel
      };
    },
    async resolveMaxTokens(modelId, messages = []) {
      const ctxLength = this._getContextLength(modelId);
      let inputTokens = 0;
      try {
        if (window.Tokenizer && typeof window.Tokenizer.count === "function") {
          const counts = await Promise.all((messages || []).map((m) => window.Tokenizer.count(m.content || "")));
          inputTokens = counts.reduce((sum, n) => sum + (n || 0), 0);
        }
      } catch (_) {
        inputTokens = 0;
      }
      if (!inputTokens && messages?.length) {
        inputTokens = (messages || []).reduce((sum, m) => {
          const quick = window.Tokenizer && typeof window.Tokenizer.quickCount === "function" ? window.Tokenizer.quickCount(m.content || "") : Math.ceil((m.content || "").length / 3);
          return sum + quick;
        }, 0);
      }
      const safetyMargin = Math.max(512, Math.floor(ctxLength * 0.05));
      const available = Math.max(512, ctxLength - inputTokens - safetyMargin);
      let maxTokens = this.DEFAULT_MAX_TOKENS;
      if (modelId && window.AppState.models) {
        const m = window.AppState.models.find((x) => x.id === modelId);
        if (m && m.max_output_tokens > 0)
          maxTokens = m.max_output_tokens;
      }
      return Math.min(maxTokens, available);
    },
    getContextLength(modelId) {
      return this._getContextLength(modelId);
    },
    _getContextLength(modelId) {
      if (modelId && window.AppState.models) {
        const m = window.AppState.models.find((x) => x.id === modelId);
        if (m && m.context_length > 0)
          return m.context_length;
      }
      return 128000;
    }
  };
  if (typeof window !== "undefined")
    window.AIService = AIService2;

  // js/storage.js
  var CardStorage2 = {
    PREFIX: "stce_",
    CHAT_HISTORY_LIMIT: 100,
    DB: {
      dbName: "stce_data",
      version: 1,
      stores: { cards: "cards", images: "images" },
      _db: null,
      _dbPromise: null,
      async init() {
        if (this._db)
          return this._db;
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
              this._db.onclose = () => {
                this._db = null;
                this._dbPromise = null;
              };
              resolve(this._db);
            };
            req.onerror = () => {
              this._dbPromise = null;
              reject(req.error);
            };
          });
        }
        return this._dbPromise;
      },
      async get(store, id) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
          const req = db.transaction(store, "readonly").objectStore(store).get(id);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      },
      async set(store, id, data) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
          const req = db.transaction(store, "readwrite").objectStore(store).put(data, id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error && req.error.name === "QuotaExceededError" ? new Error(I18n.t ? I18n.t("error.storageFull") : "Storage full! Try removing some cards or exporting them.") : req.error);
        });
      },
      async delete(store, id) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
          const req = db.transaction(store, "readwrite").objectStore(store).delete(id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      },
      async clear(store) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
          const req = db.transaction(store, "readwrite").objectStore(store).clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      },
      async getAll(store) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
          const req = db.transaction(store, "readonly").objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      }
    },
    _keys: {
      apiKey: "apiKey",
      defaultModel: "defaultModel",
      cardIndex: "cardIndex",
      activeCardId: "activeCardId",
      aiChatHistory: "aiChatHistory",
      maxTokens: "maxTokens",
      injectCopyright: "injectCopyright",
      provider: "provider",
      customApiUrl: "customApiUrl",
      customApiKey: "customApiKey",
      customModelId: "customModelId",
      providerApiKeys: "providerApiKeys",
      darkAccent: "darkAccent",
      lightAccent: "lightAccent",
      glassDensity: "glassDensity",
      vignette: "vignette",
      cardRadius: "cardRadius",
      promptAssistant: "promptAssistant",
      promptFullCard: "promptFullCard",
      promptWizard: "promptWizard",
      promptEnhance: "promptEnhance",
      promptPersonality: "promptPersonality",
      promptFirstmes: "promptFirstmes",
      promptScenario: "promptScenario",
      promptShorten: "promptShorten",
      promptTone: "promptTone",
      promptGrammar: "promptGrammar",
      promptGreetings: "promptGreetings",
      promptSystemprompt: "promptSystemprompt",
      promptTranslate: "promptTranslate",
      promptTags: "promptTags",
      promptTagsSystem: "promptTagsSystem",
      promptFullCardInstr: "promptFullCardInstr",
      promptFieldsEdit: "promptFieldsEdit",
      promptGreetingsSystem: "promptGreetingsSystem"
    },
    getAccent(theme) {
      const key = theme === "light" ? this._keys.lightAccent : this._keys.darkAccent;
      return localStorage.getItem(this.PREFIX + key) || "";
    },
    setAccent(theme, color) {
      const key = theme === "light" ? this._keys.lightAccent : this._keys.darkAccent;
      if (color)
        localStorage.setItem(this.PREFIX + key, color);
      else
        localStorage.removeItem(this.PREFIX + key);
    },
    getPrompt(name) {
      if (!name || typeof name !== "string" || !name.length)
        return "";
      const key = this._keys["prompt" + name[0].toUpperCase() + name.slice(1)];
      if (!key)
        return "";
      return localStorage.getItem(this.PREFIX + key) || "";
    },
    setPrompt(name, value) {
      const key = this._keys["prompt" + name[0].toUpperCase() + name.slice(1)];
      localStorage.setItem(this.PREFIX + key, value || "");
    },
    _secrets: { apiKey: "", customApiKey: "", providerKeys: {} },
    _secretWarn: { apiKey: false, customApiKey: false },
    _secretUnlocked: false,
    _encSecretPrefix: "encv1:",
    _bufToB64(buf) {
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0;i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    },
    _b64ToBuf(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0;i < bin.length; i++)
        bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    },
    async _deriveSecretKey() {
      const enc = new TextEncoder;
      const base = typeof location !== "undefined" && location.origin ? location.origin : "st-card-editor";
      const importKey = await crypto.subtle.importKey("raw", enc.encode("st-card-editor-secret:" + base), "PBKDF2", false, ["deriveKey"]);
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: enc.encode("stce-salt:" + base), iterations: 200000, hash: "SHA-256" }, importKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    },
    async _encryptSecret(plain) {
      const key = await this._deriveSecretKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
      return this._encSecretPrefix + JSON.stringify({
        v: 1,
        iv: this._bufToB64(iv),
        ct: this._bufToB64(ct)
      });
    },
    async _decryptSecret(stored) {
      if (typeof stored !== "string" || !stored.startsWith(this._encSecretPrefix)) {
        return null;
      }
      try {
        const obj = JSON.parse(stored.slice(this._encSecretPrefix.length));
        const key = await this._deriveSecretKey();
        const iv = this._b64ToBuf(obj.iv);
        const ct = this._b64ToBuf(obj.ct);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
        return new TextDecoder().decode(plain);
      } catch (err) {
        return null;
      }
    },
    async _unlockKeys() {
      if (this._secretUnlocked)
        return;
      this._secretUnlocked = true;
      for (const name of ["apiKey", "customApiKey"]) {
        const rawKey = this.PREFIX + this._keys[name];
        const raw = localStorage.getItem(rawKey);
        this._secretWarn[name] = false;
        if (!raw) {
          this._secrets[name] = "";
          continue;
        }
        if (!raw.startsWith(this._encSecretPrefix)) {
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
          this._secrets[name] = "";
          this._secretWarn[name] = true;
        }
      }
      await this._unlockProviderKeys();
    },
    async _unlockProviderKeys() {
      const rawKey = this.PREFIX + this._keys.providerApiKeys;
      const raw = localStorage.getItem(rawKey);
      this._secrets.providerKeys = {};
      if (!raw)
        return;
      let map;
      try {
        map = JSON.parse(raw);
      } catch (_) {
        localStorage.removeItem(rawKey);
        return;
      }
      if (!map || typeof map !== "object")
        return;
      for (const provider of Object.keys(map)) {
        const stored = map[provider];
        if (typeof stored !== "string" || !stored.startsWith(this._encSecretPrefix)) {
          this._secrets.providerKeys[provider] = stored;
          continue;
        }
        const plain = await this._decryptSecret(stored);
        if (plain !== null)
          this._secrets.providerKeys[provider] = plain;
      }
    },
    async _persistProviderKeys() {
      const map = {};
      for (const provider of Object.keys(this._secrets.providerKeys)) {
        const plain = this._secrets.providerKeys[provider];
        if (!plain)
          continue;
        try {
          map[provider] = await this._encryptSecret(plain);
        } catch (_) {
          map[provider] = plain;
        }
      }
      const rawKey = this.PREFIX + this._keys.providerApiKeys;
      if (!Object.keys(map).length) {
        localStorage.removeItem(rawKey);
        return;
      }
      try {
        localStorage.setItem(rawKey, JSON.stringify(map));
      } catch (_) {}
    },
    getProviderKey(provider) {
      return this._secrets.providerKeys[provider] || "";
    },
    async setProviderKey(provider, key) {
      const clean = key || "";
      if (clean)
        this._secrets.providerKeys[provider] = clean;
      else
        delete this._secrets.providerKeys[provider];
      await this._persistProviderKeys();
    },
    getApiKey() {
      return this._secrets.apiKey;
    },
    async setApiKey(key) {
      const clean = key || "";
      this._secrets.apiKey = clean;
      if (!clean) {
        localStorage.removeItem(this.PREFIX + this._keys.apiKey);
        return;
      }
      try {
        localStorage.setItem(this.PREFIX + this._keys.apiKey, await this._encryptSecret(clean));
      } catch (_) {
        try {
          localStorage.setItem(this.PREFIX + this._keys.apiKey, clean);
        } catch (_2) {}
      }
    },
    getDefaultModel() {
      return localStorage.getItem(this.PREFIX + this._keys.defaultModel) || "";
    },
    setDefaultModel(modelId) {
      localStorage.setItem(this.PREFIX + this._keys.defaultModel, modelId);
    },
    getMaxTokens() {
      const val = localStorage.getItem(this.PREFIX + this._keys.maxTokens);
      return val ? parseInt(val, 10) : 0;
    },
    setMaxTokens(tokens) {
      localStorage.setItem(this.PREFIX + this._keys.maxTokens, String(tokens));
    },
    getInjectCopyright() {
      const val = localStorage.getItem(this.PREFIX + this._keys.injectCopyright);
      return val === null ? true : val === "true";
    },
    getGlassDensity() {
      return localStorage.getItem(this.PREFIX + this._keys.glassDensity) || "default";
    },
    setGlassDensity(density) {
      localStorage.setItem(this.PREFIX + this._keys.glassDensity, String(density));
    },
    getVignette() {
      const val = localStorage.getItem(this.PREFIX + this._keys.vignette);
      return val === null ? true : val === "true";
    },
    setVignette(on) {
      localStorage.setItem(this.PREFIX + this._keys.vignette, String(!!on));
    },
    getCardRadius() {
      return localStorage.getItem(this.PREFIX + this._keys.cardRadius) || "compact";
    },
    setCardRadius(radius) {
      localStorage.setItem(this.PREFIX + this._keys.cardRadius, String(radius));
    },
    getProvider() {
      return localStorage.getItem(this.PREFIX + this._keys.provider) || "openrouter";
    },
    setProvider(provider) {
      localStorage.setItem(this.PREFIX + this._keys.provider, provider);
    },
    getCustomApiUrl() {
      return localStorage.getItem(this.PREFIX + this._keys.customApiUrl) || "";
    },
    setCustomApiUrl(url) {
      localStorage.setItem(this.PREFIX + this._keys.customApiUrl, url);
    },
    getCustomApiKey() {
      return this._secrets.customApiKey;
    },
    async setCustomApiKey(key) {
      const clean = key || "";
      this._secrets.customApiKey = clean;
      if (!clean) {
        localStorage.removeItem(this.PREFIX + this._keys.customApiKey);
        return;
      }
      try {
        localStorage.setItem(this.PREFIX + this._keys.customApiKey, await this._encryptSecret(clean));
      } catch (_) {
        try {
          localStorage.setItem(this.PREFIX + this._keys.customApiKey, clean);
        } catch (_2) {}
      }
    },
    getCustomModelId() {
      return localStorage.getItem(this.PREFIX + this._keys.customModelId) || "";
    },
    setCustomModelId(id) {
      localStorage.setItem(this.PREFIX + this._keys.customModelId, id);
    },
    setInjectCopyright(val) {
      localStorage.setItem(this.PREFIX + this._keys.injectCopyright, String(val));
    },
    _migrationDone: false,
    async _checkMigration() {
      if (this._migrationDone)
        return;
      const oldRaw = localStorage.getItem(this.PREFIX + "cards");
      if (!oldRaw) {
        this._migrationDone = true;
        return;
      }
      try {
        const oldCards = JSON.parse(oldRaw);
        if (!Array.isArray(oldCards)) {
          this._migrationDone = true;
          return;
        }
        const index = [];
        for (const card of oldCards) {
          if (!card || !card._id)
            continue;
          await this.DB.set(this.DB.stores.cards, card._id, card);
          index.push(this._extractMeta(card));
        }
        localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
        localStorage.removeItem(this.PREFIX + "cards");
        this._migrationDone = true;
      } catch (e) {
        console.error("Migration failed:", e);
        this._migrationDone = true;
      }
    },
    async migrateCardsToIndexedDB() {
      const keysToMigrate = [];
      for (let i = 0;i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(this.PREFIX + "card_") && key !== this.PREFIX + this._keys.cardIndex) {
          keysToMigrate.push(key);
        }
      }
      if (keysToMigrate.length === 0)
        return;
      for (const key of keysToMigrate) {
        try {
          const raw = localStorage.getItem(key);
          if (!raw)
            continue;
          const card = JSON.parse(raw);
          if (!card || !card._id)
            continue;
          await this.DB.set(this.DB.stores.cards, card._id, card);
          localStorage.removeItem(key);
        } catch (e) {
          console.error("Failed to migrate card to IndexedDB:", key, e);
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
        _fileSize: card._fileSize || 0
      };
    },
    getCards() {
      try {
        const raw = localStorage.getItem(this.PREFIX + this._keys.cardIndex);
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    },
    async getCard(id) {
      try {
        const card = await this.DB.get(this.DB.stores.cards, id);
        if (card)
          return card;
        const raw = localStorage.getItem(this.PREFIX + "card_" + id);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    saveCardIndex(index) {
      try {
        localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
      } catch (e) {
        if (e.name === "QuotaExceededError") {
          throw new Error(I18n.t ? I18n.t("error.storageFull") : "Storage full! Try removing some cards or exporting them.");
        }
        throw e;
      }
    },
    async upsertCard(card) {
      const toSave = { ...card };
      delete toSave._imageBase64;
      await this.DB.set(this.DB.stores.cards, card._id, toSave);
      const index = this.getCards();
      const idx = index.findIndex((c) => c._id === card._id);
      const meta = this._extractMeta(card);
      if (idx >= 0) {
        index[idx] = meta;
      } else {
        index.unshift(meta);
      }
      try {
        localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
      } catch (e) {
        if (e.name === "QuotaExceededError") {
          throw new Error(I18n.t ? I18n.t("error.storageFull") : "Storage full! Try removing some cards or exporting them.");
        }
        throw e;
      }
    },
    async deleteCard(id) {
      await Promise.all([
        this.deleteImage(id),
        this.DB.delete(this.DB.stores.cards, id)
      ]);
      this.clearChatHistory(id);
      const index = this.getCards().filter((c) => c._id !== id);
      localStorage.setItem(this.PREFIX + this._keys.cardIndex, JSON.stringify(index));
      if (this.getActiveCardId() === id) {
        this.setActiveCardId(null);
      }
    },
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
    async getActiveCard() {
      const id = this.getActiveCardId();
      if (!id)
        return null;
      return this.getCard(id);
    },
    _chatKey(cardId) {
      return this.PREFIX + this._keys.aiChatHistory + "_" + (cardId || "global");
    },
    _storageFullWarnedAt: 0,
    _notifyStorageFull(e) {
      console.error("Chat history write failed:", e);
      const now = Date.now();
      if (now - this._storageFullWarnedAt < 5000)
        return;
      this._storageFullWarnedAt = now;
      if (window.Ui && typeof window.Ui.showToast === "function") {
        Ui.showToast(I18n.t ? I18n.t("error.storageFull") : "Storage full! Try removing some cards or exporting them.", "danger");
      }
    },
    _sessionKey(cardId) {
      return this.PREFIX + "chatSessions_" + (cardId || "global");
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
          console.warn("Chat history truncated to last " + this.CHAT_HISTORY_LIMIT + " messages for card " + (cardId || "global"));
        }
        const trimmed = messages.slice(-this.CHAT_HISTORY_LIMIT);
        localStorage.setItem(this._chatKey(cardId), JSON.stringify(trimmed));
      } catch (e) {
        this._notifyStorageFull(e);
      }
    },
    clearChatHistory(cardId) {
      if (cardId) {
        localStorage.removeItem(this._chatKey(cardId));
        const sessions = this.getChatSessions(cardId);
        sessions.forEach((s) => localStorage.removeItem(this._sessionMsgKey(cardId, s.id)));
        localStorage.removeItem(this._sessionKey(cardId));
      } else {
        localStorage.removeItem(this._chatKey("global"));
        const sessions = this.getChatSessions("global");
        sessions.forEach((s) => localStorage.removeItem(this._sessionMsgKey("global", s.id)));
        localStorage.removeItem(this._sessionKey("global"));
      }
    },
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
        const idx = sessions.findIndex((s) => s.id === session.id);
        if (idx >= 0) {
          sessions[idx] = session;
        } else {
          sessions.unshift(session);
        }
        localStorage.setItem(this._sessionKey(cardId), JSON.stringify(sessions));
      } catch (e) {
        this._notifyStorageFull(e);
      }
    },
    deleteChatSession(cardId, sessionId) {
      try {
        const sessions = this.getChatSessions(cardId).filter((s) => s.id !== sessionId);
        localStorage.setItem(this._sessionKey(cardId), JSON.stringify(sessions));
        localStorage.removeItem(this._sessionMsgKey(cardId, sessionId));
      } catch {}
    },
    _sessionMsgKey(cardId, sessionId) {
      return this.PREFIX + "sessionMsgs_" + (cardId || "global") + "_" + sessionId;
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
      } catch (e) {
        this._notifyStorageFull(e);
      }
    },
    deleteSessionMessages(cardId, sessionId) {
      try {
        localStorage.removeItem(this._sessionMsgKey(cardId, sessionId));
      } catch {}
    },
    async clearAll() {
      const keysToRemove = [];
      for (let i = 0;i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(this.PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
      await Promise.all([
        this.DB.clear(this.DB.stores.cards).catch(() => {}),
        this.DB.clear(this.DB.stores.images).catch(() => {})
      ]);
      this._secrets = { apiKey: "", customApiKey: "", providerKeys: {} };
      this._secretWarn = { apiKey: false, customApiKey: false };
      this._secretUnlocked = false;
      this._migrationDone = false;
    },
    getImage(id) {
      return this.DB.get(this.DB.stores.images, id);
    },
    saveImage(id, base64) {
      return this.DB.set(this.DB.stores.images, id, base64);
    },
    deleteImage(id) {
      return this.DB.delete(this.DB.stores.images, id);
    },
    async getUsageEstimate() {
      let total = 0;
      for (let i = 0;i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(this.PREFIX)) {
          const val = localStorage.getItem(key);
          if (val)
            total += val.length * 2;
        }
      }
      try {
        for (const store of Object.values(this.DB.stores)) {
          const records = await this.DB.getAll(store);
          for (const rec of records) {
            if (typeof rec === "string") {
              total += rec.length * 2;
            } else if (rec && typeof rec === "object") {
              total += JSON.stringify(rec).length * 2;
            }
          }
        }
      } catch (_) {}
      return total;
    }
  };
  if (typeof window !== "undefined")
    window.CardStorage = CardStorage2;

  // js/exportUtils.js
  var ExportUtils2 = {
    EDITOR_CREDIT: "Made using https://maxime-fleury.github.io/ST-cardEditor/",
    injectCopyright(card) {
      const note = card.creator_notes || "";
      if (!note.includes(this.EDITOR_CREDIT)) {
        card.creator_notes = note ? note.trimEnd() + `

` + this.EDITOR_CREDIT : this.EDITOR_CREDIT;
      }
      return card;
    },
    async exportAsJSON() {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      await Editor.syncEditorToCard();
      if (!activeCard.name)
        Ui.showToast(I18n.t("toast.noNameWarning"), "warning");
      const clone = JSON.parse(JSON.stringify(activeCard));
      if (CardStorage.getInjectCopyright())
        this.injectCopyright(clone);
      Ui.downloadFile((activeCard.name || "character") + ".json", CardEngine.toJSON(clone), "application/json");
      Ui.showToast(I18n.t("toast.exportedJson"), "success");
    },
    async exportAsPNG() {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      await Editor.syncEditorToCard();
      const clone = JSON.parse(JSON.stringify(activeCard));
      if (CardStorage.getInjectCopyright())
        this.injectCopyright(clone);
      const json = CardEngine.toJSON(clone);
      try {
        let pngBytes = null;
        if (activeCard._imageBase64) {
          pngBytes = await this.imageBase64ToPNGBytes(activeCard._imageBase64);
          if (!pngBytes) {
            pngBytes = this._dataUrlToBytes(activeCard._imageBase64);
          }
        }
        if (!pngBytes) {
          pngBytes = await this.createMinimalPNGBytes();
        }
        const blob = new Blob([this.embedCharaChunk(pngBytes, json)], { type: "image/png" });
        Ui.downloadBlob(blob, (activeCard.name || "character") + ".png");
        Ui.showToast(I18n.t("toast.exportedPng"), "success");
      } catch (err) {
        console.error("PNG export failed:", err);
        Ui.showToast(I18n.t("toast.exportFailed"), "warning");
        this.exportAsJSON();
      }
    },
    async imageBase64ToPNGBytes(imageBase64) {
      try {
        const img = await new Promise((resolve, reject) => {
          const el = new Image;
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = imageBase64;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return new Promise((resolve) => {
          canvas.toBlob((blob) => {
            if (!blob)
              return resolve(null);
            const reader = new FileReader;
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.readAsArrayBuffer(blob);
          }, "image/png");
        });
      } catch (err) {
        console.error("Failed to convert image to PNG:", err);
        return null;
      }
    },
    async embedJSONInPNG(imageBase64, jsonStr) {
      try {
        const pngBytes = await this.imageBase64ToPNGBytes(imageBase64);
        if (!pngBytes)
          return null;
        return new Blob([this.embedCharaChunk(pngBytes, jsonStr)], { type: "image/png" });
      } catch (err) {
        console.error("Failed to embed PNG chunk:", err);
        return null;
      }
    },
    _dataUrlToBytes(dataUrl) {
      try {
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png"))
          return null;
        const comma = dataUrl.indexOf(",");
        if (comma < 0)
          return null;
        const bin = atob(dataUrl.slice(comma + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0;i < bin.length; i++)
          bytes[i] = bin.charCodeAt(i);
        const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
        for (let i = 0;i < PNG_SIG.length; i++) {
          if (bytes[i] !== PNG_SIG[i])
            return null;
        }
        return bytes;
      } catch (e) {
        console.error("Failed to decode data URL:", e);
        return null;
      }
    },
    async createMinimalPNGBytes() {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      const g = ctx.createLinearGradient(0, 0, 64, 64);
      g.addColorStop(0, "#772ce8");
      g.addColorStop(1, "#ec4899");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(I18n.t ? I18n.t("export.minimalPngLabel") : "ST Card", 32, 36);
      return new Promise((resolve) => {
        let settled = false;
        const settle = (bytes) => {
          if (!settled) {
            settled = true;
            resolve(bytes);
          }
        };
        canvas.toBlob((blob) => {
          if (!blob) {
            try {
              const dataUrl = canvas.toDataURL("image/png");
              const bin = atob(dataUrl.split(",")[1]);
              const out = new Uint8Array(bin.length);
              for (let i = 0;i < bin.length; i++)
                out[i] = bin.charCodeAt(i);
              settle(out);
            } catch (e) {
              settle(new Uint8Array(0));
            }
            return;
          }
          const reader = new FileReader;
          reader.onload = () => settle(new Uint8Array(reader.result));
          reader.onerror = () => settle(new Uint8Array(0));
          reader.readAsArrayBuffer(blob);
        }, "image/png");
      });
    },
    embedCharaChunk(pngBytes, jsonStr) {
      const bytes = new Uint8Array(pngBytes);
      let offset = 8, iendPos = -1;
      const kept = [];
      while (offset + 12 <= bytes.length) {
        const length = CardEngine._readUint32(bytes, offset);
        if (offset + 12 + length > bytes.length)
          break;
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        if (type === "IEND") {
          iendPos = offset;
          break;
        }
        const isCharaText = type === "tEXt" && (() => {
          const nullIdx = bytes.indexOf(0, offset + 8);
          if (nullIdx < 0 || nullIdx > offset + 8 + 79)
            return false;
          const kw = String.fromCharCode.apply(null, bytes.subarray(offset + 8, nullIdx));
          return kw === "chara";
        })();
        if (!isCharaText) {
          kept.push(bytes.subarray(offset, offset + 12 + length));
        }
        offset += 12 + length;
      }
      if (iendPos < 0) {
        console.warn("exportUtils: PNG missing IEND chunk — card data was not embedded");
        return bytes;
      }
      const keyword = "chara";
      const jsonBytes = new TextEncoder().encode(jsonStr);
      let b64 = "";
      const CHUNK = 32768;
      for (let i = 0;i < jsonBytes.length; i += CHUNK) {
        b64 += String.fromCharCode.apply(null, jsonBytes.subarray(i, i + CHUNK));
      }
      b64 = btoa(b64);
      const textData = new TextEncoder().encode(keyword + "\x00" + b64);
      const typeBytes = new TextEncoder().encode("tEXt");
      const crcData = new Uint8Array(4 + textData.length);
      crcData.set(typeBytes, 0);
      crcData.set(textData, 4);
      const crc = this.crc32(crcData);
      const chunk = new Uint8Array(12 + textData.length);
      new DataView(chunk.buffer).setUint32(0, textData.length, false);
      chunk.set(typeBytes, 4);
      chunk.set(textData, 8);
      new DataView(chunk.buffer).setUint32(8 + textData.length, crc, false);
      const keptSize = kept.reduce((n, c) => n + c.length, 0);
      const result = new Uint8Array(8 + keptSize + chunk.length + (bytes.length - iendPos));
      result.set(bytes.subarray(0, 8), 0);
      let pos = 8;
      for (const c of kept) {
        result.set(c, pos);
        pos += c.length;
      }
      result.set(chunk, pos);
      pos += chunk.length;
      result.set(bytes.subarray(iendPos), pos);
      return result;
    },
    crc32(data) {
      let crc = 4294967295;
      for (let i = 0;i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0;j < 8; j++)
          crc = crc & 1 ? crc >>> 1 ^ 3988292384 : crc >>> 1;
      }
      return (crc ^ 4294967295) >>> 0;
    }
  };
  if (typeof window !== "undefined")
    window.ExportUtils = ExportUtils2;

  // js/editor.js
  var Editor2 = {
    _undoStack: [],
    _redoStack: [],
    _maxUndo: 50,
    _undoCardId: null,
    _lastSnapField: null,
    _FIELD_MAP: {
      firstMes: "first_mes",
      mesExample: "mes_example",
      creatorNotes: "creator_notes",
      systemPrompt: "system_prompt",
      postHistory: "post_history_instructions",
      version: "character_version"
    },
    _toCardProp(field) {
      return this._FIELD_MAP[field] || field;
    },
    _fieldToDomId(field) {
      const map = {
        name: "editName",
        description: "editDescription",
        personality: "editPersonality",
        scenario: "editScenario",
        firstMes: "editFirstMes",
        mesExample: "editMesExample",
        creatorNotes: "editCreatorNotes",
        systemPrompt: "editSystemPrompt",
        postHistory: "editPostHistory",
        creator: "editCreator",
        version: "editVersion",
        tags: "editTags"
      };
      return map[field] || "edit" + field.charAt(0).toUpperCase() + field.slice(1);
    },
    _snapshot(field) {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      const prop = this._toCardProp(field);
      const val = activeCard[prop];
      const oldVal = Array.isArray(val) || val && typeof val === "object" ? JSON.parse(JSON.stringify(val)) : val || "";
      this._undoStack.push({ field, prop, oldValue: oldVal });
      if (this._undoStack.length > this._maxUndo)
        this._undoStack.shift();
      this._redoStack = [];
    },
    _snapshotSub(kind) {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      const prop = kind === "greetings" ? "alternate_greetings" : "character_book";
      this._undoStack.push({
        field: kind,
        prop,
        oldValue: JSON.parse(JSON.stringify(activeCard[prop] || (kind === "greetings" ? [] : { entries: [] })))
      });
      if (this._undoStack.length > this._maxUndo)
        this._undoStack.shift();
      this._redoStack = [];
    },
    _applySubEntry(entry, newValue) {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      if (entry.prop === "alternate_greetings") {
        activeCard.alternate_greetings = newValue;
        this.renderGreetings(activeCard);
      } else if (entry.prop === "character_book") {
        activeCard.character_book = newValue;
        this.renderLorebook(activeCard);
      }
    },
    async undo() {
      if (!this._undoStack.length)
        return;
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      this._lastSnapField = null;
      const entry = this._undoStack.pop();
      this._redoStack.push({
        ...entry,
        oldValue: entry.oldValue,
        newValue: JSON.parse(JSON.stringify(activeCard[entry.prop] || (entry.prop === "alternate_greetings" ? [] : entry.prop === "character_book" ? { entries: [] } : "")))
      });
      if (entry.prop === "alternate_greetings" || entry.prop === "character_book") {
        this._applySubEntry(entry, entry.oldValue);
        await this.syncEditorToCard();
        AiChat.updateContextBar();
        Ui.showToast(I18n.t("toast.undo") + ": " + entry.field, "info");
        return;
      }
      activeCard[entry.prop] = entry.oldValue;
      const el = document.querySelector("#" + this._fieldToDomId(entry.field));
      if (el)
        el.value = entry.oldValue;
      await Editor2.syncEditorToCard();
      this.updateCharCounts();
      this.autoResizeTextareas();
      AiChat.updateContextBar();
      Ui.showToast(I18n.t("toast.undo") + ": " + entry.field, "info");
    },
    async redo() {
      if (!this._redoStack.length)
        return;
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      this._lastSnapField = null;
      const entry = this._redoStack.pop();
      this._undoStack.push({
        ...entry,
        oldValue: JSON.parse(JSON.stringify(activeCard[entry.prop] || (entry.prop === "alternate_greetings" ? [] : entry.prop === "character_book" ? { entries: [] } : ""))),
        newValue: entry.newValue
      });
      if (entry.prop === "alternate_greetings" || entry.prop === "character_book") {
        this._applySubEntry(entry, entry.newValue);
        await this.syncEditorToCard();
        AiChat.updateContextBar();
        Ui.showToast(I18n.t("toast.redo") + ": " + entry.field, "info");
        return;
      }
      activeCard[entry.prop] = entry.newValue;
      const el = document.querySelector("#" + this._fieldToDomId(entry.field));
      if (el)
        el.value = entry.newValue;
      await Editor2.syncEditorToCard();
      this.updateCharCounts();
      this.autoResizeTextareas();
      AiChat.updateContextBar();
      Ui.showToast(I18n.t("toast.redo") + ": " + entry.field, "info");
    },
    populateEditor(card) {
      const $ = (sel) => document.querySelector(sel);
      function safeStyle(id, displayVal) {
        const el = $(id);
        if (el)
          el.style.display = displayVal;
      }
      this._renderedCardId = card._id;
      if (card._id !== this._undoCardId) {
        this._undoStack = [];
        this._redoStack = [];
        this._lastSnapField = null;
        this._undoCardId = card._id;
      }
      $("#editName").value = card.name || "";
      $("#editDescription").value = card.description || "";
      $("#editPersonality").value = card.personality || "";
      $("#editScenario").value = card.scenario || "";
      $("#editFirstMes").value = card.first_mes || "";
      $("#editMesExample").value = card.mes_example || "";
      $("#editCreatorNotes").value = card.creator_notes || "";
      $("#editSystemPrompt").value = card.system_prompt || "";
      $("#editPostHistory").value = card.post_history_instructions || "";
      $("#editCreator").value = card.creator || "";
      $("#editVersion").value = card.character_version || "";
      $("#editTags").value = (card.tags || []).join(", ");
      const allTags = new Set;
      (window.AppState.cards || []).forEach((c) => (c.tags || []).forEach((t) => allTags.add(t)));
      const datalist = document.querySelector("#tagSuggestions");
      if (datalist)
        datalist.innerHTML = [...allTags].map((t) => '<option value="' + Ui.escapeAttr(t) + '">').join("");
      document.querySelectorAll(".field-toggle-group").forEach((group) => {
        const targetId = group.dataset.target;
        group.querySelectorAll(".field-toggle-btn").forEach((b) => b.classList.remove("active"));
        const editBtn = group.querySelector('[data-mode="edit"]');
        if (editBtn)
          editBtn.classList.add("active");
        const textarea = document.getElementById(targetId);
        const previewId = "preview" + targetId.replace("edit", "");
        const preview = document.getElementById(previewId);
        if (textarea)
          textarea.style.display = "";
        if (preview) {
          preview.classList.remove("visible");
          preview.innerHTML = "";
        }
      });
      this.renderGreetings(card);
      const metaCreator = $("#metaCreator");
      if (metaCreator) {
        metaCreator.textContent = card.creator ? I18n.t("gen.byCreator", { name: card.creator }) : "";
        safeStyle("#metaCreator", card.creator ? "" : "none");
      }
      safeStyle("#metaVersion", card.character_version ? "" : "none");
      const metaVersion = $("#metaVersion");
      if (metaVersion) {
        metaVersion.textContent = card.character_version ? "v" + card.character_version : "";
      }
      safeStyle("#metaTags", card.tags?.length ? "" : "none");
      const metaTags = $("#metaTags");
      if (metaTags) {
        metaTags.textContent = (card.tags || []).slice(0, 3).join(", ");
      }
      if (card._imageBase64) {
        const img = $("#charAvatarImg");
        if (img) {
          img.src = card._imageBase64;
          img.hidden = false;
        }
        safeStyle("#avatarPlaceholder", "none");
      } else {
        safeStyle("#avatarPlaceholder", "");
        const img = $("#charAvatarImg");
        if (img)
          img.hidden = true;
      }
      this.renderLorebook(card);
      this.showEditor();
      this.updateCharCounts();
      this.autoResizeTextareas();
      window.syncFloatingLabels?.();
      window.Ui.updateUIState();
    },
    _captureFields(activeCard) {
      const $ = (sel) => document.querySelector(sel);
      activeCard.name = $("#editName").value.trim();
      activeCard.description = $("#editDescription").value;
      activeCard.personality = $("#editPersonality").value;
      activeCard.scenario = $("#editScenario").value;
      activeCard.first_mes = $("#editFirstMes").value;
      activeCard.mes_example = $("#editMesExample").value;
      activeCard.creator_notes = $("#editCreatorNotes").value;
      activeCard.system_prompt = $("#editSystemPrompt").value;
      activeCard.post_history_instructions = $("#editPostHistory").value;
      this.syncGreetings();
      activeCard.creator = $("#editCreator").value.trim();
      activeCard.character_version = $("#editVersion").value.trim();
      activeCard.tags = $("#editTags").value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      activeCard._fileSize = JSON.stringify({
        spec: activeCard.spec || "chara_card_v2",
        spec_version: activeCard.spec_version || "2.0",
        data: {
          name: activeCard.name || "",
          description: activeCard.description || "",
          personality: activeCard.personality || "",
          scenario: activeCard.scenario || "",
          first_mes: activeCard.first_mes || "",
          mes_example: activeCard.mes_example || "",
          creator_notes: activeCard.creator_notes || "",
          system_prompt: activeCard.system_prompt || "",
          post_history_instructions: activeCard.post_history_instructions || "",
          alternate_greetings: activeCard.alternate_greetings || [],
          tags: activeCard.tags || [],
          creator: activeCard.creator || "",
          character_version: activeCard.character_version || "",
          character_book: activeCard.character_book || { entries: [] },
          extensions: activeCard.extensions || {}
        }
      }).length;
    },
    async syncEditorToCard() {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      const prev = this._pendingSync || Promise.resolve();
      const run = prev.then(() => this._doSync(activeCard));
      this._pendingSync = run.catch(() => {});
      return run;
    },
    async _doSync(activeCard) {
      if (this._renderedCardId && this._renderedCardId !== activeCard._id)
        return;
      this._captureFields(activeCard);
      if (!activeCard.name && !this._nameWarned) {
        this._nameWarned = true;
        Ui.showToast(I18n.t("toast.noNameWarning"), "warning");
      } else if (activeCard.name && this._nameWarned) {
        this._nameWarned = false;
      }
      await CardStorage.upsertCard(activeCard);
      window.AppState.cards = CardStorage.getCards();
      window.AppState._dirty = true;
      Ui.setDirty(true);
    },
    syncEditorToCardSync() {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      if (this._renderedCardId && this._renderedCardId !== activeCard._id)
        return;
      this._captureFields(activeCard);
      try {
        CardStorage.upsertCard(activeCard).catch(() => {});
      } catch (_) {}
      const index = CardStorage.getCards();
      const idx = index.findIndex((c) => c._id === activeCard._id);
      const meta = CardStorage._extractMeta(activeCard);
      if (idx >= 0) {
        index[idx] = meta;
      } else {
        index.unshift(meta);
      }
      try {
        localStorage.setItem(CardStorage.PREFIX + CardStorage._keys.cardIndex, JSON.stringify(index));
      } catch (_) {}
      window.AppState._dirty = true;
    },
    showEditor() {
      const $ = (sel) => document.querySelector(sel);
      $("#noCardSelected").classList.add("d-none");
      $("#editorContainer").classList.remove("d-none");
    },
    async setAvatar(file) {
      const $ = (sel) => document.querySelector(sel);
      const { activeCard } = window.AppState;
      if (!activeCard) {
        Ui.showToast(I18n.t("toast.selectCard"), "warning");
        return;
      }
      try {
        const b64 = await CardEngine._blobToBase64(file);
        activeCard._imageBase64 = b64;
        activeCard._hasImage = true;
        activeCard._thumbnail = await CardEngine._createThumbnail(b64);
        const img = $("#charAvatarImg");
        if (img) {
          img.src = b64;
          img.hidden = false;
        }
        const ph = $("#avatarPlaceholder");
        if (ph)
          ph.style.display = "none";
        await CardStorage.saveImage(activeCard._id, b64);
        await this.syncEditorToCard();
        Ui.showToast(I18n.t("toast.avatarUpdated"), "success");
      } catch (e) {
        console.error("Avatar load failed", e);
        Ui.showToast(I18n.t("toast.imgFailed"), "danger");
      }
    },
    hideEditor() {
      const $ = (sel) => document.querySelector(sel);
      $("#noCardSelected").classList.remove("d-none");
      $("#editorContainer").classList.add("d-none");
    },
    _fieldIds: [
      "editName",
      "editDescription",
      "editPersonality",
      "editScenario",
      "editFirstMes",
      "editMesExample",
      "editCreatorNotes",
      "editSystemPrompt",
      "editPostHistory",
      "editCreator",
      "editVersion",
      "editTags"
    ],
    autoResizeTextareas() {
      document.querySelectorAll(".editor-textarea").forEach((ta) => {
        if (ta.offsetParent === null)
          return;
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 800) + "px";
      });
    },
    updateCharCounts() {
      const maxTokens = typeof CardStorage !== "undefined" && CardStorage.getMaxTokens ? CardStorage.getMaxTokens() : 0;
      for (const id of this._fieldIds) {
        const el = document.querySelector("#" + id);
        if (!el)
          continue;
        let countEl = el.parentElement.querySelector(".char-count");
        if (!countEl) {
          countEl = document.createElement("small");
          countEl.className = "char-count field-counter text-secondary d-block mt-1";
          countEl.style.fontSize = "0.7rem";
          el.insertAdjacentElement("afterend", countEl);
        }
        countEl.classList.add("field-counter");
        countEl.classList.remove("is-warn", "is-danger");
        const len = (el.value || "").length;
        const tokens = typeof Tokenizer !== "undefined" && Tokenizer.quickCount ? Tokenizer.quickCount(el.value || "") : Math.ceil(len / 3);
        countEl.textContent = I18n.t ? I18n.t("editor.charCount", { chars: len, tokens }) : len + " chars ~" + tokens + " tokens";
        if (maxTokens > 0) {
          if (tokens > maxTokens) {
            countEl.classList.add("is-danger");
            countEl.title = I18n.t ? I18n.t("editor.counterDanger", { tokens, max: maxTokens }) : "Exceeds the output token limit (" + maxTokens + ").";
          } else if (tokens > maxTokens * 0.75) {
            countEl.classList.add("is-warn");
            countEl.title = I18n.t ? I18n.t("editor.counterWarn", { tokens, max: maxTokens }) : "Approaching the output token limit (" + maxTokens + ").";
          }
        }
      }
    },
    renderGreetings(card) {
      const $ = (sel) => document.querySelector(sel);
      const container = $("#greetingsList");
      const count = $("#greetingCount");
      const greetings = card.alternate_greetings || [];
      const gen = this._greetGen = (this._greetGen || 0) + 1;
      count.textContent = greetings.length ? "(" + greetings.length + ")" : "";
      if (!greetings.length) {
        container.innerHTML = '<div style="font-size:0.82rem;padding:0.5rem 0;color:var(--text-secondary);"><i class="bi bi-info-circle me-1" style="color:var(--purple-400);"></i>' + (I18n.t ? I18n.t("editor.noGreetings") : "No greetings yet. Click <strong>Add Greeting</strong> or use AI to generate some.") + "</div>";
        return;
      }
      container.innerHTML = greetings.map((g, idx) => {
        const isDefault = idx === greetings.indexOf(card.first_mes);
        return '<div class="greeting-item' + (isDefault ? " default-greeting" : "") + '" data-greeting-idx="' + idx + '">' + '<div class="greeting-item-actions">' + '<button class="btn btn-outline-secondary btn-sm greeting-up" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t("editor.greetingMoveUp") : "Move up") + '"><i class="bi bi-chevron-up"></i></button>' + '<button class="btn btn-outline-secondary btn-sm greeting-down" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t("editor.greetingMoveDown") : "Move down") + '"><i class="bi bi-chevron-down"></i></button>' + (isDefault ? '<span class="greeting-item-badge bg-purple" title="' + (I18n.t ? I18n.t("editor.greetingIsDefault") : "This is the current first message") + '"><i class="bi bi-star-fill"></i></span>' : '<button class="btn btn-outline-accent btn-sm greeting-set-default" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t("editor.greetingSetDefault") : "Set as first message") + '"><i class="bi bi-star"></i></button>') + '<button class="btn btn-outline-danger btn-sm greeting-delete" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t("editor.greetingRemove") : "Remove") + '"><i class="bi bi-x-lg"></i></button>' + "</div>" + '<textarea class="form-control greeting-textarea" rows="4" placeholder="' + (I18n.t ? I18n.t("editor.greetingPlaceholder", { num: idx + 1 }) : "Greeting " + (idx + 1) + "...") + '" data-greeting-idx="' + idx + '">' + Ui.escapeHtml(g) + "</textarea>" + "</div>";
      }).join("");
      const self = this;
      container.querySelectorAll(".greeting-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
          self.syncGreetings();
          window.AppState.activeCard.alternate_greetings.splice(parseInt(btn.dataset.idx), 1);
          self.renderGreetings(window.AppState.activeCard);
          await self.syncEditorToCard();
        });
      });
      container.querySelectorAll(".greeting-set-default").forEach((btn) => {
        btn.addEventListener("click", async () => {
          self.syncGreetings();
          const g = window.AppState.activeCard.alternate_greetings[parseInt(btn.dataset.idx)];
          if (g) {
            window.AppState.activeCard.first_mes = g;
            $("#editFirstMes").value = g;
            self.renderGreetings(window.AppState.activeCard);
            await self.syncEditorToCard();
            Ui.showToast(I18n.t("toast.firstMesUpdated"), "success");
          }
        });
      });
      container.querySelectorAll(".greeting-up").forEach((btn) => {
        btn.addEventListener("click", async () => {
          self.syncGreetings();
          const idx = parseInt(btn.dataset.idx);
          if (idx > 0) {
            const arr = window.AppState.activeCard.alternate_greetings;
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            self.renderGreetings(window.AppState.activeCard);
            await self.syncEditorToCard();
          }
        });
      });
      container.querySelectorAll(".greeting-down").forEach((btn) => {
        btn.addEventListener("click", async () => {
          self.syncGreetings();
          const idx = parseInt(btn.dataset.idx);
          const arr = window.AppState.activeCard.alternate_greetings;
          if (idx < arr.length - 1) {
            [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
            self.renderGreetings(window.AppState.activeCard);
            await self.syncEditorToCard();
          }
        });
      });
      container.querySelectorAll(".greeting-textarea").forEach((ta) => {
        ta.addEventListener("focus", () => {
          self._lastSnapField = null;
        });
        ta.addEventListener("beforeinput", () => {
          if (self._lastSnapField !== "greetings") {
            self._snapshotSub("greetings");
            self._lastSnapField = "greetings";
          }
        });
        ta.addEventListener("input", Ui.debounce(async () => {
          if (!ta.isConnected || gen !== self._greetGen) {
            self.syncGreetings();
            await self.syncEditorToCard();
            return;
          }
          const idx = parseInt(ta.dataset.greetingIdx);
          if (window.AppState.activeCard.alternate_greetings[idx] !== undefined) {
            window.AppState.activeCard.alternate_greetings[idx] = ta.value;
          }
          await self.syncEditorToCard();
        }, 500));
      });
    },
    syncGreetings() {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      const $ = (sel) => document.querySelector(sel);
      const greetings = [];
      const list = $("#greetingsList");
      if (list) {
        list.querySelectorAll(".greeting-textarea").forEach((ta) => {
          greetings.push(ta.value);
        });
      }
      activeCard.alternate_greetings = greetings;
    },
    async addGreeting() {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      const $ = (sel) => document.querySelector(sel);
      if (!activeCard.alternate_greetings)
        activeCard.alternate_greetings = [];
      activeCard.alternate_greetings.push("");
      this.renderGreetings(activeCard);
      await this.syncEditorToCard();
      const allTas = $("#greetingsList").querySelectorAll(".greeting-textarea");
      const last = allTas[allTas.length - 1];
      if (last)
        last.focus();
    },
    renderLorebook(card) {
      const $ = (sel) => document.querySelector(sel);
      const container = $("#lorebookEntries");
      const entries = (card.character_book?.entries || []).map((e) => {
        if (!e || typeof e !== "object") {
          return { key: "", keysecondary: [], content: "", order: 100, constant: false, selective: false, position: "after_char", comment: "" };
        }
        if (!Array.isArray(e.keysecondary)) {
          e.keysecondary = e.keysecondary == null ? [] : String(e.keysecondary).split(",").map((s) => s.trim()).filter(Boolean);
        }
        if (e.key != null && !Array.isArray(e.key) && typeof e.key !== "string") {
          e.key = String(e.key);
        }
        return e;
      });
      const gen = this._loreGen = (this._loreGen || 0) + 1;
      const searchInput = $("#lorebookSearchInput");
      const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : "";
      if (entries.length === 0) {
        container.innerHTML = '<div class="text-center py-4" id="lorebookEmpty" style="color:var(--text-secondary);"><i class="bi bi-journal-text d-block mb-2" style="font-size: 2.5rem;color:var(--purple-400);"></i><span style="font-size:0.85rem;">' + I18n.t("editor.lorebookEmpty") + "</span></div>";
        return;
      }
      let filteredEntries = entries.map((entry, idx) => ({ entry, idx }));
      if (searchQuery) {
        filteredEntries = filteredEntries.filter(({ entry }) => {
          const keyStr = (entry.key || "").toLowerCase();
          const secStr = (entry.keysecondary || []).join(" ").toLowerCase();
          const contentStr = (entry.content || "").toLowerCase();
          const commentStr = (entry.comment || "").toLowerCase();
          return keyStr.includes(searchQuery) || secStr.includes(searchQuery) || contentStr.includes(searchQuery) || commentStr.includes(searchQuery);
        });
      }
      if (filteredEntries.length === 0) {
        container.innerHTML = '<div class="text-muted text-center py-3">' + (I18n.t ? I18n.t("editor.noEntriesMatch", { query: Ui.escapeHtml(searchQuery) }) : 'No entries match "' + Ui.escapeHtml(searchQuery) + '"') + "</div>";
        return;
      }
      container.innerHTML = '<div class="lorebook-accordion">' + filteredEntries.map(({ entry, idx }) => {
        const keys = (Array.isArray(entry.key) ? entry.key : (entry.key || "").split(",")).map((s) => String(s).trim()).filter(Boolean);
        const secondary = entry.keysecondary || [];
        const label = entry.comment || (Array.isArray(entry.key) ? entry.key.join(", ") : entry.key) || (I18n.t ? I18n.t("editor.loreEntry", { num: idx + 1 }) : "Entry " + (idx + 1));
        const keyTagsHtml = keys.slice(0, 3).map((k) => '<span class="lorebook-key-tag primary">' + Ui.escapeHtml(k) + "</span>").join("") + secondary.slice(0, 2).map((k) => '<span class="lorebook-key-tag secondary">' + Ui.escapeHtml(k) + "</span>").join("");
        return '<div class="lorebook-accordion-item" data-entry-idx="' + idx + '">' + '<div class="lorebook-accordion-header" data-lore-toggle="' + idx + '" role="button" tabindex="0" aria-expanded="false">' + '<i class="bi bi-chevron-right lorebook-chevron"></i>' + '<span class="lorebook-entry-label">' + Ui.escapeHtml(label) + "</span>" + '<div class="lorebook-key-tags">' + keyTagsHtml + "</div>" + '<button class="btn btn-outline-danger btn-sm lorebook-delete-btn" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t("editor.loreDeleteEntry") : "Delete entry") + '"><i class="bi bi-trash"></i></button>' + "</div>" + '<div class="lorebook-accordion-body">' + '<div class="row g-2 mb-2" style="font-size:0.8rem;">' + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t("editor.lorePrimaryKeys") : "Primary Keywords") + '</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr((Array.isArray(entry.key) ? entry.key.join(", ") : entry.key) || "") + '" placeholder="' + (I18n.t ? I18n.t("editor.lorePrimaryKeysPlaceholder") : "Primary keywords — comma separated") + '" data-lore-key-idx="' + idx + '"></div>' + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t("editor.loreSecondaryKeys") : "Secondary Keywords") + '</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr((entry.keysecondary || []).join(", ")) + '" placeholder="' + (I18n.t ? I18n.t("editor.loreSecondaryKeysPlaceholder") : "Secondary keywords") + '" data-lore-secondary-idx="' + idx + '"></div>' + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t("editor.loreComment") : "Comment") + '</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr(entry.comment || "") + '" placeholder="' + (I18n.t ? I18n.t("editor.loreCommentPlaceholder") : "Comment") + '" data-lore-comment-idx="' + idx + '"></div>' + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t("editor.loreOrder") : "Order") + '</label><input type="number" class="form-control form-control-sm" value="' + Ui.escapeAttr(entry.order ?? 100) + '" placeholder="' + (I18n.t ? I18n.t("editor.loreOrderPlaceholder") : "Order") + '" data-lore-order-idx="' + idx + '"></div>' + "</div>" + '<div class="d-flex gap-3 mb-2" style="font-size:0.8rem;">' + '<div class="form-check"><input class="form-check-input" type="checkbox"' + (entry.constant ? " checked" : "") + ' data-lore-constant-idx="' + idx + '"><label class="form-check-label">' + (I18n.t ? I18n.t("editor.loreConstant") : "Constant") + "</label></div>" + '<div class="form-check"><input class="form-check-input" type="checkbox"' + (entry.selective ? " checked" : "") + ' data-lore-selective-idx="' + idx + '"><label class="form-check-label">' + (I18n.t ? I18n.t("editor.loreSelective") : "Selective") + "</label></div>" + '<select class="form-select form-select-sm" style="width:auto;" data-lore-position-idx="' + idx + '">' + '<option value="before_char"' + (entry.position === "before_char" ? " selected" : "") + ">" + (I18n.t ? I18n.t("editor.loreBeforeChar") : "Before char") + "</option>" + '<option value="after_char"' + (entry.position === "after_char" ? " selected" : "") + ">" + (I18n.t ? I18n.t("editor.loreAfterChar") : "After char") + "</option></select>" + "</div>" + '<label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t("editor.loreContent") : "Content") + "</label>" + '<textarea class="form-control editor-textarea font-mono" rows="6" placeholder="' + (I18n.t ? I18n.t("editor.loreContentPlaceholder") : "Entry content...") + '" data-lore-idx="' + idx + '">' + Ui.escapeHtml(entry.content || "") + "</textarea>" + "</div>" + "</div>";
      }).join("") + "</div>";
      container.querySelectorAll("[data-lore-toggle]").forEach((header) => {
        const toggle = (e) => {
          if (e.target.closest(".lorebook-delete-btn"))
            return;
          const item = header.closest(".lorebook-accordion-item");
          if (item) {
            item.classList.toggle("open");
            header.setAttribute("aria-expanded", item.classList.contains("open") ? "true" : "false");
          }
        };
        header.addEventListener("click", toggle);
        header.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(e);
          }
        });
      });
      const self = this;
      container.querySelectorAll(".lorebook-delete-btn").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          window.AppState.activeCard.character_book.entries.splice(parseInt(btn.dataset.idx), 1);
          self.renderLorebook(window.AppState.activeCard);
          await self.syncEditorToCard();
        });
      });
      const loreFields = container.querySelectorAll("textarea[data-lore-idx], input[data-lore-key-idx], input[data-lore-secondary-idx], input[data-lore-comment-idx], input[data-lore-order-idx]");
      loreFields.forEach((fld) => {
        fld.addEventListener("focus", () => {
          self._lastSnapField = null;
        });
        fld.addEventListener("beforeinput", () => {
          if (self._lastSnapField !== "lorebook") {
            self._snapshotSub("lorebook");
            self._lastSnapField = "lorebook";
          }
        });
      });
      container.querySelectorAll("textarea[data-lore-idx]").forEach((ta) => {
        ta.addEventListener("input", Ui.debounce(async () => {
          if (!ta.isConnected || gen !== self._loreGen)
            return;
          const idx = parseInt(ta.dataset.loreIdx);
          if (window.AppState.activeCard.character_book.entries[idx]) {
            window.AppState.activeCard.character_book.entries[idx].content = ta.value;
            await self.syncEditorToCard();
            self.autoResizeTextareas();
          }
        }, 600));
      });
      container.querySelectorAll("input[data-lore-key-idx]").forEach((input) => {
        input.addEventListener("input", Ui.debounce(async () => {
          if (!input.isConnected || gen !== self._loreGen)
            return;
          const idx = parseInt(input.dataset.loreKeyIdx);
          if (window.AppState.activeCard.character_book.entries[idx]) {
            window.AppState.activeCard.character_book.entries[idx].key = input.value.trim();
            await self.syncEditorToCard();
          }
        }, 600));
      });
      container.querySelectorAll("input[data-lore-secondary-idx]").forEach((input) => {
        input.addEventListener("input", Ui.debounce(async () => {
          if (!input.isConnected || gen !== self._loreGen)
            return;
          const idx = parseInt(input.dataset.loreSecondaryIdx);
          if (window.AppState.activeCard.character_book.entries[idx]) {
            window.AppState.activeCard.character_book.entries[idx].keysecondary = input.value.split(",").map((s) => s.trim()).filter(Boolean);
            await self.syncEditorToCard();
          }
        }, 600));
      });
      container.querySelectorAll("input[data-lore-comment-idx]").forEach((input) => {
        input.addEventListener("input", Ui.debounce(async () => {
          if (!input.isConnected || gen !== self._loreGen)
            return;
          const idx = parseInt(input.dataset.loreCommentIdx);
          if (window.AppState.activeCard.character_book.entries[idx]) {
            window.AppState.activeCard.character_book.entries[idx].comment = input.value;
            await self.syncEditorToCard();
          }
        }, 600));
      });
      container.querySelectorAll("input[data-lore-order-idx]").forEach((input) => {
        input.addEventListener("input", Ui.debounce(async () => {
          if (!input.isConnected || gen !== self._loreGen)
            return;
          const idx = parseInt(input.dataset.loreOrderIdx);
          if (window.AppState.activeCard.character_book.entries[idx]) {
            const parsed = parseInt(input.value, 10);
            window.AppState.activeCard.character_book.entries[idx].order = Number.isNaN(parsed) ? 100 : parsed;
            await self.syncEditorToCard();
          }
        }, 600));
      });
      container.querySelectorAll("input[data-lore-constant-idx]").forEach((cb) => {
        cb.addEventListener("change", async () => {
          const idx = parseInt(cb.dataset.loreConstantIdx);
          if (window.AppState.activeCard.character_book.entries[idx]) {
            window.AppState.activeCard.character_book.entries[idx].constant = cb.checked;
            await self.syncEditorToCard();
          }
        });
      });
      container.querySelectorAll("input[data-lore-selective-idx]").forEach((cb) => {
        cb.addEventListener("change", async () => {
          const idx = parseInt(cb.dataset.loreSelectiveIdx);
          if (window.AppState.activeCard.character_book.entries[idx]) {
            window.AppState.activeCard.character_book.entries[idx].selective = cb.checked;
            await self.syncEditorToCard();
          }
        });
      });
      container.querySelectorAll("select[data-lore-position-idx]").forEach((sel) => {
        sel.addEventListener("change", async () => {
          const idx = parseInt(sel.dataset.lorePositionIdx);
          if (window.AppState.activeCard.character_book.entries[idx]) {
            window.AppState.activeCard.character_book.entries[idx].position = sel.value;
            await self.syncEditorToCard();
          }
        });
      });
    },
    async addLorebookEntry() {
      const { activeCard } = window.AppState;
      if (!activeCard)
        return;
      if (!activeCard.character_book)
        activeCard.character_book = { entries: [] };
      if (!activeCard.character_book.entries)
        activeCard.character_book.entries = [];
      activeCard.character_book.entries.push({ key: I18n.t ? I18n.t("editor.loreNewEntry") : "New Entry", content: "", keysecondary: [], constant: false, selective: false, position: "after_char", order: 100, comment: "" });
      this.renderLorebook(activeCard);
      await this.syncEditorToCard();
    }
  };
  if (typeof window !== "undefined")
    window.Editor = Editor2;

  // js/cardManager.js
  var DEBOUNCE_SEARCH_MS = 300;
  var CardManager2 = {
    async migrateImagesToIndexedDB() {
      const all = CardStorage.getCards();
      for (const meta of all) {
        const full = await CardStorage.getCard(meta._id);
        if (!full || !full._imageBase64)
          continue;
        try {
          await CardStorage.saveImage(full._id, full._imageBase64);
          full._thumbnail = full._thumbnail || await CardEngine._createThumbnail(full._imageBase64);
          full._hasImage = true;
          delete full._imageBase64;
          await CardStorage.upsertCard(full);
        } catch (e) {
          console.error("Image migration failed for", full._id, e);
        }
      }
      window.AppState.cards = CardStorage.getCards();
    },
    handleFileSelect(e) {
      if (e.target.files?.length) {
        this.processFiles(Array.from(e.target.files));
      }
      e.target.value = "";
    },
    async processFiles(fileList) {
      const validExts = ["png", "webp", "json"];
      let loaded = 0, errors = 0, lastCardId = null;
      for (const file of fileList) {
        const ext = file.name.split(".").pop().toLowerCase();
        if (!validExts.includes(ext)) {
          errors++;
          continue;
        }
        try {
          const card = await CardEngine.parseFile(file);
          const trimmedName = (card.name || "").trim();
          if (trimmedName) {
            const existing = CardStorage.getCards().find((c) => (c.name || "").trim().toLowerCase() === trimmedName.toLowerCase());
            if (existing) {
              let existingFull = null;
              try {
                existingFull = await CardStorage.getCard(existing._id);
              } catch (_) {}
              if (existingFull && this._cardSignature(card) === this._cardSignature(existingFull)) {
                const base = trimmedName;
                let n = 2;
                const used = new Set(CardStorage.getCards().map((c) => (c.name || "").toLowerCase()));
                let candidate = base + " (" + n + ")";
                while (used.has(candidate.toLowerCase())) {
                  n++;
                  candidate = base + " (" + n + ")";
                }
                card.name = candidate;
                Ui.showToast(I18n.t("toast.importDupe", { name: candidate }), "info");
              }
            }
          }
          if (card._imageBase64) {
            const approxBytes = Math.round(card._imageBase64.length * 3 / 4);
            if (approxBytes > 5 * 1024 * 1024) {
              Ui.showToast(I18n.t("toast.largeImage", { name: file.name, size: (approxBytes / (1024 * 1024)).toFixed(1) }), "warning");
            }
            await CardStorage.saveImage(card._id, card._imageBase64);
          }
          await CardStorage.upsertCard(card);
          lastCardId = card._id;
          loaded++;
        } catch (err) {
          console.error("Parse error:", file.name, err);
          errors++;
          Ui.showToast(I18n.t("toast.loadFailed", { name: file.name + " — " + err.message }), "danger");
        }
      }
      if (loaded > 0) {
        window.AppState.cards = CardStorage.getCards();
        this.renderCardList();
        if (loaded === 1 && lastCardId) {
          const meta = window.AppState.cards.find((c) => c._id === lastCardId);
          if (meta)
            await this.selectCard(meta);
        }
        Ui.showToast(I18n.t("toast.loaded", { count: loaded }), "success");
      }
      if (errors > 0 && loaded === 0)
        Ui.showToast(I18n.t("toast.noValid"), "warning");
    },
    _cardListBound: false,
    _cardSignature(card) {
      return JSON.stringify([
        card.spec_version || "",
        (card.description || "").trim(),
        (card.first_mes || "").trim(),
        (card.personality || "").trim(),
        (card.scenario || "").trim(),
        (card.mes_example || "").trim(),
        (card.creator_notes || "").trim(),
        (card.system_prompt || "").trim(),
        (card.post_history_instructions || "").trim(),
        (card.character_version || "").trim(),
        (card.tags || []).join("|").toLowerCase()
      ]);
    },
    _searchQuery: "",
    _selectedIds: new Set,
    _sortMode: "name-asc",
    _activeTagFilters: new Set,
    _toggleBatchSelect(cardId) {
      if (this._selectedIds.has(cardId))
        this._selectedIds.delete(cardId);
      else
        this._selectedIds.add(cardId);
      this._updateBatchToolbar();
    },
    _updateBatchToolbar() {
      const toolbar = document.querySelector("#batchToolbar");
      const count = document.querySelector("#batchCount");
      const compareBtn = document.querySelector("#btnBatchCompare");
      if (!toolbar)
        return;
      if (this._selectedIds.size > 0) {
        toolbar.classList.remove("d-none");
        count.textContent = I18n.t("left.selected", { count: this._selectedIds.size });
        if (compareBtn)
          compareBtn.classList.toggle("d-none", this._selectedIds.size !== 2);
      } else {
        toolbar.classList.add("d-none");
      }
    },
    async batchDelete() {
      if (this._selectedIds.size === 0) {
        Ui.showToast(I18n.t("toast.noSelected"), "info");
        return;
      }
      if (!confirm(I18n.t("batch.deleteConfirm", { count: this._selectedIds.size })))
        return;
      for (const id of this._selectedIds)
        await CardStorage.deleteCard(id);
      this._selectedIds.clear();
      this._updateBatchToolbar();
      window.AppState.cards = CardStorage.getCards();
      if (window.AppState.activeCard && !window.AppState.cards.find((c) => c._id === window.AppState.activeCard._id)) {
        window.AppState.activeCard = null;
        Editor.hideEditor();
      }
      this.renderCardList();
      Ui.showToast(I18n.t("toast.cardsDeleted"), "warning");
    },
    async batchCompare() {
      if (this._selectedIds.size !== 2) {
        Ui.showToast(I18n.t ? I18n.t("batch.select2ForCompare") : "Select exactly 2 cards to compare", "info");
        return;
      }
      const [idA, idB] = [...this._selectedIds];
      const cardA = await CardStorage.getCard(idA);
      const cardB = await CardStorage.getCard(idB);
      if (!cardA || !cardB) {
        Ui.showToast(I18n.t ? I18n.t("batch.compareLoadFailed") : "Failed to load cards for comparison", "danger");
        return;
      }
      const jsonA = CardEngine.toJSON(cardA);
      const jsonB = CardEngine.toJSON(cardB);
      const oldEl = document.querySelector("#aiDiffOld");
      const newEl = document.querySelector("#aiDiffNew");
      const titleEl = document.querySelector("#aiPreviewModal .modal-title");
      if (!oldEl || !newEl)
        return;
      if (titleEl)
        titleEl.innerHTML = '<i class="bi bi-layout-sidebar-inset me-2 text-accent"></i>' + (I18n.t ? I18n.t("batch.comparePrefix") : "Compare: ") + Ui.escapeHtml(cardA.name || (I18n.t ? I18n.t("batch.cardA") : "Card A")) + (I18n.t ? I18n.t("batch.compareVs") : " vs ") + Ui.escapeHtml(cardB.name || (I18n.t ? I18n.t("batch.cardB") : "Card B"));
      AiChat._renderDiff(jsonA, jsonB);
      const acceptBtn = document.querySelector("#btnAcceptAI");
      const discardBtn = document.querySelector("#btnDiscardAI");
      if (acceptBtn)
        acceptBtn.classList.add("d-none");
      if (discardBtn)
        discardBtn.classList.add("d-none");
      const applyNav = document.querySelector("#applyNavGroup");
      if (applyNav)
        applyNav.style.display = "none";
      const modal = this._aiPreviewModal = this._aiPreviewModal || new bootstrap.Modal("#aiPreviewModal");
      const modalEl = document.querySelector("#aiPreviewModal");
      const restoreButtons = () => {
        if (acceptBtn)
          acceptBtn.classList.remove("d-none");
        if (discardBtn)
          discardBtn.classList.remove("d-none");
        modalEl.removeEventListener("hidden.bs.modal", restoreButtons);
      };
      modalEl.addEventListener("hidden.bs.modal", restoreButtons);
      modal.show();
    },
    async batchExportJSON() {
      if (this._selectedIds.size === 0) {
        Ui.showToast(I18n.t("toast.noSelected"), "info");
        return;
      }
      const cards = [];
      for (const id of this._selectedIds) {
        const card = await CardStorage.getCard(id);
        if (card) {
          const clone = JSON.parse(JSON.stringify(card));
          delete clone._id;
          delete clone._filename;
          delete clone._createdAt;
          delete clone._fileSize;
          delete clone._thumbnail;
          delete clone._imageBase64;
          if (CardStorage.getInjectCopyright())
            ExportUtils.injectCopyright(clone);
          cards.push(clone);
        }
      }
      if (cards.length === 1) {
        Ui.downloadFile((cards[0].name || "character") + ".json", CardEngine.toJSON(cards[0]), "application/json");
      } else {
        Ui.downloadFile("cards_export.json", JSON.stringify(cards, null, 2), "application/json");
      }
      Ui.showToast(I18n.t("toast.exported", { count: cards.length }), "success");
    },
    _sortCards(cards) {
      const mode = this._sortMode;
      const sorted = [...cards];
      switch (mode) {
        case "name-asc":
          sorted.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
          break;
        case "name-desc":
          sorted.sort((a, b) => (b.name || "").localeCompare(a.name || ""));
          break;
        case "newest":
          sorted.sort((a, b) => (b._createdAt || 0) - (a._createdAt || 0));
          break;
        case "oldest":
          sorted.sort((a, b) => (a._createdAt || 0) - (b._createdAt || 0));
          break;
        case "largest":
          sorted.sort((a, b) => (b._fileSize || 0) - (a._fileSize || 0));
          break;
        case "smallest":
          sorted.sort((a, b) => (a._fileSize || 0) - (b._fileSize || 0));
          break;
        case "manual":
          break;
      }
      return sorted;
    },
    _renderTagCloud() {
      const tagCloudEl = document.querySelector("#tagCloud");
      if (!tagCloudEl)
        return;
      const tagCounts = {};
      (window.AppState.cards || []).forEach((c) => {
        (c.tags || []).forEach((t) => {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
      });
      const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
      if (sortedTags.length === 0) {
        tagCloudEl.innerHTML = '<span style="font-size:0.68rem;color:var(--text-muted);">' + I18n.t("gen.untagged") + "</span>";
        return;
      }
      tagCloudEl.innerHTML = sortedTags.map(([tag, count]) => {
        const isActive = this._activeTagFilters.has(tag);
        return '<span class="tag-chip' + (isActive ? " active" : "") + '" data-tag="' + Ui.escapeAttr(tag) + '">' + Ui.escapeHtml(tag) + ' <span class="tag-count">' + count + "</span>" + "</span>";
      }).join("");
      tagCloudEl.querySelectorAll(".tag-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const tag = chip.dataset.tag;
          if (this._activeTagFilters.has(tag)) {
            this._activeTagFilters.delete(tag);
          } else {
            this._activeTagFilters.add(tag);
          }
          this.renderCardList();
        });
      });
    },
    renderCardList() {
      const $ = (sel) => document.querySelector(sel);
      const { cards, activeCard } = window.AppState;
      const container = $("#cardList");
      const emptyState = $("#emptyState");
      const searchWrap = $("#cardSearchWrap");
      const controlsWrap = $("#libraryControls");
      $("#cardCount").textContent = I18n.t("left.cards", { count: cards.length });
      if (searchWrap)
        searchWrap.style.display = cards.length > 3 ? "" : "none";
      if (controlsWrap)
        controlsWrap.style.display = cards.length > 3 ? "" : "none";
      this._renderTagCloud();
      let filtered = cards;
      if (this._searchQuery) {
        const q = this._searchQuery.toLowerCase();
        filtered = cards.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.creator || "").toLowerCase().includes(q) || (c.tags || []).some((t) => t.toLowerCase().includes(q)));
      }
      if (this._activeTagFilters.size > 0) {
        filtered = filtered.filter((c) => {
          const cardTags = new Set((c.tags || []).map((t) => t.toLowerCase()));
          for (const filter of this._activeTagFilters) {
            if (!cardTags.has(filter.toLowerCase()))
              return false;
          }
          return true;
        });
      }
      filtered = this._sortCards(filtered);
      if (filtered.length === 0 && (this._searchQuery || this._activeTagFilters.size > 0)) {
        container.innerHTML = '<div class="text-center text-muted py-4">' + I18n.t("gen.noMatch") + "</div>";
        emptyState.style.display = "none";
        return;
      }
      if (filtered.length === 0) {
        container.innerHTML = "";
        emptyState.style.display = "flex";
        return;
      }
      emptyState.style.display = "none";
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      container.innerHTML = filtered.map((card) => {
        const isActive = activeCard && activeCard._id === card._id;
        const isBatch = this._selectedIds.has(card._id);
        const tags = (card.tags || []).slice(0, 2);
        const thumb = card._thumbnail || card._imageBase64;
        const desc = (card.description || "").slice(0, 300);
        const fileSize = card._fileSize ? Ui.formatFileSize(card._fileSize) : "";
        return '<div class="card-list-item' + (isActive ? " active" : "") + (isBatch ? " batch-selected" : "") + '" data-card-id="' + card._id + '" role="option" aria-selected="' + isActive + '">' + '<div class="card-list-avatar">' + (thumb ? '<img src="' + Ui.escapeAttr(thumb) + '" alt="">' : '<i class="bi bi-person-fill"></i>') + "</div>" + '<div class="card-list-info">' + '<div class="card-list-name">' + Ui.escapeHtml(card.name || I18n.t("gen.unnamed")) + "</div>" + '<div class="card-list-meta">' + (card.creator ? Ui.escapeHtml(card.creator) : "") + (card.creator && tags.length ? " · " : "") + tags.map((t) => Ui.escapeHtml(t)).join(", ") + (fileSize ? ' <span class="meta-filesize">' + fileSize + "</span>" : "") + "</div></div>" + '<input type="checkbox" class="card-batch-check" data-card-id="' + card._id + '"' + (isBatch ? " checked" : "") + ">" + '<span class="card-drag-handle" draggable="true" data-card-id="' + card._id + '"><i class="bi bi-grip-vertical"></i></span>' + (card.spec_version ? '<span class="card-list-badge bg-purple">v' + Ui.escapeHtml(card.spec_version) + "</span>" : "") + '<div class="card-preview-tooltip">' + (thumb ? '<img class="preview-avatar" src="' + Ui.escapeAttr(thumb) + '" alt="">' : "") + '<div class="fw-semibold">' + Ui.escapeHtml(card.name || I18n.t("gen.unnamed")) + "</div>" + (card.creator ? '<div class="text-muted" style="font-size:0.7rem;">' + I18n.t("gen.byCreator", { name: Ui.escapeHtml(card.creator) }) + "</div>" : "") + (desc ? '<div class="preview-desc">' + Ui.escapeHtml(desc) + "</div>" : "") + "</div></div>";
      }).join("");
      Anims.staggerFadeIn(container.querySelectorAll(".card-list-item"), { stagger: 25, duration: 200 });
      if (!reducedMotion) {
        container.querySelectorAll(".card-list-item").forEach((item) => {
          item.addEventListener("mousemove", (e) => {
            const rect = item.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const rotateX = (y - centerY) / centerY * -4;
            const rotateY = (x - centerX) / centerX * 4;
            item.style.transform = "perspective(400px) rotateX(" + rotateX + "deg) rotateY(" + rotateY + "deg) scale(1.01)";
            item.style.setProperty("--mouse-x", x / rect.width * 100 + "%");
            item.style.setProperty("--mouse-y", y / rect.height * 100 + "%");
          });
          item.addEventListener("mouseleave", () => {
            item.style.transform = "";
          });
        });
      }
      if (!this._cardListBound && container) {
        this._cardListBound = true;
        container.addEventListener("click", (e) => {
          const checkbox = e.target.closest(".card-batch-check");
          if (checkbox) {
            e.stopPropagation();
            CardManager2._toggleBatchSelect(checkbox.dataset.cardId);
            return;
          }
          const item = e.target.closest(".card-list-item");
          if (!item)
            return;
          const card = window.AppState.cards.find((c) => c._id === item.dataset.cardId);
          if (card)
            CardManager2.selectCard(card);
        });
        const searchInput = $("#cardSearchInput");
        if (searchInput) {
          searchInput.addEventListener("input", Ui.debounce(() => {
            this._searchQuery = searchInput.value.trim();
            this.renderCardList();
          }, DEBOUNCE_SEARCH_MS));
        }
        let dragId = null;
        container.addEventListener("dragstart", (e) => {
          const handle = e.target.closest(".card-drag-handle");
          if (!handle)
            return;
          dragId = handle.dataset.cardId;
          e.dataTransfer.effectAllowed = "move";
          const dragItem = handle.closest(".card-list-item");
          if (dragItem && !Anims._disabled()) {
            dragItem.style.transition = "transform 150ms ease, opacity 150ms ease";
            dragItem.style.transform = "scale(0.97)";
            dragItem.style.opacity = "0.7";
          }
        });
        container.addEventListener("dragover", (e) => {
          e.preventDefault();
          const item = e.target.closest(".card-list-item");
          if (item)
            item.classList.add("drag-over");
        });
        container.addEventListener("dragleave", (e) => {
          const item = e.target.closest(".card-list-item");
          if (item)
            item.classList.remove("drag-over");
        });
        container.addEventListener("drop", (e) => {
          e.preventDefault();
          const item = e.target.closest(".card-list-item");
          if (item)
            item.classList.remove("drag-over");
          if (!dragId || !item)
            return;
          if (this._searchQuery || this._activeTagFilters.size > 0) {
            Ui.showToast(I18n.t("toast.reorderFiltered"), "info");
            dragId = null;
            return;
          }
          const dropId = item.dataset.cardId;
          if (dragId === dropId)
            return;
          const cards2 = window.AppState.cards;
          const fromIdx = cards2.findIndex((c) => c._id === dragId);
          const toIdx = cards2.findIndex((c) => c._id === dropId);
          if (fromIdx < 0 || toIdx < 0)
            return;
          const [moved] = cards2.splice(fromIdx, 1);
          const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
          cards2.splice(adjustedTo, 0, moved);
          CardStorage.saveCardIndex(cards2);
          this.renderCardList();
          dragId = null;
        });
        container.addEventListener("dragend", () => {
          const dragItem = container.querySelector('.card-list-item[style*="scale"]');
          if (dragItem) {
            dragItem.style.transform = "";
            dragItem.style.opacity = "";
          }
          dragId = null;
        });
      }
    },
    _switchPromise: Promise.resolve(),
    async selectCard(cardMeta) {
      if (!cardMeta || !cardMeta._id)
        return;
      const run = () => this._doSelect(cardMeta);
      const next = this._switchPromise.then(run, run);
      this._switchPromise = next.catch(() => {});
      return next;
    },
    async _doSelect(cardMeta) {
      const { activeCard, isAiLoading } = window.AppState;
      if (isAiLoading) {
        AiChat._abortAll();
        AiChat._gen++;
        window.AppState.isAiLoading = false;
        AiChat.updateSendButton();
      }
      if (activeCard && activeCard._id !== cardMeta._id)
        await Editor.syncEditorToCard();
      const fullCard = await CardStorage.getCard(cardMeta._id);
      if (!fullCard)
        return;
      window.AppState.activeCard = fullCard;
      CardStorage.setActiveCardId(fullCard._id);
      try {
        const b64 = await CardStorage.getImage(fullCard._id);
        if (b64)
          window.AppState.activeCard._imageBase64 = b64;
      } catch (e) {
        console.error("Failed to load image from IndexedDB:", e);
      }
      window.AppState.chatHistory = CardStorage.getChatHistory(fullCard._id);
      const sessions = CardStorage.getChatSessions(fullCard._id);
      if (sessions.length > 0) {
        const latestSession = sessions[0];
        const sessionMessages = CardStorage.getSessionMessages(fullCard._id, latestSession.id);
        if (sessionMessages.length > 0) {
          window.AppState.chatHistory = sessionMessages;
          AiChat._currentSessionId = latestSession.id;
        } else {
          AiChat._currentSessionId = latestSession.id;
          CardStorage.saveSessionMessages(fullCard._id, latestSession.id, window.AppState.chatHistory);
        }
      } else {
        AiChat._currentSessionId = null;
      }
      AiChat._historyRendered = false;
      AiChat.renderChatHistory();
      Editor.populateEditor(fullCard);
      this.renderCardList();
      Ui.setDirty(false);
      Ui.updateUIState();
      AiChat.updateContextBar();
      setTimeout(() => {
        const aiInput = document.querySelector("#aiInput");
        if (aiInput)
          aiInput.focus();
      }, 100);
    },
    async createNewCard() {
      const { activeCard } = window.AppState;
      if (activeCard)
        await Editor.syncEditorToCard();
      const card = CardEngine.createEmptyCard();
      await CardStorage.upsertCard(card);
      window.AppState.cards = CardStorage.getCards();
      this.renderCardList();
      await this.selectCard(card);
      document.querySelector("#editName").focus();
      Ui.showToast(I18n.t("toast.newBlank"), "success");
    },
    async saveCurrentCard() {
      const { activeCard } = window.AppState;
      if (!activeCard) {
        Ui.showToast(I18n.t("toast.noCardSave"), "warning");
        return;
      }
      await Editor.syncEditorToCard();
      window.AppState._dirty = false;
      Ui.setDirty(false);
      Ui.flashSaved();
      this.renderCardList();
      Ui.showToast(I18n.t("toast.cardSaved"), "success");
    },
    async duplicateCard() {
      const { activeCard } = window.AppState;
      if (!activeCard) {
        Ui.showToast(I18n.t("toast.noCardDup"), "warning");
        return;
      }
      await Editor.syncEditorToCard();
      const clone = JSON.parse(JSON.stringify(activeCard));
      clone._id = CardEngine._uniqueId();
      clone.name = (clone.name || (I18n.t ? I18n.t("gen.unnamed") : "Unnamed")) + (I18n.t ? I18n.t("gen.copySuffix") : " (Copy)");
      await CardStorage.upsertCard(clone);
      if (clone._imageBase64)
        await CardStorage.saveImage(clone._id, clone._imageBase64);
      window.AppState.cards = CardStorage.getCards();
      this.renderCardList();
      await this.selectCard(clone);
      Ui.showToast(I18n.t("toast.cardDup"), "success");
    },
    async deleteActiveCard() {
      const { activeCard, cards } = window.AppState;
      if (!activeCard)
        return;
      await Editor.syncEditorToCard();
      const snapshot = { ...activeCard };
      if (!snapshot._imageBase64) {
        try {
          const b64 = await CardStorage.getImage(snapshot._id);
          if (b64)
            snapshot._imageBase64 = b64;
        } catch (_) {}
      }
      const snapshotIndex = cards.findIndex((c) => c._id === activeCard._id);
      try {
        await CardStorage.deleteCard(activeCard._id);
      } catch (e) {
        console.error("Failed to delete card:", e);
        Ui.showToast(I18n.t ? I18n.t("toast.deleteFailed") || "Failed to delete card" : "Failed to delete card", "danger");
        return;
      }
      window.AppState.cards = CardStorage.getCards();
      window.AppState.activeCard = null;
      Editor.hideEditor();
      this.renderCardList();
      if (window.AppState.cards.length > 0)
        await this.selectCard(window.AppState.cards[0]);
      let undone = false;
      const DURATION = 8000;
      const toastLabel = I18n && I18n.t ? I18n.t("gen.toastAutoHide", { s: Math.ceil(DURATION / 1000) }) : "Auto-hides in 8s";
      const toastEl = document.createElement("div");
      toastEl.className = "toast align-items-center border-0";
      toastEl.setAttribute("role", "alert");
      toastEl.innerHTML = '<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2 w-100"><div class="flex-grow-1 d-flex align-items-center gap-2">' + '<i class="bi bi-trash-fill text-danger"></i>' + I18n.t("toast.cardDeleted", { name: Ui.escapeHtml(snapshot.name || I18n.t("gen.unnamed")) }) + '<button class="btn btn-sm btn-outline-accent ms-2" id="undoDeleteBtn">' + I18n.t("toast.undo") + "</button>" + '</div><div class="toast-timer" style="font-size:0.62rem;white-space:nowrap;font-family:var(--font-mono);min-width:3.2em;text-align:right;">' + toastLabel + '</div><button type="button" class="btn-close btn-close-white ms-2" data-bs-dismiss="toast"></button></div></div>';
      document.querySelector("#toastContainer").appendChild(toastEl);
      const toast = new bootstrap.Toast(toastEl, { delay: DURATION });
      toast.show();
      const timerEl = toastEl.querySelector(".toast-timer");
      if (timerEl) {
        const interval = 200;
        let remaining = DURATION;
        const tick = () => {
          remaining -= interval;
          if (remaining <= 0 || undone) {
            timerEl.textContent = "";
            return;
          }
          const secs = Math.ceil(remaining / 1000);
          timerEl.textContent = I18n && I18n.t ? I18n.t("gen.toastAutoHide", { s: secs }) : "Auto-hides in " + secs + "s";
        };
        const timer = setInterval(tick, interval);
        const clearTimer = () => {
          clearInterval(timer);
          toastEl.removeEventListener("hidden.bs.toast", clearTimer);
        };
        toastEl.addEventListener("hidden.bs.toast", clearTimer);
        const observer = new MutationObserver(() => {
          if (!document.body.contains(toastEl)) {
            clearTimer();
            observer.disconnect();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        toastEl.addEventListener("hidden.bs.toast", () => {
          toastEl.remove();
          if (!undone)
            return;
        });
      } else {
        toastEl.addEventListener("hidden.bs.toast", () => {
          toastEl.remove();
          if (!undone)
            return;
        });
      }
      const undoBtn = toastEl.querySelector("#undoDeleteBtn");
      undoBtn.addEventListener("click", async () => {
        undone = true;
        toast.hide();
        await CardStorage.upsertCard(snapshot);
        if (snapshot._imageBase64) {
          await CardStorage.saveImage(snapshot._id, snapshot._imageBase64);
          snapshot._hasImage = true;
        }
        window.AppState.cards = CardStorage.getCards();
        this.renderCardList();
        await this.selectCard(snapshot);
        Ui.showToast(I18n.t("toast.cardRestored"), "success");
      });
    }
  };
  if (typeof window !== "undefined")
    window.CardManager = CardManager2;

  // js/aiChat.js
  var AiChat2 = {
    _abortControllers: [],
    _historyRendered: false,
    _selectedFields: new Set,
    _greetingCount: 3,
    _applyStore: new Map,
    _applyQueue: [],
    _applyElMap: new WeakMap,
    _applyIndex: 0,
    _currentSessionId: null,
    _gen: 0,
    MAX_PARALLEL_FIELDS: 20,
    FIELD_DEFS: [
      { id: "description", labelKey: "ai.target.description", icon: "bi-card-text" },
      { id: "personality", labelKey: "ai.target.personality", icon: "bi-brain" },
      { id: "first_mes", labelKey: "ai.target.first_mes", icon: "bi-chat-dots" },
      { id: "scenario", labelKey: "ai.target.scenario", icon: "bi-geo-alt" },
      { id: "mes_example", labelKey: "ai.target.mes_example", icon: "bi-chat-square-text" },
      { id: "alternate_greetings", labelKey: "ai.target.alternate_greetings", icon: "bi-list-ol", hasCount: true },
      { id: "system_prompt", labelKey: "ai.target.system_prompt", icon: "bi-terminal" },
      { id: "post_history_instructions", labelKey: "ai.target.post_history_instructions", icon: "bi-arrow-repeat" },
      { id: "creator_notes", labelKey: "ai.target.creator_notes", icon: "bi-pencil" }
    ],
    _renderFieldChips() {
      const $ = (sel) => document.querySelector(sel);
      const container = $("#aiFieldChips");
      if (!container)
        return;
      const chipHtml = this.FIELD_DEFS.map((f) => {
        const isActive = this._selectedFields.has(f.id);
        const label = I18n.t ? I18n.t(f.labelKey) : f.id;
        return '<span class="ai-field-chip' + (isActive ? " active" : "") + '" data-field="' + f.id + '">' + '<i class="bi ' + f.icon + '"></i>' + Ui.escapeHtml(label) + "</span>";
      }).join("");
      const allActive = this._selectedFields.size >= this.FIELD_DEFS.length;
      const allChip = '<span class="ai-field-chip all-fields' + (allActive ? " active" : "") + '" data-field="__all__">' + '<i class="bi bi-stars"></i>' + (I18n.t ? I18n.t("ai.target.full") : "All Fields") + "</span>";
      container.innerHTML = allChip + chipHtml;
      const self = this;
      container.querySelectorAll(".ai-field-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const field = chip.dataset.field;
          self._toggleFieldChip(field);
          self._renderFieldChips();
          self.updateContextBar();
        });
      });
      const countWrap = document.querySelector("#aiGreetingCount");
      if (countWrap) {
        countWrap.style.display = this._selectedFields.has("alternate_greetings") ? "flex" : "none";
      }
      const countInput = document.querySelector("#aiGreetingCountInput");
      if (countInput) {
        this._greetingCount = parseInt(countInput.value) || 3;
      }
    },
    _toggleFieldChip(field) {
      if (field === "__all__") {
        const allSelected = this._selectedFields.size >= this.FIELD_DEFS.length;
        if (allSelected) {
          this._selectedFields.clear();
        } else {
          this.FIELD_DEFS.forEach((f) => this._selectedFields.add(f.id));
        }
        return;
      }
      if (this._selectedFields.has(field)) {
        this._selectedFields.delete(field);
      } else {
        this._selectedFields.add(field);
      }
    },
    getSelectedFields() {
      return [...this._selectedFields];
    },
    send(retryPrompt) {
      const $ = (sel) => document.querySelector(sel);
      const input = $("#aiInput");
      const prompt = retryPrompt || input.value.trim();
      const { activeCard } = window.AppState;
      if (!prompt || window.AppState.isAiLoading)
        return;
      if (!activeCard) {
        Ui.showToast(I18n.t("toast.selectCard"), "warning");
        return;
      }
      const selectedFields = this.getSelectedFields();
      if (selectedFields.length === 0) {
        Ui.showToast(I18n.t("toast.selectField"), "info");
        return;
      }
      if (selectedFields.length > this.MAX_PARALLEL_FIELDS) {
        Ui.showToast(I18n.t ? I18n.t("toast.tooManyFields", { max: this.MAX_PARALLEL_FIELDS }) : "Too many fields selected. Max " + this.MAX_PARALLEL_FIELDS + " at once.", "warning");
        return;
      }
      const histPanel = $("#aiHistoryPanel");
      if (histPanel && histPanel.classList.contains("open")) {
        this.toggleHistory(false);
      }
      if (!AIService.hasApiKey()) {
        Ui.showToast(I18n.t("toast.apiKey"), "warning");
        return;
      }
      const modelId = $("#aiModelSelect").value;
      if (!modelId) {
        Ui.showToast(I18n.t("toast.selectModel"), "warning");
        return;
      }
      if (!retryPrompt) {
        input.value = "";
        const userIdx = window.AppState.chatHistory.length;
        this.addChatMessage("user", prompt, null, null, userIdx);
      }
      window.AppState.isAiLoading = true;
      this.updateSendButton();
      window.AppState.chatHistory.push({ role: "user", content: prompt });
      CardStorage.saveChatHistory(window.AppState.chatHistory, window.AppState.activeCard?._id);
      const cardId = window.AppState.activeCard?._id || "global";
      if (!this._currentSessionId) {
        const now = Date.now();
        const session = {
          id: "ses_" + now + "_" + Math.random().toString(36).slice(2, 7),
          created: now,
          lastUpdated: now,
          preview: prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt,
          messageCount: 1
        };
        this._currentSessionId = session.id;
        CardStorage.saveChatSession(cardId, session);
      }
      CardStorage.saveSessionMessages(cardId, this._currentSessionId, window.AppState.chatHistory);
      const groupedCard = this._createGroupedCard(selectedFields);
      this._abortAll();
      const gen = ++this._gen;
      const capturedGreetingCount = this._greetingCount;
      const fieldLabel = (f) => I18n.t ? I18n.t(this.FIELD_DEFS.find((d) => d.id === f)?.labelKey || "") : f;
      let completedCount = 0;
      let combinedContent = "";
      selectedFields.forEach((field) => {
        const controller = new AbortController;
        this._abortControllers.push(controller);
        const section = this._addFieldSection(groupedCard, field, fieldLabel(field));
        const contentEl = section.querySelector(".multi-field-content");
        const history = this._getRecentHistory(10);
        AIService.chatStream(prompt, this.buildSystemPrompt(field, capturedGreetingCount), modelId, (fullText) => {
          contentEl.innerHTML = Ui.escapeHtml(fullText).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/\n/g, "<br>");
          const container = document.querySelector("#aiChatMessages");
          container.scrollTop = container.scrollHeight;
        }, controller.signal, false, history).then((result) => {
          if (gen !== this._gen)
            return;
          this._releaseController(controller);
          try {
            this._finalizeFieldSection(section, field, result.content);
          } catch (e) {
            console.error("aiChat: failed to finalize field section:", e);
          }
          completedCount++;
          combinedContent += `

[` + field + `]
` + result.content;
          if (completedCount === selectedFields.length) {
            this._finalizeGroupedCard(groupedCard, selectedFields.length);
            window.AppState.chatHistory.push({ role: "assistant", content: combinedContent });
            CardStorage.saveChatHistory(window.AppState.chatHistory, window.AppState.activeCard?._id);
            this._updateSession();
            window.AppState.isAiLoading = false;
            this.updateSendButton();
            Settings.refreshCredits();
          }
        }).catch((err) => {
          if (gen !== this._gen)
            return;
          this._releaseController(controller);
          try {
            section.classList.add("error");
            section.classList.remove("streaming");
            const label = section.querySelector(".multi-field-label");
            if (label)
              label.innerHTML = label.innerHTML.replace(I18n.t ? I18n.t("ai.streaming") : "streaming...", I18n.t ? I18n.t("ai.failed") : "failed");
            contentEl.textContent = err.name === "AbortError" ? I18n.t ? I18n.t("ai.cancelled") : "Cancelled." : (I18n.t ? I18n.t("ai.errorPrefix") : "Error: ") + err.message;
          } catch (_) {}
          completedCount++;
          if (completedCount === selectedFields.length) {
            try {
              this._finalizeGroupedCard(groupedCard, selectedFields.length);
            } catch (e) {
              console.error("aiChat: failed to finalize grouped card:", e);
            }
            if (combinedContent.trim()) {
              window.AppState.chatHistory.push({ role: "assistant", content: combinedContent.trim() });
              CardStorage.saveChatHistory(window.AppState.chatHistory, window.AppState.activeCard?._id);
              this._updateSession();
            }
            window.AppState.isAiLoading = false;
            this.updateSendButton();
            Settings.refreshCredits();
          }
        });
      });
    },
    buildSystemPrompt(targetField, greetingCountOverride) {
      const { activeCard } = window.AppState;
      const greetingCount = greetingCountOverride || this._greetingCount;
      const fieldLabel = I18n.t ? I18n.t(this.FIELD_DEFS.find((d) => d.id === targetField)?.labelKey || targetField) : targetField;
      const cardForPrompt = activeCard ? { ...activeCard } : CardEngine.createEmptyCard();
      delete cardForPrompt._id;
      delete cardForPrompt._filename;
      delete cardForPrompt._hasImage;
      delete cardForPrompt._imageBase64;
      delete cardForPrompt._thumbnail;
      delete cardForPrompt._createdAt;
      delete cardForPrompt._fileSize;
      const parts = [
        CardStorage.getPrompt("assistant") || `You are an AI assistant helping edit SillyTavern character cards.
SillyTavern is an AI roleplay frontend. Cards define character personalities.`,
        "",
        "Here is the FULL character card for context:",
        "```json",
        CardEngine.toJSON(cardForPrompt),
        "```",
        ""
      ];
      if (targetField === "alternate_greetings") {
        const existing = activeCard && activeCard.alternate_greetings || [];
        const greetInstr = (CardStorage.getPrompt("greetingsSystem") || Settings.getDefaultPrompt("greetingsSystem")).split("{count}").join(String(greetingCount)).split("{current}").join(existing.length ? JSON.stringify(existing) : "(none)");
        parts.push(greetInstr);
      } else {
        const current = activeCard && activeCard[targetField] !== undefined ? activeCard[targetField] || "(empty)" : "(empty)";
        const fieldInstr = (CardStorage.getPrompt("fieldsEdit") || Settings.getDefaultPrompt("fieldsEdit")).split("{field}").join(fieldLabel).split("{current}").join(current);
        parts.push(fieldInstr);
      }
      return parts.join(`
`);
    },
    _createGroupedCard(fields) {
      const $ = (sel) => document.querySelector(sel);
      const container = $("#aiChatMessages");
      const welcome = container.querySelector(".ai-welcome");
      if (welcome)
        welcome.remove();
      const el = document.createElement("div");
      el.className = "ai-message assistant multi-field";
      el.innerHTML = '<div class="multi-field-header">' + '<i class="bi bi-robot"></i> ' + (I18n.t ? I18n.t("ai.editing", { count: fields.length }) : "Editing " + fields.length + " field" + (fields.length > 1 ? "s" : "") + "...") + "</div>";
      container.appendChild(el);
      Anims.staggerFadeIn(el, { duration: 200, from: 10 });
      container.scrollTop = container.scrollHeight;
      return el;
    },
    _addFieldSection(groupedCard, field, label) {
      const section = document.createElement("div");
      section.className = "multi-field-section streaming";
      section.setAttribute("data-field", field);
      section.innerHTML = '<div class="multi-field-label">' + '<i class="bi bi-hourglass-split"></i> ' + Ui.escapeHtml(label) + '<span class="multi-field-status"><span class="spinner-border spinner-border-sm text-accent"></span> ' + (I18n.t ? I18n.t("ai.streaming") : "streaming...") + "</span>" + "</div>" + '<div class="multi-field-content"></div>' + '<div class="multi-field-actions" style="display:none;"></div>';
      groupedCard.appendChild(section);
      return section;
    },
    _finalizeFieldSection(section, field, content) {
      section.classList.remove("streaming");
      section.classList.add("done");
      const label = section.querySelector(".multi-field-label");
      if (label) {
        const icon = label.querySelector(".bi");
        if (icon) {
          icon.className = "bi bi-check-circle-fill";
        }
        const status = label.querySelector(".multi-field-status");
        if (status)
          status.remove();
      }
      const contentEl = section.querySelector(".multi-field-content");
      if (contentEl && content.length > 300) {
        contentEl.classList.add("collapsed");
        contentEl.addEventListener("click", function onClickExpand() {
          this.classList.toggle("collapsed");
          const viewBtn = section.querySelector(".multi-field-expand-btn");
          if (viewBtn) {
            const isCollapsed = this.classList.contains("collapsed");
            viewBtn.innerHTML = isCollapsed ? '<i class="bi bi-arrows-expand"></i> ' + (I18n.t ? I18n.t("ai.viewFullResult") : "View full result") : '<i class="bi bi-arrows-collapse"></i> ' + (I18n.t ? I18n.t("ai.showLess") : "Show less");
          }
        });
      }
      const actions = section.querySelector(".multi-field-actions");
      if (actions) {
        actions.style.display = "flex";
        const self = this;
        if (content.length > 300) {
          const viewBtn = document.createElement("button");
          viewBtn.className = "multi-field-expand-btn";
          viewBtn.type = "button";
          viewBtn.innerHTML = '<i class="bi bi-arrows-expand"></i> ' + (I18n.t ? I18n.t("ai.viewFullResult") : "View full result");
          viewBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            self._showResultModal(field, content);
          });
          actions.appendChild(viewBtn);
        }
        this._registerApply(section, field, content);
        const btn = document.createElement("button");
        btn.className = "btn btn-outline-accent btn-sm";
        btn.innerHTML = '<i class="bi bi-eye me-1"></i> ' + (I18n.t ? I18n.t("ai.reviewApply") : "Review & Apply");
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          self.tryApplyAIResponse(content, field, section);
        });
        actions.appendChild(btn);
      }
    },
    _showResultModal(field, content) {
      const $ = (sel) => document.querySelector(sel);
      const fieldLabel = I18n.t ? I18n.t(this.FIELD_DEFS.find((d) => d.id === field)?.labelKey || field) : field;
      const modalEl = $("#aiResultModal");
      if (!modalEl)
        return;
      const titleEl = modalEl.querySelector(".modal-title");
      const bodyEl = modalEl.querySelector(".modal-body");
      if (titleEl)
        titleEl.innerHTML = '<i class="bi bi-file-text me-2 text-accent"></i>' + Ui.escapeHtml(fieldLabel);
      if (bodyEl)
        bodyEl.textContent = content;
      this._resultModal = this._resultModal || new bootstrap.Modal(modalEl);
      const modal = this._resultModal;
      const copyBtn = modalEl.querySelector("#btnCopyResult");
      if (copyBtn) {
        const copyLabel = () => '<i class="bi bi-clipboard me-1"></i>' + (I18n.t ? I18n.t("ai.copy") : "Copy");
        copyBtn.innerHTML = copyLabel();
        if (this._copyAbort)
          this._copyAbort.abort();
        this._copyAbort = new AbortController;
        let copyTimeout = null;
        const cleanupCopy = () => {
          if (copyTimeout) {
            clearTimeout(copyTimeout);
            copyTimeout = null;
          }
        };
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(content).then(() => {
            copyBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>' + (I18n.t ? I18n.t("ai.copied") : "Copied!");
            copyTimeout = setTimeout(() => {
              copyBtn.innerHTML = copyLabel();
            }, 2000);
          }).catch(() => {
            copyBtn.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>' + (I18n.t ? I18n.t("ai.copyFailed") : "Failed");
          });
        }, { signal: this._copyAbort.signal });
        modalEl.addEventListener("hidden.bs.modal", cleanupCopy, { once: true });
      }
      modal.show();
    },
    _finalizeGroupedCard(groupedCard, total) {
      const header = groupedCard.querySelector(".multi-field-header");
      if (header) {
        const done = groupedCard.querySelectorAll(".multi-field-section.done").length;
        const errs = groupedCard.querySelectorAll(".multi-field-section.error").length;
        let msg;
        if (I18n.t) {
          msg = I18n.t("ai.doneSummary", { done, total, errs });
        } else {
          msg = done + "/" + total + " field" + (total > 1 ? "s" : "") + " done";
          if (errs > 0)
            msg += " · " + errs + " failed";
        }
        header.innerHTML = '<i class="bi bi-robot"></i> ' + Ui.escapeHtml(msg);
      }
    },
    _abortAll() {
      this._abortControllers.forEach((c) => c.abort());
      this._abortControllers = [];
    },
    _releaseController(controller) {
      const idx = this._abortControllers.indexOf(controller);
      if (idx >= 0)
        this._abortControllers.splice(idx, 1);
    },
    _getRecentHistory(maxMessages = 10, includeLast = false) {
      const { chatHistory } = window.AppState;
      if (!chatHistory || chatHistory.length <= 1)
        return [];
      return chatHistory.slice(0, includeLast ? chatHistory.length : -1).slice(-maxMessages);
    },
    _sendFullCard(prompt, opts) {
      opts = opts || {};
      const $ = (sel) => document.querySelector(sel);
      const { activeCard } = window.AppState;
      if (window.AppState.isAiLoading)
        return;
      if (!AIService.hasApiKey()) {
        Ui.showToast(I18n.t("toast.apiKey"), "warning");
        return;
      }
      if (!activeCard) {
        Ui.showToast(I18n.t("toast.selectCard"), "warning");
        return;
      }
      const modelSelect = $("#aiModelSelect");
      const input = $("#aiInput");
      if (!modelSelect || !input) {
        Ui.showToast(I18n.t("toast.selectModel"), "warning");
        return;
      }
      const modelId = modelSelect.value;
      if (!modelId) {
        Ui.showToast(I18n.t("toast.selectModel"), "warning");
        return;
      }
      input.value = "";
      this._abortAll();
      const gen = ++this._gen;
      window.AppState.isAiLoading = true;
      this.updateSendButton();
      this.addChatMessage("user", prompt, null, null, window.AppState.chatHistory.length);
      window.AppState.chatHistory.push({ role: "user", content: prompt });
      CardStorage.saveChatHistory(window.AppState.chatHistory, activeCard?._id);
      const cardId = activeCard?._id || "global";
      if (!this._currentSessionId) {
        const now = Date.now();
        const session = {
          id: "ses_" + now + "_" + Math.random().toString(36).slice(2, 7),
          created: now,
          lastUpdated: now,
          preview: prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt,
          messageCount: 1
        };
        this._currentSessionId = session.id;
        CardStorage.saveChatSession(cardId, session);
      }
      CardStorage.saveSessionMessages(cardId, this._currentSessionId, window.AppState.chatHistory);
      const streamingEl = this.createStreamingMessage();
      let shimmerGone = false;
      const cardJson = activeCard ? CardEngine.toJSON(activeCard) : "";
      const systemPrompt = [
        CardStorage.getPrompt("fullCard") || `You are an AI assistant helping edit SillyTavern character cards.
SillyTavern is an AI roleplay frontend. Cards define character personalities.`,
        "",
        "Here is the FULL character card for context:",
        "```json",
        cardJson,
        "```",
        "",
        opts.systemPromptInstruction || (CardStorage.getPrompt("fullCardInstr") || Settings.getDefaultPrompt("fullCardInstr"))
      ].join(`
`);
      const controller = new AbortController;
      this._abortControllers.push(controller);
      AIService.chatStream(prompt, systemPrompt, modelId, (fullText) => {
        if (!shimmerGone && fullText) {
          shimmerGone = true;
          const sk = streamingEl.querySelector(".ai-shimmer");
          if (sk)
            sk.remove();
        }
        streamingEl.querySelector(".ai-message-content").innerHTML = Ui.escapeHtml(fullText).replace(/```(?:\w+)?\n?([\s\S]*?)```/g, "<pre>$1</pre>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/\n/g, "<br>");
        const container = document.querySelector("#aiChatMessages");
        container.scrollTop = container.scrollHeight;
      }, controller.signal, true, this._getRecentHistory(10)).then((result) => {
        if (gen !== this._gen) {
          streamingEl.remove();
          return;
        }
        streamingEl.remove();
        const asstIdx = window.AppState.chatHistory.length;
        const applyTarget = opts.applyTarget || "full";
        this.addChatMessage("assistant", result.content, result.usage, { content: result.content, field: applyTarget }, asstIdx);
        window.AppState.chatHistory.push({ role: "assistant", content: result.content });
        CardStorage.saveChatHistory(window.AppState.chatHistory, activeCard?._id);
        this._updateSession();
        this.tryApplyAIResponse(result.content, applyTarget);
        Settings.refreshCredits();
      }).catch((err) => {
        if (gen !== this._gen) {
          streamingEl.remove();
          return;
        }
        streamingEl.remove();
        if (err && err.name === "AbortError") {
          this.addChatMessage("system", I18n.t ? I18n.t("toast.genStopped") : "Generation stopped.");
        } else {
          this.addChatMessage("system", (I18n.t ? I18n.t("ai.errorPrefix") : "Error: ") + err.message);
          Ui.showToast(I18n.t("toast.aiError", { error: err.message }), "danger");
        }
      }).finally(() => {
        this._releaseController(controller);
        if (gen !== this._gen)
          return;
        window.AppState.isAiLoading = false;
        this.updateSendButton();
      });
    },
    _renderDiff(oldText, newText) {
      const oldEl = document.querySelector("#aiDiffOld");
      const newEl = document.querySelector("#aiDiffNew");
      if (!oldEl || !newEl)
        return;
      if (typeof Diff === "undefined") {
        oldEl.textContent = oldText || (I18n.t ? I18n.t("gen.empty") : "(empty)");
        newEl.textContent = newText;
        return;
      }
      const changes = Diff.diffWords(oldText || "", newText || "");
      let oldHtml = "";
      let newHtml = "";
      changes.forEach((part) => {
        const escaped = Ui.escapeHtml(part.value);
        if (part.removed) {
          oldHtml += '<span class="diff-del">' + escaped + "</span>";
        } else if (part.added) {
          newHtml += '<span class="diff-add">' + escaped + "</span>";
        } else {
          oldHtml += escaped;
          newHtml += escaped;
        }
      });
      oldEl.innerHTML = oldHtml || '<span class="diff-empty">' + (I18n.t ? I18n.t("gen.empty") : "(empty)") + "</span>";
      newEl.innerHTML = newHtml || '<span class="diff-empty">' + (I18n.t ? I18n.t("gen.empty") : "(empty)") + "</span>";
    },
    _registerApply(el, field, content) {
      if (!el)
        return null;
      let item = this._applyElMap.get(el);
      if (item) {
        item.field = field;
        item.content = content;
        return item;
      }
      item = { el, field, content, applied: false };
      this._applyElMap.set(el, item);
      this._applyQueue.push(item);
      return item;
    },
    _prepareApply(field, content) {
      const { activeCard } = window.AppState;
      if (!activeCard || !content)
        return null;
      if (field === "full") {
        const jsonStr = this._extractJSON(content);
        if (!jsonStr)
          return null;
        try {
          const parsed = CardEngine.parseJSON(jsonStr, activeCard._filename);
          return {
            oldVal: CardEngine.toJSON(activeCard),
            newVal: CardEngine.toJSON(parsed),
            applyFn: () => {
              const internal = { _id: activeCard._id, _filename: activeCard._filename, _hasImage: activeCard._hasImage, _imageBase64: activeCard._imageBase64, _thumbnail: activeCard._thumbnail };
              Object.assign(activeCard, parsed);
              Object.assign(activeCard, internal);
              Editor.populateEditor(activeCard);
              Editor.syncEditorToCard();
              Ui.showToast(I18n.t("toast.cardUpdatedAI"), "success");
            }
          };
        } catch (e) {
          console.error("Failed to parse AI JSON response", e);
          Ui.showToast(I18n.t("toast.jsonParseFailed"), "warning");
          return null;
        }
      }
      if (field === "tags") {
        const tags = this._extractJSONArray(content);
        if (!tags || tags.length === 0) {
          Ui.showToast(I18n.t ? I18n.t("toast.jsonInvalid") : "Could not parse tags from the response.", "warning");
          return null;
        }
        const existing = (activeCard.tags || []).map((t) => String(t).trim()).filter(Boolean);
        const merged = [...existing];
        let added = 0;
        tags.forEach((t) => {
          const s = String(t).trim();
          if (s && !merged.some((m) => m.toLowerCase() === s.toLowerCase())) {
            merged.push(s);
            added++;
          }
        });
        return {
          oldVal: JSON.stringify(existing, null, 2),
          newVal: JSON.stringify(merged, null, 2),
          applyFn: () => {
            activeCard.tags = merged;
            Editor.populateEditor(activeCard);
            Editor.syncEditorToCard();
            CardManager.renderCardList();
            Ui.showToast(I18n.t("toast.tagsUpdated", { count: added }), "success");
          }
        };
      }
      if (field === "alternate_greetings") {
        const greetings = this._extractJSONArray(content);
        if (!greetings || greetings.length === 0) {
          Ui.showToast(I18n.t("toast.greetingsParseFailed"), "warning");
          return null;
        }
        return {
          oldVal: JSON.stringify(activeCard.alternate_greetings || [], null, 2),
          newVal: JSON.stringify(greetings, null, 2),
          applyFn: () => {
            activeCard.alternate_greetings = greetings;
            Editor.renderGreetings(activeCard);
            Editor.syncEditorToCard();
            Ui.showToast(I18n.t("toast.greetingsUpdated", { count: greetings.length }), "success");
          }
        };
      }
      if (activeCard[field] !== undefined || ["description", "personality", "first_mes", "scenario", "mes_example", "system_prompt", "post_history_instructions", "creator_notes"].includes(field)) {
        let clean = content;
        const fence = clean.match(/```(?:json|text|markdown)?\s*\n?([\s\S]*?)```/);
        if (fence)
          clean = fence[1];
        const fieldLabel = this._applyFieldLabel(field);
        const headerRe = new RegExp("^\\[" + fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\]\\s*\\n?");
        clean = clean.replace(headerRe, "").trim();
        if (!clean) {
          Ui.showToast(I18n.t ? I18n.t("toast.emptyResponse") : "AI returned empty content — nothing to apply.", "warning");
          return null;
        }
        return {
          oldVal: activeCard[field] || "",
          newVal: clean,
          applyFn: () => {
            activeCard[field] = clean;
            Editor.populateEditor(activeCard);
            Editor.syncEditorToCard();
            CardManager.renderCardList();
            Ui.showToast(I18n.t("toast.fieldUpdated", { field }), "success");
          }
        };
      }
      return null;
    },
    _applyFieldLabel(field) {
      if (field === "full")
        return I18n.t ? I18n.t("ai.target.full") : "Full Card";
      if (field === "tags")
        return I18n.t ? I18n.t("ai.target.tags") : "Tags";
      return I18n.t ? I18n.t(this.FIELD_DEFS.find((d) => d.id === field)?.labelKey || field) : field;
    },
    tryApplyAIResponse(content, targetField, sourceEl) {
      const { activeCard } = window.AppState;
      if (!activeCard || !content)
        return;
      let item = null;
      if (sourceEl) {
        item = this._applyElMap.get(sourceEl);
        if (item) {
          item.field = targetField;
          item.content = content;
        }
      } else {
        item = this._applyQueue.find((it) => it.content === content && it.field === targetField) || null;
      }
      if (!item) {
        item = this._registerApply(sourceEl || null, targetField, content);
      }
      if (!item)
        return;
      this._applyIndex = this._applyQueue.indexOf(item);
      this._openApplyAt(this._applyIndex);
    },
    _openApplyAt(index) {
      const queue = this._applyQueue;
      if (!queue.length)
        return;
      const n = queue.length;
      const i = (index % n + n) % n;
      const item = queue[i];
      this._applyIndex = i;
      const modalEl = document.querySelector("#aiPreviewModal");
      if (!modalEl)
        return;
      const prep = this._prepareApply(item.field, item.content);
      if (!prep)
        return;
      this._previewModal = this._previewModal || new bootstrap.Modal(modalEl);
      const modal = this._previewModal;
      this._renderDiff(prep.oldVal, prep.newVal);
      const titleEl = modalEl.querySelector(".modal-title");
      if (titleEl)
        titleEl.innerHTML = '<i class="bi bi-split-cells me-2 text-accent"></i>' + Ui.escapeHtml(this._applyFieldLabel(item.field));
      const showNav = n > 1;
      const navGroup = document.querySelector("#applyNavGroup");
      const counterEl = document.querySelector("#applyNavCounter");
      const prevBtn = document.querySelector("#btnApplyPrev");
      const nextBtn = document.querySelector("#btnApplyNext");
      if (navGroup)
        navGroup.style.display = showNav ? "flex" : "none";
      if (counterEl)
        counterEl.textContent = showNav ? I18n.t ? I18n.t("ai.changesNav", { current: i + 1, total: n }) : i + 1 + " / " + n : "";
      if (prevBtn)
        prevBtn.disabled = !showNav;
      if (nextBtn)
        nextBtn.disabled = !showNav;
      const acceptBtn = document.querySelector("#btnAcceptAI");
      if (this._previewCleanup)
        this._previewCleanup();
      const handler = () => {
        if (item.applied) {
          modal.hide();
          return;
        }
        this._markApplied(item);
        if (prep.applyFn)
          prep.applyFn();
        modal.hide();
      };
      const cleanup = () => {
        acceptBtn.removeEventListener("click", handler);
        modalEl.removeEventListener("hidden.bs.modal", cleanup);
        if (this._previewCleanup === cleanup)
          this._previewCleanup = null;
      };
      this._previewCleanup = cleanup;
      acceptBtn.addEventListener("click", handler);
      modalEl.addEventListener("hidden.bs.modal", cleanup);
      modal.show();
    },
    _applyNav(delta) {
      const queue = this._applyQueue;
      if (queue.length < 2)
        return;
      this._openApplyAt((this._applyIndex + delta + queue.length) % queue.length);
    },
    _pruneApplyQueue() {
      this._applyQueue = this._applyQueue.filter((it) => it.el && it.el.isConnected);
      if (this._applyIndex >= this._applyQueue.length)
        this._applyIndex = Math.max(0, this._applyQueue.length - 1);
    },
    _markApplied(item) {
      item.applied = true;
      const el = item.el;
      if (!el)
        return;
      el.dataset.applied = "1";
      const actions = el.matches(".multi-field-section") ? el.querySelector(".multi-field-actions") : el.querySelector(".ai-message-actions") || el;
      const badge = document.createElement("span");
      badge.className = "ai-applied-badge";
      badge.innerHTML = '<i class="bi bi-check2-circle"></i> ' + (I18n.t ? I18n.t("ai.applied") : "Applied");
      actions.appendChild(badge);
      [...el.querySelectorAll("button")].forEach((b) => {
        if (/apply/i.test(b.textContent) || b.classList.contains("ai-message-reapply")) {
          b.disabled = true;
          b.classList.add("disabled");
        }
      });
    },
    _extractJSONArray(text) {
      if (!text)
        return null;
      const textStart = text.indexOf("[");
      if (textStart < 0)
        return null;
      let start = textStart;
      let depth = 0, inStr = false, esc = false;
      for (let i = start;i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc)
            esc = false;
          else if (c === "\\")
            esc = true;
          else if (c === '"')
            inStr = false;
          continue;
        }
        if (c === '"')
          inStr = true;
        else if (c === "[") {
          if (depth === 0)
            start = i;
          depth++;
        } else if (c === "]") {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(start, i + 1);
            try {
              const parsed = JSON.parse(candidate);
              if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
                return parsed;
              }
            } catch (_) {}
          }
        }
      }
      try {
        const parsed = JSON.parse(text.trim());
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
          return parsed;
        }
      } catch (_) {}
      return null;
    },
    _extractJSON(text) {
      if (!text)
        return null;
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate = fence ? fence[1].trim() : text.trim();
      const balanced = this._balancedBraces(candidate);
      if (balanced)
        return balanced;
      return this._balancedBraces(text);
    },
    _balancedBraces(text) {
      const start = text.indexOf("{");
      if (start < 0)
        return null;
      let depth = 0, inStr = false, esc = false;
      for (let i = start;i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc)
            esc = false;
          else if (c === "\\")
            esc = true;
          else if (c === '"')
            inStr = false;
          continue;
        }
        if (c === '"')
          inStr = true;
        else if (c === "{")
          depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0)
            return text.slice(start, i + 1);
        }
      }
      return null;
    },
    handleQuickAction(action) {
      const $ = (sel) => document.querySelector(sel);
      const { activeCard } = window.AppState;
      if (action === "newcard") {
        Wizard.show();
        return;
      }
      if (!AIService.hasApiKey()) {
        Ui.showToast(I18n.t("toast.apiKey"), "warning");
        return;
      }
      if (!activeCard) {
        Ui.showToast(I18n.t("toast.selectCard"), "warning");
        return;
      }
      const promptFor = (name) => CardStorage.getPrompt(name) || Settings.getDefaultPrompt(name);
      const currentOf = {
        shorten: activeCard.description,
        enhance: activeCard.description,
        tone: activeCard.description,
        grammar: activeCard.description,
        personality: activeCard.personality,
        firstmes: activeCard.first_mes,
        scenario: activeCard.scenario,
        systemprompt: activeCard.system_prompt
      };
      const withCurrent = (name, field) => promptFor(name) + `

Current:
` + (currentOf[field] || "(empty)");
      const prompts = {
        enhance: withCurrent("enhance", "enhance"),
        personality: withCurrent("personality", "personality"),
        firstmes: withCurrent("firstmes", "firstmes"),
        scenario: withCurrent("scenario", "scenario"),
        shorten: withCurrent("shorten", "shorten"),
        tone: promptFor("tone"),
        grammar: withCurrent("grammar", "grammar"),
        greetings: promptFor("greetings"),
        systemprompt: withCurrent("systemprompt", "systemprompt"),
        translate: promptFor("translate"),
        tags: promptFor("tags")
      };
      if (action === "translate") {
        const lang = window.prompt(I18n.t ? I18n.t("ai.translatePrompt") : "Translate to which language?", I18n.t ? I18n.t("ai.translateDefaultLang") : "French");
        if (!lang)
          return;
        prompts.translate = prompts.translate.split("{lang}").join(lang).split("{card}").join(CardEngine.toJSON(activeCard));
      }
      if (action === "tone") {
        const tone = window.prompt(I18n.t ? I18n.t("ai.tonePrompt") : "Which tone? (e.g., formal, casual, dark, humorous, poetic)", I18n.t ? I18n.t("ai.toneDefault") : "formal");
        if (!tone)
          return;
        prompts.tone = prompts.tone.split("{tone}").join(tone) + `

Current:
` + (currentOf.tone || "(empty)");
      }
      if (action === "tags") {
        this._sendFullCard(prompts.tags, {
          applyTarget: "tags",
          systemPromptInstruction: promptFor("tagsSystem")
        });
        return;
      }
      const aiPrompt = action === "translate" ? prompts.translate : prompts[action];
      if (!aiPrompt)
        return;
      this._selectedFields.clear();
      const fieldMap = {
        translate: null,
        personality: "personality",
        firstmes: "first_mes",
        scenario: "scenario",
        enhance: "description",
        shorten: "description",
        tone: "description",
        grammar: "description",
        greetings: "alternate_greetings",
        systemprompt: "system_prompt"
      };
      if (action === "translate") {
        this._renderFieldChips();
        const inp2 = $("#aiInput");
        if (inp2)
          inp2.value = aiPrompt;
        this._sendFullCard(aiPrompt);
        return;
      } else if (fieldMap[action]) {
        this._selectedFields.add(fieldMap[action]);
      }
      this._renderFieldChips();
      const inp = $("#aiInput");
      if (inp)
        inp.value = aiPrompt;
      this.send();
    },
    addChatMessage(role, content, usage, applyData, historyIndex) {
      const $ = (sel) => document.querySelector(sel);
      const container = $("#aiChatMessages");
      const welcome = container.querySelector(".ai-welcome");
      if (welcome)
        welcome.remove();
      let formatted;
      if (typeof Ui !== "undefined" && Ui.renderMarkdown) {
        formatted = Ui.renderMarkdown(content);
      } else {
        formatted = Ui.escapeHtml(content).replace(/```(?:\w+)?\n?([\s\S]*?)```/g, "<pre>$1</pre>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/^[-*] (.+)$/gm, "<li>$1</li>").replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>").replace(/\n/g, "<br>");
      }
      const usageInfo = usage ? '<div class="text-muted mt-1" style="font-size:0.65rem;">' + (usage.total_tokens || "?") + " tokens · $" + (usage.cost || 0).toFixed(5) + "</div>" : "";
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const el = document.createElement("div");
      el.className = "ai-message " + role;
      if (typeof historyIndex === "number")
        el.dataset.historyIndex = String(historyIndex);
      el.innerHTML = formatted + '<div class="text-muted mt-1" style="font-size:0.6rem;">' + time + "</div>" + usageInfo;
      if (role === "assistant") {
        const actionsWrap = document.createElement("div");
        actionsWrap.className = "ai-message-actions";
        const msgId = "msg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
        if (applyData && applyData.content) {
          this._applyStore.set(msgId, applyData);
          if (this._applyStore.size > 50) {
            const oldest = this._applyStore.keys().next().value;
            this._applyStore.delete(oldest);
          }
          el.setAttribute("data-apply-id", msgId);
          this._registerApply(el, applyData.field, applyData.content);
          const reapplyBtn = document.createElement("button");
          reapplyBtn.className = "ai-message-reapply";
          reapplyBtn.innerHTML = '<i class="bi bi-check2-circle"></i> ' + (I18n.t ? I18n.t("ai.apply") : "Apply");
          reapplyBtn.title = I18n.t ? I18n.t("ai.applyTitle") : "Apply these changes to the card";
          reapplyBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const stored = this._applyStore.get(msgId);
            if (stored) {
              this.tryApplyAIResponse(stored.content, stored.field, el);
            }
          });
          actionsWrap.appendChild(reapplyBtn);
        }
        const retryBtn = document.createElement("button");
        retryBtn.className = "ai-message-retry";
        retryBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> ' + (I18n.t ? I18n.t("ai.retry") : "Retry");
        retryBtn.title = I18n.t ? I18n.t("ai.retryTitle") : "Regenerate this response";
        retryBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const idx = parseInt(el.dataset.historyIndex, 10);
          this.retryLastMessage(Number.isNaN(idx) ? undefined : idx);
        });
        actionsWrap.appendChild(retryBtn);
        el.appendChild(actionsWrap);
      }
      container.appendChild(el);
      Anims.staggerFadeIn(el, { duration: 200, from: 10 });
      container.scrollTop = container.scrollHeight;
    },
    retryLastMessage(historyIndex) {
      const { chatHistory } = window.AppState;
      let targetUserIdx = -1;
      if (typeof historyIndex === "number") {
        for (let i = historyIndex;i >= 0; i--) {
          if (chatHistory[i] && chatHistory[i].role === "user") {
            targetUserIdx = i;
            break;
          }
        }
      }
      if (targetUserIdx < 0) {
        for (let i = chatHistory.length - 1;i >= 0; i--) {
          if (chatHistory[i].role === "user") {
            targetUserIdx = i;
            break;
          }
        }
      }
      if (targetUserIdx < 0)
        return;
      const lastUserPrompt = chatHistory[targetUserIdx].content;
      this._abortAll();
      this._gen++;
      chatHistory.splice(targetUserIdx);
      window.AppState.isAiLoading = false;
      this.updateSendButton();
      CardStorage.saveChatHistory(chatHistory, window.AppState.activeCard?._id);
      if (this._currentSessionId) {
        const cardId = window.AppState.activeCard?._id || "global";
        CardStorage.saveSessionMessages(cardId, this._currentSessionId, chatHistory);
      }
      const $ = (sel) => document.querySelector(sel);
      const container = $("#aiChatMessages");
      const allMsgs = container.querySelectorAll(".ai-message");
      let removedDom = 0;
      const targetEl = [...allMsgs].find((el) => parseInt(el.dataset.historyIndex, 10) === targetUserIdx);
      if (targetEl) {
        let el = targetEl;
        while (el) {
          const next = el.nextElementSibling;
          el.remove();
          removedDom++;
          el = next;
        }
      }
      if (removedDom === 0) {
        for (let i = allMsgs.length - 1;i >= 0 && removedDom < 2; i--) {
          const msg = allMsgs[i];
          if (msg.classList.contains("system"))
            continue;
          msg.remove();
          removedDom++;
        }
      }
      this._pruneApplyQueue();
      this.addChatMessage("user", lastUserPrompt, null, null, targetUserIdx);
      this.send(lastUserPrompt);
    },
    createStreamingMessage() {
      const $ = (sel) => document.querySelector(sel);
      const container = $("#aiChatMessages");
      const welcome = container.querySelector(".ai-welcome");
      if (welcome)
        welcome.remove();
      const el = document.createElement("div");
      el.className = "ai-message assistant";
      el.innerHTML = '<div class="ai-message-content"></div>' + '<div class="ai-shimmer" aria-hidden="true"><div class="shimmer-line"></div><div class="shimmer-line"></div><div class="shimmer-line short"></div></div>';
      container.appendChild(el);
      Anims.staggerFadeIn(el, { duration: 200, from: 10 });
      container.scrollTop = container.scrollHeight;
      return el;
    },
    renderChatHistory() {
      if (this._historyRendered)
        return;
      const { chatHistory } = window.AppState;
      const $ = (sel) => document.querySelector(sel);
      const container = $("#aiChatMessages");
      if (chatHistory.length === 0)
        return;
      const welcome = container.querySelector(".ai-welcome");
      if (welcome)
        welcome.remove();
      chatHistory.forEach((msg, i) => this.addChatMessage(msg.role, msg.content, null, null, i));
      this._historyRendered = true;
    },
    _updateSession() {
      const { chatHistory, activeCard } = window.AppState;
      if (!chatHistory || chatHistory.length < 2)
        return;
      const cardId = activeCard?._id || "global";
      const sessions = CardStorage.getChatSessions(cardId);
      const firstUser = chatHistory.find((m) => m.role === "user");
      const preview = firstUser ? firstUser.content.length > 80 ? firstUser.content.slice(0, 80) + "..." : firstUser.content : I18n.t ? I18n.t("ai.chatSession") : "Chat session";
      const now = Date.now();
      const SESSION_TIMEOUT = 30 * 60 * 1000;
      let currentSession = this._currentSessionId ? sessions.find((s) => s.id === this._currentSessionId) : sessions.length > 0 ? sessions[0] : null;
      if (currentSession && now - (currentSession.lastUpdated || currentSession.created) < SESSION_TIMEOUT) {
        currentSession.lastUpdated = now;
        currentSession.preview = preview;
        currentSession.messageCount = chatHistory.length;
        this._currentSessionId = currentSession.id;
        CardStorage.saveChatSession(cardId, currentSession);
        CardStorage.saveSessionMessages(cardId, currentSession.id, chatHistory);
      } else {
        const session = {
          id: "ses_" + now + "_" + Math.random().toString(36).slice(2, 7),
          created: now,
          lastUpdated: now,
          preview,
          messageCount: chatHistory.length
        };
        this._currentSessionId = session.id;
        CardStorage.saveChatSession(cardId, session);
        CardStorage.saveSessionMessages(cardId, session.id, chatHistory);
      }
    },
    _renderHistoryList() {
      const $ = (sel) => document.querySelector(sel);
      const list = $("#aiHistoryList");
      if (!list)
        return;
      const cardId = window.AppState.activeCard?._id || "global";
      const sessions = CardStorage.getChatSessions(cardId);
      if (sessions.length === 0) {
        list.innerHTML = '<div class="ai-history-empty">' + (I18n.t ? I18n.t("ai.historyEmpty") : "No conversations yet") + "</div>";
        return;
      }
      list.innerHTML = sessions.map((s) => {
        const date = new Date(s.created);
        const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
        const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return '<div class="ai-history-item" data-session-id="' + Ui.escapeAttr(s.id) + '">' + '<div class="ai-history-item-preview">' + Ui.escapeHtml(s.preview) + "</div>" + '<div class="ai-history-item-meta">' + '<span class="ai-history-item-time">' + dateStr + " " + timeStr + "</span>" + '<span class="ai-history-item-count">' + (I18n.t ? I18n.t("ai.msgs", { count: s.messageCount || "?" }) : (s.messageCount || "?") + " msgs") + "</span>" + "</div></div>";
      }).join("");
      list.querySelectorAll(".ai-history-item").forEach((item) => {
        item.addEventListener("click", () => {
          this._loadSession(item.dataset.sessionId);
        });
      });
    },
    _showWelcome() {
      const $ = (sel) => document.querySelector(sel);
      const container = $("#aiChatMessages");
      if (!container)
        return;
      container.innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>' + I18n.t("ai.welcomeTitle") + "</h6><p>" + I18n.t("ai.welcomeText") + '</p><div class="quick-actions">' + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="newcard"><i class="bi bi-magic me-1"></i> ' + I18n.t("ai.actionNewCard") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="translate"><i class="bi bi-translate me-1"></i> ' + I18n.t("ai.actionTranslate") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="enhance"><i class="bi bi-stars me-1"></i> ' + I18n.t("ai.actionEnhance") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="shorten"><i class="bi bi-arrows-angle-contract me-1"></i> ' + I18n.t("ai.actionShorten") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="tone"><i class="bi bi-palette me-1"></i> ' + I18n.t("ai.actionTone") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="grammar"><i class="bi bi-check2-all me-1"></i> ' + I18n.t("ai.actionGrammar") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="personality"><i class="bi bi-emoji-smile me-1"></i> ' + I18n.t("ai.actionPersonality") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="firstmes"><i class="bi bi-chat-dots me-1"></i> ' + I18n.t("ai.actionFirstMes") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="scenario"><i class="bi bi-geo-alt me-1"></i> ' + I18n.t("ai.actionScenario") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="greetings"><i class="bi bi-list-ol me-1"></i> ' + I18n.t("ai.actionGreetings") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="systemprompt"><i class="bi bi-terminal me-1"></i> ' + I18n.t("ai.actionSystemprompt") + "</button>" + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="tags"><i class="bi bi-tags me-1"></i> ' + I18n.t("ai.actionTags") + "</button>" + "</div></div>";
      const self = this;
      container.querySelectorAll(".quick-action").forEach((btn) => {
        btn.addEventListener("click", () => self.handleQuickAction(btn.dataset.action));
      });
      Anims.staggerFadeIn(container.querySelectorAll(".quick-action"), { stagger: 40, duration: 180 });
    },
    _loadSession(sessionId) {
      const cardId = window.AppState.activeCard?._id || "global";
      const sessions = CardStorage.getChatSessions(cardId);
      const session = sessions.find((s) => s.id === sessionId);
      if (!session)
        return;
      const sessionMessages = CardStorage.getSessionMessages(cardId, sessionId);
      window.AppState.chatHistory = sessionMessages;
      this._currentSessionId = sessionId;
      this._historyRendered = false;
      this._applyStore.clear();
      const $ = (sel) => document.querySelector(sel);
      const container = $("#aiChatMessages");
      if (container)
        container.innerHTML = "";
      this.toggleHistory(false);
      if (!sessionMessages || sessionMessages.length === 0) {
        this._showWelcome();
      } else {
        this.renderChatHistory();
      }
      this._renderHistoryList();
      const item = $("#aiHistoryList")?.querySelector('[data-session-id="' + sessionId + '"]');
      if (item)
        item.classList.add("active");
    },
    toggleHistory(forceState) {
      const $ = (sel) => document.querySelector(sel);
      const panel = $("#aiHistoryPanel");
      const messages = $("#aiChatMessages");
      const inputArea = $(".ai-input-area");
      if (!panel)
        return;
      const isOpen = forceState !== undefined ? forceState : !panel.classList.contains("open");
      panel.classList.toggle("open", isOpen);
      if (messages)
        messages.style.display = isOpen ? "none" : "";
      if (inputArea)
        inputArea.style.display = isOpen ? "none" : "";
      if (isOpen) {
        this._renderHistoryList();
      }
    },
    clearChat() {
      this._abortAll();
      this._gen++;
      window.AppState.isAiLoading = false;
      this.updateSendButton();
      this._historyRendered = false;
      this._selectedFields.clear();
      this._applyStore.clear();
      this._applyQueue = [];
      this._applyIndex = 0;
      this._currentSessionId = null;
      this._renderFieldChips();
      window.AppState.chatHistory = [];
      CardStorage.clearChatHistory(window.AppState.activeCard?._id);
      this._showWelcome();
      Ui.showToast(I18n.t("toast.chatCleared"), "info");
    },
    updateSendButton() {
      const $ = (sel) => document.querySelector(sel);
      const btn = $("#btnAiSend");
      const stop = $("#btnAiStop");
      if (!btn)
        return;
      btn.disabled = window.AppState.isAiLoading;
      btn.innerHTML = window.AppState.isAiLoading ? '<span class="spinner-border spinner-border-sm"></span>' : '<i class="bi bi-send-fill"></i>';
      if (stop)
        stop.classList.toggle("d-none", !window.AppState.isAiLoading);
    },
    async updateContextBar() {
      const $ = (sel) => document.querySelector(sel);
      const bar = $("#contextBarFill");
      const label = $("#contextBarLabel");
      if (!bar || !label)
        return;
      const modelSelect = $("#aiModelSelect");
      const input = $("#aiInput");
      if (!modelSelect || !input)
        return;
      const modelId = modelSelect.value;
      const prompt = input.value || "";
      const { activeCard } = window.AppState;
      if (!modelId) {
        bar.style.width = "0%";
        bar.classList.remove("warn", "danger");
        label.textContent = I18n.t("ai.selectModel");
        return;
      }
      const ctx = AIService.getContextLength(modelId);
      const cardJson = activeCard ? CardEngine.toJSON(activeCard) : "";
      const systemPromptBase = [
        CardStorage.getPrompt("assistant") || `You are an AI assistant helping edit SillyTavern character cards.
SillyTavern is an AI roleplay frontend. Cards define character personalities.`
      ].join(`
`);
      const inputText = systemPromptBase + `

` + cardJson;
      const history = this._getRecentHistory(10, true);
      let historyText = "";
      for (const msg of history) {
        historyText += (msg.content || "") + `
`;
      }
      let inputTokens = 0;
      try {
        if (window.Tokenizer && typeof window.Tokenizer.count === "function") {
          inputTokens = await window.Tokenizer.count(inputText + `
` + historyText + `
` + prompt);
        }
      } catch (_) {
        inputTokens = 0;
      }
      if (!inputTokens) {
        inputTokens = window.Tokenizer && typeof window.Tokenizer.quickCount === "function" ? window.Tokenizer.quickCount(inputText + `
` + historyText + `
` + prompt) : Math.ceil((inputText + `
` + historyText + `
` + prompt).length / 3);
      }
      const modelData = (window.AppState.models || []).find((m) => m.id === modelId);
      const modelMaxOut = modelData && modelData.max_output_tokens > 0 ? modelData.max_output_tokens : AIService.DEFAULT_MAX_TOKENS;
      const userMaxTokens = CardStorage.getMaxTokens();
      const outputCap = userMaxTokens > 0 ? Math.min(userMaxTokens, modelMaxOut) : modelMaxOut;
      const historyMsgs = history.map((m) => ({ role: m.role, content: m.content || "" }));
      const allMessages = [{ role: "system", content: inputText }, ...historyMsgs, { role: "user", content: prompt }];
      const resolvedMax = await AIService.resolveMaxTokens(modelId, allMessages);
      const actualMaxOut = Math.min(outputCap, resolvedMax);
      const total = inputTokens + actualMaxOut;
      const ratio = ctx > 0 ? total / ctx : 0;
      const pct = Math.min(100, Math.round(ratio * 100));
      bar.style.width = pct + "%";
      bar.classList.toggle("warn", ratio >= 0.9 && ratio < 1);
      bar.classList.toggle("danger", ratio >= 1);
      let labelText = this._fmt(inputTokens) + (I18n.t ? I18n.t("ai.tokensIn") : " in · ") + this._fmt(actualMaxOut) + (I18n.t ? I18n.t("ai.tokensOut") : " out · ") + this._fmt(ctx) + (I18n.t ? I18n.t("ai.tokensCtx") : " ctx");
      if (ratio >= 1) {
        labelText += I18n.t ? I18n.t("ai.exceedsLimit") : " ⚠ Exceeds limit!";
      } else if (ratio >= 0.9) {
        labelText += I18n.t ? I18n.t("ai.approachingLimit") : " ⚠ Approaching limit";
      }
      label.textContent = labelText;
    },
    _fmt(n) {
      n = n || 0;
      if (n >= 1000)
        return (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + "k";
      return "" + n;
    }
  };
  if (typeof window !== "undefined")
    window.AiChat = AiChat2;

  // js/wizard.js
  var Wizard2 = {
    _step: 1,
    _totalSteps: 5,
    _answers: {},
    _modal: null,
    _fetchedImages: [],
    _selectedImageIdx: -1,
    _tagSearch: "",
    _autoFetched: false,
    _fetching: false,
    _wizardDirtyKey: "stce_wizard_draft",
    _draftCleared: false,
    init() {
      this._modal = new bootstrap.Modal("#wizardModal");
      this._bindEvents();
      document.querySelector("#wizardModal").addEventListener("hidden.bs.modal", () => this._onModalClose());
    },
    show() {
      this._step = 1;
      this._answers = {};
      this._fetchedImages = [];
      this._selectedImageIdx = -1;
      this._tagSearch = "";
      this._autoFetched = false;
      this._fetching = false;
      this._resetFormUI();
      this._resetImageUI();
      this._renderStepIndicator();
      this._showStep(1);
      this._modal.show();
      if (this._restoreDraft()) {
        this._populateStep(1);
      }
      setTimeout(() => {
        const step1 = document.querySelector('.wizard-step[data-step="1"]');
        if (step1)
          Anims.staggerFadeIn(step1.querySelectorAll(".mb-3, .mb-4"), { stagger: 30, duration: 200 });
      }, 100);
    },
    _onModalClose() {
      if (!this._draftCleared) {
        try {
          this._collectStep(this._step);
        } catch (_) {}
        this._saveDraft();
      }
      this._fetchedImages.forEach((img) => {
        if (img && img._objUrl)
          URL.revokeObjectURL(img._objUrl);
      });
      this._fetchedImages = [];
      this._selectedImageIdx = -1;
      this._draftCleared = false;
    },
    _saveDraft() {
      try {
        if (this._answers && Object.keys(this._answers).length > 0) {
          sessionStorage.setItem(this._wizardDirtyKey, JSON.stringify(this._answers));
        }
      } catch (_) {}
    },
    _clearDraft() {
      try {
        sessionStorage.removeItem(this._wizardDirtyKey);
      } catch (_) {}
      this._draftCleared = true;
    },
    _restoreDraft() {
      try {
        const saved = sessionStorage.getItem(this._wizardDirtyKey);
        if (!saved)
          return false;
        const data = JSON.parse(saved);
        if (typeof data !== "object" || !data.name)
          return false;
        this._answers = data;
        Ui.showToast(I18n.t("wizard.draftRestored"), "info");
        return true;
      } catch (_) {
        sessionStorage.removeItem(this._wizardDirtyKey);
        return false;
      }
    },
    _resetFormUI() {
      const body = document.querySelector("#wizardModal .modal-body");
      if (!body)
        return;
      body.querySelectorAll('input[type="text"], textarea').forEach((el) => {
        el.value = "";
      });
      body.querySelectorAll("select").forEach((el) => {
        el.selectedIndex = 0;
      });
      body.querySelectorAll(".wizard-chip.active").forEach((c) => c.classList.remove("active"));
      const gc = document.querySelector("#wizGenderCustom");
      if (gc) {
        gc.value = "";
        gc.classList.add("d-none");
      }
      const lc = document.querySelector("#wizLanguageCustom");
      if (lc) {
        lc.value = "";
        lc.classList.add("d-none");
      }
      if (window.syncFloatLabels)
        window.syncFloatLabels();
    },
    _resetImageUI() {
      const btnFetch = document.querySelector("#wizBtnFetchImage");
      if (btnFetch)
        btnFetch.innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t("wizard.fetchImages");
      document.querySelectorAll(".wizard-image-card").forEach((c) => {
        c.classList.remove("selected");
        const thumb = c.querySelector(".wiz-thumb");
        if (thumb) {
          thumb.src = "";
          thumb.hidden = true;
        }
        const loader = c.querySelector(".wiz-image-loader");
        if (loader)
          loader.classList.add("d-none");
        const ph = c.querySelector(".wizard-image-placeholder");
        if (ph)
          ph.classList.remove("d-none");
      });
      const btnUse = document.querySelector("#wizBtnUseImage");
      const btnRemove = document.querySelector("#wizBtnRemoveImage");
      if (btnUse)
        btnUse.classList.add("d-none");
      if (btnRemove)
        btnRemove.classList.add("d-none");
    },
    _bindEvents() {
      const self = this;
      const on = (selector, event, fn) => {
        const el = document.querySelector(selector);
        if (el)
          el.addEventListener(event, fn);
      };
      on("#wizBtnNext", "click", () => self._next());
      on("#wizBtnBack", "click", () => self._back());
      on("#wizardModal", "keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && self._step === self._totalSteps) {
          e.preventDefault();
          self._generateWithAI();
        }
      });
      on("#wizGender", "change", (e) => {
        document.querySelector("#wizGenderCustom")?.classList.toggle("d-none", e.target.value !== "other");
      });
      on("#wizLanguage", "change", (e) => {
        document.querySelector("#wizLanguageCustom")?.classList.toggle("d-none", e.target.value !== "other");
      });
      document.querySelectorAll(".wizard-chip-group").forEach((group) => {
        group.querySelectorAll(".wizard-chip").forEach((chip) => {
          chip.addEventListener("click", () => {
            chip.classList.toggle("active");
            Anims.scaleClick(chip);
          });
        });
      });
      on("#wizBtnAI", "click", () => self._generateWithAI());
      on("#wizBtnBlank", "click", () => self._generateBlank());
      on("#wizBtnFetchImage", "click", () => self._fetchImage());
      on("#wizBtnUseImage", "click", () => self._useFetchedImage());
      on("#wizBtnRemoveImage", "click", () => self._removeFetchedImage());
      const searchInput = document.querySelector("#wizImageTagSearch");
      const searchBtn = document.querySelector("#wizBtnSearchImages");
      if (searchInput) {
        searchInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            self._syncTagSearch();
            self._fetchImage();
          }
        });
        searchInput.addEventListener("input", () => {
          self._tagSearch = searchInput.value;
          self._renderQuickTags();
        });
      }
      if (searchBtn) {
        searchBtn.addEventListener("click", () => {
          self._syncTagSearch();
          self._fetchImage();
        });
      }
      on("#btnWizardNav", "click", () => self.show());
      const centerBtn = document.querySelector("#btnWizard");
      if (centerBtn)
        centerBtn.addEventListener("click", () => self.show());
      self._bindImageEvents();
    },
    _collectStep(step) {
      const a = this._answers;
      switch (step) {
        case 1:
          a.name = document.querySelector("#wizName").value.trim();
          a.gender = document.querySelector("#wizGender").value;
          a.genderCustom = document.querySelector("#wizGenderCustom").value.trim();
          a.tags = document.querySelector("#wizTags").value.split(",").map((s) => s.trim()).filter(Boolean);
          a.creator = document.querySelector("#wizCreator").value.trim();
          break;
        case 2:
          a.type = document.querySelector("#wizType").value;
          a.language = document.querySelector("#wizLanguage").value;
          a.languageCustom = document.querySelector("#wizLanguageCustom").value.trim();
          a.genres = this._getChips("wizGenre");
          a.moods = this._getChips("wizMood");
          break;
        case 3:
          a.personalityDesc = document.querySelector("#wizPersonalityDesc").value.trim();
          a.appearance = document.querySelector("#wizAppearance").value.trim();
          a.abilities = document.querySelector("#wizAbilities").value.trim();
          break;
        case 4:
          a.scenario = document.querySelector("#wizScenario").value.trim();
          a.relationship = document.querySelector("#wizRelationship").value.trim();
          a.openingVibe = this._getChips("wizOpening");
          a.notes = document.querySelector("#wizNotes").value.trim();
          break;
      }
    },
    _populateStep(step) {
      const a = this._answers;
      switch (step) {
        case 1:
          if (a.name)
            document.querySelector("#wizName").value = a.name;
          if (a.gender)
            document.querySelector("#wizGender").value = a.gender;
          if (a.genderCustom) {
            document.querySelector("#wizGenderCustom").value = a.genderCustom;
            document.querySelector("#wizGenderCustom").classList.remove("d-none");
          }
          if (a.tags?.length)
            document.querySelector("#wizTags").value = a.tags.join(", ");
          if (a.creator)
            document.querySelector("#wizCreator").value = a.creator;
          break;
        case 2:
          if (a.type)
            document.querySelector("#wizType").value = a.type;
          if (a.language)
            document.querySelector("#wizLanguage").value = a.language;
          if (a.languageCustom) {
            document.querySelector("#wizLanguageCustom").value = a.languageCustom;
            document.querySelector("#wizLanguageCustom").classList.remove("d-none");
          }
          this._setChips("wizGenre", a.genres || []);
          this._setChips("wizMood", a.moods || []);
          break;
        case 3:
          if (a.personalityDesc)
            document.querySelector("#wizPersonalityDesc").value = a.personalityDesc;
          if (a.appearance)
            document.querySelector("#wizAppearance").value = a.appearance;
          if (a.abilities)
            document.querySelector("#wizAbilities").value = a.abilities;
          break;
        case 4:
          if (a.scenario)
            document.querySelector("#wizScenario").value = a.scenario;
          if (a.relationship)
            document.querySelector("#wizRelationship").value = a.relationship;
          this._setChips("wizOpening", a.openingVibe || []);
          if (a.notes)
            document.querySelector("#wizNotes").value = a.notes;
          break;
      }
      if (window.syncFloatLabels)
        window.syncFloatLabels();
    },
    _getChips(groupId) {
      const active = [];
      document.querySelectorAll("#" + groupId + " .wizard-chip.active").forEach((c) => active.push(c.dataset.value));
      return active;
    },
    _setChips(groupId, values) {
      const valSet = new Set(values);
      document.querySelectorAll("#" + groupId + " .wizard-chip").forEach((c) => {
        c.classList.toggle("active", valSet.has(c.dataset.value));
      });
    },
    _next() {
      this._collectStep(this._step);
      if (this._step === 1 && !this._answers.name) {
        Ui.showToast(I18n.t("wizard.nameRequired"), "warning");
        Anims.shakeElement(document.querySelector("#wizName"));
        document.querySelector("#wizName").focus();
        return;
      }
      if (this._step < this._totalSteps) {
        const prevStep = this._step;
        this._step++;
        this._populateStep(this._step);
        this._showStepAnimated(this._step, prevStep, "next");
      }
    },
    _back() {
      this._collectStep(this._step);
      if (this._step > 1) {
        const prevStep = this._step;
        this._step--;
        this._populateStep(this._step);
        this._showStepAnimated(this._step, prevStep, "back");
      }
    },
    _renderStepNav(step) {
      document.querySelector("#wizBtnBack").disabled = step === 1;
      if (step === this._totalSteps) {
        document.querySelector("#wizBtnNext").classList.add("d-none");
        document.querySelector("#wizStepLabel").textContent = I18n.t("wizard.ready");
        this._renderSummary();
        this._renderQuickTags();
        const derivedTags = this._deriveImageTags();
        const searchInput = document.querySelector("#wizImageTagSearch");
        if (searchInput && !this._autoFetched) {
          searchInput.value = derivedTags;
          this._tagSearch = derivedTags;
          this._renderQuickTags();
        }
        if (!this._autoFetched) {
          this._autoFetched = true;
          this._fetchImage();
        }
      } else {
        document.querySelector("#wizBtnNext").classList.remove("d-none");
        document.querySelector("#wizBtnNext").innerHTML = I18n.t("wizard.next") + ' <i class="bi bi-arrow-right ms-1"></i>';
        document.querySelector("#wizStepLabel").textContent = I18n.t("wizard.stepLabel", { step, total: this._totalSteps });
      }
      this._renderStepIndicator();
      this._updateProgressBar();
    },
    _showStepAnimated(step, prevStep, direction) {
      const prevEl = document.querySelector('.wizard-step[data-step="' + prevStep + '"]');
      const nextEl = document.querySelector('.wizard-step[data-step="' + step + '"]');
      document.querySelectorAll(".wizard-step").forEach((el) => {
        el.style.opacity = "";
        el.style.transform = "";
      });
      this._renderStepNav(step);
      Anims.slideStep(prevEl, nextEl, direction, () => {
        if (step === this._totalSteps) {
          const items = document.querySelectorAll(".wizard-summary-item");
          Anims.staggerFadeIn(items, { stagger: 20, duration: 200 });
        } else {
          Anims.staggerFadeIn(nextEl.querySelectorAll(".mb-3, .mb-4"), { stagger: 25, duration: 180 });
        }
      });
      setTimeout(() => {
        if (nextEl) {
          nextEl.classList.remove("d-none");
          nextEl.style.opacity = "";
          nextEl.style.transform = "";
        }
      }, 400);
    },
    _showStep(step) {
      document.querySelectorAll(".wizard-step").forEach((el) => {
        el.classList.add("d-none");
        el.style.opacity = "";
        el.style.transform = "";
      });
      const target = document.querySelector('.wizard-step[data-step="' + step + '"]');
      if (target)
        target.classList.remove("d-none");
      this._renderStepNav(step);
    },
    _renderStepIndicator() {
      const labels = [
        I18n.t("wizard.step.basics"),
        I18n.t("wizard.step.concept"),
        I18n.t("wizard.step.personality"),
        I18n.t("wizard.step.scenario"),
        I18n.t("wizard.step.generate")
      ];
      const container = document.querySelector("#wizardStepsIndicator");
      container.innerHTML = labels.map((label, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === this._step;
        const isDone = stepNum < this._step;
        const isFuture = stepNum > this._step;
        let connectorHtml = "";
        if (i < labels.length - 1) {
          const prevDone = i < this._step - 1 || i === this._step - 1 && !isActive;
          connectorHtml = '<div class="wizard-connector' + (prevDone ? " done" : "") + '"></div>';
        }
        return '<div class="wizard-step-dot-wrap">' + '<div class="wizard-step-dot' + (isActive ? " active" : "") + (isDone ? " done" : "") + (isFuture ? " future" : "") + '">' + (isDone ? '<i class="bi bi-check-lg"></i>' : "<span>" + (stepNum === this._step ? '<i class="bi bi-chevron-right"></i>' : stepNum) + "</span>") + "</div>" + (i < labels.length - 1 ? connectorHtml : "") + '<span class="wizard-step-dot-label">' + label + "</span>" + "</div>";
      }).join("");
    },
    _updateProgressBar() {
      const pct = Math.round(this._step / this._totalSteps * 100);
      document.querySelector("#wizardProgressBar").style.width = pct + "%";
      Anims.progressBounce(document.querySelector("#wizardProgressBar"));
    },
    _renderSummary() {
      const a = this._answers;
      const genderLabel = a.gender === "other" ? a.genderCustom : a.gender;
      const langLabel = a.language === "other" ? a.languageCustom : a.language;
      function summaryItem(key, value, step, full) {
        const stepIdx = step || -1;
        const editBtn = stepIdx >= 0 ? '<button class="wizard-edit-btn btn btn-sm btn-link p-0 ms-1" data-step="' + stepIdx + '" title="' + I18n.t("wizard.editStep") + '" aria-label="' + I18n.t("wizard.editStep") + '"><i class="bi bi-pencil"></i></button>' : "";
        return '<div class="wizard-summary-item' + (full ? " full" : "") + '">' + '<span class="wizard-summary-label">' + I18n.t(key) + editBtn + "</span>" + '<span class="wizard-summary-value">' + Ui.escapeHtml(value || "-") + "</span></div>";
      }
      let html = '<div class="wizard-summary-grid">';
      html += summaryItem("wizard.summary.name", a.name || "-", 1, false);
      html += summaryItem("wizard.summary.gender", genderLabel || "-", 1, false);
      html += summaryItem("wizard.summary.type", a.type ? I18n.t("wizard.type." + a.type) : "-", 2, false);
      html += summaryItem("wizard.summary.language", langLabel || "-", 2, false);
      html += summaryItem("wizard.summary.tags", (a.tags || []).join(", ") || "-", 1, false);
      html += summaryItem("wizard.summary.genres", (a.genres || []).join(", ") || "-", 2, false);
      html += summaryItem("wizard.summary.mood", (a.moods || []).join(", ") || "-", 2, false);
      html += summaryItem("wizard.summary.opening", (a.openingVibe || []).join(", ") || "-", 4, false);
      if (a.personalityDesc)
        html += summaryItem("wizard.summary.personality", a.personalityDesc, 3, true);
      if (a.appearance)
        html += summaryItem("wizard.summary.appearance", a.appearance, 3, true);
      if (a.scenario)
        html += summaryItem("wizard.summary.scenario", a.scenario, 4, true);
      if (a.relationship)
        html += summaryItem("wizard.summary.relationship", a.relationship, 4, true);
      if (a.notes)
        html += summaryItem("wizard.summary.notes", a.notes, 4, true);
      html += "</div>";
      document.querySelector("#wizardSummary").innerHTML = html;
      document.querySelectorAll(".wizard-edit-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const targetStep = parseInt(btn.dataset.step, 10);
          if (targetStep >= 1 && targetStep <= 4) {
            this._collectStep(this._step);
            this._step = targetStep;
            this._populateStep(targetStep);
            this._showStepAnimated(targetStep, this._totalSteps, "back");
          }
        });
      });
    },
    TAG_OPTIONS: [
      "waifu",
      "maid",
      "uniform",
      "selfies",
      "dress",
      "cat",
      "neko",
      "fox",
      "witch",
      "swimsuit",
      "gothic",
      "dark",
      "fantasy",
      "cyberpunk",
      "military",
      "sailor",
      "princess",
      "angel",
      "devil",
      "ninja",
      "samurai",
      "pirate",
      "vampire",
      "elf",
      "robot"
    ],
    _renderQuickTags() {
      const container = document.querySelector("#wizQuickTags");
      if (!container)
        return;
      let label = container.querySelector(".wizard-quick-tags-label");
      if (!label) {
        label = document.createElement("span");
        label.className = "wizard-quick-tags-label";
        label.setAttribute("data-i18n", "wizard.quick");
        label.textContent = I18n.t("wizard.quick");
      }
      container.innerHTML = "";
      container.appendChild(label);
      const activeTags = this._tagSearch ? new Set(this._tagSearch.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) : new Set;
      this.TAG_OPTIONS.forEach((tag) => {
        const chip = document.createElement("span");
        chip.className = "wizard-quick-tag" + (activeTags.has(tag) ? " active" : "");
        chip.dataset.tag = tag;
        chip.textContent = tag;
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          const input = document.querySelector("#wizImageTagSearch");
          if (!input)
            return;
          const current = input.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
          const idx = current.indexOf(tag);
          if (idx >= 0) {
            current.splice(idx, 1);
          } else {
            current.push(tag);
          }
          input.value = current.join(", ");
          this._tagSearch = input.value;
          this._renderQuickTags();
        });
        container.appendChild(chip);
      });
    },
    _bindImageEvents() {
      const self = this;
      document.querySelectorAll(".wizard-image-card").forEach((card) => {
        card.addEventListener("click", () => {
          const idx = parseInt(card.dataset.idx, 10);
          if (!self._fetchedImages[idx])
            return;
          document.querySelectorAll(".wizard-image-card").forEach((c) => c.classList.remove("selected"));
          card.classList.add("selected");
          self._selectedImageIdx = idx;
          document.querySelector("#wizBtnUseImage").classList.remove("d-none");
          document.querySelector("#wizBtnRemoveImage").classList.remove("d-none");
          document.querySelector("#wizBtnFetchImage").innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t("wizard.refetchOthers");
        });
      });
    },
    _syncTagSearch() {
      const input = document.querySelector("#wizImageTagSearch");
      if (input) {
        this._tagSearch = input.value;
        this._renderQuickTags();
      }
    },
    _deriveImageTags() {
      const a = this._answers;
      const tagMap = {
        fantasy: "fantasy",
        scifi: "cyberpunk",
        modern: "uniform",
        horror: "dark",
        romance: "dress",
        "slice-of-life": "maid",
        cyberpunk: "cyberpunk",
        military: "military",
        dark: "gothic",
        supernatural: "witch"
      };
      const tags = new Set(["waifu"]);
      (a.genres || []).forEach((g) => {
        if (tagMap[g])
          tags.add(tagMap[g]);
      });
      if (a.type === "vtuber")
        tags.add("selfies");
      if (a.type === "historical")
        tags.add("maid");
      if (a.type === "anime")
        tags.add("neko");
      const appearance = (a.appearance || "").toLowerCase();
      if (appearance.includes("cat") || appearance.includes("feline") || appearance.includes("neko"))
        tags.add("cat");
      if (appearance.includes("fox") || appearance.includes("kitsune"))
        tags.add("fox");
      if (appearance.includes("angel"))
        tags.add("angel");
      if (appearance.includes("devil") || appearance.includes("demon") || appearance.includes("succubus"))
        tags.add("devil");
      if (appearance.includes("vampire"))
        tags.add("vampire");
      if (appearance.includes("elf"))
        tags.add("elf");
      if (appearance.includes("sword") || appearance.includes("samurai") || appearance.includes("ninja")) {
        tags.add("samurai");
        tags.add("ninja");
      }
      if (appearance.includes("pirate"))
        tags.add("pirate");
      if (appearance.includes("robot") || appearance.includes("cyborg") || appearance.includes("android"))
        tags.add("robot");
      if (appearance.includes("princess"))
        tags.add("princess");
      if (appearance.includes("sailor") || appearance.includes("navy") || appearance.includes("marine"))
        tags.add("sailor");
      return [...tags].join(", ");
    },
    async _fetchImage() {
      if (this._fetching)
        return;
      const btn = document.querySelector("#wizBtnFetchImage");
      if (!btn)
        return;
      this._fetching = true;
      const origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="bi bi-hourglass-split me-1"></i>' + I18n.t("wizard.fetching");
      this._syncTagSearch();
      const userTags = this._tagSearch.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!userTags.length)
        userTags.push("waifu");
      let labelSet = false;
      try {
        const slotsToFetch = [];
        for (let i = 0;i < 3; i++) {
          if (i === this._selectedImageIdx)
            continue;
          slotsToFetch.push(i);
        }
        if (!slotsToFetch.length) {
          this._fetching = false;
          btn.disabled = false;
          btn.innerHTML = origHtml;
          return;
        }
        for (const i of slotsToFetch) {
          const card = document.querySelectorAll(".wizard-image-card")[i];
          card.classList.remove("selected");
          const thumb = card.querySelector(".wiz-thumb");
          thumb.src = "";
          thumb.hidden = true;
          const loader = card.querySelector(".wiz-image-loader");
          if (loader)
            loader.classList.remove("d-none");
          const ph = card.querySelector(".wizard-image-placeholder");
          if (ph)
            ph.classList.add("d-none");
          const prev = this._fetchedImages[i];
          if (prev && prev._objUrl)
            URL.revokeObjectURL(prev._objUrl);
          this._fetchedImages[i] = null;
        }
        await Promise.all(slotsToFetch.map(async (i) => {
          try {
            const slotTags = [];
            const tagIdx1 = i * 2 % userTags.length;
            slotTags.push(userTags[tagIdx1]);
            if (userTags.length > 1) {
              const tagIdx2 = (i * 2 + 1) % userTags.length;
              if (tagIdx2 !== tagIdx1)
                slotTags.push(userTags[tagIdx2]);
            }
            const page = Math.max(1, Math.floor(Math.random() * 20));
            const resp = await fetch("https://api.waifu.im/images?" + "included_tags=" + encodeURIComponent(slotTags.join(",")) + "&is_nsfw=false&page=" + page);
            if (!resp.ok)
              throw new Error("API returned " + resp.status);
            const data = await resp.json();
            const items = data.items || [];
            if (!items.length)
              throw new Error("No image for tags: " + slotTags.join(", "));
            const item = items[Math.floor(Math.random() * items.length)];
            const imgResp = await fetch(item.url);
            const blob = await imgResp.blob();
            const objUrl = URL.createObjectURL(blob);
            this._fetchedImages[i] = {
              blob,
              url: item.url,
              _objUrl: objUrl,
              tags: (item.tags || []).map((t) => t.name).join(", ")
            };
            const card = document.querySelectorAll(".wizard-image-card")[i];
            const thumb = card.querySelector(".wiz-thumb");
            thumb.src = objUrl;
            thumb.hidden = false;
            const loader = card.querySelector(".wiz-image-loader");
            if (loader)
              loader.classList.add("d-none");
            card.querySelector(".wizard-image-placeholder").classList.add("d-none");
          } catch (e) {
            console.error("waifu.im slot " + i + " fetch failed", e);
            const card = document.querySelectorAll(".wizard-image-card")[i];
            const loader = card.querySelector(".wiz-image-loader");
            if (loader)
              loader.classList.add("d-none");
            const ph = card.querySelector(".wizard-image-placeholder");
            if (ph) {
              ph.classList.remove("d-none");
              ph.innerHTML = '<i class="bi bi-exclamation-triangle"></i>';
            }
          }
        }));
        const ok = slotsToFetch.some((i) => this._fetchedImages[i]);
        if (!ok)
          throw new Error("All requests failed");
        if (this._selectedImageIdx >= 0 && this._fetchedImages[this._selectedImageIdx]) {
          document.querySelector("#wizBtnUseImage").classList.remove("d-none");
          document.querySelector("#wizBtnRemoveImage").classList.remove("d-none");
          document.querySelector("#wizBtnFetchImage").innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t("wizard.refetchOthers");
          labelSet = true;
        } else {
          document.querySelector("#wizBtnUseImage").classList.add("d-none");
          document.querySelector("#wizBtnRemoveImage").classList.add("d-none");
          document.querySelector("#wizBtnFetchImage").innerHTML = '<i class="bi bi-shuffle me-1"></i>' + I18n.t("wizard.fetchImages");
          labelSet = true;
        }
      } catch (e) {
        console.error("waifu.im fetch failed", e);
        Ui.showToast(I18n.t("toast.wizardFetchFailed", { error: e.message }), "danger");
      } finally {
        this._fetching = false;
        btn.disabled = false;
        if (!labelSet)
          btn.innerHTML = origHtml;
      }
    },
    async _useFetchedImage() {
      if (this._selectedImageIdx < 0 || !this._fetchedImages[this._selectedImageIdx])
        return;
      const card = window.AppState.activeCard;
      if (!card) {
        Ui.showToast(I18n.t("toast.createCardFirst"), "warning");
        return;
      }
      await Editor.setAvatar(this._fetchedImages[this._selectedImageIdx].blob);
    },
    _removeFetchedImage() {
      const idx = this._selectedImageIdx;
      if (idx < 0)
        return;
      const prev = this._fetchedImages[idx];
      if (prev && prev._objUrl)
        URL.revokeObjectURL(prev._objUrl);
      this._fetchedImages[idx] = null;
      this._selectedImageIdx = -1;
      const cards = document.querySelectorAll(".wizard-image-card");
      const card = cards[idx];
      if (card) {
        card.classList.remove("selected");
        const thumb = card.querySelector(".wiz-thumb");
        if (thumb) {
          thumb.src = "";
          thumb.hidden = true;
        }
        const loader = card.querySelector(".wiz-image-loader");
        if (loader)
          loader.classList.add("d-none");
        const ph = card.querySelector(".wizard-image-placeholder");
        if (ph) {
          ph.classList.remove("d-none");
          ph.innerHTML = '<i class="bi bi-image"></i>';
        }
      }
      const anyLeft = this._fetchedImages.some((img) => !!img);
      document.querySelector("#wizBtnUseImage").classList.add("d-none");
      document.querySelector("#wizBtnRemoveImage").classList.add("d-none");
      document.querySelector("#wizBtnFetchImage").innerHTML = '<i class="bi bi-shuffle me-1"></i>' + (anyLeft ? I18n.t("wizard.refetchOthers") : I18n.t("wizard.fetchImages"));
    },
    async _generateBlank() {
      this._collectStep(this._step);
      this._clearDraft();
      const chosenImage = this._selectedImageIdx >= 0 && this._fetchedImages[this._selectedImageIdx] ? this._fetchedImages[this._selectedImageIdx].blob : null;
      this._modal.hide();
      const card = CardEngine.createEmptyCard(this._answers.name || "New Character");
      card.tags = this._answers.tags || [];
      card.creator = this._answers.creator || "";
      await CardStorage.upsertCard(card);
      window.AppState.cards = CardStorage.getCards();
      await CardManager.selectCard(card);
      if (chosenImage) {
        try {
          await Editor.setAvatar(chosenImage);
        } catch (_) {}
      }
      CardManager.renderCardList();
      document.querySelector("#editName").focus();
      Ui.showToast(I18n.t("toast.wizardCreated"), "success");
    },
    async _generateWithAI() {
      this._collectStep(this._step);
      if (!AIService.hasApiKey()) {
        Ui.showToast(I18n.t("toast.wizardApi"), "warning");
        return;
      }
      const modelSelect = document.querySelector("#aiModelSelect");
      if (!modelSelect) {
        Ui.showToast(I18n.t("toast.wizardModel"), "warning");
        return;
      }
      const modelId = modelSelect.value;
      if (!modelId) {
        Ui.showToast(I18n.t("toast.wizardModel"), "warning");
        return;
      }
      this._clearDraft();
      const chosenImage = this._selectedImageIdx >= 0 && this._fetchedImages[this._selectedImageIdx] ? this._fetchedImages[this._selectedImageIdx].blob : null;
      this._modal.hide();
      const a = this._answers;
      const genderText = a.gender === "other" ? a.genderCustom : a.gender || "unspecified";
      const langMap = {
        en: "English",
        fr: "French",
        de: "German",
        ja: "Japanese",
        it: "Italian",
        pl: "Polish",
        tr: "Turkish",
        nl: "Dutch",
        uk: "Ukrainian",
        vi: "Vietnamese",
        id: "Indonesian",
        hi: "Hindi",
        ar: "Arabic",
        he: "Hebrew",
        fa: "Persian"
      };
      const langText = langMap[a.language] || a.languageCustom || "English";
      const typeLabels = {
        original: "Original Character",
        fanfic: "Fan Fiction",
        game: "Game Character",
        anime: "Anime / Manga",
        book: "Book / Movie / Show",
        historical: "Historical Figure",
        mythological: "Mythological / Folklore",
        vtuber: "VTuber / Streamer",
        other: "Other"
      };
      let prompt = (CardStorage.getPrompt("wizard") || "Create a complete SillyTavern character card as valid JSON (chara_card_v2 spec).").trimEnd() + " ";
      prompt += "Write everything in " + langText + ". ";
      prompt += `Return ONLY the JSON code block, no explanation.

`;
      prompt += `## Character Details

`;
      prompt += "- **Name**: " + (a.name || "New Character") + `
`;
      prompt += "- **Gender**: " + genderText + `
`;
      prompt += "- **Type**: " + (typeLabels[a.type] || "Original Character") + `
`;
      prompt += "- **Tags**: " + (a.tags || []).join(", ") + `
`;
      if (a.genres?.length)
        prompt += "- **Genre/World**: " + a.genres.join(", ") + `
`;
      if (a.moods?.length)
        prompt += "- **Mood/Tone**: " + a.moods.join(", ") + `
`;
      if (a.personalityDesc)
        prompt += "- **Personality**: " + a.personalityDesc + `
`;
      if (a.appearance)
        prompt += "- **Appearance**: " + a.appearance + `
`;
      if (a.abilities)
        prompt += "- **Special Traits**: " + a.abilities + `
`;
      if (a.scenario)
        prompt += "- **Scenario**: " + a.scenario + `
`;
      if (a.relationship)
        prompt += "- **Relationship to {{user}}**: " + a.relationship + `
`;
      if (a.openingVibe?.length)
        prompt += "- **First Message Style**: " + a.openingVibe.join(", ") + `
`;
      if (a.notes)
        prompt += "- **Additional Notes**: " + a.notes + `
`;
      prompt += `
## Requirements

`;
      prompt += "- `name`: Character name\n";
      prompt += "- `description`: Detailed appearance and backstory (2-4 paragraphs)\n";
      prompt += "- `personality`: Personality traits and mannerisms\n";
      prompt += "- `scenario`: The current setting and context\n";
      prompt += "- `first_mes`: An engaging opening message in character, using *asterisks for actions* and dialogue in quotes. Match the requested opening vibe.\n";
      prompt += "- `mes_example`: 2-3 example dialogues in <START> blocks showing different aspects of the character\n";
      prompt += "- `system_prompt`: A system prompt that captures the character essence\n";
      prompt += "- `tags`: The tags provided\n";
      prompt += "- `creator_notes`: Brief usage notes for the card\n";
      prompt += `- Use {{char}} for the character name and {{user}} for the user in example messages
`;
      prompt += `- Keep the JSON structure clean and valid
`;
      const card = CardEngine.createEmptyCard(a.name || "New Character");
      card.tags = a.tags || [];
      card.creator = a.creator || "";
      await CardStorage.upsertCard(card);
      window.AppState.cards = CardStorage.getCards();
      await CardManager.selectCard(card);
      if (chosenImage) {
        try {
          await Editor.setAvatar(chosenImage);
        } catch (_) {}
      }
      CardManager.renderCardList();
      AiChat._sendFullCard(prompt);
    }
  };
  if (typeof window !== "undefined")
    window.Wizard = Wizard2;

  // js/waifuTab.js
  var WaifuTab2 = {
    _fetched: [],
    _selected: -1,
    _fetching: false,
    _source: "snapshot",
    _gender: "all",
    _mode: "source",
    _preloaded: false,
    _lastRun: null,
    init() {
      const on = (sel, event, fn) => {
        const el = document.querySelector(sel);
        if (el)
          el.addEventListener(event, fn);
      };
      on("#waifuBtnFetch", "click", () => this._fetch());
      on("#waifuBtnRegenerate", "click", () => this._regenerate());
      on("#waifuBtnMixed", "click", () => this._fetchMixedFromUI());
      on("#waifuBtnUse", "click", () => this._useSelected());
      on("#waifuBtnRemove", "click", () => this._removeCurrent());
      on("#waifuBtnUpload", "click", () => {
        const inp = document.querySelector("#waifuUploadInput");
        if (inp)
          inp.click();
      });
      on("#waifuUploadInput", "change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f)
          Editor.setAvatar(f);
        e.target.value = "";
      });
      on("#waifuSourceSelect", "change", () => this._onSourceChange());
      const chipsWrap = document.querySelector("#waifuGenderChips");
      if (chipsWrap) {
        chipsWrap.addEventListener("click", (e) => {
          const chip = e.target.closest(".waifu-chip");
          if (!chip || !chip.dataset.gender)
            return;
          this._gender = chip.dataset.gender;
          chipsWrap.querySelectorAll(".waifu-chip").forEach((c) => {
            c.classList.toggle("active", c === chip);
          });
        });
      }
      const search = document.querySelector("#waifuTagSearch");
      if (search) {
        search.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this._fetch();
          }
        });
      }
      const tabTrigger = document.querySelector('#editorTabs .nav-link[data-bs-target="#tabWaifu"]');
      if (tabTrigger) {
        tabTrigger.addEventListener("shown.bs.tab", () => {
          this._refreshPreview();
          this._render();
          if (!this._preloaded && !this._fetched.length && !this._fetching) {
            this._preloaded = true;
            this._fetchMixedFromUI();
          }
        });
      }
      this._onSourceChange();
      this._refreshPreview();
      this._render();
    },
    _onSourceChange() {
      const select = document.querySelector("#waifuSourceSelect");
      this._source = select ? select.value : "snapshot";
      this._mode = "source";
      const isChar = this._source === "character";
      const genderWrap = document.querySelector("#waifuGenderWrap");
      if (genderWrap)
        genderWrap.style.display = isChar ? "" : "none";
      const sub = document.querySelector("#waifuSubText");
      const search = document.querySelector("#waifuTagSearch");
      const label = document.querySelector("#waifuSearchLabel");
      if (isChar) {
        if (sub)
          sub.textContent = I18n.t("editor.waifuCharSub");
        if (search)
          search.placeholder = I18n.t("editor.waifuSearchPlaceholderChar");
        if (label)
          label.textContent = I18n.t("editor.waifuSearchChar");
      } else {
        if (sub)
          sub.textContent = I18n.t("editor.waifuSub");
        if (search)
          search.placeholder = I18n.t("editor.waifuSearchPlaceholder");
        if (label)
          label.textContent = I18n.t("editor.waifuSearch");
      }
      this._syncGenderChips();
      this._discardResults();
    },
    _syncGenderChips() {
      const wrap = document.querySelector("#waifuGenderChips");
      if (!wrap)
        return;
      wrap.querySelectorAll(".waifu-chip").forEach((c) => {
        c.classList.toggle("active", c.dataset.gender === this._gender);
      });
    },
    _discardResults() {
      this._fetched.forEach((f) => {
        if (f && f.objUrl)
          URL.revokeObjectURL(f.objUrl);
      });
      this._fetched = [];
      this._selected = -1;
      this._render();
    },
    _searchValue() {
      const inp = document.querySelector("#waifuTagSearch");
      return inp ? inp.value.trim() : "";
    },
    _tagsFromSearch(searchVal) {
      const tags = (searchVal || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!tags.length)
        tags.push("waifu");
      return tags;
    },
    _slotTags(userTags, i) {
      const idx1 = i * 2 % userTags.length;
      const tags = [userTags[idx1]];
      if (userTags.length > 1) {
        const idx2 = (i * 2 + 1) % userTags.length;
        if (idx2 !== idx1)
          tags.push(userTags[idx2]);
      }
      return tags;
    },
    async _fetchSnapshots(searchVal) {
      const results = [];
      const userTags = this._tagsFromSearch(searchVal);
      for (let i = 0;i < 3; i++) {
        try {
          const slotTags = this._slotTags(userTags, i);
          const page = Math.max(1, Math.floor(Math.random() * 20));
          const resp = await fetch("https://api.waifu.im/images?" + "included_tags=" + encodeURIComponent(slotTags.join(",")) + "&is_nsfw=false&page=" + page);
          if (!resp.ok)
            throw new Error("API returned " + resp.status);
          const data = await resp.json();
          const items = data.items || [];
          if (!items.length)
            throw new Error("No image for " + slotTags.join(", "));
          const item = items[Math.floor(Math.random() * items.length)];
          const imgResp = await fetch(item.url);
          const blob = await imgResp.blob();
          const objUrl = URL.createObjectURL(blob);
          results.push({
            blob,
            url: item.url,
            objUrl,
            tags: (item.tags || []).map((t) => t.name).slice(0, 4).join(", ")
          });
        } catch (e) {
          console.error("waifu tab snapshot slot " + i + " fetch failed", e);
        }
      }
      return results;
    },
    async _graphQL(query, variables) {
      const resp = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables })
      });
      if (!resp.ok)
        throw new Error("AniList returned " + resp.status);
      return resp.json();
    },
    _characterQuery() {
      return `
      query ($search: String, $page: Int, $perPage: Int, $sort: [CharacterSort]) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          characters(search: $search, sort: $sort) {
            id
            name { full }
            gender
            image { large }
          }
        }
      }`;
    },
    async _queryCharacters(searchVal, genderWanted, want) {
      const search = searchVal || null;
      const perPage = 50;
      const candidates = [];
      const sort = search ? "SEARCH_MATCH" : "FAVOURITES_DESC";
      const pages = search ? 2 : 4;
      for (let page = 1;page <= pages; page++) {
        try {
          const data = await this._graphQL(this._characterQuery(), {
            search,
            page,
            perPage,
            sort: [sort]
          });
          const chars = data.data && data.data.Page && data.data.Page.characters || [];
          let pool = chars;
          if (genderWanted !== "all") {
            pool = pool.filter((c) => c && (c.gender || "").toLowerCase() === genderWanted);
          }
          for (const c of pool) {
            if (c && c.image && c.image.large)
              candidates.push(c);
          }
        } catch (e) {
          console.error("AniList character fetch failed", e);
          break;
        }
        if (candidates.length >= 60)
          break;
      }
      if (search) {
        candidates.splice(want);
      } else {
        for (let i = candidates.length - 1;i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
      }
      const results = [];
      for (const c of candidates) {
        if (results.length >= want)
          break;
        try {
          const imgResp = await fetch(c.image.large);
          if (!imgResp.ok)
            continue;
          const blob = await imgResp.blob();
          const objUrl = URL.createObjectURL(blob);
          const name = c.name && c.name.full || "";
          const genderLabel = (c.gender || "").toLowerCase() === "female" ? "Female" : "Male";
          results.push({ blob, url: c.image.large, objUrl, tags: (name + " · " + genderLabel).trim() });
        } catch (e) {}
      }
      return results;
    },
    async _fetchMixed(searchVal) {
      const [female, male] = await Promise.all([
        this._queryCharacters(searchVal, "female", 3),
        this._queryCharacters(searchVal, "male", 3)
      ]);
      const out = [];
      for (let i = 0;i < 3; i++) {
        if (female[i])
          out.push(female[i]);
        if (male[i])
          out.push(male[i]);
      }
      return out;
    },
    _currentIntent() {
      return {
        mode: this._mode,
        source: this._source,
        gender: this._gender,
        search: this._searchValue()
      };
    },
    async _runFetch(intent, triggerBtn) {
      if (this._fetching)
        return;
      this._fetching = true;
      const fetchBtn = document.querySelector("#waifuBtnFetch");
      const fetchLabel = fetchBtn ? fetchBtn.querySelector("span") : null;
      if (fetchLabel)
        fetchLabel.textContent = I18n.t("wizard.fetching");
      if (triggerBtn)
        triggerBtn.disabled = true;
      try {
        let results;
        if (intent.mode === "mixed") {
          results = await this._fetchMixed(intent.search);
        } else if (intent.source === "character") {
          results = await this._queryCharacters(intent.search, intent.gender, 3);
        } else {
          results = await this._fetchSnapshots(intent.search);
        }
        this._fetched.forEach((f) => {
          if (f && f.objUrl)
            URL.revokeObjectURL(f.objUrl);
        });
        this._fetched = results;
        this._selected = results.length ? 0 : -1;
        this._render();
        if (!results.length) {
          Ui.showToast(I18n.t("toast.wizardFetchFailed", { error: "No results found" }), "danger");
        }
        this._lastRun = intent;
      } finally {
        this._fetching = false;
        if (fetchLabel)
          fetchLabel.textContent = I18n.t("editor.waifuFetch");
        if (triggerBtn)
          triggerBtn.disabled = false;
      }
    },
    _fetch() {
      this._runFetch(this._currentIntent(), document.querySelector("#waifuBtnFetch"));
    },
    _regenerate() {
      if (!this._lastRun) {
        this._fetch();
        return;
      }
      this._runFetch({ ...this._lastRun }, document.querySelector("#waifuBtnRegenerate"));
    },
    _fetchMixedFromUI() {
      const src = document.querySelector("#waifuSourceSelect");
      if (src)
        src.value = "character";
      this._source = "character";
      this._gender = "all";
      this._mode = "mixed";
      this._onSourceChange();
      this._syncGenderChips();
      this._runFetch({ mode: "mixed", search: this._searchValue() }, document.querySelector("#waifuBtnMixed"));
    },
    _render() {
      const wrap = document.querySelector("#waifuResults");
      const btnUse = document.querySelector("#waifuBtnUse");
      const isMixed = this._mode === "mixed";
      if (!wrap)
        return;
      if (!this._fetched.length) {
        wrap.innerHTML = "";
        if (btnUse)
          btnUse.hidden = true;
        return;
      }
      wrap.innerHTML = '<div class="waifu-results-grid">' + this._fetched.map((f, i) => {
        const tagHtml = f.tags ? '<div class="waifu-card-tags">' + Ui.escapeHtml(f.tags) + "</div>" : "";
        return '<div class="waifu-card' + (i === this._selected ? " selected" : "") + '" data-idx="' + i + '" role="button" tabindex="0">' + '<img src="' + f.objUrl + '" alt="">' + tagHtml + "</div>";
      }).join("") + "</div>";
      wrap.querySelectorAll(".waifu-card").forEach((card) => {
        card.addEventListener("click", () => {
          this._selected = +card.dataset.idx;
          this._render();
        });
      });
      if (btnUse)
        btnUse.hidden = this._selected < 0;
    },
    async _useSelected() {
      if (this._selected < 0 || !this._fetched[this._selected])
        return;
      const { activeCard } = window.AppState;
      if (!activeCard) {
        Ui.showToast(I18n.t("toast.createCardFirst"), "warning");
        return;
      }
      await Editor.setAvatar(this._fetched[this._selected].blob);
      this._refreshPreview();
    },
    async _removeCurrent() {
      const { activeCard } = window.AppState;
      if (!activeCard) {
        Ui.showToast(I18n.t("toast.selectCard"), "warning");
        return;
      }
      if (!activeCard._hasImage && !activeCard._imageBase64) {
        Ui.showToast(I18n.t("toast.noImage"), "warning");
        return;
      }
      delete activeCard._imageBase64;
      delete activeCard._thumbnail;
      activeCard._hasImage = false;
      if (activeCard._id) {
        try {
          await CardStorage.deleteImage(activeCard._id);
        } catch (_) {}
      }
      const img = document.querySelector("#charAvatarImg");
      if (img) {
        img.src = "";
        img.hidden = true;
      }
      const ph = document.querySelector("#avatarPlaceholder");
      if (ph)
        ph.style.display = "";
      try {
        await Editor.syncEditorToCard();
      } catch (_) {}
      this._refreshPreview();
      Ui.showToast(I18n.t("toast.imageRemoved"), "success");
    },
    _refreshPreview() {
      const { activeCard } = window.AppState;
      const img = document.querySelector("#waifuCurrentImg");
      const noImg = document.querySelector("#waifuNoImage");
      if (!img || !noImg)
        return;
      if (activeCard && (activeCard._imageBase64 || activeCard._hasImage)) {
        img.src = activeCard._imageBase64 || activeCard._thumbnail || "";
        img.hidden = false;
        noImg.style.display = "none";
      } else {
        img.src = "";
        img.hidden = true;
        noImg.style.display = "";
      }
    }
  };
  if (typeof window !== "undefined")
    window.WaifuTab = WaifuTab2;

  // js/settings.js
  var Settings2 = {
    PROMPTS: [
      "assistant",
      "fullCard",
      "wizard",
      "fullCardInstr",
      "fieldsEdit",
      "greetingsSystem",
      "enhance",
      "personality",
      "firstmes",
      "scenario",
      "shorten",
      "tone",
      "grammar",
      "greetings",
      "systemprompt",
      "translate",
      "tags",
      "tagsSystem"
    ],
    DEFAULT_PROMPTS: {
      assistant: `You are an AI assistant helping edit SillyTavern character cards.
SillyTavern is an AI roleplay frontend. Cards define character personalities.`,
      fullCard: `You are an AI assistant helping edit SillyTavern character cards.
SillyTavern is an AI roleplay frontend. Cards define character personalities.`,
      wizard: "Create a complete SillyTavern character card as valid JSON (chara_card_v2 spec).",
      enhance: "Enhance the character description to be more detailed and vivid. Add sensory details and specific traits.",
      personality: "Expand the personality to be more nuanced. Add quirks, habits, fears, and motivations.",
      firstmes: "Improve the first message to be more engaging and in-character.",
      scenario: "Expand the scenario to be more detailed, immersive, and vivid. Add sensory atmosphere and narrative depth.",
      shorten: "Shorten and tighten the description while preserving the core meaning and character voice. Remove redundancies.",
      tone: `Rewrite the following description with a "{tone}" tone while preserving the character's core personality and key information.`,
      grammar: "Fix all grammar, spelling, and punctuation errors in the description. Improve clarity without changing the meaning or voice.",
      greetings: "Generate alternate greetings for this character.",
      systemprompt: "Enhance this system prompt to be more effective and comprehensive. Improve the instructions for the AI roleplay assistant.",
      translate: `Translate this character card to {lang}. Output the COMPLETE card as valid JSON with all fields translated. Keep the exact same JSON structure. Translate ALL text fields.

Here is the card JSON:
{card}`,
      tags: 'Analyze this character card and suggest relevant, short tags for organizing it in a card library. Consider the name, description, personality, scenario, and first message. Respond with ONLY a JSON array of 8-15 short lowercase tag strings, like: ["fantasy", "warrior", "elf"].',
      tagsSystem: `Respond with ONLY a JSON array of short tag strings. No explanations, no markdown, no code fences.
Example: ["fantasy", "warrior", "elf"]`,
      fullCardInstr: `The user wants you to edit or generate the FULL card as JSON.
Respond with ONLY the updated JSON card. Keep the exact JSON structure.`,
      fieldsEdit: `The user wants you to edit the "{field}" field of this card.

Below is the current content of that field:
[{field}]
{current}

Respond with ONLY the new content for this field. Do not include explanations, JSON wrapping, or markdown fences unless the original content uses them.`,
      greetingsSystem: `The user wants you to generate ALTERNATE GREETINGS for this character.
Current greetings: {current}
Generate exactly {count} new alternate greeting(s).
Respond with ONLY a valid JSON array of greeting strings. No explanations, no markdown.
Example response format: ["Greeting one...", "Greeting two...", "Greeting three..."]
Each greeting should be an in-character opening message that could start a conversation with {{user}}.`
    },
    async saveSettings(modal) {
      const $ = (sel) => document.querySelector(sel);
      const provider = $("#providerSelect").value;
      const apiKey = $("#apiKeyInput").value.trim();
      const defaultModel = $("#defaultModelSelect").value;
      const maxTokens = parseInt($("#maxTokensInput").value, 10) || 0;
      const customApiUrl = $("#customApiUrlInput").value.trim();
      const keyInput = provider === "custom" ? $("#customApiKeyInput") : $("#namedApiKeyInput");
      const customApiKey = keyInput.value.trim();
      const customModelId = $("#customModelInput").value.trim();
      CardStorage.setProvider(provider);
      if (provider === "openrouter") {
        await CardStorage.setApiKey(apiKey);
        AIService.setProvider("openrouter", apiKey);
        CardStorage.setDefaultModel(defaultModel);
        $("#aiModelSelect").value = defaultModel;
      } else {
        const isCustom = provider === "custom";
        const info = AIService.getProviderInfo(provider);
        if (isCustom) {
          CardStorage.setCustomApiUrl(customApiUrl);
          await CardStorage.setCustomApiKey(customApiKey);
        } else {
          await CardStorage.setProviderKey(provider, customApiKey);
        }
        CardStorage.setCustomModelId(customModelId);
        AIService.setProvider(provider, customApiKey);
        CardStorage.setDefaultModel(customModelId);
        $("#aiModelSelect").value = customModelId;
      }
      CardStorage.setMaxTokens(maxTokens);
      CardStorage.setInjectCopyright($("#injectCopyrightToggle").checked);
      const densitySel = $("#glassDensitySelect");
      if (densitySel)
        CardStorage.setGlassDensity(densitySel.value);
      const radiusSel = $("#cardRadiusSelect");
      if (radiusSel)
        CardStorage.setCardRadius(radiusSel.value);
      const vignetteToggle = $("#vignetteToggle");
      if (vignetteToggle)
        CardStorage.setVignette(vignetteToggle.checked);
      this.applyAppearance();
      this.PROMPTS.forEach((name) => {
        const input = document.querySelector("#prompt" + name[0].toUpperCase() + name.slice(1) + "Input");
        const value = input ? input.value : "";
        CardStorage.setPrompt(name, value === this.getDefaultPrompt(name) ? "" : value);
      });
      const theme = document.documentElement.getAttribute("data-theme") || "dark";
      const themeColorInput = document.querySelector("#themeColorHex");
      const themeColor = themeColorInput ? themeColorInput.value.trim() : "";
      if (/^#[0-9a-fA-F]{6}$/.test(themeColor))
        this.applyAccent(theme, themeColor);
      modal.hide();
      Ui.showToast(I18n.t("toast.settingsSaved"), "success");
      if (provider === "openrouter" && apiKey)
        this.refreshCredits();
      if (provider === "custom" || apiKey || customApiKey)
        this.refreshModelsList();
    },
    toggleApiKeyVisibility() {
      const $ = (sel) => document.querySelector(sel);
      const input = $("#apiKeyInput");
      const icon = $("#btnToggleApiKey i");
      if (input.type === "password") {
        input.type = "text";
        icon.className = "bi bi-eye-slash-fill";
      } else {
        input.type = "password";
        icon.className = "bi bi-eye-fill";
      }
    },
    toggleNamedApiKeyVisibility() {
      const $ = (sel) => document.querySelector(sel);
      const input = $("#namedApiKeyInput");
      const icon = $("#btnToggleNamedApiKey i");
      if (input.type === "password") {
        input.type = "text";
        icon.className = "bi bi-eye-slash-fill";
      } else {
        input.type = "password";
        icon.className = "bi bi-eye-fill";
      }
    },
    toggleProvider() {
      const $ = (sel) => document.querySelector(sel);
      const provider = $("#providerSelect").value;
      const isOpenRouter = provider === "openrouter";
      const isCustom = provider === "custom";
      const isNamed = !isOpenRouter && !isCustom;
      AIService.setProvider(provider, isOpenRouter ? CardStorage.getApiKey() : isCustom ? CardStorage.getCustomApiKey() : CardStorage.getProviderKey(provider));
      $("#openrouterSettings").classList.toggle("d-none", !isOpenRouter);
      $("#customSettings").classList.toggle("d-none", !isCustom);
      $("#namedProviderSettings").classList.toggle("d-none", !isNamed);
      $("#modelIdSection").classList.toggle("d-none", isOpenRouter);
      $("#openrouterExtras").classList.remove("d-none");
      $("#creditsSection").classList.toggle("d-none", !isOpenRouter);
      $("#securityWarning").classList.remove("d-none");
      if (isNamed) {
        const info = AIService.getProviderInfo(provider);
        $("#namedApiUrlInput").value = info.baseUrl;
        $("#namedApiKeyInput").value = CardStorage.getProviderKey(provider);
        const linkMap = {
          nanogpt: "https://nano-gpt.com",
          xai: "https://console.x.ai",
          zai: "https://z.ai",
          chutes: "https://chutes.ai",
          deepseek: "https://platform.deepseek.com"
        };
        $("#namedProviderLink").innerHTML = '<a href="' + (linkMap[provider] || "#") + '" target="_blank" class="text-accent">' + (I18n.t ? I18n.t("settings.getApiKeyFrom") : "Get API key from ") + Ui.escapeHtml(info.name) + ' <i class="bi bi-box-arrow-up-right ms-1"></i></a>';
      }
      if (isCustom) {
        $("#customModelInput").placeholder = I18n.t ? I18n.t("settings.customModelPlaceholder") : "e.g. llama-3.2-8b-instruct";
        $("#modelIdHint").textContent = I18n.t("settings.modelIdHint");
      } else if (isNamed) {
        $("#customModelInput").placeholder = I18n.t ? I18n.t("settings.namedModelPlaceholder", { provider }) : "e.g. " + provider + "-latest";
        $("#modelIdHint").textContent = I18n.t("settings.modelIdHintNamed");
      }
    },
    applyAccent(theme, color) {
      const normalized = String(color || "").trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(normalized))
        return false;
      const shades = this._accentShades(normalized, theme);
      CardStorage.setAccent(theme, normalized);
      Object.entries(shades).forEach(([name, value]) => document.documentElement.style.setProperty(name, value));
      document.documentElement.setAttribute("data-accent-custom", "true");
      return true;
    },
    _accentShades(hex, theme) {
      const rgb = hex.slice(1).match(/.{2}/g).map((v) => parseInt(v, 16));
      const mix = (target, amount) => rgb.map((v, i) => Math.round(v * amount + target[i] * (1 - amount)));
      const css = (values) => "#" + values.map((v) => v.toString(16).padStart(2, "0")).join("");
      const white = [255, 255, 255];
      const black = [0, 0, 0];
      return {
        "--accent-300": css(mix(white, 0.42)),
        "--accent-400": css(mix(white, 0.72)),
        "--accent-500": hex,
        "--accent-600": css(mix(black, 0.82)),
        "--accent-700": css(mix(black, 0.62)),
        "--accent-glow": "rgba(" + rgb.join(", ") + ", 0.25)",
        "--accent-glow-strong": "rgba(" + rgb.join(", ") + ", 0.45)",
        "--accent-text": theme === "light" ? css(mix(black, 0.82)) : css(mix(white, 0.78))
      };
    },
    getDefaultPrompt(name) {
      return this.DEFAULT_PROMPTS[name] || "";
    },
    resetPrompts() {
      this.PROMPTS.forEach((name) => CardStorage.setPrompt(name, ""));
      this.openSettings();
    },
    resetAccent(theme) {
      this.applyAccent(theme, "#64748b");
      this.syncAccentControls();
    },
    syncAccentControls() {
      const theme = document.documentElement.getAttribute("data-theme") || "dark";
      const color = CardStorage.getAccent(theme) || "#64748b";
      const picker = document.querySelector("#themeColorPicker");
      const hex = document.querySelector("#themeColorHex");
      if (picker)
        picker.value = color;
      if (hex)
        hex.value = color;
    },
    APPEARANCE_PRESETS: [
      { id: "slate", name: "Slate", color: "#64748b" },
      { id: "purple", name: "Cosmic Purple", color: "#8b5cf6" },
      { id: "magenta", name: "Magenta", color: "#ec4899" },
      { id: "emerald", name: "Emerald", color: "#10b981" },
      { id: "solar", name: "Solar", color: "#f59e0b" },
      { id: "ocean", name: "Ocean", color: "#3b82f6" }
    ],
    applyAppearance() {
      const root = document.documentElement;
      const theme = root.getAttribute("data-theme") || "dark";
      const GLASS = {
        subtle: { dark: "rgba(17,15,30,0.92)", light: "rgba(255,255,255,0.94)", blur: "blur(8px)" },
        default: { dark: "rgba(17,15,30,0.72)", light: "rgba(255,255,255,0.78)", blur: "blur(12px)" },
        bold: { dark: "rgba(17,15,30,0.58)", light: "rgba(255,255,255,0.60)", blur: "blur(22px)" }
      };
      const g = GLASS[CardStorage.getGlassDensity()] || GLASS.default;
      root.style.setProperty("--glass-bg", g[theme]);
      root.style.setProperty("--glass-blur", g.blur);
      const RADII = {
        compact: { sm: "6px", md: "10px", lg: "14px" },
        rounded: { sm: "10px", md: "14px", lg: "18px" },
        pill: { sm: "14px", md: "18px", lg: "24px" }
      };
      const r = RADII[CardStorage.getCardRadius()] || RADII.compact;
      root.style.setProperty("--radius-sm", r.sm);
      root.style.setProperty("--radius-md", r.md);
      root.style.setProperty("--radius-lg", r.lg);
      root.style.setProperty("--vignette-opacity", CardStorage.getVignette() ? "1" : "0");
    },
    syncAppearanceControls() {
      const $ = (sel) => document.querySelector(sel);
      const density = $("#glassDensitySelect");
      if (density)
        density.value = CardStorage.getGlassDensity();
      const radius = $("#cardRadiusSelect");
      if (radius)
        radius.value = CardStorage.getCardRadius();
      const vignette = $("#vignetteToggle");
      if (vignette)
        vignette.checked = CardStorage.getVignette();
    },
    async openSettings() {
      const $ = (sel) => document.querySelector(sel);
      await CardStorage._unlockKeys();
      const provider = CardStorage.getProvider() || "openrouter";
      $("#providerSelect").value = provider;
      $("#apiKeyInput").value = CardStorage.getApiKey();
      $("#namedApiKeyInput").value = provider === "custom" ? "" : CardStorage.getProviderKey(provider);
      $("#customApiKeyInput").value = CardStorage.getCustomApiKey();
      $("#customApiUrlInput").value = CardStorage.getCustomApiUrl();
      $("#customModelInput").value = CardStorage.getCustomModelId();
      $("#maxTokensInput").value = CardStorage.getMaxTokens() || "";
      $("#injectCopyrightToggle").checked = CardStorage.getInjectCopyright();
      this.toggleProvider();
      this.syncAccentControls();
      this.syncAppearanceControls();
      this.PROMPTS.forEach((name) => {
        const input = $("#prompt" + name[0].toUpperCase() + name.slice(1) + "Input");
        if (input)
          input.value = CardStorage.getPrompt(name) || this.getDefaultPrompt(name);
      });
    },
    async refreshCredits() {
      const $ = (sel) => document.querySelector(sel);
      if (CardStorage.getProvider() !== "openrouter") {
        this.updateStorageUsage();
        return;
      }
      if (!AIService.hasApiKey()) {
        this.updateStorageUsage();
        return;
      }
      try {
        const info = await AIService.fetchKeyInfo();
        $("#creditsBadge").classList.remove("d-none");
        $("#creditsAmount").textContent = info.limit_remaining !== null ? "$" + Number(info.limit_remaining).toFixed(2) : I18n.t ? I18n.t("gen.notAvailable") : "N/A";
        $("#creditLimit").textContent = info.limit > 0 ? "$" + Number(info.limit).toFixed(2) : I18n.t ? I18n.t("gen.unlimited") : "Unlimited";
        $("#creditRemaining").textContent = info.limit_remaining !== null ? "$" + Number(info.limit_remaining).toFixed(2) : I18n.t ? I18n.t("gen.notAvailable") : "N/A";
        $("#creditUsage").textContent = info.usage > 0 ? "$" + Number(info.usage).toFixed(2) : "$0.00";
      } catch (err) {
        console.error("Failed to fetch credits:", err);
        $("#creditsBadge").classList.add("d-none");
      }
      this.updateStorageUsage();
    },
    async refreshModelsList() {
      const $ = (sel) => document.querySelector(sel);
      const modalEl = $("#settingsModal");
      const modalOpen = modalEl && modalEl.classList.contains("show");
      const provider = modalOpen ? $("#providerSelect").value : CardStorage.getProvider();
      const isCustom = provider === "custom";
      let formKey = "";
      if (modalOpen) {
        const keyField = provider === "openrouter" ? $("#apiKeyInput") : isCustom ? $("#customApiKeyInput") : $("#namedApiKeyInput");
        formKey = keyField ? keyField.value.trim() : "";
      }
      AIService.setProvider(provider, formKey);
      if (isCustom && modalOpen) {
        const urlInput = $("#customApiUrlInput");
        AIService._customApiUrl = urlInput ? urlInput.value.trim() : "";
      }
      if (!AIService.hasApiKey() && !isCustom) {
        Ui.showToast(I18n.t("error.apiKeyNotSet"), "warning");
        return;
      }
      const myToken = this._modelReqToken = (this._modelReqToken || 0) + 1;
      const container = document.querySelector("#modelList");
      if (container)
        container.innerHTML = '<div class="p-3"><div class="skeleton skeleton-line" style="width:80%"></div><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>';
      try {
        const models = await AIService.fetchModels();
        if (myToken !== this._modelReqToken)
          return;
        window.AppState.models = models;
        this.populateModelSelects();
        this.renderModelList();
      } catch (err) {
        if (myToken !== this._modelReqToken)
          return;
        console.error("Failed to fetch models:", err);
        this.populateModelSelects();
        Ui.showToast(I18n.t("toast.modelsFailed", { error: err.message }), "danger");
      }
    },
    populateModelSelects() {
      const $ = (sel) => document.querySelector(sel);
      const d = CardStorage.getDefaultModel();
      const sorted = [...window.AppState.models].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: "base" }));
      let h = sorted.map((m) => '<option value="' + Ui.escapeAttr(m.id) + '"' + (m.id === d ? " selected" : "") + ">" + Ui.escapeHtml(m.name) + (m.is_free ? " [" + I18n.t("gen.free") + "]" : "") + "</option>").join("");
      if (d && !window.AppState.models.some((m) => m.id === d)) {
        h += '<option value="' + Ui.escapeAttr(d) + '" selected>' + Ui.escapeHtml(d) + "</option>";
      }
      $("#defaultModelSelect").innerHTML = '<option value="">' + (I18n.t ? I18n.t("settings.modelAuto") : "Auto") + "</option>" + h;
      $("#aiModelSelect").innerHTML = '<option value="">' + (I18n.t ? I18n.t("nav.selectModel") : "Select model...") + "</option>" + h;
    },
    _modelPageSize: 50,
    _modelPage: 1,
    renderModelList(filter, resetPage) {
      const $ = (sel) => document.querySelector(sel);
      filter = (filter || "").toLowerCase();
      if (resetPage)
        this._modelPage = 1;
      const container = $("#modelList");
      const filtered = window.AppState.models.filter((m) => {
        const name = m.name || m.id || "";
        const id = m.id || "";
        const prov = m.provider || "";
        const desc = m.description || "";
        return !filter || name.toLowerCase().includes(filter) || id.toLowerCase().includes(filter) || prov.toLowerCase().includes(filter) || desc.toLowerCase().includes(filter);
      });
      if (!filtered.length) {
        container.innerHTML = '<div class="text-center text-muted py-4">' + I18n.t("settings.noModels") + "</div>";
        return;
      }
      const d = CardStorage.getDefaultModel();
      const end = this._modelPage * this._modelPageSize;
      const shown = filtered.slice(0, end);
      const hasMore = end < filtered.length;
      container.innerHTML = shown.map((m) => '<div class="model-item' + (m.id === d ? " selected" : "") + '" data-model-id="' + Ui.escapeAttr(m.id || "") + '">' + '<div class="model-item-info"><div class="model-item-name">' + Ui.escapeHtml(m.name || m.id || "?") + "</div>" + '<div class="model-item-provider">' + Ui.escapeHtml(m.provider || "") + " · " + (m.context_length ? Math.floor(m.context_length / 1000) + "k ctx" : "?") + (m.max_output_tokens ? " · " + Math.floor(m.max_output_tokens / 1000) + "k out" : "") + (m.is_free ? ' · <span class="text-success">' + I18n.t("gen.free") + "</span>" : "") + "</div></div>" + '<div class="model-item-pricing">' + (m.is_free ? '<span class="price-highlight">' + I18n.t("gen.free") + "</span>" : "<div>in: " + AIService.formatPrice(m.pricing ? m.pricing.prompt : null) + "</div><div>out: " + AIService.formatPrice(m.pricing ? m.pricing.completion : null) + "</div>") + "</div></div>").join("") + (hasMore ? '<div class="text-center py-2"><button class="btn btn-outline-accent btn-sm" id="btnLoadMoreModels">' + I18n.t("settings.loadMore", { count: filtered.length - end }) + "</button></div>" : "") + '<div class="text-center text-muted" style="font-size:0.7rem;">' + I18n.t("settings.showingModels", { shown: Math.min(end, filtered.length), total: filtered.length }) + "</div>";
      Anims.staggerFadeIn(container.querySelectorAll(".model-item"), { stagger: 15, duration: 150 });
      const self = this;
      container.querySelectorAll(".model-item").forEach((item) => {
        item.addEventListener("click", () => {
          $("#defaultModelSelect").value = item.dataset.modelId;
          $("#aiModelSelect").value = item.dataset.modelId;
          CardStorage.setDefaultModel(item.dataset.modelId);
          self.renderModelList(filter);
          Ui.showToast(I18n.t("toast.modelSet", { model: item.dataset.modelId }), "info");
        });
      });
      const loadMore = container.querySelector("#btnLoadMoreModels");
      if (loadMore)
        loadMore.addEventListener("click", () => {
          self._modelPage++;
          self.renderModelList(filter);
        });
    },
    filterModels() {
      const $ = (sel) => document.querySelector(sel);
      this.renderModelList($("#modelSearch").value, true);
    },
    async updateStorageUsage() {
      const $ = (sel) => document.querySelector(sel);
      const bytes = await CardStorage.getUsageEstimate();
      const kb = (bytes / 1024).toFixed(1);
      const mb = (bytes / (1024 * 1024)).toFixed(2);
      const gb = (bytes / (1024 * 1024 * 1024)).toFixed(2);
      $("#storageUsage").textContent = parseFloat(gb) >= 1 ? gb + " GB" : parseFloat(kb) > 1000 ? mb + " MB" : kb + " KB";
    },
    async confirmClearStorage() {
      const $ = (sel) => document.querySelector(sel);
      if (!confirm(I18n.t("settings.clearConfirm")))
        return;
      await CardStorage.clearAll();
      window.AppState.cards = [];
      window.AppState.activeCard = null;
      window.AppState.chatHistory = [];
      window.AppState.models = [];
      AIService.setProvider("openrouter");
      $("#apiKeyInput").value = "";
      $("#providerSelect").value = "openrouter";
      $("#customApiUrlInput").value = "";
      $("#namedApiKeyInput").value = "";
      $("#customApiKeyInput").value = "";
      $("#customModelInput").value = "";
      this.toggleProvider();
      $("#defaultModelSelect").innerHTML = '<option value="">' + (I18n.t ? I18n.t("settings.modelAuto") : "Auto") + "</option>";
      $("#aiModelSelect").innerHTML = '<option value="">' + (I18n.t ? I18n.t("nav.selectModel") : "Select model...") + "</option>";
      Editor.hideEditor();
      CardManager.renderCardList();
      this.renderModelList();
      $("#creditsBadge").classList.add("d-none");
      $("#aiChatMessages").innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>' + (I18n.t ? I18n.t("ai.welcomeTitle") : "AI Card Assistant") + "</h6><p>" + (I18n.t ? I18n.t("ai.welcomeText") : "Ask the AI to edit, translate, or enhance your character card.") + "</p></div>";
      Ui.showToast(I18n.t("toast.dataCleared"), "warning");
    },
    exportSettings() {
      const settings = {
        provider: CardStorage.getProvider(),
        defaultModel: CardStorage.getDefaultModel(),
        maxTokens: CardStorage.getMaxTokens(),
        injectCopyright: CardStorage.getInjectCopyright(),
        customApiUrl: CardStorage.getCustomApiUrl(),
        customModelId: CardStorage.getCustomModelId()
      };
      Ui.downloadFile("st-card-editor-settings.json", JSON.stringify(settings, null, 2), "application/json");
      Ui.showToast(I18n.t("toast.settingsExported"), "success");
    },
    importSettings() {
      const $ = (sel) => document.querySelector(sel);
      const input = document.querySelector("#settingsFileInput");
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file)
          return;
        const reader = new FileReader;
        reader.onload = async () => {
          try {
            const settings = JSON.parse(reader.result);
            if (settings.provider) {
              CardStorage.setProvider(settings.provider);
              $("#providerSelect").value = settings.provider;
              this.toggleProvider();
            }
            if (settings.defaultModel) {
              CardStorage.setDefaultModel(settings.defaultModel);
              $("#defaultModelSelect").value = settings.defaultModel;
              $("#aiModelSelect").value = settings.defaultModel;
            }
            if (settings.maxTokens !== undefined) {
              CardStorage.setMaxTokens(settings.maxTokens);
              $("#maxTokensInput").value = settings.maxTokens || "";
            }
            if (settings.injectCopyright !== undefined) {
              CardStorage.setInjectCopyright(settings.injectCopyright);
              $("#injectCopyrightToggle").checked = settings.injectCopyright;
            }
            if (settings.customApiUrl) {
              CardStorage.setCustomApiUrl(settings.customApiUrl);
              $("#customApiUrlInput").value = settings.customApiUrl;
            }
            if (settings.customModelId) {
              CardStorage.setCustomModelId(settings.customModelId);
              $("#customModelInput").value = settings.customModelId;
            }
            Ui.showToast(I18n.t("toast.settingsImported"), "success");
          } catch (err) {
            Ui.showToast(I18n.t("toast.invalidFile"), "danger");
          }
        };
        reader.readAsText(file);
        e.target.value = "";
      };
      input.click();
    },
    exportPrompts() {
      const prompts = {};
      this.PROMPTS.forEach((name) => {
        prompts[name] = CardStorage.getPrompt(name) || this.getDefaultPrompt(name);
      });
      Ui.downloadFile("st-card-editor-prompts.json", JSON.stringify({ version: 1, prompts }, null, 2), "application/json");
      Ui.showToast(I18n.t ? I18n.t("settings.promptsExported") : "Prompts exported", "success");
    },
    importPrompts() {
      const $ = (sel) => document.querySelector(sel);
      const input = document.querySelector("#promptFileInput");
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file)
          return;
        const reader = new FileReader;
        reader.onload = async () => {
          try {
            const data = JSON.parse(reader.result);
            const map = data && data.prompts || {};
            if (typeof map !== "object" || Array.isArray(map))
              throw new Error("bad");
            let count = 0;
            this.PROMPTS.forEach((name) => {
              if (!(name in map))
                return;
              const value = typeof map[name] === "string" ? map[name] : "";
              CardStorage.setPrompt(name, value === this.getDefaultPrompt(name) ? "" : value);
              count++;
            });
            if (!count)
              throw new Error("none");
            this.PROMPTS.forEach((name) => {
              const field = $("#prompt" + name[0].toUpperCase() + name.slice(1) + "Input");
              if (field)
                field.value = CardStorage.getPrompt(name) || this.getDefaultPrompt(name);
            });
            Ui.showToast(I18n.t ? I18n.t("settings.promptsImported", { count }) : "Imported " + count + " prompts", "success");
          } catch (err) {
            Ui.showToast(I18n.t("toast.invalidFile"), "danger");
          }
        };
        reader.readAsText(file);
        e.target.value = "";
      };
      input.click();
    },
    async exportWorkspace() {
      const $ = (sel) => document.querySelector(sel);
      const cards = CardStorage.getCards();
      const fullCards = [];
      for (const meta of cards) {
        const card = await CardStorage.getCard(meta._id);
        if (!card)
          continue;
        try {
          const b64 = await CardStorage.getImage(card._id);
          if (b64)
            card._imageBase64 = b64;
        } catch (_) {}
        delete card._id;
        delete card._filename;
        delete card._createdAt;
        delete card._fileSize;
        fullCards.push(card);
      }
      const workspace = {
        version: "2.1",
        exportedAt: new Date().toISOString(),
        cards: fullCards,
        settings: {
          provider: CardStorage.getProvider(),
          defaultModel: CardStorage.getDefaultModel(),
          maxTokens: CardStorage.getMaxTokens(),
          injectCopyright: CardStorage.getInjectCopyright(),
          glassDensity: CardStorage.getGlassDensity(),
          cardRadius: CardStorage.getCardRadius(),
          vignette: CardStorage.getVignette()
        }
      };
      Ui.downloadFile("st-card-editor-workspace-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(workspace, null, 2), "application/json");
      Ui.showToast(I18n.t ? I18n.t("settings.workspaceExported", { count: fullCards.length }) : "Workspace exported (" + fullCards.length + " cards)", "success");
    },
    importWorkspace() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      const cleanup = () => {
        input.onchange = null;
        input.onabort = null;
        input.oncancel = null;
        input.remove();
      };
      input.onabort = cleanup;
      input.oncancel = cleanup;
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) {
          cleanup();
          return;
        }
        try {
          const text = await file.text();
          const workspace = JSON.parse(text);
          if (!workspace.cards || !Array.isArray(workspace.cards)) {
            throw new Error(I18n.t ? I18n.t("settings.invalidWorkspace") : "Invalid workspace format");
          }
          let imported = 0;
          for (const card of workspace.cards) {
            if (!card.name && !card.description)
              continue;
            const normalized = CardEngine.normalize(card, (card.name || "character") + ".json");
            const trimmedName = (normalized.name || "").trim();
            if (trimmedName) {
              const existing = CardStorage.getCards().find((c) => (c.name || "").trim().toLowerCase() === trimmedName.toLowerCase());
              if (existing) {
                let existingFull = null;
                try {
                  existingFull = await CardStorage.getCard(existing._id);
                } catch (_) {}
                if (existingFull && CardManager._cardSignature(normalized) === CardManager._cardSignature(existingFull)) {
                  const base = trimmedName;
                  let n = 2;
                  const used = new Set(CardStorage.getCards().map((c) => (c.name || "").toLowerCase()));
                  let candidate = base + " (" + n + ")";
                  while (used.has(candidate.toLowerCase())) {
                    n++;
                    candidate = base + " (" + n + ")";
                  }
                  normalized.name = candidate;
                }
              }
            }
            if (card._imageBase64) {
              await CardStorage.saveImage(normalized._id, card._imageBase64);
              normalized._hasImage = true;
              normalized._thumbnail = normalized._thumbnail || await CardEngine._createThumbnail(card._imageBase64);
            }
            await CardStorage.upsertCard(normalized);
            imported++;
          }
          if (workspace.settings) {
            if (workspace.settings.provider) {
              CardStorage.setProvider(workspace.settings.provider);
              const isCustom = workspace.settings.provider === "custom";
              const isOR = workspace.settings.provider === "openrouter";
              const providerKey = isOR ? CardStorage.getApiKey() : isCustom ? CardStorage.getCustomApiKey() : CardStorage.getProviderKey(workspace.settings.provider);
              AIService.setProvider(workspace.settings.provider, providerKey);
              const sel = document.querySelector("#providerSelect");
              if (sel)
                sel.value = workspace.settings.provider;
            }
            if (workspace.settings.defaultModel) {
              CardStorage.setDefaultModel(workspace.settings.defaultModel);
            }
            if (workspace.settings.maxTokens !== undefined)
              CardStorage.setMaxTokens(workspace.settings.maxTokens);
            if (workspace.settings.injectCopyright !== undefined)
              CardStorage.setInjectCopyright(workspace.settings.injectCopyright);
            if (workspace.settings.glassDensity !== undefined)
              CardStorage.setGlassDensity(workspace.settings.glassDensity);
            if (workspace.settings.cardRadius !== undefined)
              CardStorage.setCardRadius(workspace.settings.cardRadius);
            if (workspace.settings.vignette !== undefined)
              CardStorage.setVignette(workspace.settings.vignette);
          }
          window.AppState.cards = CardStorage.getCards();
          CardManager.renderCardList();
          Settings2.applyAppearance();
          Settings2.refreshModelsList();
          const modelSel = document.querySelector("#aiModelSelect");
          if (modelSel)
            modelSel.value = CardStorage.getDefaultModel() || "";
          Ui.showToast(I18n.t ? I18n.t("settings.workspaceImported", { count: imported }) : "Workspace imported (" + imported + " cards)", "success");
        } catch (err) {
          console.error("Workspace import failed:", err);
          Ui.showToast(I18n.t ? I18n.t("settings.workspaceImportFailed", { error: err.message }) : "Failed to import workspace: " + err.message, "danger");
        }
        cleanup();
      };
      document.body.appendChild(input);
      input.click();
    }
  };
  if (typeof window !== "undefined")
    window.Settings = Settings2;

  // js/i18n.js
  var STORAGE_KEY = "stce_lang";
  var SUPPORTED = ["en", "fr", "es", "de", "pt", "ja", "zh", "ko", "el", "ru", "it", "pl", "tr", "nl", "uk", "vi", "id", "hi", "ar", "he", "fa"];
  var RTL_LANGS = ["ar", "he", "fa"];
  var translations = {};
  translations.en = {
    "app.title": "ST Card Editor — SillyTavern Character Card Studio",
    "nav.selectModel": "Select model...",
    "nav.wizard": "Create with AI wizard",
    "nav.newCard": "New blank card",
    "nav.save": "Save",
    "nav.theme": "Toggle theme",
    "nav.shortcuts": "Shortcuts & help",
    "nav.settings": "Settings",
    "nav.focus": "Focus mode",
    "nav.focusAlt": "Focus mode (Alt+F)",
    "left.title": "Card Library",
    "left.cards": "{{count}} cards",
    "left.drop": "Drag & drop",
    "left.dropSub": "PNG or JSON character cards",
    "left.browse": "Browse files",
    "left.search": "Search cards...",
    "left.sort.nameAsc": "Name A-Z",
    "left.sort.nameDesc": "Name Z-A",
    "left.sort.manual": "Manual",
    "left.sort.newest": "Newest first",
    "left.sort.oldest": "Oldest first",
    "left.sort.largest": "Largest",
    "left.sort.smallest": "Smallest",
    "left.filterTags": "Filter by tags",
    "left.exportSelected": "Export selected as JSON",
    "left.deleteSelected": "Delete selected",
    "left.empty": "No cards loaded",
    "left.emptySub": "Drop a card or click Browse",
    "center.noCard": "No card selected",
    "center.noCardSub": "Select a card from the library or drag & drop a new one",
    "center.createAI": "Create with AI",
    "center.blankCard": "Blank Card",
    "editor.avatar": "Click or drop an image to set the avatar",
    "editor.avatarAria": "Set character avatar",
    "editor.name": "Character Name",
    "editor.exportJson": "Export as JSON",
    "editor.exportPng": "Export as PNG",
    "editor.duplicate": "Duplicate card",
    "editor.delete": "Delete card",
    "editor.tab.core": "Core",
    "editor.tab.personality": "Personality",
    "editor.tab.advanced": "Advanced",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Waifu Image",
    "editor.waifuPreview": "Current card image",
    "editor.waifuNoImage": "No image set yet",
    "editor.waifuSource": "Image source",
    "editor.waifuSourceSnap": "Anime snapshots (waifu.im)",
    "editor.waifuSourceChar": "Anime characters (AniList)",
    "editor.waifuGender": "Gender",
    "editor.waifuGenderAll": "Any gender",
    "editor.waifuGenderFemaleOnly": "Female only",
    "editor.waifuGenderMaleOnly": "Male only",
    "editor.waifuGenderFemale": "Female",
    "editor.waifuGenderMale": "Male",
    "editor.waifuCharSub": "search a character by name (e.g. zoro)",
    "editor.waifuSearch": "Search waifu.im",
    "editor.waifuSearchChar": "Search characters",
    "editor.waifuSearchPlaceholderChar": "search a character by name (e.g. zoro)",
    "editor.waifuSub": "(fetches anime-style images by tag)",
    "editor.waifuSearchPlaceholder": "e.g. waifu, elf, maid...",
    "editor.waifuFetch": "Fetch images",
    "editor.waifuRegenTitle": "Regenerate results",
    "editor.waifuMixed": "Female + Male",
    "editor.waifuMixedSub": "one-click balanced pack: 3 female + 3 male characters",
    "editor.waifuUse": "Use as card image",
    "editor.waifuUpload": "Upload from device",
    "editor.waifuRemove": "Remove image",
    "toast.noImage": "This card has no image to remove",
    "toast.imageRemoved": "Image removed",
    "editor.desc": "Description",
    "editor.descSub": "(appearance, backstory)",
    "editor.descPlaceholder": "Describe the character's appearance, background, and key traits...",
    "editor.firstMes": "First Message",
    "editor.firstMesPlaceholder": "The character's first message when starting a chat...",
    "editor.scenario": "Scenario",
    "editor.scenarioPlaceholder": "Current circumstances and context of the conversation...",
    "editor.creator": "Creator",
    "editor.creatorPlaceholder": "Card creator / author",
    "editor.version": "Character Version",
    "editor.tags": "Tags",
    "editor.tagsSub": "(comma-separated)",
    "editor.tagsPlaceholder": "fantasy, warrior, elf",
    "editor.personalitySummary": "Personality Summary",
    "editor.personalityPlaceholder": "A brief description of the character's personality... (used in character card format)",
    "editor.mesExample": "Example Messages",
    "editor.mesExampleFormat": "Format: <START> blocks with {{char}}: and {{user}}: prefixes",
    "editor.systemPrompt": "System Prompt",
    "editor.systemPromptPlaceholder": "Override the system prompt. Use {{original}} to include the default.",
    "editor.postHistory": "Post-History Instructions",
    "editor.postHistoryPlaceholder": "Instructions injected after the chat history. Use {{original}} for default.",
    "editor.creatorNotes": "Creator Notes",
    "editor.creatorNotesPlaceholder": "Notes for card users (model recommendations, usage tips...)",
    "editor.greetings": "Alternate Greetings",
    "editor.addGreeting": "Add Greeting",
    "editor.lorebookTitle": "Character Lorebook Entries",
    "editor.addEntry": "Add Entry",
    "editor.lorebookSearch": "Search entries by key, content, or comment...",
    "editor.lorebookEmpty": "No lorebook entries yet. Add one to get started.",
    "editor.noGreetings": "No greetings yet. Click <strong>Add Greeting</strong> or use AI to generate some.",
    "editor.noEntriesMatch": 'No entries match "{{query}}"',
    "editor.edit": "Edit",
    "editor.preview": "Preview",
    "ai.title": "AI Assistant",
    "ai.clearChat": "Clear chat",
    "ai.welcomeTitle": "AI Card Assistant",
    "ai.welcomeText": "Ask the AI to edit, translate, or enhance your character card.",
    "ai.quick.newCard": "New Card",
    "ai.quick.translate": "Translate",
    "ai.quick.enhance": "Enhance",
    "ai.quick.shorten": "Shorten",
    "ai.quick.tone": "Change Tone",
    "ai.quick.grammar": "Fix Grammar",
    "ai.quick.personality": "Expand Personality",
    "ai.quick.firstmes": "Improve First Message",
    "ai.quick.scenario": "Expand Scenario",
    "ai.quick.greetings": "Generate Greetings",
    "ai.quick.systemprompt": "Enhance System Prompt",
    "ai.quick.tags": "Suggest tags",
    "ai.contextTitle": "Estimated tokens used vs. model context limit",
    "ai.contextLabel": "— / — tokens",
    "ai.placeholder": "Ask AI to edit the card...",
    "ai.send": "Send",
    "ai.stop": "Stop generating",
    "ai.autoModel": "Select model...",
    "ai.target": "Target:",
    "ai.target.full": "Full Card",
    "ai.target.description": "Description",
    "ai.target.personality": "Personality",
    "ai.target.first_mes": "First Message",
    "ai.target.scenario": "Scenario",
    "ai.target.mes_example": "Example Messages",
    "ai.target.system_prompt": "System Prompt",
    "ai.target.post_history_instructions": "Post-History Instructions",
    "ai.target.creator_notes": "Creator Notes",
    "ai.target.alternate_greetings": "Alternate Greetings",
    "ai.selectModel": "Select a model",
    "ai.actionNewCard": "New Card",
    "ai.actionTranslate": "Translate",
    "ai.actionEnhance": "Enhance",
    "ai.actionShorten": "Shorten",
    "ai.actionTone": "Change Tone",
    "ai.actionGrammar": "Fix Grammar",
    "ai.actionPersonality": "Expand Personality",
    "ai.actionFirstMes": "Improve First Message",
    "ai.actionScenario": "Expand Scenario",
    "ai.actionGreetings": "Generate Greetings",
    "ai.actionSystemprompt": "Enhance System Prompt",
    "ai.actionTags": "Suggest tags",
    "ai.chatHistory": "Chat history",
    "ai.historyTitle": "Chat History",
    "ai.historyEmpty": "No conversations yet",
    "ai.retry": "Retry",
    "ai.retryTitle": "Regenerate this response",
    "ai.reapply": "Re-apply",
    "ai.reapplyTitle": "Re-open diff to apply these changes",
    "ai.noCard": "(no card selected)",
    "ai.editing": "Editing {{count}} field(s)...",
    "ai.streaming": "streaming...",
    "ai.failed": "failed",
    "ai.cancelled": "Cancelled.",
    "ai.doneSummary": "{{done}}/{{total}} done · {{errs}} failed",
    "ai.viewFullResult": "View full result",
    "ai.showLess": "Show less",
    "ai.reviewApply": "Review & Apply",
    "ai.changesNav": "Change {{current}} of {{total}}",
    "ai.changesPrev": "Previous change",
    "ai.changesNext": "Next change",
    "ai.applied": "Applied",
    "ai.target.tags": "Tags",
    "ai.copy": "Copy",
    "ai.copied": "Copied!",
    "ai.copyFailed": "Failed",
    "ai.resultTitle": "Result",
    "ai.close": "Close",
    "settings.themeColor": "Theme color",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Choose a separate accent color for each light/dark theme. Changes apply immediately.",
    "settings.appearance": "Appearance",
    "settings.accentPresets": "Accent presets",
    "settings.glassDensity": "Glass density",
    "settings.glassSubtle": "Subtle",
    "settings.glassDefault": "Default",
    "settings.glassBold": "Bold",
    "settings.cardRadius": "Card radius",
    "settings.radiusCompact": "Compact",
    "settings.radiusRounded": "Rounded",
    "settings.radiusPill": "Pill",
    "settings.vignette": "Edge vignette",
    "settings.appearanceHint": "Customize the look for each light/dark theme. Accent changes apply immediately; density, radius and the vignette are included in workspace backups.",
    "settings.resetThemeColor": "Reset",
    "settings.title": "Settings",
    "settings.generalTab": "General",
    "settings.promptsTab": "AI Prompts",
    "settings.assistantPrompt": "Assistant system prompt",
    "settings.fullCardPrompt": "Full-card system prompt",
    "settings.wizardPrompt": "Wizard generation instructions",
    "settings.promptPlaceholder": "Leave empty to use the built-in prompt",
    "settings.chatSystemPrompts": "Chat & system instructions",
    "settings.fullCardInstr": "Full-card output instructions (system)",
    "settings.fieldsEdit": "Field editing instructions (system)",
    "settings.greetingsSystem": "Greetings output instructions (system)",
    "settings.exportPrompts": "Export prompts",
    "settings.importPrompts": "Import prompts",
    "settings.promptsExported": "Prompts exported",
    "settings.promptsImported": "Imported {count} prompts",
    "settings.quickActionPrompts": "Quick-action prompts",
    "settings.tagsSystemPrompt": "Tags output instructions (system)",
    "settings.restoreDefaultPrompts": "Restore default prompts",
    "settings.promptHint": "These fields show the current prompts. If a field is empty, the built-in default prompt is used. Restore defaults to view or restore the original prompts.",
    "settings.provider": "Provider",
    "settings.providerHint": "Hosted model providers or a custom endpoint (LM Studio, Ollama, etc.)",
    "settings.apiKey": "API Key",
    "settings.getApiKey": "Get your API key from OpenRouter",
    "settings.baseUrl": "API Base URL",
    "settings.namedApiKeyPlaceholder": "Enter your API key",
    "settings.customHint": "The OpenAI-compatible endpoint. Examples: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API Key (optional)",
    "settings.apiKeyLocalPlaceholder": "Leave empty for local providers",
    "settings.apiKeyLocalHint": "Not needed for local servers like LM Studio or Ollama.",
    "settings.modelId": "Model ID",
    "settings.modelIdHint": "The exact model ID your provider expects.",
    "settings.modelIdHintNamed": "Leave empty to use the provider default model.",
    "settings.security": "Your API key is encrypted at rest in your browser's localStorage with a key tied to this address. Do not use this app on shared devices.",
    "settings.secretUnreadable": "Due to security, a saved API key could not be unlocked on this address — please re-enter it in Settings.",
    "error.pngInflateFailed": "This PNG contains character data that could not be decompressed.",
    "settings.defaultModel": "Default Model",
    "settings.browseModels": "Browse models below...",
    "settings.refreshModels": "Refresh Models",
    "settings.maxTokens": "Max Output Tokens",
    "settings.maxTokensPlaceholder": "0 = use model default",
    "settings.maxTokensHint": "Override the max output tokens per request. Set to 0 to auto-use the selected model's limit (or 64k if unknown).",
    "settings.copyright": "Inject editor credit on export",
    "settings.copyrightHint": "Adds a credit line to creator notes when exporting cards.",
    "settings.availableModels": "Available Models",
    "settings.searchModels": "Search models...",
    "settings.enterApiKey": "Enter your API key and refresh to load models",
    "settings.credits": "Credits & Usage",
    "settings.creditLimit": "Credit Limit",
    "settings.remaining": "Remaining",
    "settings.usedMonth": "Used This Month",
    "settings.localStorage": "Local Storage",
    "settings.clearAll": "Clear All Data",
    "settings.export": "Export",
    "settings.import": "Import",
    "settings.close": "Close",
    "settings.saveSettings": "Save Settings",
    "settings.languageLabel": "Language",
    "settings.languageHint": "Interface language (reload page if missing)",
    "settings.languageChanged": "Language updated",
    "settings.clearConfirm": "Delete ALL cards, settings, and chat history? This cannot be undone.",
    "settings.providerCustom": "Custom (OpenAI-compatible)",
    "settings.noModels": "No models found",
    "settings.loadMore": "Load more ({{count}} remaining)",
    "settings.showingModels": "Showing {{shown}} of {{total}} models",
    "wizard.title": "Create Character",
    "wizard.step.basics": "Basics",
    "wizard.step.concept": "Concept",
    "wizard.step.personality": "Personality",
    "wizard.step.scenario": "Scenario",
    "wizard.step.generate": "Generate",
    "wizard.basicsTitle": "Character Basics",
    "wizard.nameLabel": "Character Name",
    "wizard.namePlaceholder": "e.g. Elara Nightwhisper",
    "wizard.genderLabel": "Gender / Pronouns",
    "wizard.genderSelect": "Select...",
    "wizard.gender.female": "Female (she/her)",
    "wizard.gender.male": "Male (he/him)",
    "wizard.gender.nonbinary": "Non-binary (they/them)",
    "wizard.gender.other": "Other...",
    "wizard.genderCustom": "Custom pronouns (e.g. it/its)",
    "wizard.tagsLabel": "Tags",
    "wizard.tagsSub": "(comma-separated, helps organize your library)",
    "wizard.tagsPlaceholder": "fantasy, warrior, elf, original",
    "wizard.creatorLabel": "Creator",
    "wizard.creatorPlaceholder": "Your name / alias",
    "wizard.conceptTitle": "Concept & Setting",
    "wizard.typeLabel": "Character Type",
    "wizard.type.original": "Original Character",
    "wizard.type.fanfic": "Fan Fiction",
    "wizard.type.game": "Game Character",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Book / Movie / Show",
    "wizard.type.historical": "Historical Figure",
    "wizard.type.mythological": "Mythological / Folklore",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Other",
    "wizard.languageLabel": "Language",
    "wizard.language.other": "Other",
    "wizard.languageSpecify": "Specify language",
    "wizard.genreLabel": "Genre / World",
    "wizard.genreSub": "(select all that apply)",
    "wizard.moodLabel": "Mood / Tone",
    "wizard.moodSub": "(select all that apply)",
    "wizard.personalityTitle": "Personality & Appearance",
    "wizard.personalityTraits": "Personality Traits",
    "wizard.personalityTraitsSub": "(describe 3-5 key traits, this helps the AI)",
    "wizard.personalityTraitsPlaceholder": "e.g. Brave but reckless, fiercely loyal to friends, has a dry sense of humor, struggles with trust, secretly loves animals",
    "wizard.appearanceLabel": "Physical Appearance",
    "wizard.appearanceSub": "(brief description of how they look)",
    "wizard.appearancePlaceholder": "e.g. Tall woman with silver hair down to her waist, scarred hands, wears a dark leather jacket, piercing green eyes",
    "wizard.abilitiesLabel": "Special Abilities / Quirks",
    "wizard.abilitiesSub": "(optional, any unique traits)",
    "wizard.abilitiesPlaceholder": "e.g. Can speak to animals, has a photographic memory, always carries a worn journal",
    "wizard.scenarioTitle": "Scenario & First Message",
    "wizard.scenarioLabel": "Scenario / Setting",
    "wizard.scenarioSub": "(where does the story begin?)",
    "wizard.scenarioPlaceholder": "e.g. A rainy night in a neon-lit city. The character runs a small repair shop that fixes both machines and broken hearts.",
    "wizard.relationshipLabel": "Relationship to {{user}}",
    "wizard.relationshipSub": "(how does the character see the user?)",
    "wizard.relationshipPlaceholder": "e.g. A new customer who walked into the shop with a mysterious broken device. The character is curious but cautious.",
    "wizard.openingLabel": "First Message Vibe",
    "wizard.openingSub": "(what should the opening message feel like?)",
    "wizard.notesLabel": "Additional Notes",
    "wizard.notesSub": "(anything else the AI should know?)",
    "wizard.notesPlaceholder": "e.g. Keep the dialogue natural, avoid being overly formal, include action descriptions in asterisks",
    "wizard.generateTitle": "Generate Character",
    "wizard.refImage": "Reference Image",
    "wizard.refImageSub": "(optional, from waifu.im)",
    "wizard.fetchImages": "Fetch 3 Images",
    "wizard.refetchOthers": "Refetch Others",
    "wizard.fetching": "Fetching...",
    "wizard.useSelected": "Use Selected",
    "wizard.clear": "Clear",
    "wizard.generateAI": "Generate with AI",
    "wizard.generateAISub": "Full character card from your answers",
    "wizard.createBlank": "Create Blank Card",
    "wizard.createBlankSub": "Start with name and tags pre-filled",
    "wizard.back": "Back",
    "wizard.next": "Next",
    "wizard.stepLabel": "Step {{step}} of {{total}}",
    "wizard.ready": "Ready to generate!",
    "wizard.nameRequired": "Please enter a character name",
    "wizard.summary.name": "Name",
    "wizard.summary.gender": "Gender",
    "wizard.summary.type": "Type",
    "wizard.summary.language": "Language",
    "wizard.summary.tags": "Tags",
    "wizard.summary.genres": "Genres",
    "wizard.summary.mood": "Mood",
    "wizard.summary.opening": "Opening",
    "wizard.summary.personality": "Personality",
    "wizard.summary.appearance": "Appearance",
    "wizard.summary.scenario": "Scenario",
    "wizard.summary.relationship": "Relationship",
    "wizard.summary.notes": "Notes",
    "wizard.chip.fantasy": "Fantasy",
    "wizard.chip.scifi": "Sci-Fi",
    "wizard.chip.modern": "Modern",
    "wizard.chip.historical": "Historical",
    "wizard.chip.horror": "Horror",
    "wizard.chip.romance": "Romance",
    "wizard.chip.comedy": "Comedy",
    "wizard.chip.sliceOfLife": "Slice of Life",
    "wizard.chip.adventure": "Adventure",
    "wizard.chip.mystery": "Mystery",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Post-Apocalyptic",
    "wizard.chip.supernatural": "Supernatural",
    "wizard.chip.military": "Military",
    "wizard.chip.surreal": "Surreal",
    "wizard.chip.serious": "Serious",
    "wizard.chip.playful": "Playful",
    "wizard.chip.dark": "Dark",
    "wizard.chip.lighthearted": "Lighthearted",
    "wizard.chip.mysterious": "Mysterious",
    "wizard.chip.romantic": "Romantic",
    "wizard.chip.intense": "Intense",
    "wizard.chip.wholesome": "Wholesome",
    "wizard.chip.chaotic": "Chaotic",
    "wizard.chip.melancholic": "Melancholic",
    "wizard.chip.sarcastic": "Sarcastic",
    "wizard.chip.stoic": "Stoic",
    "wizard.chip.greeting": "Warm Greeting",
    "wizard.chip.action": "In Media Res",
    "wizard.chip.question": "Curious Question",
    "wizard.chip.conflict": "Immediate Conflict",
    "wizard.chip.atmospheric": "Atmospheric",
    "wizard.editStep": "Edit this section",
    "wizard.draftRestored": "Draft restored — your previous answers are back",
    "wizard.imagePlaceholder": "Click Fetch",
    "diff.title": "AI Response Preview",
    "diff.removed": "Removed",
    "diff.added": "Added",
    "diff.current": "Current",
    "diff.proposed": "Proposed",
    "diff.empty": "(empty)",
    "diff.discard": "Discard",
    "diff.apply": "Apply Changes",
    "shortcuts.title": "Shortcuts",
    "shortcuts.save": "Save card",
    "shortcuts.newCard": "New card",
    "shortcuts.undo": "Undo",
    "shortcuts.redo": "Redo",
    "shortcuts.sendAi": "Send AI message",
    "shortcuts.newLine": "New line in AI",
    "shortcuts.focus": "Focus mode",
    "shortcuts.collapsePanel": "Collapse/expand AI panel",
    "toast.loadFailed": "Failed: {{name}}",
    "toast.loaded": "Loaded {{count}} card(s)",
    "toast.importDupe": "Same content as an existing card — imported as {{name}}",
    "toast.largeImage": "Large image embedded in {{name}} ({{size}} MB) - consider removing it to save storage.",
    "toast.noValid": "No valid cards found. Drop PNG or JSON files.",
    "toast.noSelected": "No cards selected",
    "toast.cardsDeleted": "Cards deleted",
    "toast.deleteFailed": "Failed to delete card",
    "toast.exported": "Exported {{count}} card(s)",
    "toast.newBlank": "New blank card created",
    "toast.noCardSave": "No card to save",
    "toast.cardSaved": "Card saved!",
    "toast.noCardDup": "No card to duplicate",
    "toast.cardDup": "Card duplicated",
    "toast.cardRestored": "Card restored",
    "toast.selectCard": "Select a card first",
    "toast.avatarUpdated": "Avatar updated",
    "toast.imgFailed": "Failed to load image",
    "toast.firstMesUpdated": "First message updated!",
    "toast.settingsSaved": "Settings saved!",
    "toast.modelsFailed": "Failed to load models: {{error}}",
    "toast.modelSet": "Model set: {{model}}",
    "toast.dataCleared": "All data cleared",
    "toast.settingsExported": "Settings exported",
    "toast.settingsImported": "Settings imported!",
    "toast.invalidFile": "Invalid settings file",
    "toast.apiKey": "Set your API key in Settings",
    "toast.selectModel": "Please select a model from the navbar or settings first.",
    "toast.genStopped": "Generation stopped.",
    "toast.aiError": "AI Error: {{error}}",
    "toast.cardUpdatedAI": "Card updated from AI response!",
    "toast.jsonParseFailed": "Could not parse AI response as JSON. Check the chat.",
    "toast.emptyResponse": "AI returned empty content — nothing to apply.",
    "toast.jsonInvalid": "AI didn't return valid JSON. The response is in the chat — you can copy it manually.",
    "toast.fieldUpdated": '"{{field}}" updated!',
    "toast.greetingsUpdated": "{{count}} greeting(s) generated!",
    "toast.tagsUpdated": "Tags updated — {{count}} new tag(s) added!",
    "toast.greetingsParseFailed": "Could not parse greetings from AI response.",
    "toast.createCardFirst": "Create or select a card first",
    "toast.wizardCreated": "Card created! Start editing or use AI to fill in the details.",
    "toast.wizardApi": "Set your API key in Settings first",
    "toast.wizardModel": "Select a model or set a custom model ID in Settings",
    "toast.wizardFetchFailed": "Failed to fetch images: {{error}}",
    "toast.wizardName": "Please enter a character name",
    "toast.storageFull": "Storage full! Try removing some cards or exporting them.",
    "toast.exportedJson": "Exported as JSON!",
    "toast.exportedPng": "Exported as PNG with card data!",
    "toast.exportFailed": "Image export failed. Falling back to JSON.",
    "toast.noNameWarning": 'Warning: Card has no name. File will be saved as "character.json".',
    "toast.chatCleared": "Chat cleared",
    "toast.selectField": "Select at least one field to edit",
    "toast.tooManyFields": "Too many fields selected. Max {{max}} at once.",
    "toast.undo": "Undo",
    "toast.redo": "Redo",
    "toast.reorderFiltered": "Turn off search and filters to reorder cards.",
    "error.apiKeyNotSet": "API key not set. Enter your API key in Settings.",
    "error.customUrlNotSet": "Custom API base URL is not set. Open Settings → Custom (OpenAI-compatible) and enter your endpoint URL (e.g. http://localhost:1234/v1).",
    "error.customServerError": "The server returned an error: {{detail}}",
    "error.customAuthFailed": "Authentication failed (HTTP {{status}}). Check the API key for this endpoint.",
    "error.customPathNotFound": "Endpoint not found (HTTP 404). Check that the API Base URL is complete (e.g. includes /v1).",
    "error.customUnreachable": "Cannot reach {{url}}. Check that the server is running and the API Base URL is correct and reachable from this device.",
    "error.noModel": "No model selected. Please choose a model or set a model ID in Settings.",
    "error.noModelSimple": "No model selected.",
    "error.insufficientCredits": "Insufficient credits. Please top up your account.",
    "error.storageFull": "Storage full! Try removing some cards or exporting them.",
    "gen.empty": "(empty)",
    "gen.free": "Free",
    "gen.unlimited": "Unlimited",
    "gen.notAvailable": "N/A",
    "gen.unnamed": "Unnamed",
    "gen.byCreator": "by {{name}}",
    "gen.copySuffix": " (Copy)",
    "gen.toastAutoHide": "Auto-hides in {{s}}s",
    "gen.untagged": "No tags found",
    "gen.noMatch": "No cards match your filters",
    "batch.deleteConfirm": "Delete {{count}} card(s)? This cannot be undone.",
    "left.selected": "{{count}} selected",
    "toast.cardDeleted": 'Card "{{name}}" deleted',
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "Nearing the output token limit ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Over the output token limit ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "Collapse panel",
    "ui.expandPanel": "Expand panel",
    "ui.cardModified": "Unsaved edits",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.fr = {
    "app.title": "ST Card Editor — Studio de cartes de personnages SillyTavern",
    "nav.selectModel": "Sélectionner le modèle...",
    "nav.wizard": "Créer avec l'assistant IA",
    "nav.newCard": "Nouvelle carte vierge",
    "nav.save": "Enregistrer",
    "nav.theme": "Changer de thème",
    "nav.shortcuts": "Raccourcis et aide",
    "nav.settings": "Paramètres",
    "nav.focus": "Mode focus",
    "nav.focusAlt": "Mode focus (Alt+F)",
    "left.title": "Bibliothèque de cartes",
    "left.cards": "{{count}} cartes",
    "left.drop": "Glisser-déposer",
    "left.dropSub": "Cartes de personnages PNG ou JSON",
    "left.browse": "Parcourir les fichiers",
    "left.search": "Rechercher des cartes...",
    "left.sort.nameAsc": "Nom A-Z",
    "left.sort.manual": "Manuel",
    "left.sort.nameDesc": "Nom Z-A",
    "left.sort.newest": "Plus récent d'abord",
    "left.sort.oldest": "Plus ancien d'abord",
    "left.sort.largest": "Plus grand",
    "left.sort.smallest": "Plus petit",
    "left.filterTags": "Filtrer par tags",
    "left.exportSelected": "Exporter la sélection en JSON",
    "left.deleteSelected": "Supprimer la sélection",
    "left.empty": "Aucune carte chargée",
    "left.emptySub": "Déposez une carte ou cliquez sur Parcourir",
    "center.noCard": "Aucune carte sélectionnée",
    "center.noCardSub": "Sélectionnez une carte dans la bibliothèque ou glissez-déposez une nouvelle",
    "center.createAI": "Créer avec l'IA",
    "center.blankCard": "Carte vierge",
    "editor.avatar": "Cliquez ou déposez une image pour définir l'avatar",
    "editor.avatarAria": "Définir l'avatar du personnage",
    "editor.name": "Nom du personnage",
    "editor.exportJson": "Exporter en JSON",
    "editor.exportPng": "Exporter en PNG",
    "editor.duplicate": "Dupliquer la carte",
    "editor.delete": "Supprimer la carte",
    "editor.tab.core": "Principal",
    "editor.tab.personality": "Personnalité",
    "editor.tab.advanced": "Avancé",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Image Waifu",
    "editor.waifuPreview": "Image actuelle de la carte",
    "editor.waifuNoImage": "Aucune image définie",
    "editor.waifuSource": "Source de l'image",
    "editor.waifuSourceSnap": "Instantanés animé (waifu.im)",
    "editor.waifuSourceChar": "Personnages d'anime (AniList)",
    "editor.waifuGender": "Genre",
    "editor.waifuGenderAll": "Tous genres",
    "editor.waifuGenderFemaleOnly": "Femmes uniquement",
    "editor.waifuGenderMaleOnly": "Hommes uniquement",
    "editor.waifuGenderFemale": "Féminin",
    "editor.waifuGenderMale": "Masculin",
    "editor.waifuCharSub": "chercher un personnage par nom (ex. zoro)",
    "editor.waifuSearch": "Rechercher sur waifu.im",
    "editor.waifuSearchChar": "Rechercher des personnages",
    "editor.waifuSearchPlaceholderChar": "chercher un personnage par nom (ex. zoro)",
    "editor.waifuSub": "(récupère des images animé par tag)",
    "editor.waifuSearchPlaceholder": "ex. waifu, elfe, servante...",
    "editor.waifuFetch": "Récupérer des images",
    "editor.waifuRegenTitle": "Régénérer les résultats",
    "editor.waifuMixed": "Femmes + Hommes",
    "editor.waifuMixedSub": "pack équilibré en un clic : 3 personnages féminins + 3 masculins",
    "editor.waifuUse": "Utiliser comme image de carte",
    "editor.waifuUpload": "Importer depuis l'appareil",
    "editor.waifuRemove": "Supprimer l'image",
    "toast.noImage": "Cette carte n'a aucune image à supprimer",
    "toast.imageRemoved": "Image supprimée",
    "editor.desc": "Description",
    "editor.descSub": "(apparence, backstory)",
    "editor.descPlaceholder": "Décrivez l'apparence, le contexte et les traits principaux du personnage...",
    "editor.firstMes": "Premier message",
    "editor.firstMesPlaceholder": "Le premier message du personnage au début d'une conversation...",
    "editor.scenario": "Scénario",
    "editor.scenarioPlaceholder": "Circonstances actuelles et contexte de la conversation...",
    "editor.creator": "Créateur",
    "editor.creatorPlaceholder": "Créateur / auteur de la carte",
    "editor.version": "Version du personnage",
    "editor.tags": "Tags",
    "editor.tagsSub": "(séparés par des virgules)",
    "editor.tagsPlaceholder": "fantasy, guerrier, elfe",
    "editor.personalitySummary": "Résumé de personnalité",
    "editor.personalityPlaceholder": "Description brève de la personnalité du personnage... (utilisée dans le format de carte)",
    "editor.mesExample": "Messages d'exemple",
    "editor.mesExampleFormat": "Format : blocs <START> avec les préfixes {{char}}: et {{user}}:",
    "editor.systemPrompt": "Prompt système",
    "editor.systemPromptPlaceholder": "Remplacer le prompt système. Utilisez {{original}} pour inclure celui par défaut.",
    "editor.postHistory": "Instructions post-historique",
    "editor.postHistoryPlaceholder": "Instructions injectées après l'historique de discussion. Utilisez {{original}} pour la valeur par défaut.",
    "editor.creatorNotes": "Notes du créateur",
    "editor.creatorNotesPlaceholder": "Notes pour les utilisateurs (recommandations de modèles, conseils d'utilisation...)",
    "editor.greetings": "Salutations alternatives",
    "editor.addGreeting": "Ajouter une salutation",
    "editor.lorebookTitle": "Entrées du lorebook du personnage",
    "editor.addEntry": "Ajouter une entrée",
    "editor.lorebookSearch": "Rechercher par clé, contenu ou commentaire...",
    "editor.lorebookEmpty": "Aucune entrée dans le lorebook. Ajoutez-en une pour commencer.",
    "editor.edit": "Modifier",
    "editor.preview": "Aperçu",
    "ai.title": "Assistant IA",
    "ai.clearChat": "Effacer la discussion",
    "ai.welcomeTitle": "Assistant IA de cartes",
    "ai.welcomeText": "Demandez à l'IA de modifier, traduire ou améliorer votre carte de personnage.",
    "ai.quick.newCard": "Nouvelle carte",
    "ai.quick.translate": "Traduire",
    "ai.quick.enhance": "Améliorer",
    "ai.quick.shorten": "Raccourcir",
    "ai.quick.tone": "Changer le ton",
    "ai.quick.grammar": "Corriger la grammaire",
    "ai.quick.personality": "Développer la personnalité",
    "ai.quick.firstmes": "Améliorer le premier message",
    "ai.quick.scenario": "Développer le scénario",
    "ai.quick.greetings": "Générer des salutations",
    "ai.quick.systemprompt": "Améliorer le prompt système",
    "ai.quick.tags": "Suggérer des tags",
    "ai.contextTitle": "Tokens estimés utilisés vs. limite de contexte du modèle",
    "ai.contextLabel": "— / — tokens",
    "ai.placeholder": "Demandez à l'IA de modifier la carte...",
    "ai.send": "Envoyer",
    "ai.stop": "Arrêter la génération",
    "ai.autoModel": "Auto (utiliser le modèle de la barre)",
    "ai.target": "Cible :",
    "ai.target.full": "Carte complète",
    "ai.target.description": "Description",
    "ai.target.personality": "Personnalité",
    "ai.target.first_mes": "Premier message",
    "ai.target.scenario": "Scénario",
    "ai.target.mes_example": "Messages d'exemple",
    "ai.target.system_prompt": "Prompt système",
    "ai.target.post_history_instructions": "Instructions post-historique",
    "ai.target.creator_notes": "Notes du créateur",
    "ai.target.alternate_greetings": "Salutations alternatives",
    "ai.selectModel": "Sélectionner un modèle",
    "ai.actionNewCard": "Nouvelle carte",
    "ai.actionTranslate": "Traduire",
    "ai.actionEnhance": "Améliorer",
    "ai.actionShorten": "Raccourcir",
    "ai.actionTone": "Changer le ton",
    "ai.actionGrammar": "Corriger la grammaire",
    "ai.actionPersonality": "Développer la personnalité",
    "ai.actionFirstMes": "Améliorer le premier message",
    "ai.actionScenario": "Développer le scénario",
    "ai.actionGreetings": "Générer des salutations",
    "ai.actionSystemprompt": "Améliorer le prompt système",
    "ai.actionTags": "Suggérer des tags",
    "ai.noCard": "(aucune carte sélectionnée)",
    "settings.themeColor": "Couleur du thème",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Choisissez une couleur d’accent distincte pour chaque thème clair/sombre. Les changements sont appliqués immédiatement.",
    "settings.appearance": "Apparence",
    "settings.accentPresets": "Préréglages d’accent",
    "settings.glassDensity": "Densité du verre",
    "settings.glassSubtle": "Subtile",
    "settings.glassDefault": "Par défaut",
    "settings.glassBold": "Audacieuse",
    "settings.cardRadius": "Rayon des cartes",
    "settings.radiusCompact": "Compact",
    "settings.radiusRounded": "Arrondi",
    "settings.radiusPill": "Pilule",
    "settings.vignette": "Vignette de bord",
    "settings.appearanceHint": "Personnalisez l’apparence pour chaque thème clair/sombre. Les changements d’accent s’appliquent immédiatement ; la densité, le rayon et la vignette sont inclus dans les sauvegardes de l’espace de travail.",
    "settings.resetThemeColor": "Réinitialiser",
    "settings.generalTab": "Général",
    "settings.promptsTab": "Prompts IA",
    "settings.assistantPrompt": "Prompt système de l’assistant",
    "settings.fullCardPrompt": "Prompt système carte complète",
    "settings.wizardPrompt": "Instructions de génération du personnage",
    "settings.promptPlaceholder": "Laissez vide pour utiliser le prompt intégré",
    "settings.chatSystemPrompts": "Instructions du chat et du système",
    "settings.fullCardInstr": "Instructions de sortie de la carte complète (système)",
    "settings.fieldsEdit": "Instructions d'édition de champ (système)",
    "settings.greetingsSystem": "Instructions de sortie des salutations (système)",
    "settings.exportPrompts": "Exporter les prompts",
    "settings.importPrompts": "Importer les prompts",
    "settings.promptsExported": "Prompts exportés",
    "settings.promptsImported": "{count} prompts importés",
    "settings.quickActionPrompts": "Prompts des actions rapides",
    "settings.tagsSystemPrompt": "Instructions de sortie des balises (système)",
    "settings.restoreDefaultPrompts": "Restaurer les prompts par défaut",
    "settings.promptHint": "Ces champs affichent les prompts actuels. S’ils sont vides, le prompt intégré par défaut est utilisé. Restaurez les valeurs par défaut pour les consulter ou les rétablir.",
    "settings.title": "Paramètres",
    "settings.provider": "Fournisseur",
    "settings.providerHint": "Fournisseurs de modèles hébergés ou point de terminaison personnalisé (LM Studio, Ollama, etc.)",
    "settings.apiKey": "Clé API",
    "settings.getApiKey": "Obtenez votre clé API sur OpenRouter",
    "settings.baseUrl": "URL de base de l'API",
    "settings.namedApiKeyPlaceholder": "Entrez votre clé API",
    "settings.customHint": "Le point de terminaison compatible OpenAI. Exemples : LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "Clé API (optionnelle)",
    "settings.apiKeyLocalPlaceholder": "Laissez vide pour les fournisseurs locaux",
    "settings.apiKeyLocalHint": "Non nécessaire pour les serveurs locaux comme LM Studio ou Ollama.",
    "settings.modelId": "ID du modèle",
    "settings.modelIdHint": "L'ID exact du modèle attendu par votre fournisseur.",
    "settings.modelIdHintNamed": "Laissez vide pour utiliser le modèle par défaut du fournisseur.",
    "settings.security": "Votre clé API est chiffrée à la volée dans le localStorage de votre navigateur avec une clé liée à cette adresse. N'utilisez pas cette application sur des appareils partagés.",
    "settings.secretUnreadable": "Pour des raisons de sécurité, une clé API enregistrée n'a pas pu être déverrouillée sur cette adresse — veuillez la saisir à nouveau dans les paramètres.",
    "error.pngInflateFailed": "Ce PNG contient des données de personnage qui n'ont pas pu être décompressées.",
    "settings.defaultModel": "Modèle par défaut",
    "settings.browseModels": "Parcourir les modèles ci-dessous...",
    "settings.refreshModels": "Actualiser les modèles",
    "settings.maxTokens": "Tokens max de sortie",
    "settings.maxTokensPlaceholder": "0 = utiliser la valeur par défaut du modèle",
    "settings.maxTokensHint": "Remplacez le nombre maximum de tokens de sortie par requête. Réglez sur 0 pour utiliser automatiquement la limite du modèle sélectionné (ou 64k si inconnu).",
    "settings.copyright": "Injecter le crédit de l'éditeur à l'exportation",
    "settings.copyrightHint": "Ajoute une ligne de crédit aux notes du créateur lors de l'exportation.",
    "settings.availableModels": "Modèles disponibles",
    "settings.searchModels": "Rechercher des modèles...",
    "settings.enterApiKey": "Entrez votre clé API et actualisez pour charger les modèles",
    "settings.credits": "Crédits et utilisation",
    "settings.creditLimit": "Limite de crédits",
    "settings.remaining": "Restant",
    "settings.usedMonth": "Utilisé ce mois-ci",
    "settings.localStorage": "Stockage local",
    "settings.clearAll": "Effacer toutes les données",
    "settings.export": "Exporter",
    "settings.import": "Importer",
    "settings.close": "Fermer",
    "settings.saveSettings": "Enregistrer les paramètres",
    "settings.languageLabel": "Langue",
    "settings.languageHint": "Langue de l'interface (rechargez la page si manquant)",
    "settings.languageChanged": "Langue mise à jour",
    "settings.clearConfirm": "Supprimer TOUTES les cartes, les paramètres et l'historique des discussions ? Cette action est irréversible.",
    "settings.providerCustom": "Personnalisé (compatible OpenAI)",
    "settings.noModels": "Aucun modèle trouvé",
    "settings.loadMore": "Charger plus ({{count}} restants)",
    "settings.showingModels": "{{shown}} sur {{total}} modèles",
    "wizard.title": "Créer un personnage",
    "wizard.step.basics": "Basiques",
    "wizard.step.concept": "Concept",
    "wizard.step.personality": "Personnalité",
    "wizard.step.scenario": "Scénario",
    "wizard.step.generate": "Générer",
    "wizard.basicsTitle": "Basiques du personnage",
    "wizard.nameLabel": "Nom du personnage",
    "wizard.namePlaceholder": "ex. Elara Nightwhisper",
    "wizard.genderLabel": "Genre / Pronoms",
    "wizard.genderSelect": "Sélectionner...",
    "wizard.gender.female": "Féminin (elle)",
    "wizard.gender.male": "Masculin (il)",
    "wizard.gender.nonbinary": "Non-binaire (iel)",
    "wizard.gender.other": "Autre...",
    "wizard.genderCustom": "Pronoms personnalisés (ex. il/elle)",
    "wizard.tagsLabel": "Tags",
    "wizard.tagsSub": "(séparés par des virgules, aide à organiser votre bibliothèque)",
    "wizard.tagsPlaceholder": "fantasy, guerrier, elfe, original",
    "wizard.creatorLabel": "Créateur",
    "wizard.creatorPlaceholder": "Votre nom / alias",
    "wizard.conceptTitle": "Concept et décor",
    "wizard.typeLabel": "Type de personnage",
    "wizard.type.original": "Personnage original",
    "wizard.type.fanfic": "Fanfiction",
    "wizard.type.game": "Personnage de jeu",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Livre / Film / Série",
    "wizard.type.historical": "Personnage historique",
    "wizard.type.mythological": "Mythologique / Folklore",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Autre",
    "wizard.languageLabel": "Langue",
    "wizard.language.other": "Autre",
    "wizard.languageSpecify": "Spécifier la langue",
    "wizard.genreLabel": "Genre / Univers",
    "wizard.genreSub": "(sélectionnez tout ce qui s'applique)",
    "wizard.moodLabel": "Ambiance / Ton",
    "wizard.moodSub": "(sélectionnez tout ce qui s'applique)",
    "wizard.personalityTitle": "Personnalité et apparence",
    "wizard.personalityTraits": "Traits de personnalité",
    "wizard.personalityTraitsSub": "(décrivez 3-5 traits clés, cela aide l'IA)",
    "wizard.personalityTraitsPlaceholder": "ex. Courageux mais téméraire, loyale envers ses amis, humour sarcastique, a du mal à faire confiance, adore les animaux en secret",
    "wizard.appearanceLabel": "Apparence physique",
    "wizard.appearanceSub": "(brève description de leur apparence)",
    "wizard.appearancePlaceholder": "ex. Grande femme aux cheveux d'argent jusqu'à la taille, mains cicatrisées, porte une veste en cuir sombre, yeux verts perçants",
    "wizard.abilitiesLabel": "Capacités spéciales / Particularités",
    "wizard.abilitiesSub": "(optionnel, traits uniques)",
    "wizard.abilitiesPlaceholder": "ex. Peut parler aux animaux, mémoire photographique, porte toujours un journal usé",
    "wizard.scenarioTitle": "Scénario et premier message",
    "wizard.scenarioLabel": "Scénario / Décor",
    "wizard.scenarioSub": "(où commence l'histoire ?)",
    "wizard.scenarioPlaceholder": "ex. Une nuit pluvieuse dans une ville aux néons. Le personnage tient un petit atelier de réparation qui répare les machines et les cœurs brisés.",
    "wizard.relationshipLabel": "Relation avec {{user}}",
    "wizard.relationshipSub": "(comment le personnage voit-il l'utilisateur ?)",
    "wizard.relationshipPlaceholder": "ex. Un nouveau client entré dans l'atelier avec un appareil mystérieux cassé. Le personnage est curieux mais prudent.",
    "wizard.openingLabel": "Ambiance du premier message",
    "wizard.openingSub": "(quel devrait être le ton du message d'ouverture ?)",
    "wizard.notesLabel": "Notes supplémentaires",
    "wizard.notesSub": "(autre chose que l'IA devrait savoir ?)",
    "wizard.notesPlaceholder": "ex. Gardez le dialogue naturel, évitez d'être trop formel, incluez les descriptions d'actions entre astérisques",
    "wizard.generateTitle": "Générer le personnage",
    "wizard.refImage": "Image de référence",
    "wizard.refImageSub": "(optionnel, depuis waifu.im)",
    "wizard.fetchImages": "Récupérer 3 images",
    "wizard.refetchOthers": "Récupérer les autres",
    "wizard.fetching": "Récupération...",
    "wizard.useSelected": "Utiliser la sélection",
    "wizard.clear": "Effacer",
    "wizard.generateAI": "Générer avec l'IA",
    "wizard.generateAISub": "Carte complète du personnage à partir de vos réponses",
    "wizard.createBlank": "Créer une carte vierge",
    "wizard.createBlankSub": "Commencer avec le nom et les tags pré-remplis",
    "wizard.back": "Retour",
    "wizard.next": "Suivant",
    "wizard.stepLabel": "Étape {{step}} sur {{total}}",
    "wizard.ready": "Prêt à générer !",
    "wizard.nameRequired": "Veuillez entrer un nom de personnage",
    "wizard.summary.name": "Nom",
    "wizard.summary.gender": "Genre",
    "wizard.summary.type": "Type",
    "wizard.summary.language": "Langue",
    "wizard.summary.tags": "Tags",
    "wizard.summary.genres": "Genres",
    "wizard.summary.mood": "Ambiance",
    "wizard.summary.opening": "Ouverture",
    "wizard.summary.personality": "Personnalité",
    "wizard.summary.appearance": "Apparence",
    "wizard.summary.scenario": "Scénario",
    "wizard.summary.relationship": "Relation",
    "wizard.summary.notes": "Notes",
    "wizard.chip.fantasy": "Fantasy",
    "wizard.chip.scifi": "Science-fiction",
    "wizard.chip.modern": "Moderne",
    "wizard.chip.historical": "Historique",
    "wizard.chip.horror": "Horreur",
    "wizard.chip.romance": "Romance",
    "wizard.chip.comedy": "Comédie",
    "wizard.chip.sliceOfLife": "Tranche de vie",
    "wizard.chip.adventure": "Aventure",
    "wizard.chip.mystery": "Mystère",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Post-apocalyptique",
    "wizard.chip.supernatural": "Surnaturel",
    "wizard.chip.military": "Militaire",
    "wizard.chip.surreal": "Surréaliste",
    "wizard.chip.serious": "Sérieux",
    "wizard.chip.playful": "Joueur",
    "wizard.chip.dark": "Sombre",
    "wizard.chip.lighthearted": "Léger",
    "wizard.chip.mysterious": "Mystérieux",
    "wizard.chip.romantic": "Romantique",
    "wizard.chip.intense": "Intense",
    "wizard.chip.wholesome": "Chaleureux",
    "wizard.chip.chaotic": "Chaotique",
    "wizard.chip.melancholic": "Mélancolique",
    "wizard.chip.sarcastic": "Sarcastique",
    "wizard.chip.stoic": "Stoïque",
    "wizard.chip.greeting": "Salutation chaleureuse",
    "wizard.chip.action": "In Media Res",
    "wizard.chip.question": "Question curieuse",
    "wizard.chip.conflict": "Conflit immédiat",
    "wizard.chip.atmospheric": "Atmosphérique",
    "diff.title": "Aperçu de la réponse IA",
    "diff.removed": "Supprimé",
    "diff.added": "Ajouté",
    "diff.current": "Actuel",
    "diff.proposed": "Proposé",
    "diff.empty": "(vide)",
    "diff.discard": "Ignorer",
    "diff.apply": "Appliquer les modifications",
    "shortcuts.title": "Raccourcis",
    "shortcuts.save": "Enregistrer la carte",
    "shortcuts.newCard": "Nouvelle carte",
    "shortcuts.undo": "Annuler",
    "shortcuts.redo": "Rétablir",
    "shortcuts.sendAi": "Envoyer un message à l'IA",
    "shortcuts.newLine": "Nouvelle ligne dans l'IA",
    "shortcuts.focus": "Mode focus",
    "shortcuts.collapsePanel": "Réduire/agrandir le panneau IA",
    "toast.loadFailed": "Échec : {{name}}",
    "toast.loaded": "{{count}} carte(s) chargée(s)",
    "toast.importDupe": "Contenu identique à une carte existante — importé sous le nom « {{name}} »",
    "toast.largeImage": "Grande image intégrée dans {{name}} ({{size}} Mo) - pensez à la retirer pour économiser de l'espace.",
    "toast.noValid": "Aucune carte valide trouvée. Déposez des fichiers PNG ou JSON.",
    "toast.noSelected": "Aucune carte sélectionnée",
    "toast.cardsDeleted": "Cartes supprimées",
    "toast.deleteFailed": "Échec de la suppression de la carte",
    "toast.exported": "{{count}} carte(s) exportée(s)",
    "toast.newBlank": "Nouvelle carte vierge créée",
    "toast.noCardSave": "Aucune carte à enregistrer",
    "toast.cardSaved": "Carte enregistrée !",
    "toast.noCardDup": "Aucune carte à dupliquer",
    "toast.cardDup": "Carte dupliquée",
    "toast.cardRestored": "Carte restaurée",
    "toast.selectCard": "Sélectionnez d'abord une carte",
    "toast.avatarUpdated": "Avatar mis à jour",
    "toast.imgFailed": "Échec du chargement de l'image",
    "toast.firstMesUpdated": "Premier message mis à jour !",
    "toast.settingsSaved": "Paramètres enregistrés !",
    "toast.modelsFailed": "Échec du chargement des modèles : {{error}}",
    "toast.modelSet": "Modèle défini : {{model}}",
    "toast.dataCleared": "Toutes les données effacées",
    "toast.settingsExported": "Paramètres exportés",
    "toast.settingsImported": "Paramètres importés !",
    "toast.invalidFile": "Fichier de paramètres invalide",
    "toast.apiKey": "Définissez votre clé API dans les paramètres",
    "toast.selectModel": "Veuillez d'abord sélectionner un modèle dans la barre de navigation ou les paramètres.",
    "toast.genStopped": "Génération arrêtée.",
    "toast.aiError": "Erreur IA : {{error}}",
    "toast.cardUpdatedAI": "Carte mise à jour depuis la réponse IA !",
    "toast.jsonParseFailed": "Impossible de parser la réponse IA en JSON. Vérifiez la discussion.",
    "toast.emptyResponse": "L'IA a retourné un contenu vide — rien à appliquer.",
    "toast.jsonInvalid": "L'IA n'a pas retourné de JSON valide. La réponse est dans la discussion — vous pouvez la copier manuellement.",
    "toast.fieldUpdated": "« {{field}} » mis à jour !",
    "toast.selectField": "Sélectionnez au moins un champ à modifier",
    "toast.tooManyFields": "Trop de champs sélectionnés. Maximum {{max}} à la fois.",
    "toast.greetingsUpdated": "{{count}} salutation(s) générée(s) !",
    "toast.tagsUpdated": "Tags mis à jour — {{count}} nouveau(x) tag(s) ajouté(s) !",
    "toast.greetingsParseFailed": "Impossible d'analyser les salutations de la réponse IA.",
    "toast.createCardFirst": "Créez ou sélectionnez d'abord une carte",
    "toast.wizardCreated": "Carte créée ! Commencez à modifier ou utilisez l'IA pour remplir les détails.",
    "toast.wizardApi": "Définissez d'abord votre clé API dans les paramètres",
    "toast.wizardModel": "Sélectionnez un modèle ou définissez un ID de modèle personnalisé dans les paramètres",
    "toast.wizardFetchFailed": "Échec de la récupération des images : {{error}}",
    "toast.wizardName": "Veuillez entrer un nom de personnage",
    "toast.storageFull": "Stockage plein ! Essayez de supprimer ou d'exporter des cartes.",
    "toast.exportedJson": "Exporté en JSON !",
    "toast.exportedPng": "Exporté en PNG avec les données de la carte !",
    "toast.exportFailed": "Échec de l'exportation d'image. Retour au JSON.",
    "toast.chatCleared": "Discussion effacée",
    "toast.undo": "Annuler",
    "error.apiKeyNotSet": "Clé API non définie. Saisissez votre clé API dans les paramètres.",
    "error.customUrlNotSet": "L'URL de base de l'API personnalisée n'est pas définie. Ouvrez les Paramètres → Personnalisé (compatible OpenAI) et saisissez l'URL de votre endpoint (ex. http://localhost:1234/v1).",
    "error.customAuthFailed": "Échec d'authentification (HTTP {{status}}). Vérifiez la clé API de cet endpoint.",
    "error.customPathNotFound": "Endpoint introuvable (HTTP 404). Vérifiez que l'URL de base de l'API est complète (ex. inclut /v1).",
    "error.customUnreachable": "Impossible de joindre {{url}}. Vérifiez que le serveur est démarré et que l'URL de base de l'API est correcte et accessible depuis cet appareil.",
    "error.noModel": "Aucun modèle sélectionné. Veuillez choisir un modèle ou définir un ID de modèle dans les paramètres.",
    "error.noModelSimple": "Aucun modèle sélectionné.",
    "error.insufficientCredits": "Crédits insuffisants. Veuillez recharger votre compte.",
    "error.storageFull": "Stockage plein ! Essayez de supprimer ou d'exporter des cartes.",
    "gen.empty": "(vide)",
    "gen.free": "Gratuit",
    "gen.unlimited": "Illimité",
    "gen.notAvailable": "N/D",
    "gen.unnamed": "Sans nom",
    "gen.byCreator": "par {{name}}",
    "gen.untagged": "Aucun tag trouvé",
    "gen.noMatch": "Aucune carte ne correspond à vos filtres",
    "batch.deleteConfirm": "Supprimer {{count}} carte(s) ? Cette action est irréversible.",
    "left.selected": "{{count}} sélectionnée(s)",
    "toast.cardDeleted": "Carte «{{name}}» supprimée",
    "ai.editing": "Édition de {{count}} champ(s)...",
    "ai.streaming": "stream...",
    "ai.failed": "échec",
    "ai.cancelled": "Annulé.",
    "ai.doneSummary": "{{done}}/{{total}} terminé · {{errs}} échec(s)",
    "ai.viewFullResult": "Voir le résultat complet",
    "ai.showLess": "Afficher moins",
    "ai.reviewApply": "Examiner et appliquer",
    "ai.changesNav": "Modification {{current}} sur {{total}}",
    "ai.changesPrev": "Modification précédente",
    "ai.changesNext": "Modification suivante",
    "ai.applied": "Appliqué",
    "ai.target.tags": "Balises",
    "ai.copy": "Copier",
    "ai.copied": "Copié !",
    "ai.copyFailed": "Échec",
    "ai.resultTitle": "Résultat",
    "ai.close": "Fermer",
    "editor.noGreetings": "Pas encore de salutations. Cliquez sur <strong>Ajouter une salutation</strong> ou utilisez l'IA pour en générer.",
    "editor.noEntriesMatch": "Aucune entrée ne correspond à «{{query}}»",
    "gen.copySuffix": " (Copie)",
    "gen.toastAutoHide": "Masquage auto dans {{s}}s",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "Proche de la limite de tokens de sortie ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Dépasse la limite de tokens de sortie ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "error.customServerError": "Le serveur a renvoyé une erreur : {{detail}}",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "Réduire le panneau",
    "ui.expandPanel": "Agrandir le panneau",
    "ui.cardModified": "Modifications non enregistrées",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "Historique de la discussion",
    "ai.historyTitle": "Historique de la discussion",
    "ai.historyEmpty": "Aucune conversation pour le moment",
    "ai.retry": "Réessayer",
    "ai.retryTitle": "Régénérer cette réponse",
    "ai.reapply": "Réappliquer",
    "ai.reapplyTitle": "Rouvrir le diff pour appliquer ces modifications",
    "wizard.editStep": "Modifier cette section",
    "wizard.draftRestored": "Brouillon restauré — vos réponses précédentes sont de retour",
    "wizard.imagePlaceholder": "Cliquez sur Récupérer",
    "toast.noNameWarning": `Avertissement : la carte n'a pas de nom. Le fichier sera enregistré sous "character.json".`,
    "toast.redo": "Rétablir",
    "toast.reorderFiltered": "Désactivez la recherche et les filtres pour réorganiser les cartes.",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.es = {
    "app.title": "ST Card Editor — Estudio de tarjetas de personajes SillyTavern",
    "nav.selectModel": "Seleccionar modelo...",
    "nav.wizard": "Crear con asistente de IA",
    "nav.newCard": "Nueva tarjeta en blanco",
    "nav.save": "Guardar",
    "nav.theme": "Cambiar tema",
    "nav.shortcuts": "Atajos y ayuda",
    "nav.settings": "Configuración",
    "nav.focus": "Modo enfoque",
    "nav.focusAlt": "Modo enfoque (Alt+F)",
    "left.title": "Biblioteca de tarjetas",
    "left.cards": "{{count}} tarjetas",
    "left.drop": "Arrastrar y soltar",
    "left.dropSub": "Tarjetas de personajes PNG o JSON",
    "left.browse": "Examinar archivos",
    "left.search": "Buscar tarjetas...",
    "left.sort.nameAsc": "Nombre A-Z",
    "left.sort.nameDesc": "Nombre Z-A",
    "left.sort.manual": "Manual",
    "left.sort.newest": "Más recientes primero",
    "left.sort.oldest": "Más antiguas primero",
    "left.sort.largest": "Más grande",
    "left.sort.smallest": "Más pequeña",
    "left.filterTags": "Filtrar por etiquetas",
    "left.exportSelected": "Exportar selección como JSON",
    "left.deleteSelected": "Eliminar selección",
    "left.empty": "No hay tarjetas cargadas",
    "left.emptySub": "Suelta una tarjeta o haz clic en Examinar",
    "center.noCard": "Ninguna tarjeta seleccionada",
    "center.noCardSub": "Selecciona una tarjeta de la biblioteca o arrastra una nueva",
    "center.createAI": "Crear con IA",
    "center.blankCard": "Tarjeta en blanco",
    "editor.avatar": "Haz clic o suelta una imagen para establecer el avatar",
    "editor.avatarAria": "Establecer avatar del personaje",
    "editor.name": "Nombre del personaje",
    "editor.exportJson": "Exportar como JSON",
    "editor.exportPng": "Exportar como PNG",
    "editor.duplicate": "Duplicar tarjeta",
    "editor.delete": "Eliminar tarjeta",
    "editor.tab.core": "Principal",
    "editor.tab.personality": "Personalidad",
    "editor.tab.advanced": "Avanzado",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Imagen Waifu",
    "editor.waifuPreview": "Imagen actual de la tarjeta",
    "editor.waifuNoImage": "Aún no hay imagen",
    "editor.waifuSource": "Fuente de imagen",
    "editor.waifuSourceSnap": "Momentos de anime (waifu.im)",
    "editor.waifuSourceChar": "Personajes de anime (AniList)",
    "editor.waifuGender": "Género",
    "editor.waifuGenderAll": "Cualquier género",
    "editor.waifuGenderFemaleOnly": "Solo mujeres",
    "editor.waifuGenderMaleOnly": "Solo hombres",
    "editor.waifuGenderFemale": "Femenino",
    "editor.waifuGenderMale": "Masculino",
    "editor.waifuCharSub": "busca un personaje por nombre (p. ej. zoro)",
    "editor.waifuSearch": "Buscar en waifu.im",
    "editor.waifuSearchChar": "Buscar personajes",
    "editor.waifuSearchPlaceholderChar": "busca un personaje por nombre (p. ej. zoro)",
    "editor.waifuSub": "(obtiene imágenes de estilo anime por etiqueta)",
    "editor.waifuSearchPlaceholder": "p. ej. waifu, elfa, doncella...",
    "editor.waifuFetch": "Obtener imágenes",
    "editor.waifuRegenTitle": "Regenerar resultados",
    "editor.waifuMixed": "Mujeres + Hombres",
    "editor.waifuMixedSub": "paquete equilibrado en un clic: 3 personajes femeninos + 3 masculinos",
    "editor.waifuUse": "Usar como imagen de tarjeta",
    "editor.waifuUpload": "Subir desde el dispositivo",
    "editor.waifuRemove": "Eliminar imagen",
    "toast.noImage": "Esta tarjeta no tiene imagen para eliminar",
    "toast.imageRemoved": "Imagen eliminada",
    "editor.desc": "Descripción",
    "editor.descSub": "(apariencia, historia)",
    "editor.descPlaceholder": "Describe la apariencia, el trasfondo y los rasgos principales del personaje...",
    "editor.firstMes": "Primer mensaje",
    "editor.firstMesPlaceholder": "El primer mensaje del personaje al iniciar un chat...",
    "editor.scenario": "Escenario",
    "editor.scenarioPlaceholder": "Circunstancias actuales y contexto de la conversación...",
    "editor.creator": "Creador",
    "editor.creatorPlaceholder": "Creador / autor de la tarjeta",
    "editor.version": "Versión del personaje",
    "editor.tags": "Etiquetas",
    "editor.tagsSub": "(separadas por comas)",
    "editor.tagsPlaceholder": "fantasía, guerrero, elfo",
    "editor.personalitySummary": "Resumen de personalidad",
    "editor.personalityPlaceholder": "Una breve descripción de la personalidad del personaje... (usada en el formato de tarjeta)",
    "editor.mesExample": "Mensajes de ejemplo",
    "editor.mesExampleFormat": "Formato: bloques <START> con prefijos {{char}}: y {{user}}:",
    "editor.systemPrompt": "Prompt del sistema",
    "editor.systemPromptPlaceholder": "Sobrescribir el prompt del sistema. Usa {{original}} para incluir el predeterminado.",
    "editor.postHistory": "Instrucciones post-historial",
    "editor.postHistoryPlaceholder": "Instrucciones inyectadas después del historial de chat. Usa {{original}} para el predeterminado.",
    "editor.creatorNotes": "Notas del creador",
    "editor.creatorNotesPlaceholder": "Notas para usuarios (recomendaciones de modelos, consejos de uso...)",
    "editor.greetings": "Saludos alternativos",
    "editor.addGreeting": "Agregar saludo",
    "editor.lorebookTitle": "Entradas del lorebook del personaje",
    "editor.addEntry": "Agregar entrada",
    "editor.lorebookSearch": "Buscar entradas por clave, contenido o comentario...",
    "editor.lorebookEmpty": "Aún no hay entradas en el lorebook. Agrega una para comenzar.",
    "editor.edit": "Editar",
    "editor.preview": "Vista previa",
    "ai.title": "Asistente de IA",
    "ai.clearChat": "Limpiar chat",
    "ai.welcomeTitle": "Asistente de IA de tarjetas",
    "ai.welcomeText": "Pide a la IA que edite, traduzca o mejore tu tarjeta de personaje.",
    "ai.quick.newCard": "Nueva tarjeta",
    "ai.quick.translate": "Traducir",
    "ai.quick.enhance": "Mejorar",
    "ai.quick.shorten": "Acortar",
    "ai.quick.tone": "Cambiar tono",
    "ai.quick.grammar": "Corregir gramática",
    "ai.quick.personality": "Expandir personalidad",
    "ai.quick.firstmes": "Mejorar primer mensaje",
    "ai.quick.scenario": "Expandir escenario",
    "ai.quick.greetings": "Generar saludos",
    "ai.quick.systemprompt": "Mejorar prompt del sistema",
    "ai.quick.tags": "Sugerir etiquetas",
    "ai.contextTitle": "Tokens estimados usados vs. límite de contexto del modelo",
    "ai.contextLabel": "— / — tokens",
    "ai.placeholder": "Pide a la IA que edite la tarjeta...",
    "ai.send": "Enviar",
    "ai.stop": "Detener generación",
    "ai.autoModel": "Automático (usar modelo de la barra)",
    "ai.target": "Objetivo:",
    "ai.target.full": "Tarjeta completa",
    "ai.target.description": "Descripción",
    "ai.target.personality": "Personalidad",
    "ai.target.first_mes": "Primer mensaje",
    "ai.target.scenario": "Escenario",
    "ai.target.mes_example": "Mensajes de ejemplo",
    "ai.target.system_prompt": "Prompt del sistema",
    "ai.target.post_history_instructions": "Instrucciones post-historial",
    "ai.target.creator_notes": "Notas del creador",
    "ai.target.alternate_greetings": "Saludos alternativos",
    "ai.selectModel": "Seleccionar un modelo",
    "ai.actionNewCard": "Nueva tarjeta",
    "ai.actionTranslate": "Traducir",
    "ai.actionEnhance": "Mejorar",
    "ai.actionShorten": "Acortar",
    "ai.actionTone": "Cambiar tono",
    "ai.actionGrammar": "Corregir gramática",
    "ai.actionPersonality": "Expandir personalidad",
    "ai.actionFirstMes": "Mejorar primer mensaje",
    "ai.actionScenario": "Expandir escenario",
    "ai.actionGreetings": "Generar saludos",
    "ai.actionSystemprompt": "Mejorar prompt del sistema",
    "ai.actionTags": "Sugerir etiquetas",
    "ai.noCard": "(ninguna tarjeta seleccionada)",
    "settings.themeColor": "Color del tema",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Elija un color de acento distinto para cada tema claro/oscuro. Los cambios se aplican de inmediato.",
    "settings.appearance": "Apariencia",
    "settings.accentPresets": "Preajustes de acento",
    "settings.glassDensity": "Densidad del cristal",
    "settings.glassSubtle": "Sutil",
    "settings.glassDefault": "Predeterminado",
    "settings.glassBold": "Atrevido",
    "settings.cardRadius": "Radio de las tarjetas",
    "settings.radiusCompact": "Compacto",
    "settings.radiusRounded": "Redondeado",
    "settings.radiusPill": "Píldora",
    "settings.vignette": "Viñeta de borde",
    "settings.appearanceHint": "Personaliza el aspecto de cada tema claro/oscuro. Los cambios de acento se aplican al instante; la densidad, el radio y la viñeta se incluyen en las copias de seguridad del espacio de trabajo.",
    "settings.resetThemeColor": "Restablecer",
    "settings.generalTab": "General",
    "settings.promptsTab": "Prompts de IA",
    "settings.assistantPrompt": "Prompt del sistema del asistente",
    "settings.fullCardPrompt": "Prompt del sistema de la tarjeta completa",
    "settings.wizardPrompt": "Instrucciones de generación del asistente",
    "settings.promptPlaceholder": "Deje vacío para usar el prompt integrado",
    "settings.chatSystemPrompts": "Instrucciones del chat y del sistema",
    "settings.fullCardInstr": "Instrucciones de salida de la tarjeta completa (sistema)",
    "settings.fieldsEdit": "Instrucciones de edición de campo (sistema)",
    "settings.greetingsSystem": "Instrucciones de salida de saludos (sistema)",
    "settings.exportPrompts": "Exportar prompts",
    "settings.importPrompts": "Importar prompts",
    "settings.promptsExported": "Prompts exportados",
    "settings.promptsImported": "{count} prompts importados",
    "settings.quickActionPrompts": "Prompts de acciones rápidas",
    "settings.tagsSystemPrompt": "Instrucciones de salida de etiquetas (sistema)",
    "settings.restoreDefaultPrompts": "Restaurar prompts predeterminados",
    "settings.promptHint": "Estos campos muestran los prompts actuales. Si un campo está vacío, se usa el prompt integrado predeterminado. Restaure los valores predeterminados para verlos o recuperarlos.",
    "settings.title": "Configuración",
    "settings.provider": "Proveedor",
    "settings.providerHint": "Proveedores de modelos alojados o un endpoint personalizado (LM Studio, Ollama, etc.)",
    "settings.apiKey": "Clave API",
    "settings.getApiKey": "Obtén tu clave API de OpenRouter",
    "settings.baseUrl": "URL base de la API",
    "settings.namedApiKeyPlaceholder": "Ingresa tu clave API",
    "settings.customHint": "El endpoint compatible con OpenAI. Ejemplos: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "Clave API (opcional)",
    "settings.apiKeyLocalPlaceholder": "Dejar vacío para proveedores locales",
    "settings.apiKeyLocalHint": "No es necesaria para servidores locales como LM Studio u Ollama.",
    "settings.modelId": "ID del modelo",
    "settings.modelIdHint": "El ID exacto del modelo que espera tu proveedor.",
    "settings.modelIdHintNamed": "Dejar vacío para usar el modelo predeterminado del proveedor.",
    "settings.security": "Tu clave API se cifra en el almacenamiento local de tu navegador con una clave vinculada a esta dirección. No uses esta aplicación en dispositivos compartidos.",
    "settings.secretUnreadable": "Por seguridad, una clave API guardada no pudo desbloquearse en esta dirección — vuelve a introducirla en Ajustes.",
    "error.pngInflateFailed": "Este PNG contiene datos de personaje que no pudieron descomprimirse.",
    "settings.defaultModel": "Modelo predeterminado",
    "settings.browseModels": "Explorar modelos a continuación...",
    "settings.refreshModels": "Actualizar modelos",
    "settings.maxTokens": "Tokens máximos de salida",
    "settings.maxTokensPlaceholder": "0 = usar predeterminado del modelo",
    "settings.maxTokensHint": "Sobrescribe el máximo de tokens de salida por solicitud. Establece en 0 para usar automáticamente el límite del modelo seleccionado (o 64k si es desconocido).",
    "settings.copyright": "Inyectar crédito del editor al exportar",
    "settings.copyrightHint": "Agrega una línea de crédito en las notas del creador al exportar tarjetas.",
    "settings.availableModels": "Modelos disponibles",
    "settings.searchModels": "Buscar modelos...",
    "settings.enterApiKey": "Ingresa tu clave API y actualiza para cargar modelos",
    "settings.credits": "Créditos y uso",
    "settings.creditLimit": "Límite de créditos",
    "settings.remaining": "Restante",
    "settings.usedMonth": "Usado este mes",
    "settings.localStorage": "Almacenamiento local",
    "settings.clearAll": "Borrar todos los datos",
    "settings.export": "Exportar",
    "settings.import": "Importar",
    "settings.close": "Cerrar",
    "settings.saveSettings": "Guardar configuración",
    "settings.languageLabel": "Idioma",
    "settings.languageHint": "Idioma de la interfaz (recarga la página si falta)",
    "settings.languageChanged": "Idioma actualizado",
    "settings.clearConfirm": "¿Eliminar TODAS las tarjetas, configuración e historial de chat? Esta acción no se puede deshacer.",
    "settings.providerCustom": "Personalizado (compatible con OpenAI)",
    "settings.noModels": "No se encontraron modelos",
    "settings.loadMore": "Cargar más ({{count}} restantes)",
    "settings.showingModels": "Mostrando {{shown}} de {{total}} modelos",
    "wizard.title": "Crear personaje",
    "wizard.step.basics": "Básicos",
    "wizard.step.concept": "Concepto",
    "wizard.step.personality": "Personalidad",
    "wizard.step.scenario": "Escenario",
    "wizard.step.generate": "Generar",
    "wizard.basicsTitle": "Básicos del personaje",
    "wizard.nameLabel": "Nombre del personaje",
    "wizard.namePlaceholder": "ej. Elara Nightwhisper",
    "wizard.genderLabel": "Género / Pronombres",
    "wizard.genderSelect": "Seleccionar...",
    "wizard.gender.female": "Femenino (ella/la)",
    "wizard.gender.male": "Masculino (él/el)",
    "wizard.gender.nonbinary": "No binario (elle/elle)",
    "wizard.gender.other": "Otro...",
    "wizard.genderCustom": "Pronombres personalizados (ej. elle)",
    "wizard.tagsLabel": "Etiquetas",
    "wizard.tagsSub": "(separadas por comas, ayuda a organizar tu biblioteca)",
    "wizard.tagsPlaceholder": "fantasía, guerrero, elfo, original",
    "wizard.creatorLabel": "Creador",
    "wizard.creatorPlaceholder": "Tu nombre / alias",
    "wizard.conceptTitle": "Concepto y ambientación",
    "wizard.typeLabel": "Tipo de personaje",
    "wizard.type.original": "Personaje original",
    "wizard.type.fanfic": "Fanfiction",
    "wizard.type.game": "Personaje de juego",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Libro / Película / Serie",
    "wizard.type.historical": "Figura histórica",
    "wizard.type.mythological": "Mitología / Folclore",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Otro",
    "wizard.languageLabel": "Idioma",
    "wizard.language.other": "Otro",
    "wizard.languageSpecify": "Especificar idioma",
    "wizard.genreLabel": "Género / Mundo",
    "wizard.genreSub": "(selecciona todos los que apliquen)",
    "wizard.moodLabel": "Ambiente / Tono",
    "wizard.moodSub": "(selecciona todos los que apliquen)",
    "wizard.personalityTitle": "Personalidad y apariencia",
    "wizard.personalityTraits": "Rasgos de personalidad",
    "wizard.personalityTraitsSub": "(describe 3-5 rasgos clave, esto ayuda a la IA)",
    "wizard.personalityTraitsPlaceholder": "ej. Valiente pero imprudente, leal a sus amigos, sentido del humor seco, le cuesta confiar, secretamente ama a los animales",
    "wizard.appearanceLabel": "Apariencia física",
    "wizard.appearanceSub": "(breve descripción de su apariencia)",
    "wizard.appearancePlaceholder": "ej. Mujer alta con cabello plateado hasta la cintura, manos con cicatrices, usa chaqueta de cuero oscura, ojos verdes penetrantes",
    "wizard.abilitiesLabel": "Habilidades especiales / Peculiaridades",
    "wizard.abilitiesSub": "(opcional, rasgos únicos)",
    "wizard.abilitiesPlaceholder": "ej. Puede hablar con animales, tiene memoria fotográfica, siempre lleva un diario gastado",
    "wizard.scenarioTitle": "Escenario y primer mensaje",
    "wizard.scenarioLabel": "Escenario / Ambientación",
    "wizard.scenarioSub": "¿Dónde comienza la historia?",
    "wizard.scenarioPlaceholder": "ej. Una noche lluviosa en una ciudad iluminada por neones. El personaje tiene un pequeño taller que repara máquinas y corazones rotos.",
    "wizard.relationshipLabel": "Relación con {{user}}",
    "wizard.relationshipSub": "¿Cómo ve el personaje al usuario?",
    "wizard.relationshipPlaceholder": "ej. Un nuevo cliente que entró al taller con un dispositivo misterioso roto. El personaje es curioso pero cauteloso.",
    "wizard.openingLabel": "Ambiente del primer mensaje",
    "wizard.openingSub": "¿Cómo debería sentirse el mensaje de apertura?",
    "wizard.notesLabel": "Notas adicionales",
    "wizard.notesSub": "¿Algo más que la IA debería saber?",
    "wizard.notesPlaceholder": "ej. Mantén el diálogo natural, evita ser demasiado formal, incluye descripciones de acciones entre asteriscos",
    "wizard.generateTitle": "Generar personaje",
    "wizard.refImage": "Imagen de referencia",
    "wizard.refImageSub": "(opcional, de waifu.im)",
    "wizard.fetchImages": "Obtener 3 imágenes",
    "wizard.refetchOthers": "Obtener otras",
    "wizard.fetching": "Obteniendo...",
    "wizard.useSelected": "Usar selección",
    "wizard.clear": "Limpiar",
    "wizard.generateAI": "Generar con IA",
    "wizard.generateAISub": "Tarjeta completa del personaje con tus respuestas",
    "wizard.createBlank": "Crear tarjeta en blanco",
    "wizard.createBlankSub": "Comenzar con nombre y etiquetas prellenados",
    "wizard.back": "Atrás",
    "wizard.next": "Siguiente",
    "wizard.stepLabel": "Paso {{step}} de {{total}}",
    "wizard.ready": "¡Listo para generar!",
    "wizard.nameRequired": "Por favor ingresa un nombre de personaje",
    "wizard.summary.name": "Nombre",
    "wizard.summary.gender": "Género",
    "wizard.summary.type": "Tipo",
    "wizard.summary.language": "Idioma",
    "wizard.summary.tags": "Etiquetas",
    "wizard.summary.genres": "Géneros",
    "wizard.summary.mood": "Ambiente",
    "wizard.summary.opening": "Apertura",
    "wizard.summary.personality": "Personalidad",
    "wizard.summary.appearance": "Apariencia",
    "wizard.summary.scenario": "Escenario",
    "wizard.summary.relationship": "Relación",
    "wizard.summary.notes": "Notas",
    "wizard.chip.fantasy": "Fantasía",
    "wizard.chip.scifi": "Ciencia ficción",
    "wizard.chip.modern": "Moderno",
    "wizard.chip.historical": "Histórico",
    "wizard.chip.horror": "Terror",
    "wizard.chip.romance": "Romance",
    "wizard.chip.comedy": "Comedia",
    "wizard.chip.sliceOfLife": "Recortes de vida",
    "wizard.chip.adventure": "Aventura",
    "wizard.chip.mystery": "Misterio",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Post-apocalíptico",
    "wizard.chip.supernatural": "Sobrenatural",
    "wizard.chip.military": "Militar",
    "wizard.chip.surreal": "Surrealista",
    "wizard.chip.serious": "Serio",
    "wizard.chip.playful": "Juguetón",
    "wizard.chip.dark": "Oscuro",
    "wizard.chip.lighthearted": "Ligero",
    "wizard.chip.mysterious": "Misterioso",
    "wizard.chip.romantic": "Romántico",
    "wizard.chip.intense": "Intenso",
    "wizard.chip.wholesome": "Cálido",
    "wizard.chip.chaotic": "Caótico",
    "wizard.chip.melancholic": "Melancólico",
    "wizard.chip.sarcastic": "Sarcástico",
    "wizard.chip.stoic": "Estoico",
    "wizard.chip.greeting": "Saludo cálido",
    "wizard.chip.action": "In Media Res",
    "wizard.chip.question": "Pregunta curiosa",
    "wizard.chip.conflict": "Conflicto inmediato",
    "wizard.chip.atmospheric": "Atmosférico",
    "diff.title": "Vista previa de respuesta de IA",
    "diff.removed": "Eliminado",
    "diff.added": "Añadido",
    "diff.current": "Actual",
    "diff.proposed": "Propuesto",
    "diff.empty": "(vacío)",
    "diff.discard": "Descartar",
    "diff.apply": "Aplicar cambios",
    "shortcuts.title": "Atajos",
    "shortcuts.save": "Guardar tarjeta",
    "shortcuts.newCard": "Nueva tarjeta",
    "shortcuts.undo": "Deshacer",
    "shortcuts.redo": "Rehacer",
    "shortcuts.sendAi": "Enviar mensaje de IA",
    "shortcuts.newLine": "Nueva línea en IA",
    "shortcuts.focus": "Modo enfoque",
    "shortcuts.collapsePanel": "Contraer/expandir panel de IA",
    "toast.loadFailed": "Error: {{name}}",
    "toast.loaded": "{{count}} tarjeta(s) cargada(s)",
    "toast.importDupe": "Mismo contenido que una tarjeta existente — importada como {{name}}",
    "toast.largeImage": "Imagen grande incrustada en {{name}} ({{size}} MB) - considera eliminarla para ahorrar espacio.",
    "toast.noValid": "No se encontraron tarjetas válidas. Suelta archivos PNG o JSON.",
    "toast.noSelected": "No hay tarjetas seleccionadas",
    "toast.cardsDeleted": "Tarjetas eliminadas",
    "toast.deleteFailed": "No se pudo eliminar la tarjeta",
    "toast.exported": "{{count}} tarjeta(s) exportada(s)",
    "toast.newBlank": "Nueva tarjeta en blanco creada",
    "toast.noCardSave": "No hay tarjeta para guardar",
    "toast.cardSaved": "¡Tarjeta guardada!",
    "toast.noCardDup": "No hay tarjeta para duplicar",
    "toast.cardDup": "Tarjeta duplicada",
    "toast.cardRestored": "Tarjeta restaurada",
    "toast.selectCard": "Selecciona una tarjeta primero",
    "toast.avatarUpdated": "Avatar actualizado",
    "toast.imgFailed": "Error al cargar la imagen",
    "toast.firstMesUpdated": "¡Primer mensaje actualizado!",
    "toast.settingsSaved": "¡Configuración guardada!",
    "toast.modelsFailed": "Error al cargar modelos: {{error}}",
    "toast.modelSet": "Modelo establecido: {{model}}",
    "toast.dataCleared": "Todos los datos borrados",
    "toast.settingsExported": "Configuración exportada",
    "toast.settingsImported": "¡Configuración importada!",
    "toast.invalidFile": "Archivo de configuración no válido",
    "toast.apiKey": "Establece tu clave API en Configuración",
    "toast.selectModel": "Por favor selecciona un modelo en la barra de navegación o en la configuración primero.",
    "toast.genStopped": "Generación detenida.",
    "toast.aiError": "Error de IA: {{error}}",
    "toast.cardUpdatedAI": "¡Tarjeta actualizada con la respuesta de la IA!",
    "toast.jsonParseFailed": "No se pudo parsear la respuesta de IA como JSON. Revisa el chat.",
    "toast.emptyResponse": "La IA devolvió contenido vacío — no hay nada que aplicar.",
    "toast.jsonInvalid": "La IA no devolvió JSON válido. La respuesta está en el chat — puedes copiarla manualmente.",
    "toast.fieldUpdated": '¡"{{field}}" actualizado!',
    "toast.selectField": "Selecciona al menos un campo para editar",
    "toast.tooManyFields": "Demasiados campos seleccionados. Máximo {{max}} a la vez.",
    "toast.greetingsUpdated": "¡{{count}} saludo(s) generado(s)!",
    "toast.tagsUpdated": "¡Etiquetas actualizadas — {{count}} nueva(s) añadida(s)!",
    "toast.greetingsParseFailed": "No se pudieron analizar los saludos de la respuesta de la IA.",
    "toast.createCardFirst": "Crea o selecciona una tarjeta primero",
    "toast.wizardCreated": "¡Tarjeta creada! Comienza a editar o usa la IA para completar los detalles.",
    "toast.wizardApi": "Establece tu clave API en Configuración primero",
    "toast.wizardModel": "Selecciona un modelo o establece un ID de modelo personalizado en Configuración",
    "toast.wizardFetchFailed": "Error al obtener imágenes: {{error}}",
    "toast.wizardName": "Por favor ingresa un nombre de personaje",
    "toast.storageFull": "¡Almacenamiento lleno! Intenta eliminar o exportar algunas tarjetas.",
    "toast.exportedJson": "¡Exportado como JSON!",
    "toast.exportedPng": "¡Exportado como PNG con datos de tarjeta!",
    "toast.exportFailed": "Error al exportar imagen. Volviendo a JSON.",
    "toast.chatCleared": "Chat limpiado",
    "toast.undo": "Deshacer",
    "error.apiKeyNotSet": "Clave API no configurada. Introduce tu clave API en Configuración.",
    "error.customUrlNotSet": "La URL base de API personalizada no está configurada. Abra Configuración → Personalizado (compatible con OpenAI) e introduzca la URL del endpoint (p. ej. http://localhost:1234/v1).",
    "error.customServerError": "El servidor devolvió un error: {{detail}}",
    "error.customAuthFailed": "Error de autenticación (HTTP {{status}}). Comprueba la clave API de este endpoint.",
    "error.customPathNotFound": "Endpoint no encontrado (HTTP 404). Comprueba que la URL base de la API esté completa (p. ej. incluya /v1).",
    "error.customUnreachable": "No se puede acceder a {{url}}. Comprueba que el servidor esté en marcha y que la URL base de la API sea correcta y accesible desde este dispositivo.",
    "error.noModel": "Ningún modelo seleccionado. Por favor elige un modelo o establece un ID de modelo en Configuración.",
    "error.noModelSimple": "Ningún modelo seleccionado.",
    "error.insufficientCredits": "Créditos insuficientes. Por favor recarga tu cuenta.",
    "error.storageFull": "¡Almacenamiento lleno! Intenta eliminar o exportar algunas tarjetas.",
    "gen.empty": "(vacío)",
    "gen.free": "Gratis",
    "gen.unlimited": "Ilimitado",
    "gen.notAvailable": "N/D",
    "gen.unnamed": "Sin nombre",
    "gen.byCreator": "por {{name}}",
    "gen.untagged": "No se encontraron etiquetas",
    "gen.noMatch": "Ninguna tarjeta coincide con tus filtros",
    "batch.deleteConfirm": "¿Eliminar {{count}} tarjeta(s)? Esta acción no se puede deshacer.",
    "left.selected": "{{count}} seleccionada(s)",
    "toast.cardDeleted": 'Tarjeta "{{name}}" eliminada',
    "ai.editing": "Editando {{count}} campo(s)...",
    "ai.streaming": "transmitiendo...",
    "ai.failed": "falló",
    "ai.cancelled": "Cancelado.",
    "ai.doneSummary": "{{done}}/{{total}} hecho · {{errs}} falló",
    "ai.viewFullResult": "Ver resultado completo",
    "ai.showLess": "Mostrar menos",
    "ai.reviewApply": "Revisar y aplicar",
    "ai.changesNav": "Cambio {{current}} de {{total}}",
    "ai.changesPrev": "Cambio anterior",
    "ai.changesNext": "Cambio siguiente",
    "ai.applied": "Aplicado",
    "ai.target.tags": "Etiquetas",
    "ai.copy": "Copiar",
    "ai.copied": "¡Copiado!",
    "ai.copyFailed": "Falló",
    "ai.resultTitle": "Resultado",
    "ai.close": "Cerrar",
    "editor.noGreetings": "Aún no hay saludos. Haga clic en <strong>Agregar saludo</strong> o use la IA para generar algunos.",
    "editor.noEntriesMatch": 'Ninguna entrada coincide con "{{query}}"',
    "gen.copySuffix": " (Copia)",
    "gen.toastAutoHide": "{{s}}s",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "Cerca del límite de tokens de salida ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Supera el límite de tokens de salida ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "Contraer panel",
    "ui.expandPanel": "Expandir panel",
    "ui.cardModified": "Cambios sin guardar",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "Historial del chat",
    "ai.historyTitle": "Historial del chat",
    "ai.historyEmpty": "Aún no hay conversaciones",
    "ai.retry": "Reintentar",
    "ai.retryTitle": "Regenerar esta respuesta",
    "ai.reapply": "Reaplicar",
    "ai.reapplyTitle": "Volver a abrir el diff para aplicar estos cambios",
    "wizard.editStep": "Editar esta sección",
    "wizard.draftRestored": "Borrador restaurado: tus respuestas anteriores han vuelto",
    "wizard.imagePlaceholder": "Haz clic en Obtener",
    "toast.noNameWarning": 'Advertencia: la tarjeta no tiene nombre. El archivo se guardará como "character.json".',
    "toast.redo": "Rehacer",
    "toast.reorderFiltered": "Desactiva la búsqueda y los filtros para reordenar las tarjetas.",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.de = {
    "app.title": "ST Card Editor — SillyTavern Charakterkarten-Studio",
    "nav.selectModel": "Modell auswählen...",
    "nav.wizard": "Mit KI-Assistenten erstellen",
    "nav.newCard": "Neue leere Karte",
    "nav.save": "Speichern",
    "nav.theme": "Design wechseln",
    "nav.shortcuts": "Tastenkürzel & Hilfe",
    "nav.settings": "Einstellungen",
    "nav.focus": "Fokusmodus",
    "nav.focusAlt": "Fokusmodus (Alt+F)",
    "left.title": "Kartenbibliothek",
    "left.cards": "{{count}} Karten",
    "left.drop": "Ziehen und ablegen",
    "left.dropSub": "PNG- oder JSON-Karakterkarten",
    "left.browse": "Dateien durchsuchen",
    "left.search": "Karten suchen...",
    "left.sort.nameAsc": "Name A-Z",
    "left.sort.nameDesc": "Name Z-A",
    "left.sort.manual": "Manuell",
    "left.sort.newest": "Neueste zuerst",
    "left.sort.oldest": "Älteste zuerst",
    "left.sort.largest": "Größte",
    "left.sort.smallest": "Kleinste",
    "left.filterTags": "Nach Tags filtern",
    "left.exportSelected": "Auswahl als JSON exportieren",
    "left.deleteSelected": "Auswahl löschen",
    "left.empty": "Keine Karten geladen",
    "left.emptySub": "Legen Sie eine Karte ab oder klicken Sie auf Durchsuchen",
    "center.noCard": "Keine Karte ausgewählt",
    "center.noCardSub": "Wählen Sie eine Karte aus der Bibliothek oder ziehen Sie eine neue hierher",
    "center.createAI": "Mit KI erstellen",
    "center.blankCard": "Leere Karte",
    "editor.avatar": "Klicken oder Bild ablegen, um den Avatar festzulegen",
    "editor.avatarAria": "Charakter-Avatar festlegen",
    "editor.name": "Charaktername",
    "editor.exportJson": "Als JSON exportieren",
    "editor.exportPng": "Als PNG exportieren",
    "editor.duplicate": "Karte duplizieren",
    "editor.delete": "Karte löschen",
    "editor.tab.core": "Kern",
    "editor.tab.personality": "Persönlichkeit",
    "editor.tab.advanced": "Erweitert",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Waifu-Bild",
    "editor.waifuPreview": "Aktuelles Kartenbild",
    "editor.waifuNoImage": "Noch kein Bild festgelegt",
    "editor.waifuSource": "Bildquelle",
    "editor.waifuSourceSnap": "Anime-Momente (waifu.im)",
    "editor.waifuSourceChar": "Anime-Charaktere (AniList)",
    "editor.waifuGender": "Geschlecht",
    "editor.waifuGenderAll": "Jedes Geschlecht",
    "editor.waifuGenderFemaleOnly": "Nur Frauen",
    "editor.waifuGenderMaleOnly": "Nur Männer",
    "editor.waifuGenderFemale": "Weiblich",
    "editor.waifuGenderMale": "Männlich",
    "editor.waifuCharSub": "einen Charakter per Name suchen (z. B. zoro)",
    "editor.waifuSearch": "Auf waifu.im suchen",
    "editor.waifuSearchChar": "Charaktere suchen",
    "editor.waifuSearchPlaceholderChar": "einen Charakter per Name suchen (z. B. zoro)",
    "editor.waifuSub": "(holt Anime-Stil-Bilder nach Tag)",
    "editor.waifuSearchPlaceholder": "z. B. waifu, Elfe, Magd...",
    "editor.waifuFetch": "Bilder abrufen",
    "editor.waifuRegenTitle": "Ergebnisse neu generieren",
    "editor.waifuMixed": "Frauen + Männer",
    "editor.waifuMixedSub": "ausgewogene Auswahl mit einem Klick: 3 weibliche + 3 männliche Charaktere",
    "editor.waifuUse": "Als Kartenbild verwenden",
    "editor.waifuUpload": "Vom Gerät hochladen",
    "editor.waifuRemove": "Bild entfernen",
    "toast.noImage": "Diese Karte hat kein Bild zum Entfernen",
    "toast.imageRemoved": "Bild entfernt",
    "editor.desc": "Beschreibung",
    "editor.descSub": "(Erscheinung, Hintergrund)",
    "editor.descPlaceholder": "Beschreiben Sie das Erscheinungsbild, den Hintergrund und die Hauptmerkmale des Charakters...",
    "editor.firstMes": "Erste Nachricht",
    "editor.firstMesPlaceholder": "Die erste Nachricht des Charakters beim Start eines Chats...",
    "editor.scenario": "Szenario",
    "editor.scenarioPlaceholder": "Aktuelle Umstände und Kontext des Gesprächs...",
    "editor.creator": "Ersteller",
    "editor.creatorPlaceholder": "Karten-Ersteller / Autor",
    "editor.version": "Charakter-Version",
    "editor.tags": "Tags",
    "editor.tagsSub": "(kommagetrennt)",
    "editor.tagsPlaceholder": "Fantasy, Krieger, Elf",
    "editor.personalitySummary": "Persönlichkeits-Zusammenfassung",
    "editor.personalityPlaceholder": "Kurze Beschreibung der Persönlichkeit des Charakters... (wird im Kartenformat verwendet)",
    "editor.mesExample": "Beispiel-Nachrichten",
    "editor.mesExampleFormat": "Format: <START>-Blöcke mit {{char}}: und {{user}}: Präfixen",
    "editor.systemPrompt": "System-Prompt",
    "editor.systemPromptPlaceholder": "System-Prompt überschreiben. Verwenden Sie {{original}}, um den Standard einzubeziehen.",
    "editor.postHistory": "Post-History-Anweisungen",
    "editor.postHistoryPlaceholder": "Anweisungen, die nach dem Chat-Verlauf eingefügt werden. Verwenden Sie {{original}} für den Standard.",
    "editor.creatorNotes": "Ersteller-Notizen",
    "editor.creatorNotesPlaceholder": "Notizen für Kartenbenutzer (Modell-Empfehlung, Nutzungstipps...)",
    "editor.greetings": "Alternative Begrüßungen",
    "editor.addGreeting": "Begrüßung hinzufügen",
    "editor.lorebookTitle": "Charakter-Lorebook-Einträge",
    "editor.addEntry": "Eintrag hinzufügen",
    "editor.lorebookSearch": "Einträge nach Schlüssel, Inhalt oder Kommentar durchsuchen...",
    "editor.lorebookEmpty": "Noch keine Lorebook-Einträge. Fügen Sie einen hinzu, um zu beginnen.",
    "editor.edit": "Bearbeiten",
    "editor.preview": "Vorschau",
    "ai.title": "KI-Assistent",
    "ai.clearChat": "Chat löschen",
    "ai.welcomeTitle": "KI-Karten-Assistent",
    "ai.welcomeText": "Bitten Sie die KI, Ihre Charakterkarte zu bearbeiten, zu übersetzen oder zu verbessern.",
    "ai.quick.newCard": "Neue Karte",
    "ai.quick.translate": "Übersetzen",
    "ai.quick.enhance": "Verbessern",
    "ai.quick.shorten": "Kürzen",
    "ai.quick.tone": "Tonfall ändern",
    "ai.quick.grammar": "Grammatik korrigieren",
    "ai.quick.personality": "Persönlichkeit erweitern",
    "ai.quick.firstmes": "Erste Nachricht verbessern",
    "ai.quick.scenario": "Szenario erweitern",
    "ai.quick.greetings": "Begrüßungen generieren",
    "ai.quick.systemprompt": "System-Prompt verbessern",
    "ai.quick.tags": "Tags vorschlagen",
    "ai.contextTitle": "Geschätzte Tokens vs. Modell-Kontextgrenze",
    "ai.contextLabel": "— / — Tokens",
    "ai.placeholder": "Bitten Sie die KI, die Karte zu bearbeiten...",
    "ai.send": "Senden",
    "ai.stop": "Generierung stoppen",
    "ai.autoModel": "Auto (Navigationsmodell verwenden)",
    "ai.target": "Ziel:",
    "ai.target.full": "Vollständige Karte",
    "ai.target.description": "Beschreibung",
    "ai.target.personality": "Persönlichkeit",
    "ai.target.first_mes": "Erste Nachricht",
    "ai.target.scenario": "Szenario",
    "ai.target.mes_example": "Beispiel-Nachrichten",
    "ai.target.system_prompt": "System-Prompt",
    "ai.target.post_history_instructions": "Post-History-Anweisungen",
    "ai.target.creator_notes": "Ersteller-Notizen",
    "ai.target.alternate_greetings": "Alternative Begrüßungen",
    "ai.selectModel": "Modell auswählen",
    "ai.actionNewCard": "Neue Karte",
    "ai.actionTranslate": "Übersetzen",
    "ai.actionEnhance": "Verbessern",
    "ai.actionShorten": "Kürzen",
    "ai.actionTone": "Ton ändern",
    "ai.actionGrammar": "Grammatik korrigieren",
    "ai.actionPersonality": "Persönlichkeit erweitern",
    "ai.actionFirstMes": "Erste Nachricht verbessern",
    "ai.actionScenario": "Szenario erweitern",
    "ai.actionGreetings": "Begrüßungen generieren",
    "ai.actionSystemprompt": "System-Prompt verbessern",
    "ai.actionTags": "Tags vorschlagen",
    "ai.noCard": "(keine Karte ausgewählt)",
    "settings.themeColor": "Themenfarbe",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Wählen Sie eine eigene Akzentfarbe für das helle und das dunkle Design. Änderungen werden sofort übernommen.",
    "settings.appearance": "Erscheinungsbild",
    "settings.accentPresets": "Akzent-Farbpalette",
    "settings.glassDensity": "Glasdichte",
    "settings.glassSubtle": "Dezent",
    "settings.glassDefault": "Standard",
    "settings.glassBold": "Kräftig",
    "settings.cardRadius": "Kartenradius",
    "settings.radiusCompact": "Kompakt",
    "settings.radiusRounded": "Abgerundet",
    "settings.radiusPill": "Pille",
    "settings.vignette": "Rand-Vignette",
    "settings.appearanceHint": "Passen Sie das Aussehen jedes hellen/dunklen Designs an. Akzentänderungen gelten sofort; Dichte, Radius und Vignette sind in Workspace-Backups enthalten.",
    "settings.resetThemeColor": "Zurücksetzen",
    "settings.generalTab": "Allgemein",
    "settings.promptsTab": "KI-Prompts",
    "settings.assistantPrompt": "System-Prompt des Assistenten",
    "settings.fullCardPrompt": "System-Prompt für die komplette Karte",
    "settings.wizardPrompt": "Anweisungen für die Charaktererstellung",
    "settings.promptPlaceholder": "Leer lassen, um den integrierten Prompt zu verwenden",
    "settings.chatSystemPrompts": "Chat- und Systemanweisungen",
    "settings.fullCardInstr": "Ausgabeanweisungen für die komplette Karte (System)",
    "settings.fieldsEdit": "Feldbearbeitungsanweisungen (System)",
    "settings.greetingsSystem": "Ausgabeanweisungen für Begrüßungen (System)",
    "settings.exportPrompts": "Prompts exportieren",
    "settings.importPrompts": "Prompts importieren",
    "settings.promptsExported": "Prompts exportiert",
    "settings.promptsImported": "{count} Prompts importiert",
    "settings.quickActionPrompts": "Schnellaktions-Prompts",
    "settings.tagsSystemPrompt": "Tag-Ausgabeanweisungen (System)",
    "settings.restoreDefaultPrompts": "Standard-Prompts wiederherstellen",
    "settings.promptHint": "Diese Felder zeigen die aktuellen Prompts. Ist ein Feld leer, wird der integrierte Standard-Prompt verwendet. Stellen Sie die Standardwerte wieder her, um sie anzuzeigen oder zurückzusetzen.",
    "settings.title": "Einstellungen",
    "settings.provider": "Anbieter",
    "settings.providerHint": "Gehostete Modellanbieter oder benutzerdefinierter Endpunkt (LM Studio, Ollama usw.)",
    "settings.apiKey": "API-Schlüssel",
    "settings.getApiKey": "Holen Sie sich Ihren API-Schlüssel von OpenRouter",
    "settings.baseUrl": "API-Basis-URL",
    "settings.namedApiKeyPlaceholder": "Geben Sie Ihren API-Schlüssel ein",
    "settings.customHint": "Der OpenAI-kompatible Endpunkt. Beispiele: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API-Schlüssel (optional)",
    "settings.apiKeyLocalPlaceholder": "Leer lassen für lokale Anbieter",
    "settings.apiKeyLocalHint": "Nicht erforderlich für lokale Server wie LM Studio oder Ollama.",
    "settings.modelId": "Modell-ID",
    "settings.modelIdHint": "Die genaue Modell-ID, die Ihr Anbieter erwartet.",
    "settings.modelIdHintNamed": "Leer lassen, um das Standardmodell des Anbieters zu verwenden.",
    "settings.security": "Ihr API-Schlüssel ist verschlüsselt im localStorage Ihres Browsers gespeichert (Schlüssel gebunden an diese Adresse). Verwenden Sie diese App nicht auf gemeinsam genutzten Geräten.",
    "settings.secretUnreadable": "Aus Sicherheitsgründen konnte ein gespeicherter API-Schlüssel auf dieser Adresse nicht entsperrt werden — bitte geben Sie ihn in den Einstellungen erneut ein.",
    "error.pngInflateFailed": "Dieses PNG enthält Zeichendaten, die nicht dekomprimiert werden konnten.",
    "settings.defaultModel": "Standardmodell",
    "settings.browseModels": "Modelle unten durchsuchen...",
    "settings.refreshModels": "Modelle aktualisieren",
    "settings.maxTokens": "Max. Ausgabe-Tokens",
    "settings.maxTokensPlaceholder": "0 = Modellstandard verwenden",
    "settings.maxTokensHint": "Überschreiben Sie die maximale Anzahl der Ausgabe-Tokens pro Anfrage. Auf 0 setzen, um automatisch die Grenze des ausgewählten Modells zu verwenden (oder 64k bei unbekannt).",
    "settings.copyright": "Editor-Credit beim Export einfügen",
    "settings.copyrightHint": "Fügt beim Exportieren eine Credit-Zeile zu den Ersteller-Notizen hinzu.",
    "settings.availableModels": "Verfügbare Modelle",
    "settings.searchModels": "Modelle suchen...",
    "settings.enterApiKey": "Geben Sie Ihren API-Schlüssel ein und aktualisieren Sie, um Modelle zu laden",
    "settings.credits": "Guthaben & Nutzung",
    "settings.creditLimit": "Guthabensgrenze",
    "settings.remaining": "Verbleibend",
    "settings.usedMonth": "Diesen Monat verwendet",
    "settings.localStorage": "Lokaler Speicher",
    "settings.clearAll": "Alle Daten löschen",
    "settings.export": "Exportieren",
    "settings.import": "Importieren",
    "settings.close": "Schließen",
    "settings.saveSettings": "Einstellungen speichern",
    "settings.languageLabel": "Sprache",
    "settings.languageHint": "Oberflächensprache (Seite neu laden falls fehlend)",
    "settings.languageChanged": "Sprache aktualisiert",
    "settings.clearConfirm": "ALLE Karten, Einstellungen und Chat-Verlauf löschen? Dies kann nicht rückgängig gemacht werden.",
    "settings.providerCustom": "Benutzerdefiniert (OpenAI-kompatibel)",
    "settings.noModels": "Keine Modelle gefunden",
    "settings.loadMore": "Mehr laden ({{count}} verbleibend)",
    "settings.showingModels": "{{shown}} von {{total}} Modellen",
    "wizard.title": "Charakter erstellen",
    "wizard.step.basics": "Grundlagen",
    "wizard.step.concept": "Konzept",
    "wizard.step.personality": "Persönlichkeit",
    "wizard.step.scenario": "Szenario",
    "wizard.step.generate": "Generieren",
    "wizard.basicsTitle": "Charakter-Grundlagen",
    "wizard.nameLabel": "Charaktername",
    "wizard.namePlaceholder": "z.B. Elara Nightwhisper",
    "wizard.genderLabel": "Geschlecht / Pronomen",
    "wizard.genderSelect": "Auswählen...",
    "wizard.gender.female": "Weiblich (sie/ihr)",
    "wizard.gender.male": "Männlich (er/ihm)",
    "wizard.gender.nonbinary": "Nicht-binär (sier/ihnen)",
    "wizard.gender.other": "Andere...",
    "wizard.genderCustom": "Benutzerdefinierte Pronomen (z.B. es/sein)",
    "wizard.tagsLabel": "Tags",
    "wizard.tagsSub": "(kommagetrennt, hilft bei der Organisation Ihrer Bibliothek)",
    "wizard.tagsPlaceholder": "Fantasy, Krieger, Elf, Original",
    "wizard.creatorLabel": "Ersteller",
    "wizard.creatorPlaceholder": "Ihr Name / Alias",
    "wizard.conceptTitle": "Konzept & Setting",
    "wizard.typeLabel": "Charaktertyp",
    "wizard.type.original": "Originalcharakter",
    "wizard.type.fanfic": "Fanfiction",
    "wizard.type.game": "Spielcharakter",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Buch / Film / Serie",
    "wizard.type.historical": "Historische Persönlichkeit",
    "wizard.type.mythological": "Mythologisch / Folklore",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Andere",
    "wizard.languageLabel": "Sprache",
    "wizard.language.other": "Andere",
    "wizard.languageSpecify": "Sprache angeben",
    "wizard.genreLabel": "Genre / Welt",
    "wizard.genreSub": "(alle zutreffenden auswählen)",
    "wizard.moodLabel": "Stimmung / Tonfall",
    "wizard.moodSub": "(alle zutreffenden auswählen)",
    "wizard.personalityTitle": "Persönlichkeit & Erscheinung",
    "wizard.personalityTraits": "Persönlichkeitsmerkmale",
    "wizard.personalityTraitsSub": "(beschreiben Sie 3-5 Hauptmerkmale, dies hilft der KI)",
    "wizard.personalityTraitsPlaceholder": "z.B. Mutig aber unvorsichtig, extrem loyal gegenüber Freunden, trockener Humor, hat Vertrauensprobleme, liebt heimlich Tiere",
    "wizard.appearanceLabel": "Physische Erscheinung",
    "wizard.appearanceSub": "(kurze Beschreibung ihres Aussehens)",
    "wizard.appearancePlaceholder": "z.B. Große Frau mit silberhaar bis zur Taille, verletzte Hände, trägt eine dunkle Lederjacke, durchdringende grüne Augen",
    "wizard.abilitiesLabel": "Besondere Fähigkeiten / Eigenheiten",
    "wizard.abilitiesSub": "(optional, einzigartige Merkmale)",
    "wizard.abilitiesPlaceholder": "z.B. Kann mit Tieren sprechen, hat ein fotografisches Gedächtnis, trägt immer ein abgenutztes Tagebuch",
    "wizard.scenarioTitle": "Szenario & erste Nachricht",
    "wizard.scenarioLabel": "Szenario / Setting",
    "wizard.scenarioSub": "(wo beginnt die Geschichte?)",
    "wizard.scenarioPlaceholder": "z.B. Eine regnerische Nacht in einer neondurchfluteten Stadt. Der Charakter betreibt eine kleine Reparaturwerkstatt, die sowohl Maschinen als auch gebrochene Herzen repariert.",
    "wizard.relationshipLabel": "Beziehung zu {{user}}",
    "wizard.relationshipSub": "(wie sieht der Charakter den Benutzer?)",
    "wizard.relationshipPlaceholder": "z.B. Ein neuer Kunde, der mit einem mysteriösen, kaputten Gerät in die Werkstatt gekommen ist. Der Charakter ist neugierig, aber vorsichtig.",
    "wizard.openingLabel": "Stimmung der ersten Nachricht",
    "wizard.openingSub": "(wie sollte die Eröffnungsnachricht wirken?)",
    "wizard.notesLabel": "Zusätzliche Notizen",
    "wizard.notesSub": "(ist noch etwas, das die KI wissen sollte?)",
    "wizard.notesPlaceholder": "z.B. Dialoge natürlich halten, nicht zu förmlich sein, Handlungsbeschreibungen in Sternchen einfügen",
    "wizard.generateTitle": "Charakter generieren",
    "wizard.refImage": "Referenzbild",
    "wizard.refImageSub": "(optional, von waifu.im)",
    "wizard.fetchImages": "3 Bilder abrufen",
    "wizard.refetchOthers": "Andere neu abrufen",
    "wizard.fetching": "Abrufen...",
    "wizard.useSelected": "Auswahl verwenden",
    "wizard.clear": "Leeren",
    "wizard.generateAI": "Mit KI generieren",
    "wizard.generateAISub": "Vollständige Charakterkarte aus Ihren Antworten",
    "wizard.createBlank": "Leere Karte erstellen",
    "wizard.createBlankSub": "Mit vorausgefülltem Namen und Tags beginnen",
    "wizard.back": "Zurück",
    "wizard.next": "Weiter",
    "wizard.stepLabel": "Schritt {{step}} von {{total}}",
    "wizard.ready": "Bereit zum Generieren!",
    "wizard.nameRequired": "Bitte geben Sie einen Charakternamen ein",
    "wizard.summary.name": "Name",
    "wizard.summary.gender": "Geschlecht",
    "wizard.summary.type": "Typ",
    "wizard.summary.language": "Sprache",
    "wizard.summary.tags": "Tags",
    "wizard.summary.genres": "Genres",
    "wizard.summary.mood": "Stimmung",
    "wizard.summary.opening": "Eröffnung",
    "wizard.summary.personality": "Persönlichkeit",
    "wizard.summary.appearance": "Erscheinung",
    "wizard.summary.scenario": "Szenario",
    "wizard.summary.relationship": "Beziehung",
    "wizard.summary.notes": "Notizen",
    "wizard.chip.fantasy": "Fantasy",
    "wizard.chip.scifi": "Science-Fiction",
    "wizard.chip.modern": "Modern",
    "wizard.chip.historical": "Historisch",
    "wizard.chip.horror": "Horror",
    "wizard.chip.romance": "Romanze",
    "wizard.chip.comedy": "Komödie",
    "wizard.chip.sliceOfLife": "Alltagsleben",
    "wizard.chip.adventure": "Abenteuer",
    "wizard.chip.mystery": "Mystery",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Post-apokalyptisch",
    "wizard.chip.supernatural": "Übernatürlich",
    "wizard.chip.military": "Militärisch",
    "wizard.chip.surreal": "Surreal",
    "wizard.chip.serious": "Ernst",
    "wizard.chip.playful": "Verspielt",
    "wizard.chip.dark": "Düster",
    "wizard.chip.lighthearted": "Leicht",
    "wizard.chip.mysterious": "Mysteriös",
    "wizard.chip.romantic": "Romantisch",
    "wizard.chip.intense": "Intensiv",
    "wizard.chip.wholesome": "Herzerwärmend",
    "wizard.chip.chaotic": "Chaotisch",
    "wizard.chip.melancholic": "Melancholisch",
    "wizard.chip.sarcastic": "Sarkastisch",
    "wizard.chip.stoic": "Stoisch",
    "wizard.chip.greeting": "Warme Begrüßung",
    "wizard.chip.action": "In Medias Res",
    "wizard.chip.question": "Neugierige Frage",
    "wizard.chip.conflict": "Sofortiger Konflikt",
    "wizard.chip.atmospheric": "Atmosphärisch",
    "diff.title": "KI-Antwort-Vorschau",
    "diff.removed": "Entfernt",
    "diff.added": "Hinzugefügt",
    "diff.current": "Aktuell",
    "diff.proposed": "Vorgeschlagen",
    "diff.empty": "(leer)",
    "diff.discard": "Verwerfen",
    "diff.apply": "Änderungen anwenden",
    "shortcuts.title": "Tastenkürzel",
    "shortcuts.save": "Karte speichern",
    "shortcuts.newCard": "Neue Karte",
    "shortcuts.undo": "Rückgängig",
    "shortcuts.redo": "Wiederholen",
    "shortcuts.sendAi": "KI-Nachricht senden",
    "shortcuts.newLine": "Neue Zeile in KI",
    "shortcuts.focus": "Fokusmodus",
    "shortcuts.collapsePanel": "KI-Panel ein-/ausklappen",
    "toast.loadFailed": "Fehlgeschlagen: {{name}}",
    "toast.loaded": "{{count}} Karte(n) geladen",
    "toast.importDupe": "Identischer Inhalt wie eine vorhandene Karte — importiert als {{name}}",
    "toast.largeImage": "Großes Bild in {{name}} eingebettet ({{size}} MB) - erwägen Sie, es zu entfernen, um Speicherplatz zu sparen.",
    "toast.noValid": "Keine gültigen Karten gefunden. PNG- oder JSON-Dateien ablegen.",
    "toast.noSelected": "Keine Karten ausgewählt",
    "toast.cardsDeleted": "Karten gelöscht",
    "toast.deleteFailed": "Karte konnte nicht gelöscht werden",
    "toast.exported": "{{count}} Karte(n) exportiert",
    "toast.newBlank": "Neue leere Karte erstellt",
    "toast.noCardSave": "Keine Karte zum Speichern",
    "toast.cardSaved": "Karte gespeichert!",
    "toast.noCardDup": "Keine Karte zum Duplizieren",
    "toast.cardDup": "Karte dupliziert",
    "toast.cardRestored": "Karte wiederhergestellt",
    "toast.selectCard": "Wählen Sie zuerst eine Karte aus",
    "toast.avatarUpdated": "Avatar aktualisiert",
    "toast.imgFailed": "Bild konnte nicht geladen werden",
    "toast.firstMesUpdated": "Erste Nachricht aktualisiert!",
    "toast.settingsSaved": "Einstellungen gespeichert!",
    "toast.modelsFailed": "Modelle konnten nicht geladen werden: {{error}}",
    "toast.modelSet": "Modell festgelegt: {{model}}",
    "toast.dataCleared": "Alle Daten gelöscht",
    "toast.settingsExported": "Einstellungen exportiert",
    "toast.settingsImported": "Einstellungen importiert!",
    "toast.invalidFile": "Ungültige Einstellungsdatei",
    "toast.apiKey": "Stellen Sie Ihren API-Schlüssel in den Einstellungen ein",
    "toast.selectModel": "Bitte wählen Sie zuerst ein Modell aus der Navigationsleiste oder den Einstellungen.",
    "toast.genStopped": "Generierung gestoppt.",
    "toast.aiError": "KI-Fehler: {{error}}",
    "toast.cardUpdatedAI": "Karte mit KI-Antwort aktualisiert!",
    "toast.jsonParseFailed": "KI-Antwort konnte nicht als JSON geparst werden. Überprüfen Sie den Chat.",
    "toast.emptyResponse": "Die KI hat leeren Inhalt zurückgegeben — nichts anzuwenden.",
    "toast.jsonInvalid": "KI hat kein gültiges JSON zurückgegeben. Die Antwort ist im Chat — Sie können sie manuell kopieren.",
    "toast.fieldUpdated": '"{{field}}" aktualisiert!',
    "toast.selectField": "Wählen Sie mindestens ein Feld zum Bearbeiten aus",
    "toast.tooManyFields": "Zu viele Felder ausgewählt. Maximal {{max}} gleichzeitig.",
    "toast.greetingsUpdated": "{{count}} Begrüßung(en) generiert!",
    "toast.tagsUpdated": "Tags aktualisiert — {{count}} neue(r) hinzugefügt!",
    "toast.greetingsParseFailed": "Konnte Begrüßungen aus der KI-Antwort nicht analysieren.",
    "toast.createCardFirst": "Erstellen oder wählen Sie zuerst eine Karte aus",
    "toast.wizardCreated": "Karte erstellt! Beginnen Sie mit dem Bearbeiten oder verwenden Sie die KI, um die Details auszufüllen.",
    "toast.wizardApi": "Stellen Sie zuerst Ihren API-Schlüssel in den Einstellungen ein",
    "toast.wizardModel": "Wählen Sie ein Modell oder legen Sie eine benutzerdefinierte Modell-ID in den Einstellungen fest",
    "toast.wizardFetchFailed": "Bilder konnten nicht abgerufen werden: {{error}}",
    "toast.wizardName": "Bitte geben Sie einen Charakternamen ein",
    "toast.storageFull": "Speicher voll! Versuchen Sie, einige Karten zu löschen oder zu exportieren.",
    "toast.exportedJson": "Als JSON exportiert!",
    "toast.exportedPng": "Als PNG mit Kartendaten exportiert!",
    "toast.exportFailed": "Bildexport fehlgeschlagen. Rückfall auf JSON.",
    "toast.chatCleared": "Chat gelöscht",
    "toast.undo": "Rückgängig",
    "error.apiKeyNotSet": "API-Schlüssel nicht festgelegt. Geben Sie Ihren API-Schlüssel in den Einstellungen ein.",
    "error.customUrlNotSet": "Die Basis-URL der benutzerdefinierten API ist nicht festgelegt. Öffnen Sie die Einstellungen → Benutzerdefiniert (OpenAI-kompatibel) und geben Sie die Endpoint-URL ein (z. B. http://localhost:1234/v1).",
    "error.customServerError": "Der Server hat einen Fehler zurückgegeben: {{detail}}",
    "error.customAuthFailed": "Authentifizierung fehlgeschlagen (HTTP {{status}}). Überprüfen Sie den API-Schlüssel für diesen Endpoint.",
    "error.customPathNotFound": "Endpunkt nicht gefunden (HTTP 404). Prüfen Sie, ob die API-Basis-URL vollständig ist (z. B. /v1 enthält).",
    "error.customUnreachable": "{{url}} ist nicht erreichbar. Überprüfen Sie, ob der Server läuft und die API-Basis-URL korrekt und von diesem Gerät aus erreichbar ist.",
    "error.noModel": "Kein Modell ausgewählt. Bitte wählen Sie ein Modell oder legen Sie eine Modell-ID in den Einstellungen fest.",
    "error.noModelSimple": "Kein Modell ausgewählt.",
    "error.insufficientCredits": "Unzureichendes Guthaben. Bitte laden Sie Ihr Konto auf.",
    "error.storageFull": "Speicher voll! Versuchen Sie, einige Karten zu löschen oder zu exportieren.",
    "gen.empty": "(leer)",
    "gen.free": "Kostenlos",
    "gen.unlimited": "Unbegrenzt",
    "gen.notAvailable": "k.A.",
    "gen.unnamed": "Unbenannt",
    "gen.byCreator": "von {{name}}",
    "gen.untagged": "Keine Tags gefunden",
    "gen.noMatch": "Keine Karten entsprechen Ihren Filtern",
    "batch.deleteConfirm": "{{count}} Karte(n) löschen? Dies kann nicht rückgängig gemacht werden.",
    "left.selected": "{{count}} ausgewählt",
    "toast.cardDeleted": 'Karte "{{name}}" gelöscht',
    "ai.editing": "Bearbeite {{count}} Feld(er)...",
    "ai.streaming": "streamt...",
    "ai.failed": "fehlgeschlagen",
    "ai.cancelled": "Abgebrochen.",
    "ai.doneSummary": "{{done}}/{{total}} erledigt · {{errs}} fehlgeschlagen",
    "ai.viewFullResult": "Vollständiges Ergebnis anzeigen",
    "ai.showLess": "Weniger anzeigen",
    "ai.reviewApply": "Prüfen übernehmen",
    "ai.changesNav": "Änderung {{current}} von {{total}}",
    "ai.changesPrev": "Vorherige Änderung",
    "ai.changesNext": "Nächste Änderung",
    "ai.applied": "Angewendet",
    "ai.target.tags": "Tags",
    "ai.copy": "Kopieren",
    "ai.copied": "Kopiert!",
    "ai.copyFailed": "Fehlgeschlagen",
    "ai.resultTitle": "Ergebnis",
    "ai.close": "Schließen",
    "editor.noGreetings": "Noch keine Begrüßungen. Klicken Sie auf <strong>Begrüßung hinzufügen</strong> oder nutzen Sie KI, um welche zu erstellen.",
    "editor.noEntriesMatch": 'Keine Einträge entsprechen "{{query}}"',
    "gen.copySuffix": " (Kopie)",
    "gen.toastAutoHide": "{{s}}s",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "Nahe am Token-Ausgabelimit ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Über dem Token-Ausgabelimit ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "Panel einklappen",
    "ui.expandPanel": "Panel ausklappen",
    "ui.cardModified": "Ungespeicherte Änderungen",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "Chatverlauf",
    "ai.historyTitle": "Chatverlauf",
    "ai.historyEmpty": "Noch keine Unterhaltungen",
    "ai.retry": "Erneut versuchen",
    "ai.retryTitle": "Diese Antwort neu generieren",
    "ai.reapply": "Erneut anwenden",
    "ai.reapplyTitle": "Diff erneut öffnen, um diese Änderungen anzuwenden",
    "wizard.editStep": "Diesen Abschnitt bearbeiten",
    "wizard.draftRestored": "Entwurf wiederhergestellt – Ihre vorherigen Antworten sind zurück",
    "wizard.imagePlaceholder": "Klicken Sie auf Abrufen",
    "toast.noNameWarning": 'Warnung: Die Karte hat keinen Namen. Die Datei wird als "character.json" gespeichert.',
    "toast.redo": "Wiederholen",
    "toast.reorderFiltered": "Schalten Sie Suche und Filter aus, um Karten neu anzuordnen.",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.pt = {
    "app.title": "ST Card Editor — Estúdio de cartas de personagens SillyTavern",
    "nav.selectModel": "Selecionar modelo...",
    "nav.wizard": "Criar com assistente de IA",
    "nav.newCard": "Nova carta em branco",
    "nav.save": "Salvar",
    "nav.theme": "Alternar tema",
    "nav.shortcuts": "Atalhos e ajuda",
    "nav.settings": "Configurações",
    "nav.focus": "Modo foco",
    "nav.focusAlt": "Modo foco (Alt+F)",
    "left.title": "Biblioteca de cartas",
    "left.cards": "{{count}} cartas",
    "left.drop": "Arrastar e soltar",
    "left.dropSub": "Cartas de personagens PNG ou JSON",
    "left.browse": "Procurar arquivos",
    "left.search": "Buscar cartas...",
    "left.sort.nameAsc": "Nome A-Z",
    "left.sort.manual": "Manual",
    "left.sort.nameDesc": "Nome Z-A",
    "left.sort.newest": "Mais recentes primeiro",
    "left.sort.oldest": "Mais antigas primeiro",
    "left.sort.largest": "Maior",
    "left.sort.smallest": "Menor",
    "left.filterTags": "Filtrar por tags",
    "left.exportSelected": "Exportar selecionadas como JSON",
    "left.deleteSelected": "Excluir selecionadas",
    "left.empty": "Nenhuma carta carregada",
    "left.emptySub": "Solte uma carta ou clique em Procurar",
    "center.noCard": "Nenhuma carta selecionada",
    "center.noCardSub": "Selecione uma carta da biblioteca ou arraste uma nova",
    "center.createAI": "Criar com IA",
    "center.blankCard": "Carta em branco",
    "editor.avatar": "Clique ou solte uma imagem para definir o avatar",
    "editor.avatarAria": "Definir avatar do personagem",
    "editor.name": "Nome do personagem",
    "editor.exportJson": "Exportar como JSON",
    "editor.exportPng": "Exportar como PNG",
    "editor.duplicate": "Duplicar carta",
    "editor.delete": "Excluir carta",
    "editor.tab.core": "Principal",
    "editor.tab.personality": "Personalidade",
    "editor.tab.advanced": "Avançado",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Imagem Waifu",
    "editor.waifuPreview": "Imagem atual do cartão",
    "editor.waifuNoImage": "Nenhuma imagem definida ainda",
    "editor.waifuSource": "Fonte da imagem",
    "editor.waifuSourceSnap": "Momentos de anime (waifu.im)",
    "editor.waifuSourceChar": "Personagens de anime (AniList)",
    "editor.waifuGender": "Gênero",
    "editor.waifuGenderAll": "Qualquer gênero",
    "editor.waifuGenderFemaleOnly": "Somente mulheres",
    "editor.waifuGenderMaleOnly": "Somente homens",
    "editor.waifuGenderFemale": "Feminino",
    "editor.waifuGenderMale": "Masculino",
    "editor.waifuCharSub": "busque um personagem pelo nome (ex.: zoro)",
    "editor.waifuSearch": "Pesquisar em waifu.im",
    "editor.waifuSearchChar": "Buscar personagens",
    "editor.waifuSearchPlaceholderChar": "busque um personagem pelo nome (ex.: zoro)",
    "editor.waifuSub": "(busca imagens de estilo anime por tag)",
    "editor.waifuSearchPlaceholder": "ex.: waifu, elfa, empregada...",
    "editor.waifuFetch": "Buscar imagens",
    "editor.waifuRegenTitle": "Gerar novamente",
    "editor.waifuMixed": "Mulheres + Homens",
    "editor.waifuMixedSub": "pacote equilibrado em um clique: 3 personagens femininas + 3 masculinos",
    "editor.waifuUse": "Usar como imagem do cartão",
    "editor.waifuUpload": "Enviar do dispositivo",
    "editor.waifuRemove": "Remover imagem",
    "toast.noImage": "Este cartão não tem imagem para remover",
    "toast.imageRemoved": "Imagem removida",
    "editor.desc": "Descrição",
    "editor.descSub": "(aparência, história)",
    "editor.descPlaceholder": "Descreva a aparência, o histórico e as principais características do personagem...",
    "editor.firstMes": "Primeira mensagem",
    "editor.firstMesPlaceholder": "A primeira mensagem do personagem ao iniciar um chat...",
    "editor.scenario": "Cenário",
    "editor.scenarioPlaceholder": "Circunstâncias atuais e contexto da conversa...",
    "editor.creator": "Criador",
    "editor.creatorPlaceholder": "Criador / autor da carta",
    "editor.version": "Versão do personagem",
    "editor.tags": "Tags",
    "editor.tagsSub": "(separadas por vírgulas)",
    "editor.tagsPlaceholder": "fantasia, guerreiro, elfo",
    "editor.personalitySummary": "Resumo da personalidade",
    "editor.personalityPlaceholder": "Uma breve descrição da personalidade do personagem... (usada no formato de carta)",
    "editor.mesExample": "Mensagens de exemplo",
    "editor.mesExampleFormat": "Formato: blocos <START> com prefixos {{char}}: e {{user}}:",
    "editor.systemPrompt": "Prompt do sistema",
    "editor.systemPromptPlaceholder": "Substituir o prompt do sistema. Use {{original}} para incluir o padrão.",
    "editor.postHistory": "Instruções pós-histórico",
    "editor.postHistoryPlaceholder": "Instruções inseridas após o histórico de chat. Use {{original}} para o padrão.",
    "editor.creatorNotes": "Notas do criador",
    "editor.creatorNotesPlaceholder": "Notas para os usuários (recomendações de modelos, dicas de uso...)",
    "editor.greetings": "Saudações alternativas",
    "editor.addGreeting": "Adicionar saudação",
    "editor.lorebookTitle": "Entradas do lorebook do personagem",
    "editor.addEntry": "Adicionar entrada",
    "editor.lorebookSearch": "Buscar entradas por chave, conteúdo ou comentário...",
    "editor.lorebookEmpty": "Nenhuma entrada no lorebook ainda. Adicione uma para começar.",
    "editor.edit": "Editar",
    "editor.preview": "Visualizar",
    "ai.title": "Assistente de IA",
    "ai.clearChat": "Limpar chat",
    "ai.welcomeTitle": "Assistente de IA de cartas",
    "ai.welcomeText": "Peça à IA para editar, traduzir ou melhorar sua carta de personagem.",
    "ai.quick.newCard": "Nova carta",
    "ai.quick.translate": "Traduzir",
    "ai.quick.enhance": "Melhorar",
    "ai.quick.shorten": "Encurtar",
    "ai.quick.tone": "Mudar tom",
    "ai.quick.grammar": "Corrigir gramática",
    "ai.quick.personality": "Expandir personalidade",
    "ai.quick.firstmes": "Melhorar primeira mensagem",
    "ai.quick.scenario": "Expandir cenário",
    "ai.quick.greetings": "Gerar saudações",
    "ai.quick.systemprompt": "Aprimorar prompt do sistema",
    "ai.quick.tags": "Sugerir tags",
    "ai.contextTitle": "Tokens estimados vs. limite de contexto do modelo",
    "ai.contextLabel": "— / — tokens",
    "ai.placeholder": "Peça à IA para editar a carta...",
    "ai.send": "Enviar",
    "ai.stop": "Parar geração",
    "ai.autoModel": "Automático (usar modelo da barra)",
    "ai.target": "Alvo:",
    "ai.target.full": "Carta completa",
    "ai.target.description": "Descrição",
    "ai.target.personality": "Personalidade",
    "ai.target.first_mes": "Primeira mensagem",
    "ai.target.scenario": "Cenário",
    "ai.target.mes_example": "Mensagens de exemplo",
    "ai.target.system_prompt": "Prompt do sistema",
    "ai.target.post_history_instructions": "Instruções pós-histórico",
    "ai.target.creator_notes": "Notas do criador",
    "ai.target.alternate_greetings": "Saudações alternativas",
    "ai.selectModel": "Selecionar um modelo",
    "ai.actionNewCard": "Nova carta",
    "ai.actionTranslate": "Traduzir",
    "ai.actionEnhance": "Aprimorar",
    "ai.actionShorten": "Encurtar",
    "ai.actionTone": "Mudar tom",
    "ai.actionGrammar": "Corrigir gramática",
    "ai.actionPersonality": "Expandir personalidade",
    "ai.actionFirstMes": "Melhorar primeira mensagem",
    "ai.actionScenario": "Expandir cenário",
    "ai.actionGreetings": "Gerar saudações",
    "ai.actionSystemprompt": "Aprimorar prompt do sistema",
    "ai.actionTags": "Sugerir tags",
    "ai.noCard": "(nenhuma carta selecionada)",
    "settings.themeColor": "Cor do tema",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Escolha uma cor de destaque separada para cada tema claro/escuro. As alterações são aplicadas imediatamente.",
    "settings.appearance": "Aparência",
    "settings.accentPresets": "Predefinições de acento",
    "settings.glassDensity": "Densidade do vidro",
    "settings.glassSubtle": "Sutil",
    "settings.glassDefault": "Padrão",
    "settings.glassBold": "Ousado",
    "settings.cardRadius": "Raio do cartão",
    "settings.radiusCompact": "Compacto",
    "settings.radiusRounded": "Arredondado",
    "settings.radiusPill": "Pílula",
    "settings.vignette": "Vinheta de borda",
    "settings.appearanceHint": "Personalize a aparência de cada tema claro/escuro. Mudanças de acento se aplicam imediatamente; densidade, raio e vinheta estão incluídos nos backups do espaço de trabalho.",
    "settings.resetThemeColor": "Redefinir",
    "settings.generalTab": "Geral",
    "settings.promptsTab": "Prompts de IA",
    "settings.assistantPrompt": "Prompt do sistema do assistente",
    "settings.fullCardPrompt": "Prompt do sistema do card completo",
    "settings.wizardPrompt": "Instruções de geração do assistente de criação",
    "settings.promptPlaceholder": "Deixe vazio para usar o prompt integrado",
    "settings.chatSystemPrompts": "Instruções do chat e do sistema",
    "settings.fullCardInstr": "Instruções de saída do card completo (sistema)",
    "settings.fieldsEdit": "Instruções de edição de campo (sistema)",
    "settings.greetingsSystem": "Instruções de saída de saudações (sistema)",
    "settings.exportPrompts": "Exportar prompts",
    "settings.importPrompts": "Importar prompts",
    "settings.promptsExported": "Prompts exportados",
    "settings.promptsImported": "{count} prompts importados",
    "settings.quickActionPrompts": "Prompts de ações rápidas",
    "settings.tagsSystemPrompt": "Instruções de saída de tags (sistema)",
    "settings.restoreDefaultPrompts": "Restaurar prompts padrão",
    "settings.promptHint": "Estes campos mostram os prompts atuais. Se um campo estiver vazio, o prompt integrado padrão é usado. Restaure os padrões para visualizá-los ou recuperá-los.",
    "settings.title": "Configurações",
    "settings.provider": "Provedor",
    "settings.providerHint": "Provedores de modelos hospedados ou endpoint personalizado (LM Studio, Ollama, etc.)",
    "settings.apiKey": "Chave de API",
    "settings.getApiKey": "Obtenha sua chave de API no OpenRouter",
    "settings.baseUrl": "URL base da API",
    "settings.namedApiKeyPlaceholder": "Digite sua chave de API",
    "settings.customHint": "O endpoint compatível com OpenAI. Exemplos: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "Chave de API (opcional)",
    "settings.apiKeyLocalPlaceholder": "Deixe vazio para provedores locais",
    "settings.apiKeyLocalHint": "Não é necessária para servidores locais como LM Studio ou Ollama.",
    "settings.modelId": "ID do modelo",
    "settings.modelIdHint": "O ID exato do modelo que seu provedor espera.",
    "settings.modelIdHintNamed": "Deixe vazio para usar o modelo padrão do provedor.",
    "settings.security": "Sua chave de API é criptografada no localStorage do seu navegador com uma chave vinculada a este endereço. Não use este aplicativo em dispositivos compartilhados.",
    "settings.secretUnreadable": "Por segurança, uma chave de API salva não pôde ser desbloqueada neste endereço — insira-a novamente nas Configurações.",
    "error.pngInflateFailed": "Este PNG contém dados de personagem que não puderam ser descompactados.",
    "settings.defaultModel": "Modelo padrão",
    "settings.browseModels": "Navegue pelos modelos abaixo...",
    "settings.refreshModels": "Atualizar modelos",
    "settings.maxTokens": "Tokens máximos de saída",
    "settings.maxTokensPlaceholder": "0 = usar padrão do modelo",
    "settings.maxTokensHint": "Sobrescreva o máximo de tokens de saída por requisição. Defina como 0 para usar automaticamente o limite do modelo selecionado (ou 64k se desconhecido).",
    "settings.copyright": "Inserir crédito do editor ao exportar",
    "settings.copyrightHint": "Adiciona uma linha de crédito nas notas do criador ao exportar cartas.",
    "settings.availableModels": "Modelos disponíveis",
    "settings.searchModels": "Buscar modelos...",
    "settings.enterApiKey": "Digite sua chave de API e atualize para carregar os modelos",
    "settings.credits": "Créditos e uso",
    "settings.creditLimit": "Limite de crédito",
    "settings.remaining": "Restante",
    "settings.usedMonth": "Usado este mês",
    "settings.localStorage": "Armazenamento local",
    "settings.clearAll": "Limpar todos os dados",
    "settings.export": "Exportar",
    "settings.import": "Importar",
    "settings.close": "Fechar",
    "settings.saveSettings": "Salvar configurações",
    "settings.languageLabel": "Idioma",
    "settings.languageHint": "Idioma da interface (recarregue a página se faltar)",
    "settings.languageChanged": "Idioma atualizado",
    "settings.clearConfirm": "Excluir TODAS as cartas, configurações e histórico de chat? Esta ação não pode ser desfeita.",
    "settings.providerCustom": "Personalizado (compatível com OpenAI)",
    "settings.noModels": "Nenhum modelo encontrado",
    "settings.loadMore": "Carregar mais ({{count}} restantes)",
    "settings.showingModels": "Mostrando {{shown}} de {{total}} modelos",
    "wizard.title": "Criar personagem",
    "wizard.step.basics": "Básicos",
    "wizard.step.concept": "Conceito",
    "wizard.step.personality": "Personalidade",
    "wizard.step.scenario": "Cenário",
    "wizard.step.generate": "Gerar",
    "wizard.basicsTitle": "Básicos do personagem",
    "wizard.nameLabel": "Nome do personagem",
    "wizard.namePlaceholder": "ex. Elara Nightwhisper",
    "wizard.genderLabel": "Gênero / Pronomes",
    "wizard.genderSelect": "Selecionar...",
    "wizard.gender.female": "Feminino (ela/dela)",
    "wizard.gender.male": "Masculino (ele/dele)",
    "wizard.gender.nonbinary": "Não binário (elu/delu)",
    "wizard.gender.other": "Outro...",
    "wizard.genderCustom": "Pronomes personalizados (ex. elu/delu)",
    "wizard.tagsLabel": "Tags",
    "wizard.tagsSub": "(separadas por vírgulas, ajuda a organizar sua biblioteca)",
    "wizard.tagsPlaceholder": "fantasia, guerreiro, elfo, original",
    "wizard.creatorLabel": "Criador",
    "wizard.creatorPlaceholder": "Seu nome / apelido",
    "wizard.conceptTitle": "Conceito e ambientação",
    "wizard.typeLabel": "Tipo de personagem",
    "wizard.type.original": "Personagem original",
    "wizard.type.fanfic": "Fanfiction",
    "wizard.type.game": "Personagem de jogo",
    "wizard.type.anime": "Anime / Mangá",
    "wizard.type.book": "Livro / Filme / Série",
    "wizard.type.historical": "Figura histórica",
    "wizard.type.mythological": "Mitológico / Folclore",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Outro",
    "wizard.languageLabel": "Idioma",
    "wizard.language.other": "Outro",
    "wizard.languageSpecify": "Especificar idioma",
    "wizard.genreLabel": "Gênero / Mundo",
    "wizard.genreSub": "(selecione todos que se aplicam)",
    "wizard.moodLabel": "Ambiente / Tom",
    "wizard.moodSub": "(selecione todos que se aplicam)",
    "wizard.personalityTitle": "Personalidade e aparência",
    "wizard.personalityTraits": "Traços de personalidade",
    "wizard.personalityTraitsSub": "(descreva 3-5 traços principais, isso ajuda a IA)",
    "wizard.personalityTraitsPlaceholder": "ex. Corajoso mas imprudente, leal aos amigos, senso de humor seco, dificuldade em confiar, secretamente ama animais",
    "wizard.appearanceLabel": "Aparência física",
    "wizard.appearanceSub": "(breve descrição de como eles parecem)",
    "wizard.appearancePlaceholder": "ex. Mulher alta com cabelos prateados até a cintura, mãos cicatrizadas, usa jaqueta de couro escura, olhos verdes penetrantes",
    "wizard.abilitiesLabel": "Habilidades especiais / Peculiaridades",
    "wizard.abilitiesSub": "(opcional, traços únicos)",
    "wizard.abilitiesPlaceholder": "ex. Pode falar com animais, tem memória fotográfica, sempre carrega um diário desgastado",
    "wizard.scenarioTitle": "Cenário e primeira mensagem",
    "wizard.scenarioLabel": "Cenário / Ambientação",
    "wizard.scenarioSub": "(onde a história começa?)",
    "wizard.scenarioPlaceholder": "ex. Uma noite chuvosa em uma cidade iluminada por neons. O personagem tem uma pequena loja de conserto que conserta máquinas e corações partidos.",
    "wizard.relationshipLabel": "Relação com {{user}}",
    "wizard.relationshipSub": "(como o personagem vê o usuário?)",
    "wizard.relationshipPlaceholder": "ex. Um novo cliente que entrou na loja com um dispositivo misterioso quebrado. O personagem é curioso, mas cauteloso.",
    "wizard.openingLabel": "Ambiente da primeira mensagem",
    "wizard.openingSub": "(como deve ser a sensação da mensagem de abertura?)",
    "wizard.notesLabel": "Notas adicionais",
    "wizard.notesSub": "(mais alguma coisa que a IA deveria saber?)",
    "wizard.notesPlaceholder": "ex. Mantenha o diálogo natural, evite ser excessivamente formal, inclua descrições de ações entre asteriscos",
    "wizard.generateTitle": "Gerar personagem",
    "wizard.refImage": "Imagem de referência",
    "wizard.refImageSub": "(opcional, do waifu.im)",
    "wizard.fetchImages": "Buscar 3 imagens",
    "wizard.refetchOthers": "Buscar outras",
    "wizard.fetching": "Buscando...",
    "wizard.useSelected": "Usar selecionada",
    "wizard.clear": "Limpar",
    "wizard.generateAI": "Gerar com IA",
    "wizard.generateAISub": "Carta completa do personagem com suas respostas",
    "wizard.createBlank": "Criar carta em branco",
    "wizard.createBlankSub": "Começar com nome e tags pré-preenchidos",
    "wizard.back": "Voltar",
    "wizard.next": "Próximo",
    "wizard.stepLabel": "Passo {{step}} de {{total}}",
    "wizard.ready": "Pronto para gerar!",
    "wizard.nameRequired": "Por favor, insira um nome de personagem",
    "wizard.summary.name": "Nome",
    "wizard.summary.gender": "Gênero",
    "wizard.summary.type": "Tipo",
    "wizard.summary.language": "Idioma",
    "wizard.summary.tags": "Tags",
    "wizard.summary.genres": "Gêneros",
    "wizard.summary.mood": "Ambiente",
    "wizard.summary.opening": "Abertura",
    "wizard.summary.personality": "Personalidade",
    "wizard.summary.appearance": "Aparência",
    "wizard.summary.scenario": "Cenário",
    "wizard.summary.relationship": "Relação",
    "wizard.summary.notes": "Notas",
    "wizard.chip.fantasy": "Fantasia",
    "wizard.chip.scifi": "Ficção científica",
    "wizard.chip.modern": "Moderno",
    "wizard.chip.historical": "Histórico",
    "wizard.chip.horror": "Terror",
    "wizard.chip.romance": "Romance",
    "wizard.chip.comedy": "Comédia",
    "wizard.chip.sliceOfLife": "Cotidiano",
    "wizard.chip.adventure": "Aventura",
    "wizard.chip.mystery": "Mistério",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Pós-apocalíptico",
    "wizard.chip.supernatural": "Sobrenatural",
    "wizard.chip.military": "Militar",
    "wizard.chip.surreal": "Surreal",
    "wizard.chip.serious": "Sério",
    "wizard.chip.playful": "Brincalhão",
    "wizard.chip.dark": "Sombrio",
    "wizard.chip.lighthearted": "Leve",
    "wizard.chip.mysterious": "Misterioso",
    "wizard.chip.romantic": "Romântico",
    "wizard.chip.intense": "Intenso",
    "wizard.chip.wholesome": "Acolhedor",
    "wizard.chip.chaotic": "Caótico",
    "wizard.chip.melancholic": "Melancólico",
    "wizard.chip.sarcastic": "Sarcástico",
    "wizard.chip.stoic": "Estóico",
    "wizard.chip.greeting": "Saudação calorosa",
    "wizard.chip.action": "In Media Res",
    "wizard.chip.question": "Pergunta curiosa",
    "wizard.chip.conflict": "Conflito imediato",
    "wizard.chip.atmospheric": "Atmosférico",
    "diff.title": "Prévia da resposta da IA",
    "diff.removed": "Removido",
    "diff.added": "Adicionado",
    "diff.current": "Atual",
    "diff.proposed": "Proposto",
    "diff.empty": "(vazio)",
    "diff.discard": "Descartar",
    "diff.apply": "Aplicar alterações",
    "shortcuts.title": "Atalhos",
    "shortcuts.save": "Salvar carta",
    "shortcuts.newCard": "Nova carta",
    "shortcuts.undo": "Desfazer",
    "shortcuts.redo": "Refazer",
    "shortcuts.sendAi": "Enviar mensagem de IA",
    "shortcuts.newLine": "Nova linha na IA",
    "shortcuts.focus": "Modo foco",
    "shortcuts.collapsePanel": "Recolher/expandir painel de IA",
    "toast.loadFailed": "Falha: {{name}}",
    "toast.loaded": "{{count}} carta(s) carregada(s)",
    "toast.importDupe": "Mesmo conteúdo de uma carta existente — importada como {{name}}",
    "toast.largeImage": "Imagem grande incorporada em {{name}} ({{size}} MB) - considere removê-la para economizar espaço.",
    "toast.noValid": "Nenhuma válida encontrada. Solte arquivos PNG ou JSON.",
    "toast.noSelected": "Nenhuma carta selecionada",
    "toast.cardsDeleted": "Cartas excluídas",
    "toast.deleteFailed": "Falha ao excluir a carta",
    "toast.exported": "{{count}} carta(s) exportada(s)",
    "toast.newBlank": "Nova carta em branco criada",
    "toast.noCardSave": "Nenhuma carta para salvar",
    "toast.cardSaved": "Carta salva!",
    "toast.noCardDup": "Nenhuma carta para duplicar",
    "toast.cardDup": "Carta duplicada",
    "toast.cardRestored": "Carta restaurada",
    "toast.selectCard": "Selecione uma carta primeiro",
    "toast.avatarUpdated": "Avatar atualizado",
    "toast.imgFailed": "Falha ao carregar imagem",
    "toast.firstMesUpdated": "Primeira mensagem atualizada!",
    "toast.settingsSaved": "Configurações salvas!",
    "toast.modelsFailed": "Falha ao carregar modelos: {{error}}",
    "toast.modelSet": "Modelo definido: {{model}}",
    "toast.dataCleared": "Todos os dados limpos",
    "toast.settingsExported": "Configurações exportadas",
    "toast.settingsImported": "Configurações importadas!",
    "toast.invalidFile": "Arquivo de configurações inválido",
    "toast.apiKey": "Defina sua chave de API nas Configurações",
    "toast.selectModel": "Por favor, selecione um modelo na barra de navegação ou nas configurações primeiro.",
    "toast.genStopped": "Geração interrompida.",
    "toast.aiError": "Erro de IA: {{error}}",
    "toast.cardUpdatedAI": "Carta atualizada com a resposta da IA!",
    "toast.jsonParseFailed": "Não foi possível analisar a resposta da IA como JSON. Verifique o chat.",
    "toast.emptyResponse": "A IA retornou conteúdo vazio — nada para aplicar.",
    "toast.jsonInvalid": "A IA não retornou JSON válido. A resposta está no chat — você pode copiá-la manualmente.",
    "toast.fieldUpdated": '"{{field}}" atualizado!',
    "toast.selectField": "Selecione pelo menos um campo para editar",
    "toast.tooManyFields": "Muitos campos selecionados. Máximo de {{max}} por vez.",
    "toast.greetingsUpdated": "{{count}} saudação(ões) gerada(s)!",
    "toast.tagsUpdated": "Tags atualizadas — {{count}} nova(s) adicionada(s)!",
    "toast.greetingsParseFailed": "Não foi possível analisar as saudações da resposta da IA.",
    "toast.createCardFirst": "Crie ou selecione uma carta primeiro",
    "toast.wizardCreated": "Carta criada! Comece a editar ou use a IA para preencher os detalhes.",
    "toast.wizardApi": "Defina sua chave de API nas Configurações primeiro",
    "toast.wizardModel": "Selecione um modelo ou defina um ID de modelo personalizado nas Configurações",
    "toast.wizardFetchFailed": "Falha ao buscar imagens: {{error}}",
    "toast.wizardName": "Por favor, insira um nome de personagem",
    "toast.storageFull": "Armazenamento cheio! Tente remover ou exportar algumas cartas.",
    "toast.exportedJson": "Exportado como JSON!",
    "toast.exportedPng": "Exportado como PNG com dados da carta!",
    "toast.exportFailed": "Falha na exportação de imagem. Retornando para JSON.",
    "toast.chatCleared": "Chat limpo",
    "toast.undo": "Desfazer",
    "error.apiKeyNotSet": "Chave de API não definida. Insira sua chave de API nas Configurações.",
    "error.customUrlNotSet": "A URL base da API personalizada não está definida. Abra Configurações → Personalizado (compatível com OpenAI) e insira a URL do endpoint (ex.: http://localhost:1234/v1).",
    "error.customServerError": "O servidor retornou um erro: {{detail}}",
    "error.customAuthFailed": "Falha de autenticação (HTTP {{status}}). Verifique a chave de API deste endpoint.",
    "error.customPathNotFound": "Endpoint não encontrado (HTTP 404). Verifique se a URL base da API está completa (ex.: inclui /v1).",
    "error.customUnreachable": "Não foi possível acessar {{url}}. Verifique se o servidor está em execução e se a URL base da API está correta e acessível deste dispositivo.",
    "error.noModel": "Nenhum modelo selecionado. Por favor, escolha um modelo ou defina um ID de modelo nas Configurações.",
    "error.noModelSimple": "Nenhum modelo selecionado.",
    "error.insufficientCredits": "Créditos insuficientes. Por favor, recarregue sua conta.",
    "error.storageFull": "Armazenamento cheio! Tente remover ou exportar algumas cartas.",
    "gen.empty": "(vazio)",
    "gen.free": "Gratuito",
    "gen.unlimited": "Ilimitado",
    "gen.notAvailable": "N/D",
    "gen.unnamed": "Sem nome",
    "gen.byCreator": "por {{name}}",
    "gen.untagged": "Nenhuma tag encontrada",
    "gen.noMatch": "Nenhuma carta corresponde aos seus filtros",
    "batch.deleteConfirm": "Excluir {{count}} carta(s)? Esta ação não pode ser desfeita.",
    "left.selected": "{{count}} selecionada(s)",
    "toast.cardDeleted": 'Carta "{{name}}" excluída',
    "ai.editing": "Editando {{count}} campo(s)...",
    "ai.streaming": "transmitindo...",
    "ai.failed": "falhou",
    "ai.cancelled": "Cancelado.",
    "ai.doneSummary": "{{done}}/{{total}} concluído · {{errs}} falhou",
    "ai.viewFullResult": "Ver resultado completo",
    "ai.showLess": "Mostrar menos",
    "ai.reviewApply": "Revisar e aplicar",
    "ai.changesNav": "Alteração {{current}} de {{total}}",
    "ai.changesPrev": "Alteração anterior",
    "ai.changesNext": "Próxima alteração",
    "ai.applied": "Aplicado",
    "ai.target.tags": "Tags",
    "ai.copy": "Copiar",
    "ai.copied": "Copiado!",
    "ai.copyFailed": "Falhou",
    "ai.resultTitle": "Resultado",
    "ai.close": "Fechar",
    "editor.noGreetings": "Ainda sem saudações. Clique em <strong>Adicionar saudação</strong> ou use a IA para gerar algumas.",
    "editor.noEntriesMatch": 'Nenhuma entrada corresponde a "{{query}}"',
    "gen.copySuffix": " (Cópia)",
    "gen.toastAutoHide": "{{s}}s",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "Próximo do limite de tokens de saída ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Acima do limite de tokens de saída ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "Recolher painel",
    "ui.expandPanel": "Expandir painel",
    "ui.cardModified": "Alterações não salvas",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "Histórico do chat",
    "ai.historyTitle": "Histórico do chat",
    "ai.historyEmpty": "Nenhuma conversa ainda",
    "ai.retry": "Tentar novamente",
    "ai.retryTitle": "Regenerar esta resposta",
    "ai.reapply": "Reaplicar",
    "ai.reapplyTitle": "Reabrir o diff para aplicar essas alterações",
    "wizard.editStep": "Editar esta seção",
    "wizard.draftRestored": "Rascunho restaurado — suas respostas anteriores voltaram",
    "wizard.imagePlaceholder": "Clique em Buscar",
    "toast.noNameWarning": 'Aviso: a carta não tem nome. O arquivo será salvo como "character.json".',
    "toast.redo": "Refazer",
    "toast.reorderFiltered": "Desative a pesquisa e os filtros para reordenar as cartas.",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.ja = {
    "app.title": "ST Card Editor — SillyTavern キャラクターカードスタジオ",
    "nav.selectModel": "モデルを選択...",
    "nav.wizard": "AIウィザードで作成",
    "nav.newCard": "新しい空白カード",
    "nav.save": "保存",
    "nav.theme": "テーマ切替",
    "nav.shortcuts": "ショートカットとヘルプ",
    "nav.settings": "設定",
    "nav.focus": "フォーカスモード",
    "nav.focusAlt": "フォーカスモード（Alt+F）",
    "left.title": "カードライブラリ",
    "left.cards": "{{count}}枚のカード",
    "left.drop": "ドラッグ＆ドロップ",
    "left.sort.manual": "手动",
    "left.dropSub": "PNGまたはJSONのキャラクターカード",
    "left.browse": "ファイルを参照",
    "left.search": "カードを検索...",
    "left.sort.nameAsc": "名前 A-Z",
    "left.sort.nameDesc": "名前 Z-A",
    "left.sort.newest": "新しい順",
    "left.sort.oldest": "古い順",
    "left.sort.largest": "大きい順",
    "left.sort.smallest": "小さい順",
    "left.filterTags": "タグでフィルター",
    "left.exportSelected": "選択をJSONとしてエクスポート",
    "left.deleteSelected": "選択を削除",
    "left.empty": "カードが読み込まれていません",
    "left.emptySub": "カードをドロップするか「参照」をクリック",
    "center.noCard": "カードが選択されていません",
    "center.noCardSub": "ライブラリからカードを選択するか、新しいカードをドラッグ＆ドロップしてください",
    "center.createAI": "AIで作成",
    "center.blankCard": "空白カード",
    "editor.avatar": "クリックまたは画像をドロップしてアバターを設定",
    "editor.avatarAria": "キャラクターアバターを設定",
    "editor.name": "キャラクター名",
    "editor.exportJson": "JSONとしてエクスポート",
    "editor.exportPng": "PNGとしてエクスポート",
    "editor.duplicate": "カードを複製",
    "editor.delete": "カードを削除",
    "editor.tab.core": "コア",
    "editor.tab.personality": "性格",
    "editor.tab.advanced": "詳細",
    "editor.tab.lorebook": "ロアブック",
    "editor.tab.waifu": "Waifu画像",
    "editor.waifuPreview": "現在のカード画像",
    "editor.waifuNoImage": "まだ画像が設定されていません",
    "editor.waifuSource": "画像ソース",
    "editor.waifuSourceSnap": "アニメの一瞬 (waifu.im)",
    "editor.waifuSourceChar": "アニメキャラ (AniList)",
    "editor.waifuGender": "性別",
    "editor.waifuGenderAll": "すべて",
    "editor.waifuGenderFemaleOnly": "女性のみ",
    "editor.waifuGenderMaleOnly": "男性のみ",
    "editor.waifuGenderFemale": "女性",
    "editor.waifuGenderMale": "男性",
    "editor.waifuCharSub": "キャラ名で検索（例：zoro）",
    "editor.waifuSearch": "waifu.imを検索",
    "editor.waifuSearchChar": "キャラクターを検索",
    "editor.waifuSearchPlaceholderChar": "キャラ名で検索（例：zoro）",
    "editor.waifuSub": "(タグでアニメ風の画像を取得)",
    "editor.waifuSearchPlaceholder": "例：waifu、エルフ、メイド...",
    "editor.waifuFetch": "画像を取得",
    "editor.waifuRegenTitle": "結果を再生成",
    "editor.waifuMixed": "女性 + 男性",
    "editor.waifuMixedSub": "ワンクリックで男女3人ずつのバランスセット",
    "editor.waifuUse": "カード画像として使用",
    "editor.waifuUpload": "デバイスからアップロード",
    "editor.waifuRemove": "画像を削除",
    "toast.noImage": "このカードには削除する画像がありません",
    "toast.imageRemoved": "画像を削除しました",
    "editor.desc": "説明",
    "editor.descSub": "（外見、背景）",
    "editor.descPlaceholder": "キャラクターの外見、背景、主要な特徴を記述してください...",
    "editor.firstMes": "最初のメッセージ",
    "editor.firstMesPlaceholder": "チャット開始時のキャラクターの最初のメッセージ...",
    "editor.scenario": "シナリオ",
    "editor.scenarioPlaceholder": "会話の現在の状況とコンテキスト...",
    "editor.creator": "作成者",
    "editor.creatorPlaceholder": "カード作成者 / 作者",
    "editor.version": "キャラクターバージョン",
    "editor.tags": "タグ",
    "editor.tagsSub": "（カンマ区切り）",
    "editor.tagsPlaceholder": "ファンタジー、戦士、エルフ",
    "editor.personalitySummary": "性格要約",
    "editor.personalityPlaceholder": "キャラクターの性格の簡単な説明...（カード形式で使用）",
    "editor.mesExample": "メッセージ例",
    "editor.mesExampleFormat": "フォーマット: <START>ブロック（{{char}}: と {{user}}: プレフィックス）",
    "editor.systemPrompt": "システムプロンプト",
    "editor.systemPromptPlaceholder": "システムプロンプトを上書きします。デフォルトを含めるには{{original}}を使用してください。",
    "editor.postHistory": "ポストヒストリー指示",
    "editor.postHistoryPlaceholder": "チャット履歴の後に注入される指示。デフォルトには{{original}}を使用してください。",
    "editor.creatorNotes": "作成者ノート",
    "editor.creatorNotesPlaceholder": "カードユーザー向けのノート（モデルの推奨、使用のヒント...）",
    "editor.greetings": "代替挨拶",
    "editor.addGreeting": "挨拶を追加",
    "editor.lorebookTitle": "キャラクターのロアブックエントリ",
    "editor.addEntry": "エントリを追加",
    "editor.lorebookSearch": "キー、内容、コメントでエントリを検索...",
    "editor.lorebookEmpty": "ロアブックエントリがまだありません。追加して始めましょう。",
    "editor.edit": "編集",
    "editor.preview": "プレビュー",
    "ai.title": "AIアシスタント",
    "ai.clearChat": "チャットをクリア",
    "ai.welcomeTitle": "AIカードアシスタント",
    "ai.welcomeText": "AIにキャラクターカードの編集、翻訳、改善を依頼できます。",
    "ai.quick.newCard": "新しいカード",
    "ai.quick.translate": "翻訳",
    "ai.quick.enhance": "改善",
    "ai.quick.shorten": "短縮",
    "ai.quick.tone": "トーン変更",
    "ai.quick.grammar": "文法修正",
    "ai.quick.personality": "性格拡充",
    "ai.quick.firstmes": "最初のメッセージ改善",
    "ai.quick.scenario": "シナリオを展開",
    "ai.quick.greetings": "挨拶を生成",
    "ai.quick.systemprompt": "システムプロンプトを強化",
    "ai.quick.tags": "タグを提案",
    "ai.contextTitle": "推定使用トークン数 vs モデルのコンテキスト制限",
    "ai.contextLabel": "— / — トークン",
    "ai.placeholder": "AIにカードの編集を依頼...",
    "ai.send": "送信",
    "ai.stop": "生成を停止",
    "ai.autoModel": "自動（ナビのモデルを使用）",
    "ai.target": "対象:",
    "ai.target.full": "完全なカード",
    "ai.target.description": "説明",
    "ai.target.personality": "性格",
    "ai.target.first_mes": "最初のメッセージ",
    "ai.target.scenario": "シナリオ",
    "ai.target.mes_example": "メッセージ例",
    "ai.target.system_prompt": "システムプロンプト",
    "ai.target.post_history_instructions": "ポストヒストリー指示",
    "ai.target.creator_notes": "作成者ノート",
    "ai.target.alternate_greetings": "代替挨拶",
    "ai.selectModel": "モデルを選択",
    "ai.actionNewCard": "新しいカード",
    "ai.actionTranslate": "翻訳",
    "ai.actionEnhance": "強化",
    "ai.actionShorten": "簡縮",
    "ai.actionTone": "トーン変更",
    "ai.actionGrammar": "文法修正",
    "ai.actionPersonality": "性格を展開",
    "ai.actionFirstMes": "最初のメッセージを改善",
    "ai.actionScenario": "シナリオを展開",
    "ai.actionGreetings": "挨拶を生成",
    "ai.actionSystemprompt": "システムプロンプトを強化",
    "ai.actionTags": "タグを提案",
    "ai.noCard": "（カードが選択されていません）",
    "settings.themeColor": "テーマカラー",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "ライト/ダークテーマごとにアクセントカラーを設定できます。変更はすぐに反映されます。",
    "settings.appearance": "外観",
    "settings.accentPresets": "アクセントプリセット",
    "settings.glassDensity": "ガラスの濃さ",
    "settings.glassSubtle": "控えめ",
    "settings.glassDefault": "デフォルト",
    "settings.glassBold": "大胆",
    "settings.cardRadius": "カードの角丸",
    "settings.radiusCompact": "コンパクト",
    "settings.radiusRounded": "ラウンド",
    "settings.radiusPill": "ピル",
    "settings.vignette": "エッジビネット",
    "settings.appearanceHint": "各ライト/ダークテーマの外観をカスタマイズします。アクセント変更はすぐに反映されます。密度・角丸・ビネットはワークスペースのバックアップに含まれます。",
    "settings.resetThemeColor": "リセット",
    "settings.generalTab": "一般",
    "settings.promptsTab": "AIプロンプト",
    "settings.assistantPrompt": "アシスタントのシステムプロンプト",
    "settings.fullCardPrompt": "カード全体のシステムプロンプト",
    "settings.wizardPrompt": "キャラクター生成の指示",
    "settings.promptPlaceholder": "空欄の場合は内蔵プロンプトを使用します",
    "settings.chatSystemPrompts": "チャット・システム指示",
    "settings.fullCardInstr": "カード全体の出力指示（システム）",
    "settings.fieldsEdit": "フィールド編集の指示（システム）",
    "settings.greetingsSystem": "挨拶の出力指示（システム）",
    "settings.exportPrompts": "プロンプトをエクスポート",
    "settings.importPrompts": "プロンプトをインポート",
    "settings.promptsExported": "プロンプトをエクスポートしました",
    "settings.promptsImported": "{count} 個のプロンプトをインポートしました",
    "settings.quickActionPrompts": "クイックアクション・プロンプト",
    "settings.tagsSystemPrompt": "タグ出力の指示（システム）",
    "settings.restoreDefaultPrompts": "デフォルトのプロンプトを復元",
    "settings.promptHint": "これらのフィールドには現在のプロンプトが表示されます。空欄の場合は内蔵のデフォルトプロンプトが使用されます。「デフォルトに戻す」で表示・復元できます。",
    "settings.title": "設定",
    "settings.provider": "プロバイダー",
    "settings.providerHint": "ホスティングモデルプロバイダーまたはカスタムエンドポイント（LM Studio、Ollamaなど）",
    "settings.apiKey": "APIキー",
    "settings.getApiKey": "OpenRouterからAPIキーを取得",
    "settings.baseUrl": "APIベースURL",
    "settings.namedApiKeyPlaceholder": "APIキーを入力",
    "settings.customHint": "OpenAI互換エンドポイント。例: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "APIキー（オプション）",
    "settings.apiKeyLocalPlaceholder": "ローカルプロバイダーの場合は空欄",
    "settings.apiKeyLocalHint": "LM StudioやOllamaなどのローカルサーバーには不要です。",
    "settings.modelId": "モデルID",
    "settings.modelIdHint": "プロバイダーが期待する正確なモデルID。",
    "settings.modelIdHintNamed": "プロバイダーのデフォルトモデルを使用する場合は空欄。",
    "settings.security": "APIキーはブラウザのlocalStorageにこのアドレスに紐づく鍵で暗号化して保存されます。共有デバイスではこのアプリを使用しないでください。",
    "settings.secretUnreadable": "セキュリティ上の理由により、このアドレスで保存済みのAPIキーをロック解除できませんでした。設定で再入力してください。",
    "error.pngInflateFailed": "このPNGには解凍できなかったキャラクターデータが含まれています。",
    "settings.defaultModel": "デフォルトモデル",
    "settings.browseModels": "下のモデルを参照...",
    "settings.refreshModels": "モデルを更新",
    "settings.maxTokens": "最大出力トークン",
    "settings.maxTokensPlaceholder": "0 = モデルのデフォルトを使用",
    "settings.maxTokensHint": "リクエストごとの最大出力トークンを上書き。0に設定すると、選択したモデルの制限（不明な場合は64k）が自動使用されます。",
    "settings.copyright": "エクスポート時にエディタークレジットを挿入",
    "settings.copyrightHint": "カードエクスポート時に作成者ノートにクレジット行を追加します。",
    "settings.availableModels": "利用可能なモデル",
    "settings.searchModels": "モデルを検索...",
    "settings.enterApiKey": "APIキーを入力して更新し、モデルを読み込んでください",
    "settings.credits": "クレジットと使用量",
    "settings.creditLimit": "クレジット制限",
    "settings.remaining": "残り",
    "settings.usedMonth": "今月の使用量",
    "settings.localStorage": "ローカルストレージ",
    "settings.clearAll": "全データを消去",
    "settings.export": "エクスポート",
    "settings.import": "インポート",
    "settings.close": "閉じる",
    "settings.saveSettings": "設定を保存",
    "settings.languageLabel": "言語",
    "settings.languageHint": "インターフェースの言語（不足している場合はページを再読み込みしてください）",
    "settings.languageChanged": "言語が更新されました",
    "settings.clearConfirm": "すべてのカード、設定、チャット履歴を削除しますか？この操作は取り消せません。",
    "settings.providerCustom": "カスタム（OpenAI互換）",
    "settings.noModels": "モデルが見つかりません",
    "settings.loadMore": "さらに読み込み（{{count}}件残り）",
    "settings.showingModels": "{{total}}件中{{shown}}件を表示",
    "wizard.title": "キャラクター作成",
    "wizard.step.basics": "基本情報",
    "wizard.step.concept": "コンセプト",
    "wizard.step.personality": "性格",
    "wizard.step.scenario": "シナリオ",
    "wizard.step.generate": "生成",
    "wizard.basicsTitle": "キャラクター基本情報",
    "wizard.nameLabel": "キャラクター名",
    "wizard.namePlaceholder": "例: エララ・ナイトウィスパー",
    "wizard.genderLabel": "性別 / 代名詞",
    "wizard.genderSelect": "選択...",
    "wizard.gender.female": "女性（彼女）",
    "wizard.gender.male": "男性（彼）",
    "wizard.gender.nonbinary": "ノンバイナリー（彼ら）",
    "wizard.gender.other": "その他...",
    "wizard.genderCustom": "カスタム代名詞（例: それ）",
    "wizard.tagsLabel": "タグ",
    "wizard.tagsSub": "（カンマ区切り、ライブラリの整理に役立ちます）",
    "wizard.tagsPlaceholder": "ファンタジー、戦士、エルフ、オリジナル",
    "wizard.creatorLabel": "作成者",
    "wizard.creatorPlaceholder": "あなたの名前 / ニックネーム",
    "wizard.conceptTitle": "コンセプトと設定",
    "wizard.typeLabel": "キャラクタータイプ",
    "wizard.type.original": "オリジナルキャラクター",
    "wizard.type.fanfic": "ファンフィクション",
    "wizard.type.game": "ゲームキャラクター",
    "wizard.type.anime": "アニメ / 漫画",
    "wizard.type.book": "本 / 映画 / 番組",
    "wizard.type.historical": "歴史的人物",
    "wizard.type.mythological": "神話 / 民間伝承",
    "wizard.type.vtuber": "VTuber / ストリーマー",
    "wizard.type.other": "その他",
    "wizard.languageLabel": "言語",
    "wizard.language.other": "その他",
    "wizard.languageSpecify": "言語を指定",
    "wizard.genreLabel": "ジャンル / 世界観",
    "wizard.genreSub": "（該当するものをすべて選択）",
    "wizard.moodLabel": "雰囲気 / トーン",
    "wizard.moodSub": "（該当するものをすべて選択）",
    "wizard.personalityTitle": "性格と外見",
    "wizard.personalityTraits": "性格の特徴",
    "wizard.personalityTraitsSub": "（3〜5つの主要な特徴を記述、AIの助けになります）",
    "wizard.personalityTraitsPlaceholder": "例: 勇敢だが無謀、友人に非常に忠実、乾いたユーモアのセンス、信頼に苦労する、動物を密かに愛している",
    "wizard.appearanceLabel": "外見",
    "wizard.appearanceSub": "（見た目の簡単な説明）",
    "wizard.appearancePlaceholder": "例: 腰まで届く銀髪の女性、傷だらけの手、黒い革のジャケット、鋭い緑の瞳",
    "wizard.abilitiesLabel": "特殊能力 / 個性",
    "wizard.abilitiesSub": "（オプション、ユニークな特徴）",
    "wizard.abilitiesPlaceholder": "例: 動物と話せる、瞬時記憶力、常に使い古した日記を持っている",
    "wizard.scenarioTitle": "シナリオと最初のメッセージ",
    "wizard.scenarioLabel": "シナリオ / 設定",
    "wizard.scenarioSub": "（物語はどこから始まりますか？）",
    "wizard.scenarioPlaceholder": "例: ネオンに照らされた街の雨の夜。キャラクターは機械と壊れた心の両方を修理する小さな修理工房を営んでいる。",
    "wizard.relationshipLabel": "{{user}}との関係",
    "wizard.relationshipSub": "（キャラクターはユーザーをどう見ていますか？）",
    "wizard.relationshipPlaceholder": "例: 謎の壊れた機器を持って工房に入ってきた新しい客。キャラクターは好奇心旺盛だが慎重。",
    "wizard.openingLabel": "最初のメッセージの雰囲気",
    "wizard.openingSub": "（オープニングメッセージはどのような雰囲気べきですか？）",
    "wizard.notesLabel": "追加ノート",
    "wizard.notesSub": "（他にAIが知るべきことはありますか？）",
    "wizard.notesPlaceholder": "例: 会話を自然に、あまり堅すぎない、アクションの説明はアスタリスクで囲む",
    "wizard.generateTitle": "キャラクターを生成",
    "wizard.refImage": "参考画像",
    "wizard.refImageSub": "（オプション、waifu.imから）",
    "wizard.fetchImages": "3枚の画像を取得",
    "wizard.refetchOthers": "他の画像を再取得",
    "wizard.fetching": "取得中...",
    "wizard.useSelected": "選択を使用",
    "wizard.clear": "クリア",
    "wizard.generateAI": "AIで生成",
    "wizard.generateAISub": "回答から完全なキャラクターカードを作成",
    "wizard.createBlank": "空白カードを作成",
    "wizard.createBlankSub": "名前とタグを事前入力して開始",
    "wizard.back": "戻る",
    "wizard.next": "次へ",
    "wizard.stepLabel": "ステップ {{step}} / {{total}}",
    "wizard.ready": "生成の準備ができました！",
    "wizard.nameRequired": "キャラクター名を入力してください",
    "wizard.summary.name": "名前",
    "wizard.summary.gender": "性別",
    "wizard.summary.type": "タイプ",
    "wizard.summary.language": "言語",
    "wizard.summary.tags": "タグ",
    "wizard.summary.genres": "ジャンル",
    "wizard.summary.mood": "雰囲気",
    "wizard.summary.opening": "オープニング",
    "wizard.summary.personality": "性格",
    "wizard.summary.appearance": "外見",
    "wizard.summary.scenario": "シナリオ",
    "wizard.summary.relationship": "関係",
    "wizard.summary.notes": "ノート",
    "wizard.chip.fantasy": "ファンタジー",
    "wizard.chip.scifi": "SF",
    "wizard.chip.modern": "現代",
    "wizard.chip.historical": "歴史",
    "wizard.chip.horror": "ホラー",
    "wizard.chip.romance": "ロマンス",
    "wizard.chip.comedy": "コメディ",
    "wizard.chip.sliceOfLife": "日常",
    "wizard.chip.adventure": "アドベンチャー",
    "wizard.chip.mystery": "ミステリー",
    "wizard.chip.cyberpunk": "サイバーパンク",
    "wizard.chip.postApocalyptic": "ポストアポカリプス",
    "wizard.chip.supernatural": "超自然",
    "wizard.chip.military": "軍事",
    "wizard.chip.surreal": "シュール",
    "wizard.chip.serious": "シリアス",
    "wizard.chip.playful": "遊び心",
    "wizard.chip.dark": "ダーク",
    "wizard.chip.lighthearted": "軽快",
    "wizard.chip.mysterious": "ミステリアス",
    "wizard.chip.romantic": "ロマンチック",
    "wizard.chip.intense": "激しい",
    "wizard.chip.wholesome": "健全",
    "wizard.chip.chaotic": "カオス",
    "wizard.chip.melancholic": "メランコリック",
    "wizard.chip.sarcastic": "皮肉屋",
    "wizard.chip.stoic": "ストイック",
    "wizard.chip.greeting": "温かい挨拶",
    "wizard.chip.action": "途中から始める",
    "wizard.chip.question": "好奇心のある質問",
    "wizard.chip.conflict": "即座の冲突",
    "wizard.chip.atmospheric": "雰囲気重視",
    "diff.title": "AI応答プレビュー",
    "diff.removed": "削除",
    "diff.added": "追加",
    "diff.current": "現在",
    "diff.proposed": "提案",
    "diff.empty": "（空）",
    "diff.discard": "破棄",
    "diff.apply": "変更を適用",
    "shortcuts.title": "ショートカット",
    "shortcuts.save": "カードを保存",
    "shortcuts.newCard": "新しいカード",
    "shortcuts.undo": "元に戻す",
    "shortcuts.redo": "やり直し",
    "shortcuts.sendAi": "AIメッセージを送信",
    "shortcuts.newLine": "AIで改行",
    "shortcuts.focus": "フォーカスモード",
    "shortcuts.collapsePanel": "AIパネルを折りたたむ／展開",
    "toast.loadFailed": "失敗: {{name}}",
    "toast.loaded": "{{count}}枚のカードを読み込みました",
    "toast.importDupe": "既存のカードと同じ内容 — {{name}} としてインポートしました",
    "toast.largeImage": "{{name}} に大きな画像が埋め込まれています（{{size}} MB）- 容量を節約するため削除をご検討ください。",
    "toast.noValid": "有効なカードが見つかりません。PNGまたはJSONファイルをドロップしてください。",
    "toast.noSelected": "カードが選択されていません",
    "toast.cardsDeleted": "カードが削除されました",
    "toast.deleteFailed": "カードの削除に失敗しました",
    "toast.exported": "{{count}}枚のカードをエクスポートしました",
    "toast.newBlank": "新しい空白カードが作成されました",
    "toast.noCardSave": "保存するカードがありません",
    "toast.cardSaved": "カードが保存されました！",
    "toast.noCardDup": "複製するカードがありません",
    "toast.cardDup": "カードが複製されました",
    "toast.cardRestored": "カードが復元されました",
    "toast.selectCard": "まずカードを選択してください",
    "toast.avatarUpdated": "アバターが更新されました",
    "toast.imgFailed": "画像の読み込みに失敗しました",
    "toast.firstMesUpdated": "最初のメッセージが更新されました！",
    "toast.settingsSaved": "設定が保存されました！",
    "toast.modelsFailed": "モデルの読み込みに失敗しました: {{error}}",
    "toast.modelSet": "モデルが設定されました: {{model}}",
    "toast.dataCleared": "すべてのデータが消去されました",
    "toast.settingsExported": "設定がエクスポートされました",
    "toast.settingsImported": "設定がインポートされました！",
    "toast.invalidFile": "無効な設定ファイル",
    "toast.apiKey": "設定でAPIキーを設定してください",
    "toast.selectModel": "まずナビバーまたは設定からモデルを選択してください。",
    "toast.genStopped": "生成が停止されました。",
    "toast.aiError": "AIエラー: {{error}}",
    "toast.cardUpdatedAI": "AI応答でカードが更新されました！",
    "toast.jsonParseFailed": "AI応答をJSONとして解析できませんでした。チャットを確認してください。",
    "toast.emptyResponse": "AIが空の内容を返しました。適用できるものがありません。",
    "toast.jsonInvalid": "AIが有効なJSONを返しませんでした。応答はチャットにあります — 手動でコピーできます。",
    "toast.fieldUpdated": '"{{field}}"が更新されました！',
    "toast.selectField": "編集するフィールドを少なくとも1つ選択してください",
    "toast.tooManyFields": "フィールドが多すぎます。一度に{{max}}個までです。",
    "toast.greetingsUpdated": "{{count}}件の挨拶を生成しました！",
    "toast.tagsUpdated": "タグを更新しました — {{count}}件追加！",
    "toast.greetingsParseFailed": "AIの応答から挨拶を解析できませんでした。",
    "toast.createCardFirst": "まずカードを作成または選択してください",
    "toast.wizardCreated": "カードが作成されました！編集を始めるか、AIで詳細を入力してください。",
    "toast.wizardApi": "まず設定でAPIキーを設定してください",
    "toast.wizardModel": "設定でモデルを選択するか、カスタムモデルIDを設定してください",
    "toast.wizardFetchFailed": "画像の取得に失敗しました: {{error}}",
    "toast.wizardName": "キャラクター名を入力してください",
    "toast.storageFull": "ストレージが満了しました！カードを削除またはエクスポートしてください。",
    "toast.exportedJson": "JSONとしてエクスポートしました！",
    "toast.exportedPng": "カードデータ付きPNGとしてエクスポートしました！",
    "toast.exportFailed": "画像エクスポートに失敗しました。JSONにフォールバックします。",
    "toast.chatCleared": "チャットがクリアされました",
    "toast.undo": "元に戻す",
    "error.apiKeyNotSet": "APIキーが設定されていません。設定でAPIキーを入力してください。",
    "error.customUrlNotSet": "カスタムAPIのベースURLが設定されていません。設定→カスタム（OpenAI互換）を開き、エンドポイントURL（例：http://localhost:1234/v1）を入力してください。",
    "error.customServerError": "サーバーがエラーを返しました：{{detail}}",
    "error.customAuthFailed": "認証に失敗しました（HTTP {{status}}）。このエンドポイントのAPIキーを確認してください。",
    "error.customPathNotFound": "エンドポイントが見つかりません（HTTP 404）。APIのベースURLが完全か（例：/v1を含む）確認してください。",
    "error.customUnreachable": "{{url}} に接続できません。サーバーが起動しているか、APIのベースURLが正しくこのデバイスからアクセス可能かを確認してください。",
    "error.noModel": "モデルが選択されていません。モデルを選択するか、設定でモデルIDを設定してください。",
    "error.noModelSimple": "モデルが選択されていません。",
    "error.insufficientCredits": "クレジットが不足しています。アカウントをチャージしてください。",
    "error.storageFull": "ストレージが満了しました！カードを削除またはエクスポートしてください。",
    "gen.empty": "（空）",
    "gen.free": "無料",
    "gen.unlimited": "無制限",
    "gen.notAvailable": "N/A",
    "gen.unnamed": "無名",
    "gen.byCreator": "{{name}}作",
    "gen.untagged": "タグが見つかりません",
    "gen.noMatch": "フィルターに一致するカードがありません",
    "batch.deleteConfirm": "{{count}}枚のカードを削除しますか？この操作は取り消せません。",
    "left.selected": "{{count}}件選択中",
    "toast.cardDeleted": "カード「{{name}}」を削除しました",
    "ai.editing": "{{count}}のフィールドを編集中...",
    "ai.streaming": "ストリーミング...",
    "ai.failed": "失敗",
    "ai.cancelled": "キャンセルされました。",
    "ai.doneSummary": "{{done}}/{{total}} 完了 · {{errs}} 失敗",
    "ai.viewFullResult": "結果を全部表示",
    "ai.showLess": "簡略表示",
    "ai.reviewApply": "確認して適用",
    "ai.changesNav": "変更 {{current}} / {{total}}",
    "ai.changesPrev": "前の変更",
    "ai.changesNext": "次の変更",
    "ai.applied": "適用済み",
    "ai.target.tags": "タグ",
    "ai.copy": "コピー",
    "ai.copied": "コピーしました！",
    "ai.copyFailed": "失敗",
    "ai.resultTitle": "結果",
    "ai.close": "閉じる",
    "editor.noGreetings": "まだグリーティングがありません。<strong>グリーティングを追加</strong>するか、AIを使って生成してください。",
    "editor.noEntriesMatch": "「{{query}}」に一致するエントリはありません",
    "gen.copySuffix": " (コピー)",
    "gen.toastAutoHide": "{{s}}秒後に自動閉じる",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "出力トークン上限に近づいています（{tokens}/{max}）。",
    "editor.counterDanger": "出力トークン上限を超えています（{tokens}/{max}）。",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "パネルを折りたたむ",
    "ui.expandPanel": "パネルを展開",
    "ui.cardModified": "未保存の変更",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "チャット履歴",
    "ai.historyTitle": "チャット履歴",
    "ai.historyEmpty": "まだ会話がありません",
    "ai.retry": "再試行",
    "ai.retryTitle": "この応答を再生成",
    "ai.reapply": "再適用",
    "ai.reapplyTitle": "これらの変更を適用するには diff を再度開いてください",
    "wizard.editStep": "このセクションを編集",
    "wizard.draftRestored": "下書きが復元されました — 以前の回答が戻りました",
    "wizard.imagePlaceholder": "取得をクリック",
    "toast.noNameWarning": '警告: カードに名前がありません。ファイルは "character.json" として保存されます。',
    "toast.redo": "やり直す",
    "toast.reorderFiltered": "カードを並べ替えるには、検索とフィルターをオフにしてください。",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.zh = {
    "app.title": "ST Card Editor — SillyTavern 角色卡工作室",
    "nav.selectModel": "选择模型...",
    "nav.wizard": "使用AI向导创建",
    "nav.newCard": "新建空白卡片",
    "nav.save": "保存",
    "nav.theme": "切换主题",
    "nav.shortcuts": "快捷键与帮助",
    "nav.settings": "设置",
    "nav.focus": "专注模式",
    "nav.focusAlt": "专注模式（Alt+F）",
    "left.title": "卡片库",
    "left.cards": "{{count}}张卡片",
    "left.sort.manual": "手动",
    "left.drop": "拖放",
    "left.dropSub": "PNG或JSON角色卡片",
    "left.browse": "浏览文件",
    "left.search": "搜索卡片...",
    "left.sort.nameAsc": "名称 A-Z",
    "left.sort.nameDesc": "名称 Z-A",
    "left.sort.newest": "最新优先",
    "left.sort.oldest": "最旧优先",
    "left.sort.largest": "最大",
    "left.sort.smallest": "最小",
    "left.filterTags": "按标签筛选",
    "left.exportSelected": "导出选中为JSON",
    "left.deleteSelected": "删除选中",
    "left.empty": "未加载卡片",
    "left.emptySub": "拖入卡片或点击浏览",
    "center.noCard": "未选择卡片",
    "center.noCardSub": "从卡片库中选择一张卡片，或拖放一张新卡片",
    "center.createAI": "使用AI创建",
    "center.blankCard": "空白卡片",
    "editor.avatar": "点击或拖放图片以设置头像",
    "editor.avatarAria": "设置角色头像",
    "editor.name": "角色名称",
    "editor.exportJson": "导出为JSON",
    "editor.exportPng": "导出为PNG",
    "editor.duplicate": "复制卡片",
    "editor.delete": "删除卡片",
    "editor.tab.core": "核心",
    "editor.tab.personality": "性格",
    "editor.tab.advanced": "高级",
    "editor.tab.lorebook": "世界书",
    "editor.tab.waifu": "Waifu图片",
    "editor.waifuPreview": "当前卡片图片",
    "editor.waifuNoImage": "尚未设置图片",
    "editor.waifuSource": "图片来源",
    "editor.waifuSourceSnap": "动漫快照 (waifu.im)",
    "editor.waifuSourceChar": "动漫角色 (AniList)",
    "editor.waifuGender": "性别",
    "editor.waifuGenderAll": "全部",
    "editor.waifuGenderFemaleOnly": "仅女性",
    "editor.waifuGenderMaleOnly": "仅男性",
    "editor.waifuGenderFemale": "女",
    "editor.waifuGenderMale": "男",
    "editor.waifuCharSub": "按名称搜索角色（如 zoro）",
    "editor.waifuSearch": "在 waifu.im 搜索",
    "editor.waifuSearchChar": "搜索角色",
    "editor.waifuSearchPlaceholderChar": "按名称搜索角色（如 zoro）",
    "editor.waifuSub": "(按标签获取动漫风格图片)",
    "editor.waifuSearchPlaceholder": "例如：waifu、精灵、女仆...",
    "editor.waifuFetch": "获取图片",
    "editor.waifuRegenTitle": "重新生成结果",
    "editor.waifuMixed": "女性 + 男性",
    "editor.waifuMixedSub": "一键均衡包：3 个女角色 + 3 个男角色",
    "editor.waifuUse": "用作卡片图片",
    "editor.waifuUpload": "从设备上传",
    "editor.waifuRemove": "移除图片",
    "toast.noImage": "此卡片没有可移除的图片",
    "toast.imageRemoved": "图片已移除",
    "editor.desc": "描述",
    "editor.descSub": "（外貌、背景故事）",
    "editor.descPlaceholder": "描述角色的外貌、背景和主要特征...",
    "editor.firstMes": "首条消息",
    "editor.firstMesPlaceholder": "角色在开始聊天时发送的第一条消息...",
    "editor.scenario": "场景",
    "editor.scenarioPlaceholder": "对话的当前情况和背景...",
    "editor.creator": "创作者",
    "editor.creatorPlaceholder": "卡片创作者 / 作者",
    "editor.version": "角色版本",
    "editor.tags": "标签",
    "editor.tagsSub": "（逗号分隔）",
    "editor.tagsPlaceholder": "奇幻、战士、精灵",
    "editor.personalitySummary": "性格摘要",
    "editor.personalityPlaceholder": "角色性格的简要描述...（用于角色卡片格式）",
    "editor.mesExample": "消息示例",
    "editor.mesExampleFormat": "格式：使用<START>块，前缀为{{char}}: 和{{user}}:",
    "editor.systemPrompt": "系统提示词",
    "editor.systemPromptPlaceholder": "覆盖系统提示词。使用{{original}}包含默认值。",
    "editor.postHistory": "后历史指令",
    "editor.postHistoryPlaceholder": "在聊天历史之后注入的指令。使用{{original}}获取默认值。",
    "editor.creatorNotes": "创作者备注",
    "editor.creatorNotesPlaceholder": "给卡片用户的备注（模型推荐、使用技巧...）",
    "editor.greetings": "备用问候",
    "editor.addGreeting": "添加问候",
    "editor.lorebookTitle": "角色世界书条目",
    "editor.addEntry": "添加条目",
    "editor.lorebookSearch": "按关键词、内容或备注搜索条目...",
    "editor.lorebookEmpty": "暂无世界书条目。添加一个开始使用。",
    "editor.edit": "编辑",
    "editor.preview": "预览",
    "ai.title": "AI助手",
    "ai.clearChat": "清除聊天",
    "ai.welcomeTitle": "AI卡片助手",
    "ai.welcomeText": "请求AI编辑、翻译或增强您的角色卡片。",
    "ai.quick.newCard": "新卡片",
    "ai.quick.translate": "翻译",
    "ai.quick.enhance": "增强",
    "ai.quick.shorten": "缩短",
    "ai.quick.tone": "改变语气",
    "ai.quick.grammar": "修正语法",
    "ai.quick.personality": "扩展性格",
    "ai.quick.firstmes": "改进首条消息",
    "ai.quick.scenario": "扩展场景",
    "ai.quick.greetings": "生成问候语",
    "ai.quick.systemprompt": "增强系统提示",
    "ai.quick.tags": "建议标签",
    "ai.contextTitle": "预估使用令牌数 vs 模型上下文限制",
    "ai.contextLabel": "— / — 令牌",
    "ai.placeholder": "请求AI编辑卡片...",
    "ai.send": "发送",
    "ai.stop": "停止生成",
    "ai.autoModel": "自动（使用导航栏模型）",
    "ai.target": "目标:",
    "ai.target.full": "完整卡片",
    "ai.target.description": "描述",
    "ai.target.personality": "性格",
    "ai.target.first_mes": "首条消息",
    "ai.target.scenario": "场景",
    "ai.target.mes_example": "消息示例",
    "ai.target.system_prompt": "系统提示词",
    "ai.target.post_history_instructions": "后历史指令",
    "ai.target.creator_notes": "创作者备注",
    "ai.target.alternate_greetings": "替代问候语",
    "ai.selectModel": "选择模型",
    "ai.actionNewCard": "新建卡片",
    "ai.actionTranslate": "翻译",
    "ai.actionEnhance": "增强",
    "ai.actionShorten": "缩省",
    "ai.actionTone": "更改语气",
    "ai.actionGrammar": "修正语法",
    "ai.actionPersonality": "扩展性格",
    "ai.actionFirstMes": "改善首条消息",
    "ai.actionScenario": "扩展场景",
    "ai.actionGreetings": "生成问候语",
    "ai.actionSystemprompt": "增强系统提示",
    "ai.actionTags": "建议标签",
    "ai.noCard": "（未选择卡片）",
    "settings.themeColor": "主题颜色",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "可为浅色/深色主题分别设置强调色，更改立即生效。",
    "settings.appearance": "外观",
    "settings.accentPresets": "强调色预设",
    "settings.glassDensity": "玻璃密度",
    "settings.glassSubtle": "柔和",
    "settings.glassDefault": "默认",
    "settings.glassBold": "大胆",
    "settings.cardRadius": "卡片圆角",
    "settings.radiusCompact": "紧凑",
    "settings.radiusRounded": "圆润",
    "settings.radiusPill": "胶囊",
    "settings.vignette": "边缘暗角",
    "settings.appearanceHint": "为每个浅色/深色主题自定义外观。强调色更改立即生效；密度、圆角和暗角包含在工作区备份中。",
    "settings.resetThemeColor": "重置",
    "settings.generalTab": "常规",
    "settings.promptsTab": "AI 提示词",
    "settings.assistantPrompt": "助手系统提示词",
    "settings.fullCardPrompt": "整卡系统提示词",
    "settings.wizardPrompt": "角色生成指令",
    "settings.promptPlaceholder": "留空则使用内置提示词",
    "settings.chatSystemPrompts": "聊天与系统指令",
    "settings.fullCardInstr": "整卡输出指令（系统）",
    "settings.fieldsEdit": "字段编辑指令（系统）",
    "settings.greetingsSystem": "问候语输出指令（系统）",
    "settings.exportPrompts": "导出提示词",
    "settings.importPrompts": "导入提示词",
    "settings.promptsExported": "提示词已导出",
    "settings.promptsImported": "已导入 {count} 条提示词",
    "settings.quickActionPrompts": "快捷操作提示词",
    "settings.tagsSystemPrompt": "标签输出指令（系统）",
    "settings.restoreDefaultPrompts": "恢复默认提示词",
    "settings.promptHint": "这些字段显示当前提示词。留空时将使用内置默认提示词。点击“恢复默认”可查看或还原原始提示词。",
    "settings.title": "设置",
    "settings.provider": "提供商",
    "settings.providerHint": "托管模型提供商或自定义端点（LM Studio、Ollama等）",
    "settings.apiKey": "API密钥",
    "settings.getApiKey": "从OpenRouter获取API密钥",
    "settings.baseUrl": "API基础URL",
    "settings.namedApiKeyPlaceholder": "输入您的API密钥",
    "settings.customHint": "OpenAI兼容端点。示例：LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API密钥（可选）",
    "settings.apiKeyLocalPlaceholder": "本地提供商请留空",
    "settings.apiKeyLocalHint": "LM Studio或Ollama等本地服务器不需要。",
    "settings.modelId": "模型ID",
    "settings.modelIdHint": "您的提供商期望的确切模型ID。",
    "settings.modelIdHintNamed": "留空以使用提供商的默认模型。",
    "settings.security": "您的API密钥已使用与此地址绑定的密钥加密并存储在浏览器本地存储中。请勿在共享设备上使用此应用。",
    "settings.secretUnreadable": "出于安全原因，在此地址无法解锁已保存的API密钥，请在设置中重新输入。",
    "error.pngInflateFailed": "此PNG包含无法解压的角色数据。",
    "settings.defaultModel": "默认模型",
    "settings.browseModels": "浏览下方模型...",
    "settings.refreshModels": "刷新模型",
    "settings.maxTokens": "最大输出令牌",
    "settings.maxTokensPlaceholder": "0 = 使用模型默认值",
    "settings.maxTokensHint": "覆盖每次请求的最大输出令牌数。设为0以自动使用所选模型的限制（未知时为64k）。",
    "settings.copyright": "导出时注入编辑器署名",
    "settings.copyrightHint": "导出卡片时在创作者备注中添加署名行。",
    "settings.availableModels": "可用模型",
    "settings.searchModels": "搜索模型...",
    "settings.enterApiKey": "输入API密钥并刷新以加载模型",
    "settings.credits": "额度与使用",
    "settings.creditLimit": "额度限制",
    "settings.remaining": "剩余",
    "settings.usedMonth": "本月使用",
    "settings.localStorage": "本地存储",
    "settings.clearAll": "清除所有数据",
    "settings.export": "导出",
    "settings.import": "导入",
    "settings.close": "关闭",
    "settings.saveSettings": "保存设置",
    "settings.languageLabel": "语言",
    "settings.languageHint": "界面语言（如缺失请刷新页面）",
    "settings.languageChanged": "语言已更新",
    "settings.clearConfirm": "删除所有卡片、设置和聊天记录？此操作不可撤销。",
    "settings.providerCustom": "自定义（OpenAI兼容）",
    "settings.noModels": "未找到模型",
    "settings.loadMore": "加载更多（剩余{{count}}个）",
    "settings.showingModels": "显示 {{shown}} / {{total}} 个模型",
    "wizard.title": "创建角色",
    "wizard.step.basics": "基本信息",
    "wizard.step.concept": "概念",
    "wizard.step.personality": "性格",
    "wizard.step.scenario": "场景",
    "wizard.step.generate": "生成",
    "wizard.basicsTitle": "角色基本信息",
    "wizard.nameLabel": "角色名称",
    "wizard.namePlaceholder": "例如：艾拉拉·夜语",
    "wizard.genderLabel": "性别 / 代词",
    "wizard.genderSelect": "选择...",
    "wizard.gender.female": "女性（她）",
    "wizard.gender.male": "男性（他）",
    "wizard.gender.nonbinary": "非二元（他们）",
    "wizard.gender.other": "其他...",
    "wizard.genderCustom": "自定义代词（例如：它）",
    "wizard.tagsLabel": "标签",
    "wizard.tagsSub": "（逗号分隔，帮助整理卡片库）",
    "wizard.tagsPlaceholder": "奇幻、战士、精灵、原创",
    "wizard.creatorLabel": "创作者",
    "wizard.creatorPlaceholder": "您的名字 / 别名",
    "wizard.conceptTitle": "概念与设定",
    "wizard.typeLabel": "角色类型",
    "wizard.type.original": "原创角色",
    "wizard.type.fanfic": "同人作品",
    "wizard.type.game": "游戏角色",
    "wizard.type.anime": "动画 / 漫画",
    "wizard.type.book": "书籍 / 电影 / 节目",
    "wizard.type.historical": "历史人物",
    "wizard.type.mythological": "神话 / 民间传说",
    "wizard.type.vtuber": "虚拟主播 / 直播主",
    "wizard.type.other": "其他",
    "wizard.languageLabel": "语言",
    "wizard.language.other": "其他",
    "wizard.languageSpecify": "指定语言",
    "wizard.genreLabel": "题材 / 世界观",
    "wizard.genreSub": "（选择所有适用项）",
    "wizard.moodLabel": "氛围 / 语气",
    "wizard.moodSub": "（选择所有适用项）",
    "wizard.personalityTitle": "性格与外貌",
    "wizard.personalityTraits": "性格特征",
    "wizard.personalityTraitsSub": "（描述3-5个主要特征，这对AI有帮助）",
    "wizard.personalityTraitsPlaceholder": "例如：勇敢但鲁莽、对朋友极其忠诚、幽默感干燥、难以信任他人、暗地里喜欢动物",
    "wizard.appearanceLabel": "外貌描述",
    "wizard.appearanceSub": "（简要描述外貌）",
    "wizard.appearancePlaceholder": "例如：银色长发及腰的高挑女性、双手有伤疤、穿黑色皮夹克、锐利的绿眼睛",
    "wizard.abilitiesLabel": "特殊能力 / 特点",
    "wizard.abilitiesSub": "（可选，任何独特特征）",
    "wizard.abilitiesPlaceholder": "例如：能与动物交流、过目不忘、总是带着一本旧日记",
    "wizard.scenarioTitle": "场景与首条消息",
    "wizard.scenarioLabel": "场景 / 设定",
    "wizard.scenarioSub": "（故事从哪里开始？）",
    "wizard.scenarioPlaceholder": "例如：霓虹灯闪烁的城市中的一个雨夜。角色经营着一家小修理店，既修机器也修补破碎的心。",
    "wizard.relationshipLabel": "与{{user}}的关系",
    "wizard.relationshipSub": "（角色如何看待用户？）",
    "wizard.relationshipPlaceholder": "例如：一个带着神秘损坏设备走进店铺的新客户。角色充满好奇但很谨慎。",
    "wizard.openingLabel": "首条消息风格",
    "wizard.openingSub": "（开场消息应该是什么感觉？）",
    "wizard.notesLabel": "附加备注",
    "wizard.notesSub": "（AI还需要知道什么？）",
    "wizard.notesPlaceholder": "例如：保持对话自然，避免过于正式，用星号包含动作描述",
    "wizard.generateTitle": "生成角色",
    "wizard.refImage": "参考图片",
    "wizard.refImageSub": "（可选，来自waifu.im）",
    "wizard.fetchImages": "获取3张图片",
    "wizard.refetchOthers": "重新获取其他",
    "wizard.fetching": "获取中...",
    "wizard.useSelected": "使用选中",
    "wizard.clear": "清除",
    "wizard.generateAI": "使用AI生成",
    "wizard.generateAISub": "根据您的回答生成完整角色卡片",
    "wizard.createBlank": "创建空白卡片",
    "wizard.createBlankSub": "预填姓名和标签开始",
    "wizard.back": "返回",
    "wizard.next": "下一步",
    "wizard.stepLabel": "步骤 {{step}} / {{total}}",
    "wizard.ready": "准备就绪！",
    "wizard.nameRequired": "请输入角色名称",
    "wizard.summary.name": "名称",
    "wizard.summary.gender": "性别",
    "wizard.summary.type": "类型",
    "wizard.summary.language": "语言",
    "wizard.summary.tags": "标签",
    "wizard.summary.genres": "题材",
    "wizard.summary.mood": "氛围",
    "wizard.summary.opening": "开场",
    "wizard.summary.personality": "性格",
    "wizard.summary.appearance": "外貌",
    "wizard.summary.scenario": "场景",
    "wizard.summary.relationship": "关系",
    "wizard.summary.notes": "备注",
    "wizard.chip.fantasy": "奇幻",
    "wizard.chip.scifi": "科幻",
    "wizard.chip.modern": "现代",
    "wizard.chip.historical": "历史",
    "wizard.chip.horror": "恐怖",
    "wizard.chip.romance": "言情",
    "wizard.chip.comedy": "喜剧",
    "wizard.chip.sliceOfLife": "日常",
    "wizard.chip.adventure": "冒险",
    "wizard.chip.mystery": "悬疑",
    "wizard.chip.cyberpunk": "赛博朋克",
    "wizard.chip.postApocalyptic": "后启示录",
    "wizard.chip.supernatural": "超自然",
    "wizard.chip.military": "军事",
    "wizard.chip.surreal": "超现实",
    "wizard.chip.serious": "严肃",
    "wizard.chip.playful": "俏皮",
    "wizard.chip.dark": "黑暗",
    "wizard.chip.lighthearted": "轻松",
    "wizard.chip.mysterious": "神秘",
    "wizard.chip.romantic": "浪漫",
    "wizard.chip.intense": "激烈",
    "wizard.chip.wholesome": "温馨",
    "wizard.chip.chaotic": "混乱",
    "wizard.chip.melancholic": "忧郁",
    "wizard.chip.sarcastic": "讽刺",
    "wizard.chip.stoic": "冷静",
    "wizard.chip.greeting": "温暖问候",
    "wizard.chip.action": "直入主题",
    "wizard.chip.question": "好奇提问",
    "wizard.chip.conflict": "即时冲突",
    "wizard.chip.atmospheric": "氛围感",
    "diff.title": "AI回复预览",
    "diff.removed": "已删除",
    "diff.added": "已添加",
    "diff.current": "当前",
    "diff.proposed": "建议",
    "diff.empty": "（空）",
    "diff.discard": "放弃",
    "diff.apply": "应用更改",
    "shortcuts.title": "快捷键",
    "shortcuts.save": "保存卡片",
    "shortcuts.newCard": "新建卡片",
    "shortcuts.undo": "撤销",
    "shortcuts.redo": "重做",
    "shortcuts.sendAi": "发送AI消息",
    "shortcuts.newLine": "AI中换行",
    "shortcuts.focus": "专注模式",
    "shortcuts.collapsePanel": "折叠/展开 AI 面板",
    "toast.loadFailed": "失败: {{name}}",
    "toast.loaded": "已加载 {{count}} 张卡片",
    "toast.importDupe": "与现有卡片内容相同 — 已作为 {{name}} 导入",
    "toast.largeImage": "{{name}} 中嵌入了大图（{{size}} MB）- 建议移除以节省存储空间。",
    "toast.noValid": "未找到有效卡片。请拖放PNG或JSON文件。",
    "toast.noSelected": "未选择卡片",
    "toast.cardsDeleted": "卡片已删除",
    "toast.deleteFailed": "删除卡片失败",
    "toast.exported": "已导出 {{count}} 张卡片",
    "toast.newBlank": "已创建新空白卡片",
    "toast.noCardSave": "没有可保存的卡片",
    "toast.cardSaved": "卡片已保存！",
    "toast.noCardDup": "没有可复制的卡片",
    "toast.cardDup": "卡片已复制",
    "toast.cardRestored": "卡片已恢复",
    "toast.selectCard": "请先选择一张卡片",
    "toast.avatarUpdated": "头像已更新",
    "toast.imgFailed": "图片加载失败",
    "toast.firstMesUpdated": "首条消息已更新！",
    "toast.settingsSaved": "设置已保存！",
    "toast.modelsFailed": "模型加载失败: {{error}}",
    "toast.modelSet": "模型已设置: {{model}}",
    "toast.dataCleared": "所有数据已清除",
    "toast.settingsExported": "设置已导出",
    "toast.settingsImported": "设置已导入！",
    "toast.invalidFile": "无效的设置文件",
    "toast.apiKey": "请在设置中配置API密钥",
    "toast.selectModel": "请先从导航栏或设置中选择一个模型。",
    "toast.genStopped": "生成已停止。",
    "toast.aiError": "AI错误: {{error}}",
    "toast.cardUpdatedAI": "卡片已从AI回复中更新！",
    "toast.jsonParseFailed": "无法将AI回复解析为JSON。请检查聊天。",
    "toast.emptyResponse": "AI返回了空内容，没有可以应用的内容。",
    "toast.jsonInvalid": "AI未返回有效JSON。回复在聊天中 — 您可以手动复制。",
    "toast.fieldUpdated": '"{{field}}" 已更新！',
    "toast.selectField": "请至少选择一个要编辑的字段",
    "toast.tooManyFields": "选择的字段过多。最多同时{{max}}个。",
    "toast.greetingsUpdated": "已生成 {{count}} 条问候语！",
    "toast.tagsUpdated": "标签已更新 — 新增 {{count}} 个！",
    "toast.greetingsParseFailed": "无法从AI响应中解析问候语。",
    "toast.createCardFirst": "请先创建或选择一张卡片",
    "toast.wizardCreated": "卡片已创建！开始编辑或使用AI填写详情。",
    "toast.wizardApi": "请先在设置中配置API密钥",
    "toast.wizardModel": "请在设置中选择模型或设置自定义模型ID",
    "toast.wizardFetchFailed": "获取图片失败: {{error}}",
    "toast.wizardName": "请输入角色名称",
    "toast.storageFull": "存储已满！请尝试删除或导出一些卡片。",
    "toast.exportedJson": "已导出为JSON！",
    "toast.exportedPng": "已导出为PNG（含卡片数据）！",
    "toast.exportFailed": "图片导出失败，回退到JSON。",
    "toast.chatCleared": "聊天已清除",
    "toast.undo": "撤销",
    "error.apiKeyNotSet": "未设置 API 密钥。请在设置中输入您的 API 密钥。",
    "error.customUrlNotSet": "未设置自定义 API 的基础 URL。请打开设置 → 自定义（兼容 OpenAI），输入端点 URL（例如 http://localhost:1234/v1）。",
    "error.customServerError": "服务器返回错误：{{detail}}",
    "error.customAuthFailed": "身份验证失败（HTTP {{status}}）。请检查此端点的 API 密钥。",
    "error.customPathNotFound": "未找到端点（HTTP 404）。请检查 API 基础 URL 是否完整（例如包含 /v1）。",
    "error.customUnreachable": "无法访问 {{url}}。请检查服务器是否正在运行，以及 API 基础 URL 是否正确且可从当前设备访问。",
    "error.noModel": "未选择模型。请选择模型或在设置中设置模型ID。",
    "error.noModelSimple": "未选择模型。",
    "error.insufficientCredits": "额度不足。请充值您的账户。",
    "error.storageFull": "存储已满！请尝试删除或导出一些卡片。",
    "gen.empty": "（空）",
    "gen.free": "免费",
    "gen.unlimited": "无限制",
    "gen.notAvailable": "无",
    "gen.unnamed": "未命名",
    "gen.byCreator": "作者: {{name}}",
    "gen.untagged": "无标签",
    "gen.noMatch": "没有卡片匹配您的筛选条件",
    "batch.deleteConfirm": "删除{{count}}张卡片？此操作无法撤销。",
    "left.selected": "已选择{{count}}张",
    "toast.cardDeleted": "卡片「{{name}}」已删除",
    "ai.editing": "正在编辑 {{count}} 个字段...",
    "ai.streaming": "流式传输中...",
    "ai.failed": "失败",
    "ai.cancelled": "已取消。",
    "ai.doneSummary": "{{done}}/{{total}} 完成 · {{errs}} 失败",
    "ai.viewFullResult": "查看完整结果",
    "ai.showLess": "显示较少",
    "ai.reviewApply": "审查并应用",
    "ai.changesNav": "第 {{current}} 项，共 {{total}} 项",
    "ai.changesPrev": "上一个更改",
    "ai.changesNext": "下一个更改",
    "ai.applied": "已应用",
    "ai.target.tags": "标签",
    "ai.copy": "复制",
    "ai.copied": "已复制！",
    "ai.copyFailed": "复制失败",
    "ai.resultTitle": "结果",
    "ai.close": "关闭",
    "editor.noGreetings": "尚无问候语。<strong>添加问候语</strong>或使用AI生成。",
    "editor.noEntriesMatch": '未找到匹配"{{query}}"的条目',
    "gen.copySuffix": " (副本)",
    "gen.toastAutoHide": "{{s}}秒后自动关闭",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "接近输出令牌上限（{tokens}/{max}）。",
    "editor.counterDanger": "超出输出令牌上限（{tokens}/{max}）。",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "收起面板",
    "ui.expandPanel": "展开面板",
    "ui.cardModified": "未保存的修改",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "聊天记录",
    "ai.historyTitle": "聊天记录",
    "ai.historyEmpty": "还没有对话",
    "ai.retry": "重试",
    "ai.retryTitle": "重新生成此回复",
    "ai.reapply": "重新应用",
    "ai.reapplyTitle": "重新打开差异以应用这些更改",
    "wizard.editStep": "编辑此部分",
    "wizard.draftRestored": "草稿已恢复 — 您之前的回答已返回",
    "wizard.imagePlaceholder": "点击获取",
    "toast.noNameWarning": '警告：卡片没有名称。文件将保存为 "character.json"。',
    "toast.redo": "重做",
    "toast.reorderFiltered": "关闭搜索和筛选以重新排列卡片。",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.ko = {
    "app.title": "ST Card Editor — SillyTavern 캐릭터 카드 스튜디오",
    "nav.selectModel": "모델 선택...",
    "nav.wizard": "AI 마법사로 만들기",
    "nav.newCard": "새 빈 카드",
    "nav.save": "저장",
    "nav.theme": "테마 전환",
    "nav.shortcuts": "단축키 및 도움말",
    "nav.settings": "설정",
    "nav.focus": "포커스 모드",
    "nav.focusAlt": "포커스 모드 (Alt+F)",
    "left.title": "카드 라이브러리",
    "left.cards": "{{count}}장의 카드",
    "left.drop": "드래그 앤 드롭",
    "left.sort.manual": "수동",
    "left.dropSub": "PNG 또는 JSON 캐릭터 카드",
    "left.browse": "파일 찾아보기",
    "left.search": "카드 검색...",
    "left.sort.nameAsc": "이름 A-Z",
    "left.sort.nameDesc": "이름 Z-A",
    "left.sort.newest": "최신순",
    "left.sort.oldest": "오래된순",
    "left.sort.largest": "큰순",
    "left.sort.smallest": "작은순",
    "left.filterTags": "태그로 필터",
    "left.exportSelected": "선택을 JSON으로 내보내기",
    "left.deleteSelected": "선택 삭제",
    "left.empty": "로드된 카드 없음",
    "left.emptySub": "카드를 드롭하거나 찾아보기를 클릭하세요",
    "center.noCard": "카드가 선택되지 않음",
    "center.noCardSub": "라이브러리에서 카드를 선택하거나 새 카드를 드래그 앤 드롭하세요",
    "center.createAI": "AI로 만들기",
    "center.blankCard": "빈 카드",
    "editor.avatar": "클릭하거나 이미지를 드롭하여 아바타 설정",
    "editor.avatarAria": "캐릭터 아바타 설정",
    "editor.name": "캐릭터 이름",
    "editor.exportJson": "JSON으로 내보내기",
    "editor.exportPng": "PNG로 내보내기",
    "editor.duplicate": "카드 복제",
    "editor.delete": "카드 삭제",
    "editor.tab.core": "핵심",
    "editor.tab.personality": "성격",
    "editor.tab.advanced": "고급",
    "editor.tab.lorebook": "로어북",
    "editor.tab.waifu": "와이후 이미지",
    "editor.waifuPreview": "현재 카드 이미지",
    "editor.waifuNoImage": "아직 이미지가 없습니다",
    "editor.waifuSource": "이미지 소스",
    "editor.waifuSourceSnap": "애니메이션 스냅샷 (waifu.im)",
    "editor.waifuSourceChar": "애니 캐릭터 (AniList)",
    "editor.waifuGender": "성별",
    "editor.waifuGenderAll": "모두",
    "editor.waifuGenderFemaleOnly": "여성만",
    "editor.waifuGenderMaleOnly": "남성만",
    "editor.waifuGenderFemale": "여성",
    "editor.waifuGenderMale": "남성",
    "editor.waifuCharSub": "이름으로 캐릭터 검색 (예: zoro)",
    "editor.waifuSearch": "waifu.im 검색",
    "editor.waifuSearchChar": "캐릭터 검색",
    "editor.waifuSearchPlaceholderChar": "이름으로 캐릭터 검색 (예: zoro)",
    "editor.waifuSub": "(태그로 애니메이션 스타일 이미지 가져오기)",
    "editor.waifuSearchPlaceholder": "예: waifu, 엘프, 메이드...",
    "editor.waifuFetch": "이미지 가져오기",
    "editor.waifuRegenTitle": "결과 다시 생성",
    "editor.waifuMixed": "여성 + 남성",
    "editor.waifuMixedSub": "원클릭 균형 팩: 여성 3명 + 남성 3명",
    "editor.waifuUse": "카드 이미지로 사용",
    "editor.waifuUpload": "기기에서 업로드",
    "editor.waifuRemove": "이미지 제거",
    "toast.noImage": "이 카드에는 제거할 이미지가 없습니다",
    "toast.imageRemoved": "이미지 제거됨",
    "editor.desc": "설명",
    "editor.descSub": "(외모, 배경故事)",
    "editor.descPlaceholder": "캐릭터의 외모, 배경, 주요 특징을 설명하세요...",
    "editor.firstMes": "첫 번째 메시지",
    "editor.firstMesPlaceholder": "채팅 시작 시 캐릭터의 첫 번째 메시지...",
    "editor.scenario": "시나리오",
    "editor.scenarioPlaceholder": "대화의 현재 상황과 맥락...",
    "editor.creator": "크리에이터",
    "editor.creatorPlaceholder": "카드 제작자 / 저자",
    "editor.version": "캐릭터 버전",
    "editor.tags": "태그",
    "editor.tagsSub": "(쉼표 구분)",
    "editor.tagsPlaceholder": "판타지, 전사, 엘프",
    "editor.personalitySummary": "성격 요약",
    "editor.personalityPlaceholder": "캐릭터 성격의 간략한 설명... (캐릭터 카드 형식에서 사용)",
    "editor.mesExample": "메시지 예시",
    "editor.mesExampleFormat": "형식: <START> 블록, {{char}}: 및 {{user}}: 접두사",
    "editor.systemPrompt": "시스템 프롬프트",
    "editor.systemPromptPlaceholder": "시스템 프롬프트를 덮어쓰기. 기본값을 포함하려면 {{original}}을 사용하세요.",
    "editor.postHistory": "후처리 히스토리 지시사항",
    "editor.postHistoryPlaceholder": "채팅 기록 후에 주입되는 지시사항. 기본값에는 {{original}}을 사용하세요.",
    "editor.creatorNotes": "크리에이터 메모",
    "editor.creatorNotesPlaceholder": "카드 사용자를 위한 메모 (모델 추천, 사용 팁...)",
    "editor.greetings": "대체 인사",
    "editor.addGreeting": "인사 추가",
    "editor.lorebookTitle": "캐릭터 로어북 항목",
    "editor.addEntry": "항목 추가",
    "editor.lorebookSearch": "키, 내용 또는 댓글로 항목 검색...",
    "editor.lorebookEmpty": "로어북 항목이 아직 없습니다. 하나 추가하여 시작하세요.",
    "editor.edit": "편집",
    "editor.preview": "미리보기",
    "ai.title": "AI 어시스턴트",
    "ai.clearChat": "채팅 지우기",
    "ai.welcomeTitle": "AI 카드 어시스턴트",
    "ai.welcomeText": "AI에게 캐릭터 카드 편집, 번역, 향상을 요청하세요.",
    "ai.quick.newCard": "새 카드",
    "ai.quick.translate": "번역",
    "ai.quick.enhance": "향상",
    "ai.quick.shorten": "단축",
    "ai.quick.tone": "어조 변경",
    "ai.quick.grammar": "문법 수정",
    "ai.quick.personality": "성격 확장",
    "ai.quick.firstmes": "첫 번째 메시지 개선",
    "ai.quick.scenario": "시나리오 확장",
    "ai.quick.greetings": "인사말 생성",
    "ai.quick.systemprompt": "시스템 프롬프트 향상",
    "ai.quick.tags": "태그 제안",
    "ai.contextTitle": "예상 토큰 사용량 vs 모델 컨텍스트 제한",
    "ai.contextLabel": "— / — 토큰",
    "ai.placeholder": "AI에게 카드 편집을 요청하세요...",
    "ai.send": "보내기",
    "ai.stop": "생성 중지",
    "ai.autoModel": "자동 (내비게이션 모델 사용)",
    "ai.target": "대상:",
    "ai.target.full": "전체 카드",
    "ai.target.description": "설명",
    "ai.target.personality": "성격",
    "ai.target.first_mes": "첫 번째 메시지",
    "ai.target.scenario": "시나리오",
    "ai.target.mes_example": "메시지 예시",
    "ai.target.system_prompt": "시스템 프롬프트",
    "ai.target.post_history_instructions": "후처리 히스토리 지시사항",
    "ai.target.creator_notes": "크리에이터 메모",
    "ai.target.alternate_greetings": "대체 인사말",
    "ai.selectModel": "모델 선택",
    "ai.actionNewCard": "새 카드",
    "ai.actionTranslate": "번역",
    "ai.actionEnhance": "향상",
    "ai.actionShorten": "단축",
    "ai.actionTone": "어조 변경",
    "ai.actionGrammar": "문법 수정",
    "ai.actionPersonality": "성격 확장",
    "ai.actionFirstMes": "첫 메시지 개선",
    "ai.actionScenario": "시나리오 확장",
    "ai.actionGreetings": "인사말 생성",
    "ai.actionSystemprompt": "시스템 프롬프트 향상",
    "ai.actionTags": "태그 제안",
    "ai.noCard": "(카드가 선택되지 않음)",
    "settings.themeColor": "테마 색상",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "라이트/다크 테마마다 강조 색상을 따로 지정할 수 있습니다. 변경 사항은 즉시 적용됩니다.",
    "settings.appearance": "외관",
    "settings.accentPresets": "강조색 프리셋",
    "settings.glassDensity": "유리 밀도",
    "settings.glassSubtle": "은은함",
    "settings.glassDefault": "기본",
    "settings.glassBold": "대담함",
    "settings.cardRadius": "카드 모서리",
    "settings.radiusCompact": "컴팩트",
    "settings.radiusRounded": "라운드",
    "settings.radiusPill": "필",
    "settings.vignette": "가장자리 비네트",
    "settings.appearanceHint": "각 라이트/다크 테마의 모양을 커스터마이즈합니다. 강조색 변경은 즉시 적용됩니다. 밀도·모서리·비네트는 워크스페이스 백업에 포함됩니다.",
    "settings.resetThemeColor": "초기화",
    "settings.generalTab": "일반",
    "settings.promptsTab": "AI 프롬프트",
    "settings.assistantPrompt": "어시스턴트 시스템 프롬프트",
    "settings.fullCardPrompt": "전체 카드 시스템 프롬프트",
    "settings.wizardPrompt": "캐릭터 생성 지침",
    "settings.promptPlaceholder": "비워 두면 내장 프롬프트를 사용합니다",
    "settings.chatSystemPrompts": "채팅 및 시스템 지침",
    "settings.fullCardInstr": "전체 카드 출력 지침 (시스템)",
    "settings.fieldsEdit": "필드 편집 지침 (시스템)",
    "settings.greetingsSystem": "인사말 출력 지침 (시스템)",
    "settings.exportPrompts": "프롬프트 내보내기",
    "settings.importPrompts": "프롬프트 가져오기",
    "settings.promptsExported": "프롬프트를 내보냈습니다",
    "settings.promptsImported": "{count}개의 프롬프트를 가져왔습니다",
    "settings.quickActionPrompts": "빠른 실행 프롬프트",
    "settings.tagsSystemPrompt": "태그 출력 지침 (시스템)",
    "settings.restoreDefaultPrompts": "기본 프롬프트 복원",
    "settings.promptHint": "이 필드에는 현재 프롬프트가 표시됩니다. 비워 두면 내장 기본 프롬프트가 사용됩니다. 기본값 복원을 누르면 확인하거나 되돌릴 수 있습니다.",
    "settings.title": "설정",
    "settings.provider": "제공자",
    "settings.providerHint": "호스팅 모델 제공자 또는 사용자 정의 엔드포인트 (LM Studio, Ollama 등)",
    "settings.apiKey": "API 키",
    "settings.getApiKey": "OpenRouter에서 API 키를 받으세요",
    "settings.baseUrl": "API 기본 URL",
    "settings.namedApiKeyPlaceholder": "API 키를 입력하세요",
    "settings.customHint": "OpenAI 호환 엔드포인트. 예: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API 키 (선택사항)",
    "settings.apiKeyLocalPlaceholder": "로컬 제공자의 경우 비워두세요",
    "settings.apiKeyLocalHint": "LM Studio나 Ollama와 같은 로컬 서버에는 필요하지 않습니다.",
    "settings.modelId": "모델 ID",
    "settings.modelIdHint": "제공자가 기대하는 정확한 모델 ID.",
    "settings.modelIdHintNamed": "제공자의 기본 모델을 사용하려면 비워두세요.",
    "settings.security": "API 키는 브라우저의 localStorage에 이 주소와 연동된 키로 암호화되어 저장됩니다. 공유 기기에서 이 앱을 사용하지 마세요.",
    "settings.secretUnreadable": "보안상의 이유로 이 주소에서는 저장된 API 키를 잠금 해제할 수 없습니다. 설정에서 키를 다시 입력해 주세요.",
    "error.pngInflateFailed": "이 PNG에는 압축을 풀 수 없는 캐릭터 데이터가 포함되어 있습니다.",
    "settings.defaultModel": "기본 모델",
    "settings.browseModels": "아래에서 모델을 찾아보세요...",
    "settings.refreshModels": "모델 새로고침",
    "settings.maxTokens": "최대 출력 토큰",
    "settings.maxTokensPlaceholder": "0 = 모델 기본값 사용",
    "settings.maxTokensHint": "요청당 최대 출력 토큰을 덮어쓰기. 선택한 모델의 제한(알려지지 않은 경우 64k)을 자동 사용하려면 0으로 설정하세요.",
    "settings.copyright": "내보내기 시 에디터 크레딧 주입",
    "settings.copyrightHint": "카드 내보내기 시 크리에이터 메모에 크레딧 라인을 추가합니다.",
    "settings.availableModels": "사용 가능한 모델",
    "settings.searchModels": "모델 검색...",
    "settings.enterApiKey": "API 키를 입력하고 새로고침하여 모델을 로드하세요",
    "settings.credits": "크레딧 및 사용량",
    "settings.creditLimit": "크레딧 한도",
    "settings.remaining": "잔여",
    "settings.usedMonth": "이번 달 사용량",
    "settings.localStorage": "로컬 스토리지",
    "settings.clearAll": "모든 데이터 지우기",
    "settings.export": "내보내기",
    "settings.import": "가져오기",
    "settings.close": "닫기",
    "settings.saveSettings": "설정 저장",
    "settings.languageLabel": "언어",
    "settings.languageHint": "인터페이스 언어 (누락 시 페이지 새로고침)",
    "settings.languageChanged": "언어가 업데이트되었습니다",
    "settings.clearConfirm": "모든 카드, 설정 및 채팅 기록을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.",
    "settings.providerCustom": "사용자 정의 (OpenAI 호환)",
    "settings.noModels": "모델을 찾을 수 없음",
    "settings.loadMore": "더 불러오기 ({{count}}개 남음)",
    "settings.showingModels": "{{total}}개 중 {{shown}}개 표시",
    "wizard.title": "캐릭터 만들기",
    "wizard.step.basics": "기본정보",
    "wizard.step.concept": "컨셉",
    "wizard.step.personality": "성격",
    "wizard.step.scenario": "시나리오",
    "wizard.step.generate": "생성",
    "wizard.basicsTitle": "캐릭터 기본정보",
    "wizard.nameLabel": "캐릭터 이름",
    "wizard.namePlaceholder": "예: 엘라라 나이트위스퍼",
    "wizard.genderLabel": "성별 / 대명사",
    "wizard.genderSelect": "선택...",
    "wizard.gender.female": "여성 (그녀)",
    "wizard.gender.male": "남성 (그)",
    "wizard.gender.nonbinary": "논바이너리 (그들)",
    "wizard.gender.other": "기타...",
    "wizard.genderCustom": "사용자 정의 대명사 (예: 그것)",
    "wizard.tagsLabel": "태그",
    "wizard.tagsSub": "(쉼표 구분, 라이브러리 정리에 도움)",
    "wizard.tagsPlaceholder": "판타지, 전사, 엘프, 오리지널",
    "wizard.creatorLabel": "크리에이터",
    "wizard.creatorPlaceholder": "이름 / 별명",
    "wizard.conceptTitle": "컨셉 & 설정",
    "wizard.typeLabel": "캐릭터 유형",
    "wizard.type.original": "오리지널 캐릭터",
    "wizard.type.fanfic": "패닉션",
    "wizard.type.game": "게임 캐릭터",
    "wizard.type.anime": "애니메이션 / 만화",
    "wizard.type.book": "책 / 영화 / 프로그램",
    "wizard.type.historical": "역사적 인물",
    "wizard.type.mythological": "신화 / 민속",
    "wizard.type.vtuber": "버추얼 튜버 / 스트리머",
    "wizard.type.other": "기타",
    "wizard.languageLabel": "언어",
    "wizard.language.other": "기타",
    "wizard.languageSpecify": "언어 지정",
    "wizard.genreLabel": "장르 / 세계관",
    "wizard.genreSub": "(해당하는 모든 것 선택)",
    "wizard.moodLabel": "분위기 / 어조",
    "wizard.moodSub": "(해당하는 모든 것 선택)",
    "wizard.personalityTitle": "성격 & 외모",
    "wizard.personalityTraits": "성격 특성",
    "wizard.personalityTraitsSub": "(3-5가지 주요 특성을 설명하세요, AI에게 도움이 됩니다)",
    "wizard.personalityTraitsPlaceholder": "예: 용감하지만 경솔, 친구에게 매우 충성, 건조한 유머 감각, 신뢰에 어려움을 겪음, 동물을 몰래 좋아함",
    "wizard.appearanceLabel": "외모",
    "wizard.appearanceSub": "(외모에 대한 간략한 설명)",
    "wizard.appearancePlaceholder": "예: 허리까지 은발인 키 큰 여성, 상처가 난 손, 어두운 가죽 재킷, 날카로운 초록색 눈",
    "wizard.abilitiesLabel": "특수 능력 / 특이점",
    "wizard.abilitiesSub": "(선택사항, 고유한 특성)",
    "wizard.abilitiesPlaceholder": "예: 동물과 대화할 수 있음, 사진 기억력, 항상 낡은 일기를 가지고 다님",
    "wizard.scenarioTitle": "시나리오 & 첫 번째 메시지",
    "wizard.scenarioLabel": "시나리오 / 설정",
    "wizard.scenarioSub": "(이야기가 어디서 시작되나요?)",
    "wizard.scenarioPlaceholder": "예: 네온 불이 비치는 도시의 비 오는 밤. 캐릭터는 기계와 부서진 마음을 모두 수리하는 작은 수리점을 운영하고 있습니다.",
    "wizard.relationshipLabel": "{{user}}와의 관계",
    "wizard.relationshipSub": "(캐릭터가 사용자를 어떻게 보나요?)",
    "wizard.relationshipPlaceholder": "예: 신비로운 고장난 기기를 가지고 가게에 들어온 새로운 고객. 캐릭터는 호기심이 많지만 조심스럽습니다.",
    "wizard.openingLabel": "첫 번째 메시지 분위기",
    "wizard.openingSub": "(오프닝 메시지는 어떤 느낌이어야 하나요?)",
    "wizard.notesLabel": "추가 메모",
    "wizard.notesSub": "(AI가 알아야 할 다른 것이 있나요?)",
    "wizard.notesPlaceholder": "예: 대화를 자연스럽게 유지, 지나치게 격식체로 하지 않기, 별표로 액션 묘사 포함",
    "wizard.generateTitle": "캐릭터 생성",
    "wizard.refImage": "참조 이미지",
    "wizard.refImageSub": "(선택사항, waifu.im에서)",
    "wizard.fetchImages": "3장의 이미지 가져오기",
    "wizard.refetchOthers": "다른 이미지 다시 가져오기",
    "wizard.fetching": "가져오는 중...",
    "wizard.useSelected": "선택 사용",
    "wizard.clear": "지우기",
    "wizard.generateAI": "AI로 생성",
    "wizard.generateAISub": "답변으로 완전한 캐릭터 카드 생성",
    "wizard.createBlank": "빈 카드 만들기",
    "wizard.createBlankSub": "이름과 태그를 미리 입력하여 시작",
    "wizard.back": "뒤로",
    "wizard.next": "다음",
    "wizard.stepLabel": "단계 {{step}} / {{total}}",
    "wizard.ready": "생성 준비 완료!",
    "wizard.nameRequired": "캐릭터 이름을 입력하세요",
    "wizard.summary.name": "이름",
    "wizard.summary.gender": "성별",
    "wizard.summary.type": "유형",
    "wizard.summary.language": "언어",
    "wizard.summary.tags": "태그",
    "wizard.summary.genres": "장르",
    "wizard.summary.mood": "분위기",
    "wizard.summary.opening": "오프닝",
    "wizard.summary.personality": "성격",
    "wizard.summary.appearance": "외모",
    "wizard.summary.scenario": "시나리오",
    "wizard.summary.relationship": "관계",
    "wizard.summary.notes": "메모",
    "wizard.chip.fantasy": "판타지",
    "wizard.chip.scifi": "SF",
    "wizard.chip.modern": "현대",
    "wizard.chip.historical": "역사",
    "wizard.chip.horror": "호러",
    "wizard.chip.romance": "로맨스",
    "wizard.chip.comedy": "코미디",
    "wizard.chip.sliceOfLife": "일상",
    "wizard.chip.adventure": "모험",
    "wizard.chip.mystery": "미스터리",
    "wizard.chip.cyberpunk": "사이버펑크",
    "wizard.chip.postApocalyptic": "포스트 아포칼립스",
    "wizard.chip.supernatural": "초자연",
    "wizard.chip.military": "군사",
    "wizard.chip.surreal": "초현실주의",
    "wizard.chip.serious": "진지",
    "wizard.chip.playful": "장난기",
    "wizard.chip.dark": "다크",
    "wizard.chip.lighthearted": "경쾌",
    "wizard.chip.mysterious": "신비",
    "wizard.chip.romantic": "로맨틱",
    "wizard.chip.intense": "강렬",
    "wizard.chip.wholesome": "따뜻한",
    "wizard.chip.chaotic": "카오스",
    "wizard.chip.melancholic": "우울",
    "wizard.chip.sarcastic": "냉소",
    "wizard.chip.stoic": "스토아",
    "wizard.chip.greeting": "따뜻한 인사",
    "wizard.chip.action": "중간부터 시작",
    "wizard.chip.question": "호기심 질문",
    "wizard.chip.conflict": "즉각적 갈등",
    "wizard.chip.atmospheric": "분위기 중시",
    "diff.title": "AI 응답 미리보기",
    "diff.removed": "삭제됨",
    "diff.added": "추가됨",
    "diff.current": "현재",
    "diff.proposed": "제안",
    "diff.empty": "(비어있음)",
    "diff.discard": "포기",
    "diff.apply": "변경 사항 적용",
    "shortcuts.title": "단축키",
    "shortcuts.save": "카드 저장",
    "shortcuts.newCard": "새 카드",
    "shortcuts.undo": "실행 취소",
    "shortcuts.redo": "다시 실행",
    "shortcuts.sendAi": "AI 메시지 보내기",
    "shortcuts.newLine": "AI에서 새 줄",
    "shortcuts.focus": "포커스 모드",
    "shortcuts.collapsePanel": "AI 패널 접기/펼치기",
    "toast.loadFailed": "실패: {{name}}",
    "toast.loaded": "{{count}}장의 카드 로드됨",
    "toast.importDupe": "기존 카드와 동일한 내용 — {{name}}(으)로 가져옴",
    "toast.largeImage": "{{name}}에 큰 이미지가 포함되어 있습니다 ({{size}} MB) - 저장 공간을 절약하려면 제거를 고려하세요.",
    "toast.noValid": "유효한 카드를 찾을 수 없습니다. PNG 또는 JSON 파일을 드롭하세요.",
    "toast.noSelected": "카드가 선택되지 않음",
    "toast.cardsDeleted": "카드 삭제됨",
    "toast.deleteFailed": "카드 삭제에 실패했습니다",
    "toast.exported": "{{count}}장의 카드 내보내기됨",
    "toast.newBlank": "새 빈 카드 생성됨",
    "toast.noCardSave": "저장할 카드 없음",
    "toast.cardSaved": "카드 저장됨!",
    "toast.noCardDup": "복제할 카드 없음",
    "toast.cardDup": "카드 복제됨",
    "toast.cardRestored": "카드 복원됨",
    "toast.selectCard": "먼저 카드를 선택하세요",
    "toast.avatarUpdated": "아바타 업데이트됨",
    "toast.imgFailed": "이미지 로드 실패",
    "toast.firstMesUpdated": "첫 번째 메시지 업데이트됨!",
    "toast.settingsSaved": "설정 저장됨!",
    "toast.modelsFailed": "모델 로드 실패: {{error}}",
    "toast.modelSet": "모델 설정됨: {{model}}",
    "toast.dataCleared": "모든 데이터 지워짐",
    "toast.settingsExported": "설정 내보내기됨",
    "toast.settingsImported": "설정 가져오기됨!",
    "toast.invalidFile": "잘못된 설정 파일",
    "toast.apiKey": "설정에서 API 키를 설정하세요",
    "toast.selectModel": "먼저 내비게이션 바 또는 설정에서 모델을 선택하세요.",
    "toast.genStopped": "생성이 중지됨.",
    "toast.aiError": "AI 오류: {{error}}",
    "toast.cardUpdatedAI": "AI 응답으로 카드 업데이트됨!",
    "toast.jsonParseFailed": "AI 응답을 JSON으로 파싱할 수 없습니다. 채팅을 확인하세요.",
    "toast.emptyResponse": "AI가 빈 콘텐츠를 반환했습니다. 적용할 내용이 없습니다.",
    "toast.jsonInvalid": "AI가 유효한 JSON을 반환하지 않았습니다. 응답은 채팅에 있습니다 — 수동으로 복사할 수 있습니다.",
    "toast.fieldUpdated": '"{{field}}" 업데이트됨!',
    "toast.selectField": "편집할 필드를 하나 이상 선택하세요",
    "toast.tooManyFields": "필드가 너무 많습니다. 한 번에 최대 {{max}}개까지 선택 가능합니다.",
    "toast.greetingsUpdated": "{{count}}개의 인사말이 생성되었습니다!",
    "toast.tagsUpdated": "태그 업데이트됨 — {{count}}개 추가됨!",
    "toast.greetingsParseFailed": "AI 응답에서 인사말을 구문 분석할 수 없습니다.",
    "toast.createCardFirst": "먼저 카드를 만들거나 선택하세요",
    "toast.wizardCreated": "카드 생성됨! 편집을 시작하거나 AI로 세부사항을 채우세요.",
    "toast.wizardApi": "먼저 설정에서 API 키를 설정하세요",
    "toast.wizardModel": "설정에서 모델을 선택하거나 사용자 정의 모델 ID를 설정하세요",
    "toast.wizardFetchFailed": "이미지 가져오기 실패: {{error}}",
    "toast.wizardName": "캐릭터 이름을 입력하세요",
    "toast.storageFull": "스토리지가 가득 찼습니다! 카드를 삭제하거나 내보내세요.",
    "toast.exportedJson": "JSON으로 내보내기됨!",
    "toast.exportedPng": "카드 데이터와 함께 PNG로 내보내기됨!",
    "toast.exportFailed": "이미지 내보내기 실패. JSON으로 대체합니다.",
    "toast.chatCleared": "채팅 지워짐",
    "toast.undo": "실행 취소",
    "error.apiKeyNotSet": "API 키가 설정되지 않았습니다. 설정에서 API 키를 입력하세요.",
    "error.customUrlNotSet": "사용자 지정 API 기본 URL이 설정되지 않았습니다. 설정 → 사용자 지정(OpenAI 호환)을 열고 엔드포인트 URL(예: http://localhost:1234/v1)을 입력하세요.",
    "error.customServerError": "서버에서 오류를 반환했습니다: {{detail}}",
    "error.customAuthFailed": "인증 실패(HTTP {{status}}). 이 엔드포인트의 API 키를 확인하세요.",
    "error.customPathNotFound": "엔드포인트를 찾을 수 없음(HTTP 404). API 기본 URL이 완전한지(예: /v1 포함) 확인하세요.",
    "error.customUnreachable": "{{url}}에 연결할 수 없습니다. 서버가 실행 중인지, API 기본 URL이 올바르고 이 기기에서 접근 가능한지 확인하세요.",
    "error.noModel": "모델이 선택되지 않았습니다. 모델을 선택하거나 설정에서 모델 ID를 설정하세요.",
    "error.noModelSimple": "모델이 선택되지 않음.",
    "error.insufficientCredits": "크레딧이 부족합니다. 계정을 충전하세요.",
    "error.storageFull": "스토리지가 가득 찼습니다! 카드를 삭제하거나 내보내세요.",
    "gen.empty": "(비어있음)",
    "gen.free": "무료",
    "gen.unlimited": "무제한",
    "gen.notAvailable": "해당없음",
    "gen.unnamed": "이름 없음",
    "gen.byCreator": "{{name}} 제작",
    "gen.untagged": "태그 없음",
    "gen.noMatch": "필터와 일치하는 카드가 없습니다",
    "batch.deleteConfirm": "{{count}}장의 카드를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.",
    "left.selected": "{{count}}개 선택됨",
    "toast.cardDeleted": '카드 "{{name}}" 삭제됨',
    "ai.editing": "{{count}}개 필드 편집중...",
    "ai.streaming": "스트리밍중...",
    "ai.failed": "실패",
    "ai.cancelled": "취소됨.",
    "ai.doneSummary": "{{done}}/{{total}} 완료 · {{errs}} 실패",
    "ai.viewFullResult": "전체 결과 보기",
    "ai.showLess": "간략히 보기",
    "ai.reviewApply": "검토 및 적용",
    "ai.changesNav": "변경 {{current}} / {{total}}",
    "ai.changesPrev": "이전 변경",
    "ai.changesNext": "다음 변경",
    "ai.applied": "적용됨",
    "ai.target.tags": "태그",
    "ai.copy": "복사",
    "ai.copied": "복사됨!",
    "ai.copyFailed": "실패",
    "ai.resultTitle": "결과",
    "ai.close": "닫기",
    "editor.noGreetings": "아직 인사말이 없습니다. <strong>인사말 추가</strong>를 클릭하거나 AI를 사용하여 생성하세요.",
    "editor.noEntriesMatch": '"{{query}}"과(과) 일치하는 엔트리가 없습니다',
    "gen.copySuffix": " (복사)",
    "gen.toastAutoHide": "{{s}}초 후 자동 닫힘",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "출력 토큰 한도에 가까워짐 ({{tokens}}/{{max}}).",
    "editor.counterDanger": "출력 토큰 한도 초과 ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "패널 접기",
    "ui.expandPanel": "패널 펼치기",
    "ui.cardModified": "저장되지 않은 변경",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "채팅 기록",
    "ai.historyTitle": "채팅 기록",
    "ai.historyEmpty": "아직 대화가 없습니다",
    "ai.retry": "다시 시도",
    "ai.retryTitle": "이 응답 다시 생성",
    "ai.reapply": "다시 적용",
    "ai.reapplyTitle": "이 변경 사항을 적용하려면 diff를 다시 여세요",
    "wizard.editStep": "이 섹션 편집",
    "wizard.draftRestored": "초안 복원됨 — 이전 답변이 돌아왔습니다",
    "wizard.imagePlaceholder": "가져오기 클릭",
    "toast.noNameWarning": '경고: 카드에 이름이 없습니다. 파일이 "character.json"으로 저장됩니다.',
    "toast.redo": "다시 실행",
    "toast.reorderFiltered": "카드를 다시 정렬하려면 검색과 필터를 끄세요.",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.el = {
    "app.title": "ST Card Editor — Στούντιο καρτών χαρακτήρων SillyTavern",
    "nav.selectModel": "Επιλογή μοντέλου...",
    "nav.wizard": "Δημιουργία με AI βοηθό",
    "nav.newCard": "Νέα κενή κάρτα",
    "nav.save": "Αποθήκευση",
    "nav.theme": "Εναλλαγή θέματος",
    "nav.shortcuts": "Συντομεύσεις & βοήθεια",
    "nav.settings": "Ρυθμίσεις",
    "nav.focus": "Λειτουργία εστίασης",
    "nav.focusAlt": "Λειτουργία εστίασης (Alt+F)",
    "left.title": "Βιβλιοθήκη καρτών",
    "left.cards": "{{count}} κάρτες",
    "left.drop": "Σύρσιμο & αφή",
    "left.sort.manual": "Χειροκίνητα",
    "left.dropSub": "Κάρτες χαρακτήρων PNG ή JSON",
    "left.browse": "Περιήγηση αρχείων",
    "left.search": "Αναζήτηση καρτών...",
    "left.sort.nameAsc": "Όνομα A-Ω",
    "left.sort.nameDesc": "Όνομα Ω-Α",
    "left.sort.newest": "Νεότερα πρώτα",
    "left.sort.oldest": "Παλαιότερα πρώτα",
    "left.sort.largest": "Μεγαλύτερο",
    "left.sort.smallest": "Μικρότερο",
    "left.filterTags": "Φίλτρο ανά ετικέτες",
    "left.exportSelected": "Εξαγωγή επιλογής ως JSON",
    "left.deleteSelected": "Διαγραφή επιλογής",
    "left.empty": "Δεν υπάρχουν κάρτες",
    "left.emptySub": "Αφήστε μια κάρτα ή κάντε κλικ στην Περιήγηση",
    "center.noCard": "Δεν επιλέχθηκε κάρτα",
    "center.noCardSub": "Επιλέξτε μια κάρτα από τη βιβλιοθήκη ή σύρστε μια νέα",
    "center.createAI": "Δημιουργία με AI",
    "center.blankCard": "Κενή κάρτα",
    "editor.avatar": "Κάντε κλικ ή αφήστε μια εικόνα για ορισμό avatar",
    "editor.avatarAria": "Ορισμός avatar χαρακτήρα",
    "editor.name": "Όνομα χαρακτήρα",
    "editor.exportJson": "Εξαγωγή ως JSON",
    "editor.exportPng": "Εξαγωγή ως PNG",
    "editor.duplicate": "Διπλασιασμός κάρτας",
    "editor.delete": "Διαγραφή κάρτας",
    "editor.tab.core": "Πυρήνας",
    "editor.tab.personality": "Προσωπικότητα",
    "editor.tab.advanced": "Για ειδικούς",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Εικόνα Waifu",
    "editor.waifuPreview": "Τρέχουσα εικόνα κάρτας",
    "editor.waifuNoImage": "Δεν έχει οριστεί εικόνα ακόμα",
    "editor.waifuSource": "Πηγή εικόνας",
    "editor.waifuSourceSnap": "Στιγμιότυπα anime (waifu.im)",
    "editor.waifuSourceChar": "Χαρακτήρες anime (AniList)",
    "editor.waifuGender": "Φύλο",
    "editor.waifuGenderAll": "Όλα τα φύλα",
    "editor.waifuGenderFemaleOnly": "Μόνο γυναίκες",
    "editor.waifuGenderMaleOnly": "Μόνο άνδρες",
    "editor.waifuGenderFemale": "Θηλυκό",
    "editor.waifuGenderMale": "Αρσενικό",
    "editor.waifuCharSub": "αναζήτηση χαρακτήρα με όνομα (π.χ. zoro)",
    "editor.waifuSearch": "Αναζήτηση στο waifu.im",
    "editor.waifuSearchChar": "Αναζήτηση χαρακτήρων",
    "editor.waifuSearchPlaceholderChar": "αναζήτηση χαρακτήρα με όνομα (π.χ. zoro)",
    "editor.waifuSub": "(ανακτά εικόνες σε στυλ anime με ετικέτα)",
    "editor.waifuSearchPlaceholder": "π.χ. waifu, ξωτικό, υπηρέτρια...",
    "editor.waifuFetch": "Ανάκτηση εικόνων",
    "editor.waifuRegenTitle": "Αναδημιουργία αποτελεσμάτων",
    "editor.waifuMixed": "Γυναίκες + Άνδρες",
    "editor.waifuMixedSub": "εξισορροπημένο πακέτο με ένα κλικ: 3 θηλυκοί + 3 αρσενικοί χαρακτήρες",
    "editor.waifuUse": "Χρήση ως εικόνα κάρτας",
    "editor.waifuUpload": "Μεταφόρτωση από συσκευή",
    "editor.waifuRemove": "Αφαίρεση εικόνας",
    "toast.noImage": "Αυτή η κάρτα δεν έχει εικόνα για αφαίρεση",
    "toast.imageRemoved": "Η εικόνα αφαιρέθηκε",
    "editor.desc": "Περιγραφή",
    "editor.descSub": "(εμφάνιση, ιστορικό)",
    "editor.descPlaceholder": "Περιγράψτε την εμφάνιση, το υπόβαθρο και τα κύρια χαρακτηριστικά του χαρακτήρα...",
    "editor.firstMes": "Πρώτο μήνυμα",
    "editor.firstMesPlaceholder": "Το πρώτο μήνυμα του χαρακτήρα κατά την έναρξη συνομιλίας...",
    "editor.scenario": "Σενάριο",
    "editor.scenarioPlaceholder": "Τρέχουσες συνθήκες και πλαίσιο της συνομιλίας...",
    "editor.creator": "Δημιουργός",
    "editor.creatorPlaceholder": "Δημιουργός / συγγραφέας κάρτας",
    "editor.version": "Έκδοση χαρακτήρα",
    "editor.tags": "Ετικέτες",
    "editor.tagsSub": "(διαχωρισμένες με κόμμα)",
    "editor.tagsPlaceholder": "φαντασία, πολεμιστής, ξωτικό",
    "editor.personalitySummary": "Περίληψη προσωπικότητας",
    "editor.personalityPlaceholder": "Σύντομη περιγραφή της προσωπικότητας του χαρακτήρα... (χρησιμοποιείται στη μορφή κάρτας)",
    "editor.mesExample": "Παραδείγματα μηνυμάτων",
    "editor.mesExampleFormat": "Μορφή: μπλοκ <START> με προθέματα {{char}}: και {{user}}:",
    "editor.systemPrompt": "Prompt συστήματος",
    "editor.systemPromptPlaceholder": "Αντικατάσταση του prompt συστήματος. Χρησιμοποιήστε {{original}} για να συμπεριληφθεί το προεπιλεγμένο.",
    "editor.postHistory": "Οδηγίες μετά το ιστορικό",
    "editor.postHistoryPlaceholder": "Οδηγίες που εισάγονται μετά το ιστορικό συνομιλίας. Χρησιμοποιήστε {{original}} για το προεπιλεγμένο.",
    "editor.creatorNotes": "Σημειώσεις δημιουργού",
    "editor.creatorNotesPlaceholder": "Σημειώσεις για τους χρήστες (συστάσεις μοντέλων, συμβουλές χρήσης...)",
    "editor.greetings": "Εναλλακτικοί χαιρετισμοί",
    "editor.addGreeting": "Προσθήκη χαιρετισμού",
    "editor.lorebookTitle": "Καταχωρήσεις lorebook χαρακτήρα",
    "editor.addEntry": "Προσθήκη καταχώρησης",
    "editor.lorebookSearch": "Αναζήτηση καταχωρήσεων ανά κλειδί, περιεχόμενο ή σχόλιο...",
    "editor.lorebookEmpty": "Δεν υπάρχουν ακόμα καταχωρήσεις lorebook. Προσθέστε μια για να ξεκινήσετε.",
    "editor.edit": "Επεξεργασία",
    "editor.preview": "Προεπισκόπηση",
    "ai.title": "Βοηθός AI",
    "ai.clearChat": "Εκκαθάριση συνομιλίας",
    "ai.welcomeTitle": "Βοηθός AI καρτών",
    "ai.welcomeText": "Ζητήστε από το AI να επεξεργαστεί, μεταφράσει ή βελτιώσει την κάρτα χαρακτήρα σας.",
    "ai.quick.newCard": "Νέα κάρτα",
    "ai.quick.translate": "Μετάφραση",
    "ai.quick.enhance": "Βελτίωση",
    "ai.quick.shorten": "Σύντμηση",
    "ai.quick.tone": "Αλλαγή τόνου",
    "ai.quick.grammar": "Διόρθωση γραμματικής",
    "ai.quick.personality": "Επέκταση προσωπικότητας",
    "ai.quick.firstmes": "Βελτίωση πρώτου μηνύματος",
    "ai.quick.scenario": "Επέκταση σεναρίου",
    "ai.quick.greetings": "Δημιουργία χαιρετισμών",
    "ai.quick.systemprompt": "Ενίσχυση prompt συστήματος",
    "ai.quick.tags": "Πρόταση ετικετών",
    "ai.contextTitle": "Εκτιμώμενα token που χρησιμοποιήθηκαν vs όριο context μοντέλου",
    "ai.contextLabel": "— / — token",
    "ai.placeholder": "Ζητήστε από το AI να επεξεργαστεί την κάρτα...",
    "ai.send": "Αποστολή",
    "ai.stop": "Διακοπή δημιουργίας",
    "ai.autoModel": "Αυτόματο (χρήση μοντέλου μπάρας)",
    "ai.target": "Στόχος:",
    "ai.target.full": "Πλήρης κάρτα",
    "ai.target.description": "Περιγραφή",
    "ai.target.personality": "Προσωπικότητα",
    "ai.target.first_mes": "Πρώτο μήνυμα",
    "ai.target.scenario": "Σενάριο",
    "ai.target.mes_example": "Παραδείγματα μηνυμάτων",
    "ai.target.system_prompt": "Prompt συστήματος",
    "ai.target.post_history_instructions": "Οδηγίες μετά το ιστορικό",
    "ai.target.creator_notes": "Σημειώσεις δημιουργού",
    "ai.target.alternate_greetings": "Εναλλακτικοί χαιρετισμοί",
    "ai.selectModel": "Επιλογή μοντέλου",
    "ai.actionNewCard": "Νέα κάρτα",
    "ai.actionTranslate": "Μετάφραση",
    "ai.actionEnhance": "Βελτίωση",
    "ai.actionShorten": "Σύντμηση",
    "ai.actionTone": "Αλλαγή τόνου",
    "ai.actionGrammar": "Διόρθωση γραμματικής",
    "ai.actionPersonality": "Επέκταση χαρακτήρα",
    "ai.actionFirstMes": "Βελτίωση πρώτου μηνύματος",
    "ai.actionScenario": "Επέκταση σεναρίου",
    "ai.actionGreetings": "Δημιουργία χαιρετισμών",
    "ai.actionSystemprompt": "Ενίσχυση prompt συστήματος",
    "ai.actionTags": "Πρόταση ετικετών",
    "ai.noCard": "(δεν επιλέχθηκε κάρτα)",
    "settings.themeColor": "Χρώμα θέματος",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Επιλέξτε ξεχωριστό χρώμα έμφασης για κάθε φωτεινό/σκοτεινό θέμα. Οι αλλαγές εφαρμόζονται άμεσα.",
    "settings.appearance": "Εμφάνιση",
    "settings.accentPresets": "Προεπιλογές έμφασης",
    "settings.glassDensity": "Πυκνότητα γυαλιού",
    "settings.glassSubtle": "Διακριτικό",
    "settings.glassDefault": "Προεπιλογή",
    "settings.glassBold": "Έντονο",
    "settings.cardRadius": "Ακτίνα καρτών",
    "settings.radiusCompact": "Συμπαγές",
    "settings.radiusRounded": "Στρογγυλεμένο",
    "settings.radiusPill": "Χάπι",
    "settings.vignette": "Βινιέτα άκρων",
    "settings.appearanceHint": "Προσαρμόστε την εμφάνιση κάθε φωτεινού/σκούρου θέματος. Οι αλλαγές έμφασης ισχύουν άμεσα. Η πυκνότητα, η ακτίνα και η βινιέτα περιλαμβάνονται στα αντίγραφα ασφαλείας του χώρου εργασίας.",
    "settings.resetThemeColor": "Επαναφορά",
    "settings.generalTab": "Γενικά",
    "settings.promptsTab": "Προτροπές AI",
    "settings.assistantPrompt": "Προτροπή συστήματος του βοηθού",
    "settings.fullCardPrompt": "Προτροπή συστήματος ολόκληρης κάρτας",
    "settings.wizardPrompt": "Οδηγίες δημιουργίας χαρακτήρα",
    "settings.promptPlaceholder": "Αφήστε κενό για χρήση της ενσωματωμένης προτροπής",
    "settings.chatSystemPrompts": "Οδηγίες συνομιλίας και συστήματος",
    "settings.fullCardInstr": "Οδηγίες εξόδου πλήρους κάρτας (σύστημα)",
    "settings.fieldsEdit": "Οδηγίες επεξεργασίας πεδίου (σύστημα)",
    "settings.greetingsSystem": "Οδηγίες εξόδου χαιρετισμών (σύστημα)",
    "settings.exportPrompts": "Εξαγωγή προτροπών",
    "settings.importPrompts": "Εισαγωγή προτροπών",
    "settings.promptsExported": "Οι προτροπές εξήχθησαν",
    "settings.promptsImported": "Εισαγόμενες προτροπές: {count}",
    "settings.quickActionPrompts": "Προτροπές γρήγορων ενεργειών",
    "settings.tagsSystemPrompt": "Οδηγίες εξόδου ετικετών (σύστημα)",
    "settings.restoreDefaultPrompts": "Επαναφορά προεπιλεγμένων προτροπών",
    "settings.promptHint": "Αυτά τα πεδία εμφανίζουν τις τρέχουσες προτροπές. Αν ένα πεδίο είναι κενό, χρησιμοποιείται η ενσωματωμένη προεπιλεγμένη προτροπή. Επαναφέρετε τις προεπιλογές για να τις δείτε ή να τις επαναφέρετε.",
    "settings.title": "Ρυθμίσεις",
    "settings.provider": "Πάροχος",
    "settings.providerHint": "Πάροχοι φιλοξενούμενων μοντέλων ή προσαρμοσμένο endpoint (LM Studio, Ollama, κ.λπ.)",
    "settings.apiKey": "Κλειδί API",
    "settings.getApiKey": "Λάβετε το κλειδί API σας από το OpenRouter",
    "settings.baseUrl": "Βασική URL API",
    "settings.namedApiKeyPlaceholder": "Εισάγετε το κλειδί API σας",
    "settings.customHint": "Το endpoint συμβατό με OpenAI. Παραδείγματα: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "Κλειδί API (προαιρετικό)",
    "settings.apiKeyLocalPlaceholder": "Αφήστε κενό για τοπικούς παρόχους",
    "settings.apiKeyLocalHint": "Δεν απαιτείται για τοπικούς δικτυακούς εξυπηρετητές όπως LM Studio ή Ollama.",
    "settings.modelId": "ID μοντέλου",
    "settings.modelIdHint": "Το ακριβές ID μοντέλου που αναμένει ο πάροχός σας.",
    "settings.modelIdHintNamed": "Αφήστε κενό για χρήση του προεπιλεγμένου μοντέλου του παρόχου.",
    "settings.security": "Το κλειδί API σας είναι κρυπτογραφημένο στο localStorage του προγράμματος περιήγησης με κλειδί συνδεδεμένο σε αυτή τη διεύθυνση. Μην χρησιμοποιείτε αυτήν την εφαρμογή σε κοινόχρηστες συσκευές.",
    "settings.secretUnreadable": "Για λόγους ασφαλείας, ένα αποθηκευμένο κλειδί API δεν μπόρεσε να ξεκλειδωθεί σε αυτή τη διεύθυνση — εισάγετέ το ξανά στις Ρυθμίσεις.",
    "error.pngInflateFailed": "Αυτό το PNG περιέχει δεδομένα χαρακτήρα που δεν μπόρεσαν να αποσυμπιεστούν.",
    "settings.defaultModel": "Προεπιλεγμένο μοντέλο",
    "settings.browseModels": "Περιήγηση μοντέλων παρακάτω...",
    "settings.refreshModels": "Ανανέωση μοντέλων",
    "settings.maxTokens": "Μέγιστα token εξόδου",
    "settings.maxTokensPlaceholder": "0 = χρήση προεπιλογής μοντέλου",
    "settings.maxTokensHint": "Αντικατάσταση του μέγιστου αριθμού token εξόδου ανά αίτημα. Ορίστε σε 0 για αυτόματη χρήση του ορίου του επιλεγμένου μοντέλου (ή 64k αν άγνωστο).",
    "settings.copyright": "Εισαγωγή σήματος δημιουργού κατά την εξαγωγή",
    "settings.copyrightHint": "Προσθέτει μια γραμμή σήματος στις σημειώσεις δημιουργού κατά την εξαγωγή καρτών.",
    "settings.availableModels": "Διαθέσιμα μοντέλα",
    "settings.searchModels": "Αναζήτηση μοντέλων...",
    "settings.enterApiKey": "Εισάγετε το κλειδί API σας και ανανεώστε για φόρτωση μοντέλων",
    "settings.credits": "Πιστωτικά & χρήση",
    "settings.creditLimit": "Όριο πιστωτικών",
    "settings.remaining": "Υπόλοιπο",
    "settings.usedMonth": "Χρήση αυτόν τον μήνα",
    "settings.localStorage": "Τοπική αποθήκευση",
    "settings.clearAll": "Εκκαθάριση όλων των δεδομένων",
    "settings.export": "Εξαγωγή",
    "settings.import": "Εισαγωγή",
    "settings.close": "Κλείσιμο",
    "settings.saveSettings": "Αποθήκευση ρυθμίσεων",
    "settings.languageLabel": "Γλώσσα",
    "settings.languageHint": "Γλώσσα διεπαφής (ανανεώστε τη σελίδα αν λείπει)",
    "settings.languageChanged": "Η γλώσσα ενημερώθηκε",
    "settings.clearConfirm": "Διαγραφή ΟΛΩΝ των καρτών, ρυθμίσεων και ιστορικού συνομιλίας; Αυτή η ενέργεια δεν μπορεί να αναιρεθεί.",
    "settings.providerCustom": "Προσαρμοσμένο (συμβατό με OpenAI)",
    "settings.noModels": "Δεν βρέθηκαν μοντέλα",
    "settings.loadMore": "Φόρτωση περισσότερων ({{count}} υπόλοιπα)",
    "settings.showingModels": "Εμφάνιση {{shown}} από {{total}} μοντέλα",
    "wizard.title": "Δημιουργία χαρακτήρα",
    "wizard.step.basics": "Βασικά",
    "wizard.step.concept": "Έννοια",
    "wizard.step.personality": "Προσωπικότητα",
    "wizard.step.scenario": "Σενάριο",
    "wizard.step.generate": "Δημιουργία",
    "wizard.basicsTitle": "Βασικά χαρακτήρα",
    "wizard.nameLabel": "Όνομα χαρακτήρα",
    "wizard.namePlaceholder": "π.χ. Ελάρα Νάιτγουισπερ",
    "wizard.genderLabel": "Φύλο / Αντωνυμίες",
    "wizard.genderSelect": "Επιλογή...",
    "wizard.gender.female": "Θηλυκό (αυτή)",
    "wizard.gender.male": "Αρσενικό (αυτός)",
    "wizard.gender.nonbinary": "Μη δυαδικό (αυτοί)",
    "wizard.gender.other": "Άλλο...",
    "wizard.genderCustom": "Προσαρμοσμένες αντωνυμίες (π.χ. αυτό)",
    "wizard.tagsLabel": "Ετικέτες",
    "wizard.tagsSub": "(διαχωρισμένες με κόμμα, βοηθά στην οργάνωση της βιβλιοθήκης)",
    "wizard.tagsPlaceholder": "φαντασία, πολεμιστής, ξωτικό, πρωτότυπο",
    "wizard.creatorLabel": "Δημιουργός",
    "wizard.creatorPlaceholder": "Το όνομά σας / ψευδώνυμο",
    "wizard.conceptTitle": "Έννοια & ρύθμιση",
    "wizard.typeLabel": "Τύπος χαρακτήρα",
    "wizard.type.original": "Πρωτότυπος χαρακτήρας",
    "wizard.type.fanfic": "Fan Fiction",
    "wizard.type.game": "Χαρακτήρας παιχνιδιού",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Βιβλίο / Ταινία / Σειρά",
    "wizard.type.historical": "Ιστορικό πρόσωπο",
    "wizard.type.mythological": "Μυθολογικό / Λαϊκός πολιτισμός",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Άλλο",
    "wizard.languageLabel": "Γλώσσα",
    "wizard.language.other": "Άλλο",
    "wizard.languageSpecify": "Ορισμός γλώσσας",
    "wizard.genreLabel": "Είδος / Κόσμος",
    "wizard.genreSub": "(επιλέξτε όλα όσα ισχύουν)",
    "wizard.moodLabel": "Διάθεση / Τόνος",
    "wizard.moodSub": "(επιλέξτε όλα όσα ισχύουν)",
    "wizard.personalityTitle": "Προσωπικότητα & εμφάνιση",
    "wizard.personalityTraits": "Χαρακτηριστικά προσωπικότητας",
    "wizard.personalityTraitsSub": "(περιγράψτε 3-5 κύρια χαρακτηριστικά, αυτό βοηθά το AI)",
    "wizard.personalityTraitsPlaceholder": "π.χ. Γενναίος αλλά απρόσεκτος, πιστός στους φίλους, ξηρός χιούμορ, δυσκολεύεται να εμπιστευτεί, κρυφά αγαπά τα ζώα",
    "wizard.appearanceLabel": "Φυσική εμφάνιση",
    "wizard.appearanceSub": "(σύντομη περιγραφή της εμφάνισης)",
    "wizard.appearancePlaceholder": "π.χ. Ψηλή γυναίκα με ασημένια μαλλιά μέχρι τη μέση, σημαδεμένα χέρια, σκούρο δερμάτινο μπουφάν, διεισδυτικά πράσινα μάτια",
    "wizard.abilitiesLabel": "Ειδικές ικανότητες / Ιδιοσυγκρασίες",
    "wizard.abilitiesSub": "(προαιρετικό, μοναδικά χαρακτηριστικά)",
    "wizard.abilitiesPlaceholder": "π.χ. Μπορεί να μιλήσει στα ζώα, έχει φωτογραφική μνήμη, κουβαλά πάντα ένα φθαρμένο ημερολόγιο",
    "wizard.scenarioTitle": "Σενάριο & πρώτο μήνυμα",
    "wizard.scenarioLabel": "Σενάριο / Ρύθμιση",
    "wizard.scenarioSub": "(πού ξεκινά η ιστορία;)",
    "wizard.scenarioPlaceholder": "π.χ. Μια βροχερή νύχτα σε μια πόλη με νεόν. Ο χαρακτήρας διατηρεί ένα μικρό κατάστημα επισκευής που φτιάχνει μηχανές και σπασμένες καρδιές.",
    "wizard.relationshipLabel": "Σχέση με {{user}}",
    "wizard.relationshipSub": "(πώς βλέπει ο χαρακτήρας τον χρήστη;)",
    "wizard.relationshipPlaceholder": "π.χ. Ένας νέος πελάτης που μπήκε στο κατάστημα με μια μυστηριώδη χαλασμένη συσκευή. Ο χαρακτήρας είναι περίεργος αλλά προσεκτικός.",
    "wizard.openingLabel": "Διάθεση πρώτου μηνύματος",
    "wizard.openingSub": "(πώς θα πρέπει να φαίνεται το μήνυμα ενάρξεως;)",
    "wizard.notesLabel": "Πρόσθετες σημειώσεις",
    "wizard.notesSub": "(κάτι ακόμα που πρέπει να ξέρει το AI;)",
    "wizard.notesPlaceholder": "π.χ. Φυσικός διάλογος, όχι υπερβολικά επίσημος, περιγραφές ενεργειών με αστερίσκους",
    "wizard.generateTitle": "Δημιουργία χαρακτήρα",
    "wizard.refImage": "Εικόνα αναφοράς",
    "wizard.refImageSub": "(προαιρετικό, από waifu.im)",
    "wizard.fetchImages": "Λήψη 3 εικόνων",
    "wizard.refetchOthers": "Νέα λήψη άλλων",
    "wizard.fetching": "Λήψη...",
    "wizard.useSelected": "Χρήση επιλογής",
    "wizard.clear": "Εκκαθάριση",
    "wizard.generateAI": "Δημιουργία με AI",
    "wizard.generateAISub": "Πλήρης κάρτα χαρακτήρα από τις απαντήσεις σας",
    "wizard.createBlank": "Δημιουργία κενής κάρτας",
    "wizard.createBlankSub": "Εκκίνηση με προσυμπληρωμένο όνομα και ετικέτες",
    "wizard.back": "Πίσω",
    "wizard.next": "Επόμενο",
    "wizard.stepLabel": "Βήμα {{step}} από {{total}}",
    "wizard.ready": "Έτοιμο για δημιουργία!",
    "wizard.nameRequired": "Εισάγετε ένα όνομα χαρακτήρα",
    "wizard.summary.name": "Όνομα",
    "wizard.summary.gender": "Φύλο",
    "wizard.summary.type": "Τύπος",
    "wizard.summary.language": "Γλώσσα",
    "wizard.summary.tags": "Ετικέτες",
    "wizard.summary.genres": "Είδη",
    "wizard.summary.mood": "Διάθεση",
    "wizard.summary.opening": "Έναρξη",
    "wizard.summary.personality": "Προσωπικότητα",
    "wizard.summary.appearance": "Εμφάνιση",
    "wizard.summary.scenario": "Σενάριο",
    "wizard.summary.relationship": "Σχέση",
    "wizard.summary.notes": "Σημειώσεις",
    "wizard.chip.fantasy": "Φαντασία",
    "wizard.chip.scifi": "Επιστημονική φαντασία",
    "wizard.chip.modern": "Σύγχρονο",
    "wizard.chip.historical": "Ιστορικό",
    "wizard.chip.horror": "Τρόμος",
    "wizard.chip.romance": "Ρομαντισμός",
    "wizard.chip.comedy": "Κωμωδία",
    "wizard.chip.sliceOfLife": "Καθημερινή ζωή",
    "wizard.chip.adventure": "Περιπέτεια",
    "wizard.chip.mystery": "Μυστήριο",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Μετα-αποκαλυπτικό",
    "wizard.chip.supernatural": "Υπερφυσικό",
    "wizard.chip.military": "Στρατιωτικό",
    "wizard.chip.surreal": "Υπερπραγματικό",
    "wizard.chip.serious": "Σοβαρό",
    "wizard.chip.playful": "Παιχνιδιάρικο",
    "wizard.chip.dark": "Σκοτεινό",
    "wizard.chip.lighthearted": "Ελαφρύ",
    "wizard.chip.mysterious": "Μυστηριώδες",
    "wizard.chip.romantic": "Ρομαντικό",
    "wizard.chip.intense": "Έντονο",
    "wizard.chip.wholesome": "Υγιεινό",
    "wizard.chip.chaotic": "Χαοτικό",
    "wizard.chip.melancholic": "Μελαγχολικό",
    "wizard.chip.sarcastic": "Σαρκαστικό",
    "wizard.chip.stoic": "Στωικό",
    "wizard.chip.greeting": "Θερμός χαιρετισμός",
    "wizard.chip.action": "In Media Res",
    "wizard.chip.question": "Περίεργη ερώτηση",
    "wizard.chip.conflict": "Άμεση σύγκρουση",
    "wizard.chip.atmospheric": "Ατμοσφαιρικό",
    "diff.title": "Προεπισκόπηση απάντησης AI",
    "diff.removed": "Αφαιρέθηκε",
    "diff.added": "Προστέθηκε",
    "diff.current": "Τρέχον",
    "diff.proposed": "Προτεινόμενο",
    "diff.empty": "(κενό)",
    "diff.discard": "Απόρριψη",
    "diff.apply": "Εφαρμογή αλλαγών",
    "shortcuts.title": "Συντομεύσεις",
    "shortcuts.save": "Αποθήκευση κάρτας",
    "shortcuts.newCard": "Νέα κάρτα",
    "shortcuts.undo": "Αναίρεση",
    "shortcuts.redo": "Επαναφορά",
    "shortcuts.sendAi": "Αποστολή μηνύματος AI",
    "shortcuts.newLine": "Νέα γραμμή στο AI",
    "shortcuts.focus": "Λειτουργία εστίασης",
    "shortcuts.collapsePanel": "Σύμπτυξη/Ανάπτυξη πίνακα AI",
    "toast.loadFailed": "Αποτυχία: {{name}}",
    "toast.loaded": "Φορτώθηκαν {{count}} κάρτες",
    "toast.importDupe": "Ίδιο περιεχόμενο με υπάρχουσα κάρτα — εισήχθη ως {{name}}",
    "toast.largeImage": "Μεγάλη εικόνα ενσωματωμένη στο {{name}} ({{size}} MB) - σκεφτείτε να την αφαιρέσετε για εξοικονόμηση χώρου.",
    "toast.noValid": "Δεν βρέθηκαν έγκυρες κάρτες. Αφήστε αρχεία PNG ή JSON.",
    "toast.noSelected": "Δεν επιλέχθηκαν κάρτες",
    "toast.cardsDeleted": "Κάρτες διαγράφηκαν",
    "toast.deleteFailed": "Αποτυχία διαγραφής της κάρτας",
    "toast.exported": "Εξήχθησαν {{count}} κάρτες",
    "toast.newBlank": "Δημιουργήθηκε νέα κενή κάρτα",
    "toast.noCardSave": "Δεν υπάρχει κάρτα για αποθήκευση",
    "toast.cardSaved": "Η κάρτα αποθηκεύτηκε!",
    "toast.noCardDup": "Δεν υπάρχει κάρτα για διπλασιασμό",
    "toast.cardDup": "Η κάρτα διπλασιάστηκε",
    "toast.cardRestored": "Η κάρτα αποκαταστάθηκε",
    "toast.selectCard": "Επιλέξτε μια κάρτα πρώτα",
    "toast.avatarUpdated": "Το avatar ενημερώθηκε",
    "toast.imgFailed": "Αποτυχία φόρτωσης εικόνας",
    "toast.firstMesUpdated": "Το πρώτο μήνυμα ενημερώθηκε!",
    "toast.settingsSaved": "Οι ρυθμίσεις αποθηκεύτηκαν!",
    "toast.modelsFailed": "Αποτυχία φόρτωσης μοντέλων: {{error}}",
    "toast.modelSet": "Μοντέλο ορίστηκε: {{model}}",
    "toast.dataCleared": "Όλα τα δεδομένα εκκαθαρίστηκαν",
    "toast.settingsExported": "Οι ρυθμίσεις εξήχθησαν",
    "toast.settingsImported": "Οι ρυθμίσεις εισήχθησαν!",
    "toast.invalidFile": "Μη έγκυρο αρχείο ρυθμίσεων",
    "toast.apiKey": "Ορίστε το κλειδί API σας στις Ρυθμίσεις",
    "toast.selectModel": "Παρακαλώ επιλέξτε ένα μοντέλο από τη μπάρα πλοήγησης ή τις ρυθμίσεις πρώτα.",
    "toast.genStopped": "Η δημιουργία σταμάτησε.",
    "toast.aiError": "Σφάλμα AI: {{error}}",
    "toast.cardUpdatedAI": "Η κάρτα ενημερώθηκε από την απάντηση AI!",
    "toast.jsonParseFailed": "Αδυναμία ανάλυσης της απάντησης AI ως JSON. Ελέγξτε τη συνομιλία.",
    "toast.emptyResponse": "Η AI επέστρεψε κενό περιεχόμενο — τίποτα να εφαρμοστεί.",
    "toast.jsonInvalid": "Το AI δεν επέστρεψε έγκυρο JSON. Η απάντηση είναι στη συνομιλία — μπορείτε να την αντιγράψετε χειροκίνητα.",
    "toast.fieldUpdated": '"{{field}}" ενημερώθηκε!',
    "toast.selectField": "Επιλέξτε τουλάχιστον ένα πεδίο για επεξεργασία",
    "toast.tooManyFields": "Πάρα πολλά πεδία επιλεγμένα. Μέγιστο {{max}} ταυτόχρονα.",
    "toast.greetingsUpdated": "{{count}} χαιρετισμός(οί) δημιουργήθηκε(αν)!",
    "toast.tagsUpdated": "Ενημέρωση ετικετών — προστέθηκαν {{count}} νέες!",
    "toast.greetingsParseFailed": "Δεν ήταν δυνατή η ανάλυση των χαιρετισμών από την απάντηση AI.",
    "toast.createCardFirst": "Δημιουργήστε ή επιλέξτε μια κάρτα πρώτα",
    "toast.wizardCreated": "Η κάρτα δημιουργήθηκε! Ξεκινήστε την επεξεργασία ή χρησιμοποιήστε AI για να συμπληρώσετε τις λεπτομέρειες.",
    "toast.wizardApi": "Ορίστε το κλειδί API σας στις Ρυθμίσεις πρώτα",
    "toast.wizardModel": "Επιλέξτε ένα μοντέλο ή ορίστε ένα προσαρμοσμένο ID μοντέλου στις Ρυθμίσεις",
    "toast.wizardFetchFailed": "Αποτυχία λήψης εικόνων: {{error}}",
    "toast.wizardName": "Παρακαλώ εισάγετε ένα όνομα χαρακτήρα",
    "toast.storageFull": "Η αποθήκευση είναι γεμάτη! Δοκιμάστε να αφαιρέσετε ή να εξάγετε κάποιες κάρτες.",
    "toast.exportedJson": "Εξήχθη ως JSON!",
    "toast.exportedPng": "Εξήχθη ως PNG με δεδομένα κάρτας!",
    "toast.exportFailed": "Αποτυχία εξαγωγής εικόνας. Επιστροφή σε JSON.",
    "toast.chatCleared": "Η συνομιλία εκκαθαρίστηκε",
    "toast.undo": "Αναίρεση",
    "error.apiKeyNotSet": "Το κλειδί API δεν έχει οριστεί. Εισάγετε το κλειδί API στις Ρυθμίσεις.",
    "error.customUrlNotSet": "Η βασική διεύθυνση URL της προσαρμοσμένης API δεν έχει οριστεί. Ανοίξτε Ρυθμίσεις → Προσαρμοσμένη (συμβατή με OpenAI) και εισάγετε τη διεύθυνση URL του endpoint (π.χ. http://localhost:1234/v1).",
    "error.customServerError": "Ο διακομιστής επέστρεψε σφάλμα: {{detail}}",
    "error.customAuthFailed": "Αποτυχία ελέγχου ταυτότητας (HTTP {{status}}). Ελέγξτε το κλειδί API για αυτό το endpoint.",
    "error.customPathNotFound": "Το endpoint δεν βρέθηκε (HTTP 404). Ελέγξτε αν η βασική διεύθυνση URL της API είναι πλήρης (π.χ. περιλαμβάνει /v1).",
    "error.customUnreachable": "Δεν είναι δυνατή η πρόσβαση στο {{url}}. Ελέγξτε ότι ο διακομιστής εκτελείται και ότι η βασική διεύθυνση URL της API είναι σωστή και προσβάσιμη από αυτή τη συσκευή.",
    "error.noModel": "Δεν επιλέχθηκε μοντέλο. Παρακαλώ επιλέξτε ένα μοντέλο ή ορίστε ένα ID μοντέλου στις Ρυθμίσεις.",
    "error.noModelSimple": "Δεν επιλέχθηκε μοντέλο.",
    "error.insufficientCredits": "Ανεπαρκή πιστωτικά. Παρακαλώ προσθέστε χρήματα στον λογαριασμό σας.",
    "error.storageFull": "Η αποθήκευση είναι γεμάτη! Δοκιμάστε να αφαιρέσετε ή να εξάγετε κάποιες κάρτες.",
    "gen.empty": "(κενό)",
    "gen.free": "Δωρεάν",
    "gen.unlimited": "Απεριόριστο",
    "gen.notAvailable": "Μ/Δ",
    "gen.unnamed": "Χωρίς όνομα",
    "gen.byCreator": "από {{name}}",
    "gen.untagged": "Δεν βρέθηκαν ετικέτες",
    "gen.noMatch": "Καμία κάρτα δεν ταιριάζει στα φίλτρα σας",
    "batch.deleteConfirm": "Διαγραφή {{count}} κάρτα(s); Αυτή η ενέργεια δεν μπορεί να αναιρεθεί.",
    "left.selected": "{{count}} επιλεγμένες",
    "toast.cardDeleted": 'Η κάρτα "{{name}}" διαγράφηκε',
    "ai.editing": "Επεξεργασία {{count}} πεδίου/ων...",
    "ai.streaming": "ροή...",
    "ai.failed": "απέτυχε",
    "ai.cancelled": "Ακυρώθηκε.",
    "ai.doneSummary": "{{done}}/{{total}} έγιναν · {{errs}} απέτυχαν",
    "ai.viewFullResult": "Προβολή πλήρους αποτελέσματος",
    "ai.showLess": "Εμφάνιση λιγότερων",
    "ai.reviewApply": "Ανασκόπηση & Εφαρμογή",
    "ai.changesNav": "Αλλαγή {{current}} από {{total}}",
    "ai.changesPrev": "Προηγούμενη αλλαγή",
    "ai.changesNext": "Επόμενη αλλαγή",
    "ai.applied": "Εφαρμόστηκε",
    "ai.target.tags": "Ετικέτες",
    "ai.copy": "Αντιγραφή",
    "ai.copied": "Αντιγράφηκε!",
    "ai.copyFailed": "Απέτυχε",
    "ai.resultTitle": "Αποτέλεσμα",
    "ai.close": "Κλείσιμο",
    "editor.noGreetings": "Δεν υπάρχουν ακόμα χαιρετισμοί. <strong>Προσθέστε έναν χαιρετισμό</strong> ή χρησιμοποιήστε AI για δημιουργία.",
    "editor.noEntriesMatch": 'Δεν υπάρχουν εγγραφές που να ταιριάζουν με "{{query}}"',
    "gen.copySuffix": " (Αντίγραφο)",
    "gen.toastAutoHide": "Αυτόματη απόκρυψη σε {{s}}δ",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "Πλησιάζει το όριο token εξόδου ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Υπερβαίνει το όριο token εξόδου ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "Σύμπτυξη πίνακα",
    "ui.expandPanel": "Ανάπτυξη πίνακα",
    "ui.cardModified": "Μη αποθηκευμένες αλλαγές",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "Ιστορικό συνομιλίας",
    "ai.historyTitle": "Ιστορικό συνομιλίας",
    "ai.historyEmpty": "Δεν υπάρχουν ακόμη συνομιλίες",
    "ai.retry": "Επανάληψη",
    "ai.retryTitle": "Αναδημιουργία αυτής της απάντησης",
    "ai.reapply": "Εκ νέου εφαρμογή",
    "ai.reapplyTitle": "Ανοίξτε ξανά το diff για να εφαρμόσετε αυτές τις αλλαγές",
    "wizard.editStep": "Επεξεργασία αυτής της ενότητας",
    "wizard.draftRestored": "Το προσχέδιο αποκαταστάθηκε — οι προηγούμενες απαντήσεις σας επέστρεψαν",
    "wizard.imagePlaceholder": "Κάντε κλικ στη Λήψη",
    "toast.noNameWarning": 'Προειδοποίηση: Η κάρτα δεν έχει όνομα. Το αρχείο θα αποθηκευτεί ως "character.json".',
    "toast.redo": "Επανάληψη",
    "toast.reorderFiltered": "Απενεργοποιήστε την αναζήτηση και τα φίλτρα για να αναδιατάξετε τις κάρτες.",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.ru = {
    "app.title": "ST Card Editor — Студия карт персонажей SillyTavern",
    "nav.selectModel": "Выбрать модель...",
    "nav.wizard": "Создать с помощью ИИ-помощника",
    "nav.newCard": "Новая пустая карточка",
    "nav.save": "Сохранить",
    "nav.theme": "Переключить тему",
    "nav.shortcuts": "Горячие клавиши и помощь",
    "nav.settings": "Настройки",
    "nav.focus": "Режим фокуса",
    "nav.focusAlt": "Режим фокуса (Alt+F)",
    "left.title": "Библиотека карточек",
    "left.cards": "{{count}} карточек",
    "left.sort.manual": "Вручную",
    "left.drop": "Перетащите",
    "left.dropSub": "Карточки персонажей PNG или JSON",
    "left.browse": "Обзор файлов",
    "left.search": "Поиск карточек...",
    "left.sort.nameAsc": "Имя А-Я",
    "left.sort.nameDesc": "Имя Я-А",
    "left.sort.newest": "Сначала новые",
    "left.sort.oldest": "Сначала старые",
    "left.sort.largest": "Сначала большие",
    "left.sort.smallest": "Сначала маленькие",
    "left.filterTags": "Фильтр по тегам",
    "left.exportSelected": "Экспортировать выбранные как JSON",
    "left.deleteSelected": "Удалить выбранные",
    "left.empty": "Нет загруженных карточек",
    "left.emptySub": "Перетащите карточку или нажмите «Обзор»",
    "center.noCard": "Карточка не выбрана",
    "center.noCardSub": "Выберите карточку из библиотеки или перетащите новую",
    "center.createAI": "Создать с ИИ",
    "center.blankCard": "Пустая карточка",
    "editor.avatar": "Нажмите или перетащите изображение для аватара",
    "editor.avatarAria": "Установить аватар персонажа",
    "editor.name": "Имя персонажа",
    "editor.exportJson": "Экспорт в JSON",
    "editor.exportPng": "Экспорт в PNG",
    "editor.duplicate": "Дублировать карточку",
    "editor.delete": "Удалить карточку",
    "editor.tab.core": "Основное",
    "editor.tab.personality": "Характер",
    "editor.tab.advanced": "Дополнительно",
    "editor.tab.lorebook": "Лорбук",
    "editor.tab.waifu": "Изображение Waifu",
    "editor.waifuPreview": "Текущее изображение карточки",
    "editor.waifuNoImage": "Изображение ещё не задано",
    "editor.waifuSource": "Источник изображения",
    "editor.waifuSourceSnap": "Аниме-снимки (waifu.im)",
    "editor.waifuSourceChar": "Аниме-персонажи (AniList)",
    "editor.waifuGender": "Пол",
    "editor.waifuGenderAll": "Любой пол",
    "editor.waifuGenderFemaleOnly": "Только женщины",
    "editor.waifuGenderMaleOnly": "Только мужчины",
    "editor.waifuGenderFemale": "Женский",
    "editor.waifuGenderMale": "Мужской",
    "editor.waifuCharSub": "поиск персонажа по имени (например, zoro)",
    "editor.waifuSearch": "Поиск на waifu.im",
    "editor.waifuSearchChar": "Поиск персонажей",
    "editor.waifuSearchPlaceholderChar": "поиск персонажа по имени (например, zoro)",
    "editor.waifuSub": "(получает изображения в аниме-стиле по тегу)",
    "editor.waifuSearchPlaceholder": "например: waifu, эльф, служанка...",
    "editor.waifuFetch": "Получить изображения",
    "editor.waifuRegenTitle": "Перегенерировать результаты",
    "editor.waifuMixed": "Женщины + Мужчины",
    "editor.waifuMixedSub": "сбалансированный набор в один клик: 3 женских + 3 мужских персонажа",
    "editor.waifuUse": "Использовать как изображение карточки",
    "editor.waifuUpload": "Загрузить с устройства",
    "editor.waifuRemove": "Удалить изображение",
    "toast.noImage": "У этой карточки нет изображения для удаления",
    "toast.imageRemoved": "Изображение удалено",
    "editor.desc": "Описание",
    "editor.descSub": "(внешность, предыстория)",
    "editor.descPlaceholder": "Опишите внешность, предысторию и основные черты персонажа...",
    "editor.firstMes": "Первое сообщение",
    "editor.firstMesPlaceholder": "Первое сообщение персонажа при начале чата...",
    "editor.scenario": "Сценарий",
    "editor.scenarioPlaceholder": "Текущие обстоятельства и контекст разговора...",
    "editor.creator": "Автор",
    "editor.creatorPlaceholder": "Автор / создатель карточки",
    "editor.version": "Версия персонажа",
    "editor.tags": "Теги",
    "editor.tagsSub": "(через запятую)",
    "editor.tagsPlaceholder": "фэнтези, воин, эльф",
    "editor.personalitySummary": "Краткая характеристика",
    "editor.personalityPlaceholder": "Краткое описание характера персонажа... (используется в формате карточки)",
    "editor.mesExample": "Примеры сообщений",
    "editor.mesExampleFormat": "Формат: блоки <START> с префиксами {{char}}: и {{user}}:",
    "editor.systemPrompt": "Системный промпт",
    "editor.systemPromptPlaceholder": "Переопределить системный промпт. Используйте {{original}} для включения значения по умолчанию.",
    "editor.postHistory": "Инструкции после истории",
    "editor.postHistoryPlaceholder": "Инструкции, вставляемые после истории чата. Используйте {{original}} для значения по умолчанию.",
    "editor.creatorNotes": "Заметки автора",
    "editor.creatorNotesPlaceholder": "Заметки для пользователей (рекомендации моделей, советы...)",
    "editor.greetings": "Альтернативные приветствия",
    "editor.addGreeting": "Добавить приветствие",
    "editor.lorebookTitle": "Записи лорбука персонажа",
    "editor.addEntry": "Добавить запись",
    "editor.lorebookSearch": "Поиск записей по ключу, содержимому или комментарию...",
    "editor.lorebookEmpty": "Записей в лорбуке пока нет. Добавьте первую.",
    "editor.edit": "Редактировать",
    "editor.preview": "Предпросмотр",
    "ai.title": "ИИ-помощник",
    "ai.clearChat": "Очистить чат",
    "ai.welcomeTitle": "ИИ-помощник карточек",
    "ai.welcomeText": "Попросите ИИ отредактировать, перевести или улучшить вашу карточку персонажа.",
    "ai.quick.newCard": "Новая карточка",
    "ai.quick.translate": "Перевести",
    "ai.quick.enhance": "Улучшить",
    "ai.quick.shorten": "Сократить",
    "ai.quick.tone": "Изменить тон",
    "ai.quick.grammar": "Исправить грамматику",
    "ai.quick.personality": "Расширить характер",
    "ai.quick.firstmes": "Улучшить первое сообщение",
    "ai.quick.scenario": "Расширить сценарий",
    "ai.quick.greetings": "Создать приветствия",
    "ai.quick.systemprompt": "Улучшить системный промпт",
    "ai.quick.tags": "Предложить теги",
    "ai.contextTitle": "Примерные токены vs лимит контекста модели",
    "ai.contextLabel": "— / — токенов",
    "ai.placeholder": "Попросите ИИ отредактировать карточку...",
    "ai.send": "Отправить",
    "ai.stop": "Остановить генерацию",
    "ai.autoModel": "Авто (модель из навигации)",
    "ai.target": "Цель:",
    "ai.target.full": "Полная карточка",
    "ai.target.description": "Описание",
    "ai.target.personality": "Характер",
    "ai.target.first_mes": "Первое сообщение",
    "ai.target.scenario": "Сценарий",
    "ai.target.mes_example": "Примеры сообщений",
    "ai.target.system_prompt": "Системный промпт",
    "ai.target.post_history_instructions": "Инструкции после истории",
    "ai.target.creator_notes": "Заметки автора",
    "ai.target.alternate_greetings": "Альтернативные приветствия",
    "ai.selectModel": "Выберите модель",
    "ai.actionNewCard": "Новая карта",
    "ai.actionTranslate": "Перевести",
    "ai.actionEnhance": "Улучшить",
    "ai.actionShorten": "Сократить",
    "ai.actionTone": "Изменить тон",
    "ai.actionGrammar": "Исправить грамматику",
    "ai.actionPersonality": "Развить характер",
    "ai.actionFirstMes": "Улучшить первое сообщение",
    "ai.actionScenario": "Расширить сценарий",
    "ai.actionGreetings": "Создать приветствия",
    "ai.actionSystemprompt": "Улучшить системный промпт",
    "ai.actionTags": "Предложить теги",
    "ai.noCard": "(карточка не выбрана)",
    "settings.themeColor": "Цвет темы",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Выберите отдельный акцентный цвет для светлой и тёмной темы. Изменения применяются сразу.",
    "settings.appearance": "Внешний вид",
    "settings.accentPresets": "Пресеты акцента",
    "settings.glassDensity": "Плотность стекла",
    "settings.glassSubtle": "Тонкий",
    "settings.glassDefault": "По умолчанию",
    "settings.glassBold": "Смелый",
    "settings.cardRadius": "Радиус карточек",
    "settings.radiusCompact": "Компактный",
    "settings.radiusRounded": "Скруглённый",
    "settings.radiusPill": "Пилюля",
    "settings.vignette": "Виньетка по краям",
    "settings.appearanceHint": "Настройте внешний вид для каждой светлой/тёмной темы. Изменения акцента применяются сразу; плотность, радиус и виньетка включаются в резервные копии рабочей области.",
    "settings.resetThemeColor": "Сбросить",
    "settings.generalTab": "Общие",
    "settings.promptsTab": "ИИ-промпты",
    "settings.assistantPrompt": "Системный промпт ассистента",
    "settings.fullCardPrompt": "Системный промпт всей карточки",
    "settings.wizardPrompt": "Инструкции генерации персонажа",
    "settings.promptPlaceholder": "Оставьте пустым, чтобы использовать встроенный промпт",
    "settings.chatSystemPrompts": "Инструкции чата и системы",
    "settings.fullCardInstr": "Инструкции вывода полной карточки (система)",
    "settings.fieldsEdit": "Инструкции редактирования поля (система)",
    "settings.greetingsSystem": "Инструкции вывода приветствий (система)",
    "settings.exportPrompts": "Экспортировать промпты",
    "settings.importPrompts": "Импортировать промпты",
    "settings.promptsExported": "Промпты экспортированы",
    "settings.promptsImported": "Импортировано промптов: {count}",
    "settings.quickActionPrompts": "Промпты быстрых действий",
    "settings.tagsSystemPrompt": "Инструкции вывода тегов (система)",
    "settings.restoreDefaultPrompts": "Восстановить промпты по умолчанию",
    "settings.promptHint": "В этих полях показаны текущие промпты. Если поле пусто, используется встроенный промпт по умолчанию. Нажмите «Восстановить по умолчанию», чтобы просмотреть или вернуть исходные промпты.",
    "settings.title": "Настройки",
    "settings.provider": "Провайдер",
    "settings.providerHint": "Провайдеры моделей или пользовательский эндпоинт (LM Studio, Ollama и т.д.)",
    "settings.apiKey": "API-ключ",
    "settings.getApiKey": "Получите API-ключ на OpenRouter",
    "settings.baseUrl": "Базовый URL API",
    "settings.namedApiKeyPlaceholder": "Введите ваш API-ключ",
    "settings.customHint": "Совместимый с OpenAI эндпоинт. Примеры: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API-ключ (необязательно)",
    "settings.apiKeyLocalPlaceholder": "Оставьте пустым для локальных провайдеров",
    "settings.apiKeyLocalHint": "Не нужен для локальных серверов вроде LM Studio или Ollama.",
    "settings.modelId": "ID модели",
    "settings.modelIdHint": "Точный ID модели, который ожидает ваш провайдер.",
    "settings.modelIdHintNamed": "Оставьте пустым для использования модели по умолчанию.",
    "settings.security": "Ваш API-ключ хранится в зашифрованном виде в localStorage браузера (ключ привязан к этому адресу). Не используйте это приложение на общих устройствах.",
    "settings.secretUnreadable": "В целях безопасности сохранённый API-ключ не удалось разблокировать по этому адресу — введите его заново в настройках.",
    "error.pngInflateFailed": "Этот PNG содержит данные персонажа, которые не удалось распаковать.",
    "settings.defaultModel": "Модель по умолчанию",
    "settings.browseModels": "Просмотр моделей ниже...",
    "settings.refreshModels": "Обновить модели",
    "settings.maxTokens": "Макс. токенов вывода",
    "settings.maxTokensPlaceholder": "0 = значение по умолчанию модели",
    "settings.maxTokensHint": "Переопределить максимум токенов вывода за запрос. Установите 0 для автоматического использования лимита выбранной модели (или 64k, если неизвестно).",
    "settings.copyright": "Вставлять отметку редактора при экспорте",
    "settings.copyrightHint": "Добавляет строку с отметкой в заметки автора при экспорте карточек.",
    "settings.availableModels": "Доступные модели",
    "settings.searchModels": "Поиск моделей...",
    "settings.enterApiKey": "Введите API-ключ и обновите для загрузки моделей",
    "settings.credits": "Кредиты и использование",
    "settings.creditLimit": "Лимит кредитов",
    "settings.remaining": "Остаток",
    "settings.usedMonth": "Использовано в этом месяце",
    "settings.localStorage": "Локальное хранилище",
    "settings.clearAll": "Очистить все данные",
    "settings.export": "Экспорт",
    "settings.import": "Импорт",
    "settings.close": "Закрыть",
    "settings.saveSettings": "Сохранить настройки",
    "settings.languageLabel": "Язык",
    "settings.languageHint": "Язык интерфейса (перезагрузите страницу, если отсутствует)",
    "settings.languageChanged": "Язык обновлён",
    "settings.clearConfirm": "Удалить ВСЕ карточки, настройки и историю чата? Это действие необратимо.",
    "settings.providerCustom": "Пользовательский (совместимый с OpenAI)",
    "settings.noModels": "Модели не найдены",
    "settings.loadMore": "Загрузить ещё ({{count}} осталось)",
    "settings.showingModels": "Показано {{shown}} из {{total}} моделей",
    "wizard.title": "Создание персонажа",
    "wizard.step.basics": "Основы",
    "wizard.step.concept": "Концепция",
    "wizard.step.personality": "Характер",
    "wizard.step.scenario": "Сценарий",
    "wizard.step.generate": "Генерация",
    "wizard.basicsTitle": "Основы персонажа",
    "wizard.nameLabel": "Имя персонажа",
    "wizard.namePlaceholder": "например, Элара Найтуиспер",
    "wizard.genderLabel": "Пол / Местоимения",
    "wizard.genderSelect": "Выбрать...",
    "wizard.gender.female": "Женский (она)",
    "wizard.gender.male": "Мужской (он)",
    "wizard.gender.nonbinary": "Небинарный (они)",
    "wizard.gender.other": "Другое...",
    "wizard.genderCustom": "Пользовательские местоимения (например, оно)",
    "wizard.tagsLabel": "Теги",
    "wizard.tagsSub": "(через запятую, помогает организовать библиотеку)",
    "wizard.tagsPlaceholder": "фэнтези, воин, эльф, оригинальный",
    "wizard.creatorLabel": "Автор",
    "wizard.creatorPlaceholder": "Ваше имя / псевдоним",
    "wizard.conceptTitle": "Концепция и сеттинг",
    "wizard.typeLabel": "Тип персонажа",
    "wizard.type.original": "Оригинальный персонаж",
    "wizard.type.fanfic": "Фанфик",
    "wizard.type.game": "Персонаж игры",
    "wizard.type.anime": "Аниме / Манга",
    "wizard.type.book": "Книга / Фильм / Сериал",
    "wizard.type.historical": "Историческая личность",
    "wizard.type.mythological": "Мифологический / Фольклор",
    "wizard.type.vtuber": "VTuber / Стример",
    "wizard.type.other": "Другое",
    "wizard.languageLabel": "Язык",
    "wizard.language.other": "Другое",
    "wizard.languageSpecify": "Указать язык",
    "wizard.genreLabel": "Жанр / Мир",
    "wizard.genreSub": "(выберите все подходящие)",
    "wizard.moodLabel": "Настроение / Тон",
    "wizard.moodSub": "(выберите все подходящие)",
    "wizard.personalityTitle": "Характер и внешность",
    "wizard.personalityTraits": "Черты характера",
    "wizard.personalityTraitsSub": "(опишите 3-5 ключевых черт, это поможет ИИ)",
    "wizard.personalityTraitsPlaceholder": "например, Храбрый, но безрассуден, предан друзьям, сухое чувство юмора, с трудом доверяет, тайно любит животных",
    "wizard.appearanceLabel": "Внешность",
    "wizard.appearanceSub": "(краткое описание внешности)",
    "wizard.appearancePlaceholder": "например, Высокая женщина с серебряными волосами до пояса, израненные руки, тёмная кожаная куртка, пронзительные зелёные глаза",
    "wizard.abilitiesLabel": "Особые способности / Особенности",
    "wizard.abilitiesSub": "(необязательно, уникальные черты)",
    "wizard.abilitiesPlaceholder": "например, Может разговаривать с животными, феноменальная память, всегда носит потрёпанный дневник",
    "wizard.scenarioTitle": "Сценарий и первое сообщение",
    "wizard.scenarioLabel": "Сценарий / Сеттинг",
    "wizard.scenarioSub": "(с чего начинается история?)",
    "wizard.scenarioPlaceholder": "например, Дождливая ночь в неоновом городе. Персонаж управляет маленькой ремонтной мастерской, чинящей и машины, и разбитые сердца.",
    "wizard.relationshipLabel": "Отношение к {{user}}",
    "wizard.relationshipSub": "(как персонаж относится к пользователю?)",
    "wizard.relationshipPlaceholder": "например, Новый клиент, зашедший в мастерскую с загадочным сломанным устройством. Персонаж любопытствен, но осторожен.",
    "wizard.openingLabel": "Настроение первого сообщения",
    "wizard.openingSub": "(каким должно быть ощущение от первого сообщения?)",
    "wizard.notesLabel": "Дополнительные заметки",
    "wizard.notesSub": "(что ещё должен знать ИИ?)",
    "wizard.notesPlaceholder": "например, Естественный диалог, без излишней formalности, описания действий в звёздочках",
    "wizard.generateTitle": "Генерация персонажа",
    "wizard.refImage": "Эталонное изображение",
    "wizard.refImageSub": "(необязательно, с waifu.im)",
    "wizard.fetchImages": "Получить 3 изображения",
    "wizard.refetchOthers": "Получить другие",
    "wizard.fetching": "Получение...",
    "wizard.useSelected": "Использовать выбранное",
    "wizard.clear": "Очистить",
    "wizard.generateAI": "Генерация с ИИ",
    "wizard.generateAISub": "Полная карточка персонажа на основе ваших ответов",
    "wizard.createBlank": "Создать пустую карточку",
    "wizard.createBlankSub": "Начать с предзаполненным именем и тегами",
    "wizard.back": "Назад",
    "wizard.next": "Далее",
    "wizard.stepLabel": "Шаг {{step}} из {{total}}",
    "wizard.ready": "Готово к генерации!",
    "wizard.nameRequired": "Пожалуйста, введите имя персонажа",
    "wizard.summary.name": "Имя",
    "wizard.summary.gender": "Пол",
    "wizard.summary.type": "Тип",
    "wizard.summary.language": "Язык",
    "wizard.summary.tags": "Теги",
    "wizard.summary.genres": "Жанры",
    "wizard.summary.mood": "Настроение",
    "wizard.summary.opening": "Открытие",
    "wizard.summary.personality": "Характер",
    "wizard.summary.appearance": "Внешность",
    "wizard.summary.scenario": "Сценарий",
    "wizard.summary.relationship": "Отношение",
    "wizard.summary.notes": "Заметки",
    "wizard.chip.fantasy": "Фэнтези",
    "wizard.chip.scifi": "Научная фантастика",
    "wizard.chip.modern": "Современность",
    "wizard.chip.historical": "Историческое",
    "wizard.chip.horror": "Ужасы",
    "wizard.chip.romance": "Романтика",
    "wizard.chip.comedy": "Комедия",
    "wizard.chip.sliceOfLife": "Повседневность",
    "wizard.chip.adventure": "Приключения",
    "wizard.chip.mystery": "Детектив",
    "wizard.chip.cyberpunk": "Киберпанк",
    "wizard.chip.postApocalyptic": "Постапокалипсис",
    "wizard.chip.supernatural": "Сверхъестественное",
    "wizard.chip.military": "Военное",
    "wizard.chip.surreal": "Сюрреализм",
    "wizard.chip.serious": "Серьёзное",
    "wizard.chip.playful": "Игривое",
    "wizard.chip.dark": "Тёмное",
    "wizard.chip.lighthearted": "Лёгкое",
    "wizard.chip.mysterious": "Загадочное",
    "wizard.chip.romantic": "Романтичное",
    "wizard.chip.intense": "Интенсивное",
    "wizard.chip.wholesome": "Тёплое",
    "wizard.chip.chaotic": "Хаотичное",
    "wizard.chip.melancholic": "Меланхоличное",
    "wizard.chip.sarcastic": "Саркастичное",
    "wizard.chip.stoic": "Стоическое",
    "wizard.chip.greeting": "Тёплое приветствие",
    "wizard.chip.action": "In Media Res",
    "wizard.chip.question": "Любопытный вопрос",
    "wizard.chip.conflict": "Немедленный конфликт",
    "wizard.chip.atmospheric": "Атмосферное",
    "diff.title": "Предпросмотр ответа ИИ",
    "diff.removed": "Удалено",
    "diff.added": "Добавлено",
    "diff.current": "Текущее",
    "diff.proposed": "Предлагаемое",
    "diff.empty": "(пусто)",
    "diff.discard": "Отклонить",
    "diff.apply": "Применить изменения",
    "shortcuts.title": "Горячие клавиши",
    "shortcuts.save": "Сохранить карточку",
    "shortcuts.newCard": "Новая карточка",
    "shortcuts.undo": "Отменить",
    "shortcuts.redo": "Повторить",
    "shortcuts.sendAi": "Отправить сообщение ИИ",
    "shortcuts.newLine": "Новая строка в ИИ",
    "shortcuts.focus": "Режим фокуса",
    "shortcuts.collapsePanel": "Свернуть/развернуть панель ИИ",
    "toast.loadFailed": "Ошибка: {{name}}",
    "toast.loaded": "Загружено {{count}} карточек",
    "toast.importDupe": "Содержимое совпадает с существующей картой — импортировано как {{name}}",
    "toast.largeImage": "В {{name}} встроено большое изображение ({{size}} МБ) - удалите его, чтобы сэкономить место.",
    "toast.noValid": "Не найдено подходящих карточек. Перетащите PNG или JSON файлы.",
    "toast.noSelected": "Карточки не выбраны",
    "toast.cardsDeleted": "Карточки удалены",
    "toast.deleteFailed": "Не удалось удалить карту",
    "toast.exported": "Экспортировано {{count}} карточек",
    "toast.newBlank": "Создана новая пустая карточка",
    "toast.noCardSave": "Нет карточки для сохранения",
    "toast.cardSaved": "Карточка сохранена!",
    "toast.noCardDup": "Нет карточки для дублирования",
    "toast.cardDup": "Карточка дублирована",
    "toast.cardRestored": "Карточка восстановлена",
    "toast.selectCard": "Сначала выберите карточку",
    "toast.avatarUpdated": "Аватар обновлён",
    "toast.imgFailed": "Не удалось загрузить изображение",
    "toast.firstMesUpdated": "Первое сообщение обновлено!",
    "toast.settingsSaved": "Настройки сохранены!",
    "toast.modelsFailed": "Не удалось загрузить модели: {{error}}",
    "toast.modelSet": "Модель установлена: {{model}}",
    "toast.dataCleared": "Все данные удалены",
    "toast.settingsExported": "Настройки экспортированы",
    "toast.settingsImported": "Настройки импортированы!",
    "toast.invalidFile": "Недопустимый файл настроек",
    "toast.apiKey": "Установите API-ключ в настройках",
    "toast.selectModel": "Пожалуйста, сначала выберите модель в навигации или настройках.",
    "toast.genStopped": "Генерация остановлена.",
    "toast.aiError": "Ошибка ИИ: {{error}}",
    "toast.cardUpdatedAI": "Карточка обновлена по ответу ИИ!",
    "toast.jsonParseFailed": "Не удалось распознать ответ ИИ как JSON. Проверьте чат.",
    "toast.emptyResponse": "AI вернул пустой контент — нечего применять.",
    "toast.jsonInvalid": "ИИ не вернул корректный JSON. Ответ в чате — вы можете скопировать его вручную.",
    "toast.fieldUpdated": '"{{field}}" обновлено!',
    "toast.selectField": "Выберите хотя бы одно поле для редактирования",
    "toast.tooManyFields": "Слишком много полей. Максимум {{max}} за раз.",
    "toast.greetingsUpdated": "Сгенерировано {{count}} приветствий!",
    "toast.tagsUpdated": "Теги обновлены — добавлено {{count}} новых!",
    "toast.greetingsParseFailed": "Не удалось разобрать приветствия из ответа AI.",
    "toast.createCardFirst": "Сначала создайте или выберите карточку",
    "toast.wizardCreated": "Карточка создана! Начните редактирование или используйте ИИ для заполнения деталей.",
    "toast.wizardApi": "Сначала установите API-ключ в настройках",
    "toast.wizardModel": "Выберите модель или установите пользовательский ID модели в настройках",
    "toast.wizardFetchFailed": "Не удалось получить изображения: {{error}}",
    "toast.wizardName": "Пожалуйста, введите имя персонажа",
    "toast.storageFull": "Хранилище заполнено! Попробуйте удалить или экспортировать карточки.",
    "toast.exportedJson": "Экспортировано как JSON!",
    "toast.exportedPng": "Экспортировано как PNG с данными карточки!",
    "toast.exportFailed": "Ошибка экспорта изображения. Возврат к JSON.",
    "toast.chatCleared": "Чат очищен",
    "toast.undo": "Отменить",
    "error.apiKeyNotSet": "Ключ API не задан. Введите ключ API в настройках.",
    "error.customUrlNotSet": "Базовый URL пользовательского API не задан. Откройте Настройки → Пользовательский (совместимый с OpenAI) и введите URL конечной точки (например, http://localhost:1234/v1).",
    "error.customServerError": "Сервер вернул ошибку: {{detail}}",
    "error.customAuthFailed": "Ошибка аутентификации (HTTP {{status}}). Проверьте ключ API для этой конечной точки.",
    "error.customPathNotFound": "Конечная точка не найдена (HTTP 404). Проверьте, что базовый URL API полный (например, содержит /v1).",
    "error.customUnreachable": "Не удается подключиться к {{url}}. Убедитесь, что сервер запущен, а базовый URL API корректен и доступен с этого устройства.",
    "error.noModel": "Модель не выбрана. Пожалуйста, выберите модель или установите ID модели в настройках.",
    "error.noModelSimple": "Модель не выбрана.",
    "error.insufficientCredits": "Недостаточно кредитов. Пожалуйста, пополните аккаунт.",
    "error.storageFull": "Хранилище заполнено! Попробуйте удалить или экспортировать карточки.",
    "gen.empty": "(пусто)",
    "gen.free": "Бесплатно",
    "gen.unlimited": "Без ограничений",
    "gen.notAvailable": "Н/Д",
    "gen.unnamed": "Без имени",
    "gen.byCreator": "{{name}}",
    "gen.untagged": "Теги не найдены",
    "gen.noMatch": "Нет карточек, соответствующих фильтрам",
    "batch.deleteConfirm": "Удалить {{count}} карточек? Это действие нельзя отменить.",
    "left.selected": "{{count}} выбрано",
    "toast.cardDeleted": "Карточка «{{name}}» удалена",
    "ai.editing": "Редактирование {{count}} поля/полей...",
    "ai.streaming": "потоковая передача...",
    "ai.failed": "ошибка",
    "ai.cancelled": "Отменено.",
    "ai.doneSummary": "{{done}}/{{total}} готово · {{errs}} ошибок",
    "ai.viewFullResult": "Посмотреть полный результат",
    "ai.showLess": "Показать меньше",
    "ai.reviewApply": "Просмотр и применение",
    "ai.changesNav": "Изменение {{current}} из {{total}}",
    "ai.changesPrev": "Предыдущее изменение",
    "ai.changesNext": "Следующее изменение",
    "ai.applied": "Применено",
    "ai.target.tags": "Теги",
    "ai.copy": "Копировать",
    "ai.copied": "Скопировано!",
    "ai.copyFailed": "Ошибка",
    "ai.resultTitle": "Результат",
    "ai.close": "Закрыть",
    "editor.noGreetings": "Пока нет приветствий. <strong>Добавьте приветствие</strong> или используйте ИИ для создания.",
    "editor.noEntriesMatch": 'Нет записей, соответствующих "{{query}}"',
    "gen.copySuffix": " (Копия)",
    "gen.toastAutoHide": "Автоскрытие через {{s}}с",
    "ai.apply": "Apply",
    "ai.applyTitle": "Apply these changes to the card",
    "ai.errorPrefix": "Error: ",
    "ai.translatePrompt": "Translate to which language?",
    "ai.translateDefaultLang": "French",
    "ai.tonePrompt": "Which tone? (e.g., formal, casual, dark, humorous, poetic)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Chat session",
    "ai.msgs": "{{count}} msgs",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Exceeds limit!",
    "ai.approachingLimit": " ⚠ Approaching limit",
    "ai.count": "Count:",
    "ai.resizeAria": "Resize AI assistant",
    "ai.chatMessagesAria": "AI chat messages",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Example dialogue here...
{{user}}: User response...
<START>
{{char}}: Another example...`,
    "batch.select2ForCompare": "Select exactly 2 cards to compare",
    "batch.compareLoadFailed": "Failed to load cards for comparison",
    "batch.comparePrefix": "Compare: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Card A",
    "batch.cardB": "Card B",
    "editor.charCount": "{{chars}} chars ~{{tokens}} tokens",
    "editor.counterWarn": "Близко к лимиту токенов вывода ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Превышен лимит токенов вывода ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Move up",
    "editor.greetingMoveDown": "Move down",
    "editor.greetingIsDefault": "This is the current first message",
    "editor.greetingSetDefault": "Set as first message",
    "editor.greetingRemove": "Remove",
    "editor.greetingPlaceholder": "Greeting {{num}}...",
    "editor.loreEntry": "Entry {{num}}",
    "editor.loreDeleteEntry": "Delete entry",
    "editor.lorePrimaryKeys": "Primary Keywords",
    "editor.lorePrimaryKeysPlaceholder": "Primary keywords — comma separated",
    "editor.loreSecondaryKeys": "Secondary Keywords",
    "editor.loreSecondaryKeysPlaceholder": "Secondary keywords",
    "editor.loreComment": "Comment",
    "editor.loreCommentPlaceholder": "Comment",
    "editor.loreOrder": "Order",
    "editor.loreOrderPlaceholder": "Order",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selective",
    "editor.loreBeforeChar": "Before char",
    "editor.loreAfterChar": "After char",
    "editor.loreContent": "Content",
    "editor.loreContentPlaceholder": "Entry content...",
    "editor.loreNewEntry": "New Entry",
    "error.unknown": "Unknown error",
    "error.unexpected": "Unexpected error: {{message}}",
    "error.requestFailed": "Request failed: {{message}}",
    "error.unsupportedFile": "Unsupported file type: .{{ext}}",
    "error.invalidJson": "Invalid JSON: {{message}}",
    "error.notPng": "Not a valid PNG file",
    "error.unknownFormat": "Unknown card format — not a SillyTavern character card",
    "error.fetchModelsFailed": "Failed to fetch models (HTTP {{status}})",
    "error.noChoices": "API returned no response choices",
    "error.emptyResponse": "Empty response from API (no body)",
    "gen.newCharacter": "New Character",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Restore",
    "settings.backupTitle": "Backup all cards",
    "settings.restoreTitle": "Restore backup",
    "settings.exportTitle": "Export settings",
    "settings.importTitle": "Import settings",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "e.g. deepseek-v4-flash",
    "settings.customModelPlaceholder": "e.g. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "e.g. {{provider}}-latest",
    "settings.getApiKeyFrom": "Get API key from ",
    "settings.customModelDesc": "Custom model",
    "settings.workspaceExported": "Workspace exported ({{count}} cards)",
    "settings.invalidWorkspace": "Invalid workspace format",
    "settings.workspaceImported": "Workspace imported ({{count}} cards)",
    "settings.workspaceImportFailed": "Failed to import workspace: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Toggle AI Assistant",
    "nav.toggleAIAria": "Toggle AI Assistant",
    "nav.notificationsAria": "Notifications",
    "left.sortCards": "Sort cards",
    "left.compareSelected": "Compare selected cards",
    "left.resizeAria": "Resize card library",
    "left.cardListAria": "Card library",
    "ui.saved": " Saved",
    "ui.collapsePanel": "Свернуть панель",
    "ui.expandPanel": "Развернуть панель",
    "ui.cardModified": "Несохранённые изменения",
    "export.minimalPngLabel": "ST Card",
    "wizard.search": "Search",
    "wizard.quick": "Quick:",
    "wizard.imageSearchPlaceholder": "Search tags: cat, dress, uniform, cyberpunk...",
    "ai.chatHistory": "История чата",
    "ai.historyTitle": "История чата",
    "ai.historyEmpty": "Разговоров пока нет",
    "ai.retry": "Повторить",
    "ai.retryTitle": "Сгенерировать этот ответ заново",
    "ai.reapply": "Применить повторно",
    "ai.reapplyTitle": "Откройте diff повторно, чтобы применить эти изменения",
    "wizard.editStep": "Редактировать этот раздел",
    "wizard.draftRestored": "Черновик восстановлен — ваши предыдущие ответы вернулись",
    "wizard.imagePlaceholder": "Нажмите «Получить»",
    "toast.noNameWarning": 'Предупреждение: у карточки нет имени. Файл будет сохранён как "character.json".',
    "toast.redo": "Повторить",
    "toast.reorderFiltered": "Отключите поиск и фильтры, чтобы изменить порядок карточек.",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.it = {
    "app.title": "ST Card Editor — Studio di carte personaggio SillyTavern",
    "nav.selectModel": "Seleziona modello...",
    "nav.wizard": "Crea con la procedura guidata AI",
    "nav.newCard": "Nuova scheda vuota",
    "nav.save": "Salva",
    "nav.theme": "Cambia tema",
    "nav.shortcuts": "Scorciatoie e aiuto",
    "nav.settings": "Impostazioni",
    "nav.focus": "Modalità focus",
    "nav.focusAlt": "Modalità focus (Alt+F)",
    "left.title": "Libreria schede",
    "left.cards": "{{count}} schede",
    "left.drop": "Trascina e rilascia",
    "left.dropSub": "Schede personaggio PNG o JSON",
    "left.browse": "Sfoglia file",
    "left.search": "Cerca schede...",
    "left.sort.nameAsc": "Nome A-Z",
    "left.sort.nameDesc": "Nome Z-A",
    "left.sort.manual": "Manuale",
    "left.sort.newest": "Prima le più recenti",
    "left.sort.oldest": "Prima le più vecchie",
    "left.sort.largest": "Più grandi",
    "left.sort.smallest": "Più piccole",
    "left.filterTags": "Filtra per tag",
    "left.exportSelected": "Esporta selezionate come JSON",
    "left.deleteSelected": "Elimina selezionate",
    "left.empty": "Nessuna scheda caricata",
    "left.emptySub": "Rilascia una scheda o fai clic su Sfoglia",
    "center.noCard": "Nessuna scheda selezionata",
    "center.noCardSub": "Seleziona una scheda dalla libreria oppure trascina e rilascia una nuova",
    "center.createAI": "Crea con AI",
    "center.blankCard": "Scheda vuota",
    "editor.avatar": "Fai clic o rilascia un'immagine per impostare l'avatar",
    "editor.avatarAria": "Imposta avatar del personaggio",
    "editor.name": "Nome del personaggio",
    "editor.exportJson": "Esporta come JSON",
    "editor.exportPng": "Esporta come PNG",
    "editor.duplicate": "Duplica scheda",
    "editor.delete": "Elimina scheda",
    "editor.tab.core": "Principale",
    "editor.tab.personality": "Personalità",
    "editor.tab.advanced": "Avanzate",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Immagine Waifu",
    "editor.waifuPreview": "Immagine attuale della scheda",
    "editor.waifuNoImage": "Nessuna immagine impostata",
    "editor.waifuSource": "Sorgente immagine",
    "editor.waifuSourceSnap": "Istanti anime (waifu.im)",
    "editor.waifuSourceChar": "Personaggi anime (AniList)",
    "editor.waifuGender": "Genere",
    "editor.waifuGenderAll": "Qualsiasi genere",
    "editor.waifuGenderFemaleOnly": "Solo donne",
    "editor.waifuGenderMaleOnly": "Solo uomini",
    "editor.waifuGenderFemale": "Femminile",
    "editor.waifuGenderMale": "Maschile",
    "editor.waifuCharSub": "cerca un personaggio per nome (es. zoro)",
    "editor.waifuSearch": "Cerca su waifu.im",
    "editor.waifuSearchChar": "Cerca personaggi",
    "editor.waifuSearchPlaceholderChar": "cerca un personaggio per nome (es. zoro)",
    "editor.waifuSub": "(recupera immagini in stile anime per tag)",
    "editor.waifuSearchPlaceholder": "es. waifu, elfo, cameriera...",
    "editor.waifuFetch": "Recupera immagini",
    "editor.waifuRegenTitle": "Rigenera i risultati",
    "editor.waifuMixed": "Donne + Uomini",
    "editor.waifuMixedSub": "pacchetto bilanciato in un clic: 3 personaggi femminili + 3 maschili",
    "editor.waifuUse": "Usa come immagine della scheda",
    "editor.waifuUpload": "Carica dal dispositivo",
    "editor.waifuRemove": "Rimuovi immagine",
    "toast.noImage": "Questa scheda non ha un'immagine da rimuovere",
    "toast.imageRemoved": "Immagine rimossa",
    "editor.desc": "Descrizione",
    "editor.descSub": "(aspetto, retroscena)",
    "editor.descPlaceholder": "Descrivi l'aspetto, il background e i tratti principali del personaggio...",
    "editor.firstMes": "Primo messaggio",
    "editor.firstMesPlaceholder": "Il primo messaggio del personaggio all'inizio di una chat...",
    "editor.scenario": "Scenario",
    "editor.scenarioPlaceholder": "Circostanze attuali e contesto della conversazione...",
    "editor.creator": "Creatore",
    "editor.creatorPlaceholder": "Creatore / autore della scheda",
    "editor.version": "Versione del personaggio",
    "editor.tags": "Tag",
    "editor.tagsSub": "(separati da virgole)",
    "editor.tagsPlaceholder": "fantasy, guerriera, elfa",
    "editor.personalitySummary": "Sommario della personalità",
    "editor.personalityPlaceholder": "Una breve descrizione della personalità del personaggio... (usata nel formato scheda personaggio)",
    "editor.mesExample": "Messaggi di esempio",
    "editor.mesExampleFormat": "Formato: blocchi <START> con prefissi {{char}}: e {{user}}:",
    "editor.systemPrompt": "Prompt di sistema",
    "editor.systemPromptPlaceholder": "Sostituisci il prompt di sistema. Usa {{original}} per includere quello predefinito.",
    "editor.postHistory": "Istruzioni post-cronologia",
    "editor.postHistoryPlaceholder": "Istruzioni iniettate dopo la cronologia della chat. Usa {{original}} per il valore predefinito.",
    "editor.creatorNotes": "Note del creatore",
    "editor.creatorNotesPlaceholder": "Note per gli utenti della scheda (raccomandazioni sul modello, consigli d'uso...)",
    "editor.greetings": "Saluti alternativi",
    "editor.addGreeting": "Aggiungi saluto",
    "editor.lorebookTitle": "Voci del lorebook del personaggio",
    "editor.addEntry": "Aggiungi voce",
    "editor.lorebookSearch": "Cerca voci per chiave, contenuto o commento...",
    "editor.lorebookEmpty": "Nessuna voce nel lorebook. Aggiungine una per iniziare.",
    "editor.noGreetings": "Nessun saluto ancora. Fai clic su <strong>Aggiungi saluto</strong> oppure usa l'AI per generarne.",
    "editor.noEntriesMatch": 'Nessuna voce corrisponde a "{{query}}"',
    "editor.edit": "Modifica",
    "editor.preview": "Anteprima",
    "ai.title": "Assistente AI",
    "ai.clearChat": "Svuota chat",
    "ai.welcomeTitle": "Assistente schede AI",
    "ai.welcomeText": "Chiedi all'AI di modificare, tradurre o migliorare la tua scheda personaggio.",
    "ai.quick.newCard": "Nuova scheda",
    "ai.quick.translate": "Traduci",
    "ai.quick.enhance": "Migliora",
    "ai.quick.shorten": "Accorcia",
    "ai.quick.tone": "Cambia tono",
    "ai.quick.grammar": "Correggi grammatica",
    "ai.quick.personality": "Espandi personalità",
    "ai.quick.firstmes": "Migliora primo messaggio",
    "ai.quick.scenario": "Espandi scenario",
    "ai.quick.greetings": "Genera saluti",
    "ai.quick.systemprompt": "Migliora prompt di sistema",
    "ai.quick.tags": "Suggerisci tag",
    "ai.contextTitle": "Token stimati usati rispetto al limite di contesto del modello",
    "ai.contextLabel": "— / — token",
    "ai.placeholder": "Chiedi all'AI di modificare la scheda...",
    "ai.send": "Invia",
    "ai.stop": "Interrompi generazione",
    "ai.autoModel": "Seleziona modello...",
    "ai.target": "Destinazione:",
    "ai.target.full": "Scheda completa",
    "ai.target.description": "Descrizione",
    "ai.target.personality": "Personalità",
    "ai.target.first_mes": "Primo messaggio",
    "ai.target.scenario": "Scenario",
    "ai.target.mes_example": "Messaggi di esempio",
    "ai.target.system_prompt": "Prompt di sistema",
    "ai.target.post_history_instructions": "Istruzioni post-cronologia",
    "ai.target.creator_notes": "Note del creatore",
    "ai.target.alternate_greetings": "Saluti alternativi",
    "ai.selectModel": "Seleziona un modello",
    "ai.actionNewCard": "Nuova scheda",
    "ai.actionTranslate": "Traduci",
    "ai.actionEnhance": "Migliora",
    "ai.actionShorten": "Accorcia",
    "ai.actionTone": "Cambia tono",
    "ai.actionGrammar": "Correggi grammatica",
    "ai.actionPersonality": "Espandi personalità",
    "ai.actionFirstMes": "Migliora primo messaggio",
    "ai.actionScenario": "Espandi scenario",
    "ai.actionGreetings": "Genera saluti",
    "ai.actionSystemprompt": "Migliora prompt di sistema",
    "ai.actionTags": "Suggerisci tag",
    "ai.chatHistory": "Cronologia chat",
    "ai.historyTitle": "Cronologia chat",
    "ai.historyEmpty": "Nessuna conversazione",
    "ai.retry": "Riprova",
    "ai.retryTitle": "Rigenera questa risposta",
    "ai.reapply": "Ri-applica",
    "ai.reapplyTitle": "Riapri il diff per applicare queste modifiche",
    "ai.noCard": "(nessuna scheda selezionata)",
    "ai.editing": "Modifica di {{count}} campo/i...",
    "ai.streaming": "streaming...",
    "ai.failed": "non riuscita",
    "ai.cancelled": "Annullata.",
    "ai.doneSummary": "{{done}}/{{total}} completati · {{errs}} non riusciti",
    "ai.viewFullResult": "Visualizza risultato completo",
    "ai.showLess": "Mostra meno",
    "ai.reviewApply": "Rivedi e applica",
    "ai.changesNav": "Modifica {{current}} di {{total}}",
    "ai.changesPrev": "Modifica precedente",
    "ai.changesNext": "Modifica successiva",
    "ai.applied": "Applicato",
    "ai.target.tags": "Tag",
    "ai.copy": "Copia",
    "ai.copied": "Copiato!",
    "ai.copyFailed": "Non riuscito",
    "ai.resultTitle": "Risultato",
    "ai.close": "Chiudi",
    "settings.themeColor": "Colore del tema",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Scegliere un colore di accento distinto per ogni tema chiaro/scuro. Le modifiche vengono applicate immediatamente.",
    "settings.appearance": "Aspetto",
    "settings.accentPresets": "Predefiniti accento",
    "settings.glassDensity": "Densità del vetro",
    "settings.glassSubtle": "Sottile",
    "settings.glassDefault": "Predefinito",
    "settings.glassBold": "Audace",
    "settings.cardRadius": "Raggio delle card",
    "settings.radiusCompact": "Compatto",
    "settings.radiusRounded": "Arrotondato",
    "settings.radiusPill": "Pillola",
    "settings.vignette": "Vignettatura ai bordi",
    "settings.appearanceHint": "Personalizza l’aspetto di ogni tema chiaro/scuro. Le modifiche all’accento si applicano subito; densità, raggio e vignettatura sono inclusi nei backup dell’area di lavoro.",
    "settings.resetThemeColor": "Reimposta",
    "settings.generalTab": "Generali",
    "settings.promptsTab": "Prompt IA",
    "settings.assistantPrompt": "Prompt di sistema dell’assistente",
    "settings.fullCardPrompt": "Prompt di sistema della scheda completa",
    "settings.wizardPrompt": "Istruzioni di generazione del personaggio",
    "settings.promptPlaceholder": "Lasciare vuoto per usare il prompt integrato",
    "settings.chatSystemPrompts": "Istruzioni di chat e di sistema",
    "settings.fullCardInstr": "Istruzioni di output della scheda completa (sistema)",
    "settings.fieldsEdit": "Istruzioni di modifica del campo (sistema)",
    "settings.greetingsSystem": "Istruzioni di output dei saluti (sistema)",
    "settings.exportPrompts": "Esporta prompt",
    "settings.importPrompts": "Importa prompt",
    "settings.promptsExported": "Prompt esportati",
    "settings.promptsImported": "{count} prompt importati",
    "settings.quickActionPrompts": "Prompt delle azioni rapide",
    "settings.tagsSystemPrompt": "Istruzioni di output dei tag (sistema)",
    "settings.restoreDefaultPrompts": "Ripristina i prompt predefiniti",
    "settings.promptHint": "Questi campi mostrano i prompt attuali. Se un campo è vuoto, viene usato il prompt integrato predefinito. Ripristinare i valori predefiniti per visualizzarli o recuperarli.",
    "settings.title": "Impostazioni",
    "settings.provider": "Fornitore",
    "settings.providerHint": "Fornitori di modelli ospitati oppure un endpoint personalizzato (LM Studio, Ollama, ecc.)",
    "settings.apiKey": "Chiave API",
    "settings.getApiKey": "Ottieni la tua chiave API da OpenRouter",
    "settings.baseUrl": "URL base API",
    "settings.namedApiKeyPlaceholder": "Inserisci la tua chiave API",
    "settings.customHint": "Endpoint compatibile con OpenAI. Esempi: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "Chiave API (facoltativa)",
    "settings.apiKeyLocalPlaceholder": "Lascia vuoto per i fornitori locali",
    "settings.apiKeyLocalHint": "Non necessaria per server locali come LM Studio o Ollama.",
    "settings.modelId": "ID modello",
    "settings.modelIdHint": "L'ID esatto del modello previsto dal tuo fornitore.",
    "settings.modelIdHintNamed": "Lascia vuoto per usare il modello predefinito del fornitore.",
    "settings.security": "La tua chiave API è criptata nel localStorage del browser con una chiave legata a questo indirizzo. Non usare questa app su dispositivi condivisi.",
    "settings.secretUnreadable": "Per motivi di sicurezza, una chiave API salvata non è stata sbloccata su questo indirizzo — reinserisci la chiave nelle Impostazioni.",
    "error.pngInflateFailed": "Questo PNG contiene dati del personaggio che non hanno potuto essere decompressi.",
    "settings.defaultModel": "Modello predefinito",
    "settings.browseModels": "Sfoglia i modelli qui sotto...",
    "settings.refreshModels": "Aggiorna modelli",
    "settings.maxTokens": "Token di output massimi",
    "settings.maxTokensPlaceholder": "0 = usa il predefinito del modello",
    "settings.maxTokensHint": "Sostituisci il numero massimo di token di output per richiesta. Imposta 0 per usare automaticamente il limite del modello selezionato (o 64k se sconosciuto).",
    "settings.copyright": "Inietta credito dell'editor all'esportazione",
    "settings.copyrightHint": "Aggiunge una riga di credito alle note del creatore durante l'esportazione delle schede.",
    "settings.availableModels": "Modelli disponibili",
    "settings.searchModels": "Cerca modelli...",
    "settings.enterApiKey": "Inserisci la tua chiave API e aggiorna per caricare i modelli",
    "settings.credits": "Crediti e utilizzo",
    "settings.creditLimit": "Limite di credito",
    "settings.remaining": "Rimanenti",
    "settings.usedMonth": "Usati questo mese",
    "settings.localStorage": "Archiviazione locale",
    "settings.clearAll": "Cancella tutti i dati",
    "settings.export": "Esporta",
    "settings.import": "Importa",
    "settings.close": "Chiudi",
    "settings.saveSettings": "Salva impostazioni",
    "settings.languageLabel": "Lingua",
    "settings.languageHint": "Lingua dell'interfaccia (ricarica la pagina se mancante)",
    "settings.languageChanged": "Lingua aggiornata",
    "settings.clearConfirm": "Eliminare TUTTE le schede, le impostazioni e la cronologia chat? Questa operazione non può essere annullata.",
    "settings.providerCustom": "Personalizzato (compatibile OpenAI)",
    "settings.noModels": "Nessun modello trovato",
    "settings.loadMore": "Carica altri ({{count}} rimanenti)",
    "settings.showingModels": "Mostrati {{shown}} di {{total}} modelli",
    "wizard.title": "Crea personaggio",
    "wizard.step.basics": "Base",
    "wizard.step.concept": "Concetto",
    "wizard.step.personality": "Personalità",
    "wizard.step.scenario": "Scenario",
    "wizard.step.generate": "Genera",
    "wizard.basicsTitle": "Base del personaggio",
    "wizard.nameLabel": "Nome del personaggio",
    "wizard.namePlaceholder": "es. Elara Nightwhisper",
    "wizard.genderLabel": "Genere / Pronomi",
    "wizard.genderSelect": "Seleziona...",
    "wizard.gender.female": "Femmina (lei)",
    "wizard.gender.male": "Maschio (lui)",
    "wizard.gender.nonbinary": "Non binario (loro)",
    "wizard.gender.other": "Altro...",
    "wizard.genderCustom": "Pronomi personalizzati (es. esso)",
    "wizard.tagsLabel": "Tag",
    "wizard.tagsSub": "(separati da virgole, aiutano a organizzare la libreria)",
    "wizard.tagsPlaceholder": "fantasy, guerriera, elfa, originale",
    "wizard.creatorLabel": "Creatore",
    "wizard.creatorPlaceholder": "Il tuo nome / alias",
    "wizard.conceptTitle": "Concetto e ambientazione",
    "wizard.typeLabel": "Tipo di personaggio",
    "wizard.type.original": "Personaggio originale",
    "wizard.type.fanfic": "Fan fiction",
    "wizard.type.game": "Personaggio di gioco",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Libro / Film / Serie",
    "wizard.type.historical": "Figura storica",
    "wizard.type.mythological": "Mitologico / Folcloristico",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Altro",
    "wizard.languageLabel": "Lingua",
    "wizard.language.other": "Altro",
    "wizard.languageSpecify": "Specifica la lingua",
    "wizard.genreLabel": "Genere / Mondo",
    "wizard.genreSub": "(seleziona tutte le opzioni applicabili)",
    "wizard.moodLabel": "Atmosfera / Tono",
    "wizard.moodSub": "(seleziona tutte le opzioni applicabili)",
    "wizard.personalityTitle": "Personalità e aspetto",
    "wizard.personalityTraits": "Tratti di personalità",
    "wizard.personalityTraitsSub": "(descrivi 3-5 tratti chiave, questo aiuta l'AI)",
    "wizard.personalityTraitsPlaceholder": "es. Coraggiosa ma impulsiva, fedelissima agli amici, ironia tagliente, fatica a fidarsi, ama segretamente gli animali",
    "wizard.appearanceLabel": "Aspetto fisico",
    "wizard.appearanceSub": "(breve descrizione di come appare)",
    "wizard.appearancePlaceholder": "es. Donna alta con capelli argentei fino alla vita, mani segnate da cicatrici, giacca di pelle scura, occhi verdi penetranti",
    "wizard.abilitiesLabel": "Abilità speciali / Stranezze",
    "wizard.abilitiesSub": "(facoltative, qualsiasi tratto unico)",
    "wizard.abilitiesPlaceholder": "es. Sa parlare con gli animali, ha una memoria fotografica, porta sempre con sé un diario logoro",
    "wizard.scenarioTitle": "Scenario e primo messaggio",
    "wizard.scenarioLabel": "Scenario / Ambientazione",
    "wizard.scenarioSub": "(dove inizia la storia?)",
    "wizard.scenarioPlaceholder": "es. Una notte piovosa in una città illuminata al neon. Il personaggio gestisce una piccola officina che ripara sia macchine che cuori spezzati.",
    "wizard.relationshipLabel": "Relazione con {{user}}",
    "wizard.relationshipSub": "(come vede il personaggio l'utente?)",
    "wizard.relationshipPlaceholder": "es. Un nuovo cliente entrato in officina con un misterioso dispositivo rotto. Il personaggio è curioso ma prudente.",
    "wizard.openingLabel": "Atmosfera del primo messaggio",
    "wizard.openingSub": "(come dovrebbe essere il messaggio di apertura?)",
    "wizard.notesLabel": "Note aggiuntive",
    "wizard.notesSub": "(qualsiasi altra cosa l'AI dovrebbe sapere?)",
    "wizard.notesPlaceholder": "es. Mantieni il dialogo naturale, evita un tono troppo formale, includi le descrizioni delle azioni tra asterischi",
    "wizard.generateTitle": "Genera personaggio",
    "wizard.refImage": "Immagine di riferimento",
    "wizard.refImageSub": "(facoltativa, da waifu.im)",
    "wizard.fetchImages": "Recupera 3 immagini",
    "wizard.refetchOthers": "Recupera altre",
    "wizard.fetching": "Recupero in corso...",
    "wizard.useSelected": "Usa selezionata",
    "wizard.clear": "Cancella",
    "wizard.generateAI": "Genera con AI",
    "wizard.generateAISub": "Scheda personaggio completa dalle tue risposte",
    "wizard.createBlank": "Crea scheda vuota",
    "wizard.createBlankSub": "Inizia con nome e tag precompilati",
    "wizard.back": "Indietro",
    "wizard.next": "Avanti",
    "wizard.stepLabel": "Passo {{step}} di {{total}}",
    "wizard.ready": "Pronto per generare!",
    "wizard.nameRequired": "Inserisci un nome per il personaggio",
    "wizard.summary.name": "Nome",
    "wizard.summary.gender": "Genere",
    "wizard.summary.type": "Tipo",
    "wizard.summary.language": "Lingua",
    "wizard.summary.tags": "Tag",
    "wizard.summary.genres": "Generi",
    "wizard.summary.mood": "Atmosfera",
    "wizard.summary.opening": "Apertura",
    "wizard.summary.personality": "Personalità",
    "wizard.summary.appearance": "Aspetto",
    "wizard.summary.scenario": "Scenario",
    "wizard.summary.relationship": "Relazione",
    "wizard.summary.notes": "Note",
    "wizard.chip.fantasy": "Fantasy",
    "wizard.chip.scifi": "Fantascienza",
    "wizard.chip.modern": "Moderno",
    "wizard.chip.historical": "Storico",
    "wizard.chip.horror": "Horror",
    "wizard.chip.romance": "Romantico",
    "wizard.chip.comedy": "Commedia",
    "wizard.chip.sliceOfLife": "Vita quotidiana",
    "wizard.chip.adventure": "Avventura",
    "wizard.chip.mystery": "Mistero",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Post-apocalittico",
    "wizard.chip.supernatural": "Soprannaturale",
    "wizard.chip.military": "Militare",
    "wizard.chip.surreal": "Surreale",
    "wizard.chip.serious": "Serio",
    "wizard.chip.playful": "Giocoso",
    "wizard.chip.dark": "Scuro",
    "wizard.chip.lighthearted": "Spensierato",
    "wizard.chip.mysterious": "Misterioso",
    "wizard.chip.romantic": "Romantico",
    "wizard.chip.intense": "Intenso",
    "wizard.chip.wholesome": "Sano e genuino",
    "wizard.chip.chaotic": "Caotico",
    "wizard.chip.melancholic": "Malinconico",
    "wizard.chip.sarcastic": "Sarcastico",
    "wizard.chip.stoic": "Stoico",
    "wizard.chip.greeting": "Saluto caloroso",
    "wizard.chip.action": "In medias res",
    "wizard.chip.question": "Domanda curiosa",
    "wizard.chip.conflict": "Conflitto immediato",
    "wizard.chip.atmospheric": "Atmosferico",
    "wizard.editStep": "Modifica questa sezione",
    "wizard.draftRestored": "Bozza ripristinata — le tue risposte precedenti sono tornate",
    "wizard.imagePlaceholder": "Fai clic su Recupera",
    "diff.title": "Anteprima risposta AI",
    "diff.removed": "Rimosso",
    "diff.added": "Aggiunto",
    "diff.current": "Attuale",
    "diff.proposed": "Proposto",
    "diff.empty": "(vuoto)",
    "diff.discard": "Scarta",
    "diff.apply": "Applica modifiche",
    "shortcuts.title": "Scorciatoie",
    "shortcuts.save": "Salva scheda",
    "shortcuts.newCard": "Nuova scheda",
    "shortcuts.undo": "Annulla",
    "shortcuts.redo": "Ripeti",
    "shortcuts.sendAi": "Invia messaggio AI",
    "shortcuts.newLine": "Nuova riga nella chat AI",
    "shortcuts.focus": "Modalità focus",
    "shortcuts.collapsePanel": "Comprimi/espandi pannello IA",
    "toast.loadFailed": "Non riuscito: {{name}}",
    "toast.loaded": "Caricate {{count}} scheda/e",
    "toast.importDupe": "Stesso contenuto di una carta esistente — importata come {{name}}",
    "toast.largeImage": "Immagine di grandi dimensioni incorporata in {{name}} ({{size}} MB) - valuta di rimuoverla per risparmiare spazio.",
    "toast.noValid": "Nessuna scheda valida trovata. Rilascia file PNG o JSON.",
    "toast.noSelected": "Nessuna scheda selezionata",
    "toast.cardsDeleted": "Schede eliminate",
    "toast.deleteFailed": "Impossibile eliminare la scheda",
    "toast.exported": "Esportate {{count}} scheda/e",
    "toast.newBlank": "Nuova scheda vuota creata",
    "toast.noCardSave": "Nessuna scheda da salvare",
    "toast.cardSaved": "Scheda salvata!",
    "toast.noCardDup": "Nessuna scheda da duplicare",
    "toast.cardDup": "Scheda duplicata",
    "toast.cardRestored": "Scheda ripristinata",
    "toast.selectCard": "Seleziona prima una scheda",
    "toast.avatarUpdated": "Avatar aggiornato",
    "toast.imgFailed": "Impossibile caricare l'immagine",
    "toast.firstMesUpdated": "Primo messaggio aggiornato!",
    "toast.settingsSaved": "Impostazioni salvate!",
    "toast.modelsFailed": "Impossibile caricare i modelli: {{error}}",
    "toast.modelSet": "Modello impostato: {{model}}",
    "toast.dataCleared": "Tutti i dati cancellati",
    "toast.settingsExported": "Impostazioni esportate",
    "toast.settingsImported": "Impostazioni importate!",
    "toast.invalidFile": "File di impostazioni non valido",
    "toast.apiKey": "Imposta la tua chiave API nelle Impostazioni",
    "toast.selectModel": "Seleziona un modello dalla barra di navigazione o dalle impostazioni.",
    "toast.genStopped": "Generazione interrotta.",
    "toast.aiError": "Errore AI: {{error}}",
    "toast.cardUpdatedAI": "Scheda aggiornata dalla risposta AI!",
    "toast.jsonParseFailed": "Impossibile analizzare la risposta AI come JSON. Controlla la chat.",
    "toast.emptyResponse": "L'IA ha restituito contenuto vuoto — niente da applicare.",
    "toast.jsonInvalid": "L'AI non ha restituito JSON valido. La risposta è nella chat — puoi copiarla manualmente.",
    "toast.fieldUpdated": '"{{field}}" aggiornato!',
    "toast.greetingsUpdated": "Generati {{count}} saluto/i!",
    "toast.tagsUpdated": "Tag aggiornati — {{count}} nuovi aggiunti!",
    "toast.greetingsParseFailed": "Impossibile analizzare i saluti dalla risposta AI.",
    "toast.createCardFirst": "Crea o seleziona prima una scheda",
    "toast.wizardCreated": "Scheda creata! Inizia a modificarla o usa l'AI per compilare i dettagli.",
    "toast.wizardApi": "Imposta prima la tua chiave API nelle Impostazioni",
    "toast.wizardModel": "Seleziona un modello oppure imposta un ID modello personalizzato nelle Impostazioni",
    "toast.wizardFetchFailed": "Impossibile recuperare le immagini: {{error}}",
    "toast.wizardName": "Inserisci un nome per il personaggio",
    "toast.storageFull": "Archiviazione piena! Prova a rimuovere alcune schede o a esportarle.",
    "toast.exportedJson": "Esportato come JSON!",
    "toast.exportedPng": "Esportato come PNG con i dati della scheda!",
    "toast.exportFailed": "Esportazione immagine non riuscita. Ripiego su JSON.",
    "toast.noNameWarning": 'Attenzione: la scheda non ha un nome. Il file verrà salvato come "character.json".',
    "toast.chatCleared": "Chat svuotata",
    "toast.selectField": "Seleziona almeno un campo da modificare",
    "toast.tooManyFields": "Troppi campi selezionati. Massimo {{max}} alla volta.",
    "toast.undo": "Annulla",
    "toast.redo": "Ripeti",
    "toast.reorderFiltered": "Disattiva ricerca e filtri per riordinare le schede.",
    "error.apiKeyNotSet": "Chiave API non impostata. Inserisci la tua chiave API nelle Impostazioni.",
    "error.customUrlNotSet": "L'URL di base dell'API personalizzata non è impostata. Apri Impostazioni → Personalizzato (compatibile con OpenAI) e inserisci l'URL dell'endpoint (es. http://localhost:1234/v1).",
    "error.customAuthFailed": "Autenticazione fallita (HTTP {{status}}). Controlla la chiave API per questo endpoint.",
    "error.customPathNotFound": "Endpoint non trovato (HTTP 404). Controlla che l'URL di base dell'API sia completo (es. includa /v1).",
    "error.customUnreachable": "Impossibile raggiungere {{url}}. Verifica che il server sia in esecuzione e che l'URL di base dell'API sia corretto e raggiungibile da questo dispositivo.",
    "error.noModel": "Nessun modello selezionato. Scegli un modello oppure imposta un ID modello nelle Impostazioni.",
    "error.noModelSimple": "Nessun modello selezionato.",
    "error.insufficientCredits": "Crediti insufficienti. Ricarica il tuo account.",
    "error.storageFull": "Archiviazione piena! Prova a rimuovere alcune schede o a esportarle.",
    "gen.empty": "(vuoto)",
    "gen.free": "Gratuito",
    "gen.unlimited": "Illimitato",
    "gen.notAvailable": "N/D",
    "gen.unnamed": "Senza nome",
    "gen.byCreator": "di {{name}}",
    "gen.copySuffix": " (Copia)",
    "gen.toastAutoHide": "Si nasconde automaticamente tra {{s}}s",
    "gen.untagged": "Nessun tag trovato",
    "gen.noMatch": "Nessuna scheda corrisponde ai tuoi filtri",
    "batch.deleteConfirm": "Eliminare {{count}} scheda/e? Questa operazione non può essere annullata.",
    "left.selected": "{{count}} selezionate",
    "toast.cardDeleted": 'Scheda "{{name}}" eliminata',
    "ai.apply": "Applica",
    "ai.applyTitle": "Applica queste modifiche alla scheda",
    "ai.errorPrefix": "Errore: ",
    "ai.translatePrompt": "In quale lingua vuoi tradurre?",
    "ai.translateDefaultLang": "Francese",
    "ai.tonePrompt": "Quale tono? (es. formale, informale, cupo, umoristico, poetico)",
    "ai.toneDefault": "formale",
    "ai.chatSession": "Sessione chat",
    "ai.msgs": "{{count}} msg",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Supera il limite!",
    "ai.approachingLimit": " ⚠ Limite vicino",
    "ai.count": "Conteggio:",
    "ai.resizeAria": "Ridimensiona assistente AI",
    "ai.chatMessagesAria": "Messaggi della chat AI",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Dialogo di esempio qui...
{{user}}: Risposta dell'utente...
<START>
{{char}}: Un altro esempio...`,
    "batch.select2ForCompare": "Seleziona esattamente 2 schede da confrontare",
    "batch.compareLoadFailed": "Impossibile caricare le schede per il confronto",
    "batch.comparePrefix": "Confronta: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Scheda A",
    "batch.cardB": "Scheda B",
    "editor.charCount": "{{chars}} caratteri ~{{tokens}} token",
    "editor.counterWarn": "Vicino al limite di token di output ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Oltre il limite di token di output ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Sposta su",
    "editor.greetingMoveDown": "Sposta giù",
    "editor.greetingIsDefault": "Questo è il primo messaggio corrente",
    "editor.greetingSetDefault": "Imposta come primo messaggio",
    "editor.greetingRemove": "Rimuovi",
    "editor.greetingPlaceholder": "Saluto {{num}}...",
    "editor.loreEntry": "Voce {{num}}",
    "editor.loreDeleteEntry": "Elimina voce",
    "editor.lorePrimaryKeys": "Parole chiave primarie",
    "editor.lorePrimaryKeysPlaceholder": "Parole chiave primarie — separate da virgole",
    "editor.loreSecondaryKeys": "Parole chiave secondarie",
    "editor.loreSecondaryKeysPlaceholder": "Parole chiave secondarie",
    "editor.loreComment": "Commento",
    "editor.loreCommentPlaceholder": "Commento",
    "editor.loreOrder": "Ordine",
    "editor.loreOrderPlaceholder": "Ordine",
    "editor.loreConstant": "Costante",
    "editor.loreSelective": "Selettiva",
    "editor.loreBeforeChar": "Prima del personaggio",
    "editor.loreAfterChar": "Dopo il personaggio",
    "editor.loreContent": "Contenuto",
    "editor.loreContentPlaceholder": "Contenuto della voce...",
    "editor.loreNewEntry": "Nuova voce",
    "error.unknown": "Errore sconosciuto",
    "error.unexpected": "Errore imprevisto: {{message}}",
    "error.requestFailed": "Richiesta non riuscita: {{message}}",
    "error.unsupportedFile": "Tipo di file non supportato: .{{ext}}",
    "error.invalidJson": "JSON non valido: {{message}}",
    "error.notPng": "File PNG non valido",
    "error.unknownFormat": "Formato scheda sconosciuto — non è una scheda personaggio SillyTavern",
    "error.fetchModelsFailed": "Impossibile recuperare i modelli (HTTP {{status}})",
    "error.customServerError": "Il server ha restituito un errore: {{detail}}",
    "error.noChoices": "L'API non ha restituito opzioni di risposta",
    "error.emptyResponse": "Risposta vuota dall'API (nessun corpo)",
    "gen.newCharacter": "Nuovo personaggio",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Backup",
    "settings.restore": "Ripristina",
    "settings.backupTitle": "Esegui il backup di tutte le schede",
    "settings.restoreTitle": "Ripristina backup",
    "settings.exportTitle": "Esporta impostazioni",
    "settings.importTitle": "Importa impostazioni",
    "settings.modelAuto": "Automatico",
    "settings.modelIdPlaceholder": "es. deepseek-v4-flash",
    "settings.customModelPlaceholder": "es. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "es. {{provider}}-latest",
    "settings.getApiKeyFrom": "Ottieni la chiave API da ",
    "settings.customModelDesc": "Modello personalizzato",
    "settings.workspaceExported": "Area di lavoro esportata ({{count}} schede)",
    "settings.invalidWorkspace": "Formato area di lavoro non valido",
    "settings.workspaceImported": "Area di lavoro importata ({{count}} schede)",
    "settings.workspaceImportFailed": "Importazione area di lavoro non riuscita: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Attiva/disattiva assistente AI",
    "nav.toggleAIAria": "Attiva/disattiva assistente AI",
    "nav.notificationsAria": "Notifiche",
    "left.sortCards": "Ordina schede",
    "left.compareSelected": "Confronta schede selezionate",
    "left.resizeAria": "Ridimensiona libreria schede",
    "left.cardListAria": "Libreria schede",
    "ui.saved": " Salvat",
    "ui.collapsePanel": "Comprimi pannello",
    "ui.expandPanel": "Espandi pannello",
    "ui.cardModified": "Modifiche non salvate",
    "export.minimalPngLabel": "Scheda ST",
    "wizard.search": "Cerca",
    "wizard.quick": "Veloce:",
    "wizard.imageSearchPlaceholder": "Cerca tag: gatto, vestito, divisa, cyberpunk...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.pl = {
    "app.title": "ST Card Editor — Studio kart postaci SillyTavern",
    "nav.selectModel": "Wybierz model...",
    "nav.wizard": "Utwórz za pomocą kreatora AI",
    "nav.newCard": "Nowa pusta karta",
    "nav.save": "Zapisz",
    "nav.theme": "Przełącz motyw",
    "nav.shortcuts": "Skróty i pomoc",
    "nav.settings": "Ustawienia",
    "nav.focus": "Tryb skupienia",
    "nav.focusAlt": "Tryb skupienia (Alt+F)",
    "left.title": "Biblioteka kart",
    "left.cards": "{{count}} kart",
    "left.drop": "Przeciągnij i upuść",
    "left.dropSub": "Karty postaci PNG lub JSON",
    "left.browse": "Przeglądaj pliki",
    "left.search": "Szukaj kart...",
    "left.sort.nameAsc": "Nazwa A-Z",
    "left.sort.nameDesc": "Nazwa Z-A",
    "left.sort.manual": "Ręcznie",
    "left.sort.newest": "Najnowsze",
    "left.sort.oldest": "Najstarsze",
    "left.sort.largest": "Największe",
    "left.sort.smallest": "Najmniejsze",
    "left.filterTags": "Filtruj według tagów",
    "left.exportSelected": "Eksportuj zaznaczone jako JSON",
    "left.deleteSelected": "Usuń zaznaczone",
    "left.empty": "Nie załadowano żadnych kart",
    "left.emptySub": "Upuść kartę lub kliknij Przeglądaj",
    "center.noCard": "Nie wybrano karty",
    "center.noCardSub": "Wybierz kartę z biblioteki lub przeciągnij i upuść nową",
    "center.createAI": "Utwórz z AI",
    "center.blankCard": "Pusta karta",
    "editor.avatar": "Kliknij lub upuść obraz, aby ustawić awatar",
    "editor.avatarAria": "Ustaw awatar postaci",
    "editor.name": "Imię postaci",
    "editor.exportJson": "Eksportuj jako JSON",
    "editor.exportPng": "Eksportuj jako PNG",
    "editor.duplicate": "Duplikuj kartę",
    "editor.delete": "Usuń kartę",
    "editor.tab.core": "Główne",
    "editor.tab.personality": "Osobowość",
    "editor.tab.advanced": "Zaawansowane",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Obraz Waifu",
    "editor.waifuPreview": "Aktualny obraz karty",
    "editor.waifuNoImage": "Nie ustawiono jeszcze obrazu",
    "editor.waifuSource": "Źródło obrazu",
    "editor.waifuSourceSnap": "Migawki anime (waifu.im)",
    "editor.waifuSourceChar": "Postacie anime (AniList)",
    "editor.waifuGender": "Płeć",
    "editor.waifuGenderAll": "Dowolna płeć",
    "editor.waifuGenderFemaleOnly": "Tylko kobiety",
    "editor.waifuGenderMaleOnly": "Tylko mężczyźni",
    "editor.waifuGenderFemale": "Kobieta",
    "editor.waifuGenderMale": "Mężczyzna",
    "editor.waifuCharSub": "szukaj postaci po nazwie (np. zoro)",
    "editor.waifuSearch": "Szukaj na waifu.im",
    "editor.waifuSearchChar": "Szukaj postaci",
    "editor.waifuSearchPlaceholderChar": "szukaj postaci po nazwie (np. zoro)",
    "editor.waifuSub": "(pobiera obrazy w stylu anime według tagu)",
    "editor.waifuSearchPlaceholder": "np. waifu, elf, pokojówka...",
    "editor.waifuFetch": "Pobierz obrazy",
    "editor.waifuRegenTitle": "Przegeneruj wyniki",
    "editor.waifuMixed": "Kobiety + Mężczyźni",
    "editor.waifuMixedSub": "zbalansowany pakiet jednym kliknięciem: 3 postacie żeńskie + 3 męskie",
    "editor.waifuUse": "Użyj jako obrazu karty",
    "editor.waifuUpload": "Prześlij z urządzenia",
    "editor.waifuRemove": "Usuń obraz",
    "toast.noImage": "Ta karta nie ma obrazu do usunięcia",
    "toast.imageRemoved": "Obraz usunięty",
    "editor.desc": "Opis",
    "editor.descSub": "(wygląd, historia)",
    "editor.descPlaceholder": "Opisz wygląd postaci, pochodzenie i kluczowe cechy...",
    "editor.firstMes": "Pierwsza wiadomość",
    "editor.firstMesPlaceholder": "Pierwsza wiadomość postaci na początku czatu...",
    "editor.scenario": "Scenariusz",
    "editor.scenarioPlaceholder": "Obecne okoliczności i kontekst rozmowy...",
    "editor.creator": "Twórca",
    "editor.creatorPlaceholder": "Twórca / autor karty",
    "editor.version": "Wersja postaci",
    "editor.tags": "Tagi",
    "editor.tagsSub": "(oddzielone przecinkami)",
    "editor.tagsPlaceholder": "fantasy, wojowniczka, elfka",
    "editor.personalitySummary": "Podsumowanie osobowości",
    "editor.personalityPlaceholder": "Krótki opis osobowości postaci... (używany w formacie karty postaci)",
    "editor.mesExample": "Przykładowe wiadomości",
    "editor.mesExampleFormat": "Format: bloki <START> z prefiksami {{char}}: i {{user}}:",
    "editor.systemPrompt": "Prompt systemowy",
    "editor.systemPromptPlaceholder": "Zastąp prompt systemowy. Użyj {{original}}, aby dołączyć domyślny.",
    "editor.postHistory": "Instrukcje po historii",
    "editor.postHistoryPlaceholder": "Instrukcje wstrzykiwane po historii czatu. Użyj {{original}} dla domyślnych.",
    "editor.creatorNotes": "Notatki twórcy",
    "editor.creatorNotesPlaceholder": "Notatki dla użytkowników karty (zalecane modele, wskazówki użycia...)",
    "editor.greetings": "Alternatywne powitania",
    "editor.addGreeting": "Dodaj powitanie",
    "editor.lorebookTitle": "Wpisy lorebooku postaci",
    "editor.addEntry": "Dodaj wpis",
    "editor.lorebookSearch": "Szukaj wpisów po kluczu, treści lub komentarzu...",
    "editor.lorebookEmpty": "Brak wpisów w lorebooku. Dodaj jeden, aby zacząć.",
    "editor.noGreetings": "Brak powitań. Kliknij <strong>Dodaj powitanie</strong> lub wygeneruj je za pomocą AI.",
    "editor.noEntriesMatch": 'Brak wpisów pasujących do "{{query}}"',
    "editor.edit": "Edytuj",
    "editor.preview": "Podgląd",
    "ai.title": "Asystent AI",
    "ai.clearChat": "Wyczyść czat",
    "ai.welcomeTitle": "Asystent kart AI",
    "ai.welcomeText": "Poproś AI o edycję, tłumaczenie lub ulepszenie karty postaci.",
    "ai.quick.newCard": "Nowa karta",
    "ai.quick.translate": "Tłumacz",
    "ai.quick.enhance": "Ulepsz",
    "ai.quick.shorten": "Skróć",
    "ai.quick.tone": "Zmień ton",
    "ai.quick.grammar": "Popraw gramatykę",
    "ai.quick.personality": "Rozbuduj osobowość",
    "ai.quick.firstmes": "Ulepsz pierwszą wiadomość",
    "ai.quick.scenario": "Rozbuduj scenariusz",
    "ai.quick.greetings": "Generuj powitania",
    "ai.quick.systemprompt": "Ulepsz prompt systemowy",
    "ai.quick.tags": "Zasugeruj tagi",
    "ai.contextTitle": "Szacowane użyte tokeny a limit kontekstu modelu",
    "ai.contextLabel": "— / — tokenów",
    "ai.placeholder": "Poproś AI o edycję karty...",
    "ai.send": "Wyślij",
    "ai.stop": "Zatrzymaj generowanie",
    "ai.autoModel": "Wybierz model...",
    "ai.target": "Cel:",
    "ai.target.full": "Cała karta",
    "ai.target.description": "Opis",
    "ai.target.personality": "Osobowość",
    "ai.target.first_mes": "Pierwsza wiadomość",
    "ai.target.scenario": "Scenariusz",
    "ai.target.mes_example": "Przykładowe wiadomości",
    "ai.target.system_prompt": "Prompt systemowy",
    "ai.target.post_history_instructions": "Instrukcje po historii",
    "ai.target.creator_notes": "Notatki twórcy",
    "ai.target.alternate_greetings": "Alternatywne powitania",
    "ai.selectModel": "Wybierz model",
    "ai.actionNewCard": "Nowa karta",
    "ai.actionTranslate": "Tłumacz",
    "ai.actionEnhance": "Ulepsz",
    "ai.actionShorten": "Skróć",
    "ai.actionTone": "Zmień ton",
    "ai.actionGrammar": "Popraw gramatykę",
    "ai.actionPersonality": "Rozbuduj osobowość",
    "ai.actionFirstMes": "Ulepsz pierwszą wiadomość",
    "ai.actionScenario": "Rozbuduj scenariusz",
    "ai.actionGreetings": "Generuj powitania",
    "ai.actionSystemprompt": "Ulepsz prompt systemowy",
    "ai.actionTags": "Zasugeruj tagi",
    "ai.chatHistory": "Historia czatu",
    "ai.historyTitle": "Historia czatu",
    "ai.historyEmpty": "Brak rozmów",
    "ai.retry": "Ponów",
    "ai.retryTitle": "Wygeneruj ponownie tę odpowiedź",
    "ai.reapply": "Zastosuj ponownie",
    "ai.reapplyTitle": "Otwórz ponownie diff, aby zastosować te zmiany",
    "ai.noCard": "(nie wybrano karty)",
    "ai.editing": "Edycja {{count}} pola/pól...",
    "ai.streaming": "przesyłanie...",
    "ai.failed": "niepowodzenie",
    "ai.cancelled": "Anulowano.",
    "ai.doneSummary": "{{done}}/{{total}} gotowych · {{errs}} nieudanych",
    "ai.viewFullResult": "Zobacz pełny wynik",
    "ai.showLess": "Pokaż mniej",
    "ai.reviewApply": "Przejrzyj i zastosuj",
    "ai.changesNav": "Zmiana {{current}} z {{total}}",
    "ai.changesPrev": "Poprzednia zmiana",
    "ai.changesNext": "Następna zmiana",
    "ai.applied": "Zastosowano",
    "ai.target.tags": "Tagi",
    "ai.copy": "Kopiuj",
    "ai.copied": "Skopiowano!",
    "ai.copyFailed": "Niepowodzenie",
    "ai.resultTitle": "Wynik",
    "ai.close": "Zamknij",
    "settings.themeColor": "Kolor motywu",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Wybierz osobny kolor akcentu dla motywu jasnego i ciemnego. Zmiany są stosowane natychmiast.",
    "settings.appearance": "Wygląd",
    "settings.accentPresets": "Presety akcentu",
    "settings.glassDensity": "Gęstość szkła",
    "settings.glassSubtle": "Subtelny",
    "settings.glassDefault": "Domyślny",
    "settings.glassBold": "Odważny",
    "settings.cardRadius": "Promień kart",
    "settings.radiusCompact": "Kompaktowy",
    "settings.radiusRounded": "Zaokrąglony",
    "settings.radiusPill": "Tabletka",
    "settings.vignette": "Winieta krawędzi",
    "settings.appearanceHint": "Dostosuj wygląd każdego jasnego/ciemnego motywu. Zmiany akcentu stosują się natychmiast; gęstość, promień i winieta są uwzględniane w kopiach zapasowych obszaru roboczego.",
    "settings.resetThemeColor": "Resetuj",
    "settings.generalTab": "Ogólne",
    "settings.promptsTab": "Prompty AI",
    "settings.assistantPrompt": "Prompt systemowy asystenta",
    "settings.fullCardPrompt": "Prompt systemowy całej karty",
    "settings.wizardPrompt": "Instrukcje generowania postaci",
    "settings.promptPlaceholder": "Pozostaw puste, aby użyć wbudowanego promptu",
    "settings.chatSystemPrompts": "Instrukcje czatu i systemu",
    "settings.fullCardInstr": "Instrukcje wyjścia całej karty (system)",
    "settings.fieldsEdit": "Instrukcje edycji pola (system)",
    "settings.greetingsSystem": "Instrukcje wyjścia powitań (system)",
    "settings.exportPrompts": "Eksportuj prompty",
    "settings.importPrompts": "Importuj prompty",
    "settings.promptsExported": "Prompty wyeksportowane",
    "settings.promptsImported": "Zaimportowano promptów: {count}",
    "settings.quickActionPrompts": "Prompty szybkich akcji",
    "settings.tagsSystemPrompt": "Instrukcje wyjścia tagów (system)",
    "settings.restoreDefaultPrompts": "Przywróć domyślne prompty",
    "settings.promptHint": "Te pola pokazują bieżące prompty. Puste pole oznacza użycie wbudowanego promptu domyślnego. Przywróć domyślne, aby je wyświetlić lub przywrócić.",
    "settings.title": "Ustawienia",
    "settings.provider": "Dostawca",
    "settings.providerHint": "Zewnętrzni dostawcy modeli lub własny endpoint (LM Studio, Ollama itd.)",
    "settings.apiKey": "Klucz API",
    "settings.getApiKey": "Pobierz klucz API z OpenRouter",
    "settings.baseUrl": "Podstawowy adres URL API",
    "settings.namedApiKeyPlaceholder": "Wprowadź swój klucz API",
    "settings.customHint": "Endpoint zgodny z OpenAI. Przykłady: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "Klucz API (opcjonalny)",
    "settings.apiKeyLocalPlaceholder": "Pozostaw puste dla dostawców lokalnych",
    "settings.apiKeyLocalHint": "Niewymagany dla lokalnych serwerów, takich jak LM Studio czy Ollama.",
    "settings.modelId": "ID modelu",
    "settings.modelIdHint": "Dokładny ID modelu oczekiwany przez Twojego dostawcę.",
    "settings.modelIdHintNamed": "Pozostaw puste, aby użyć domyślnego modelu dostawcy.",
    "settings.security": "Twój klucz API jest szyfrowany w localStorage przeglądarki przy użyciu klucza powiązanego z tym adresem. Nie używaj tej aplikacji na współdzielonych urządzeniach.",
    "settings.secretUnreadable": "Ze względów bezpieczeństwa zapisany klucz API nie został odblokowany na tym adresie — wprowadź go ponownie w Ustawieniach.",
    "error.pngInflateFailed": "Ten plik PNG zawiera dane postaci, których nie udało się zdekompresować.",
    "settings.defaultModel": "Domyślny model",
    "settings.browseModels": "Przeglądaj modele poniżej...",
    "settings.refreshModels": "Odśwież modele",
    "settings.maxTokens": "Maksymalna liczba tokenów wyjściowych",
    "settings.maxTokensPlaceholder": "0 = użyj domyślnego modelu",
    "settings.maxTokensHint": "Zastąp maksymalną liczbę tokenów wyjściowych na żądanie. Ustaw 0, aby automatycznie użyć limitu wybranego modelu (lub 64k, jeśli nieznany).",
    "settings.copyright": "Dodaj informację o edytorze przy eksporcie",
    "settings.copyrightHint": "Dodaje linię z informacją o twórcy do notatek przy eksporcie kart.",
    "settings.availableModels": "Dostępne modele",
    "settings.searchModels": "Szukaj modeli...",
    "settings.enterApiKey": "Wprowadź klucz API i odśwież, aby załadować modele",
    "settings.credits": "Kredyty i zużycie",
    "settings.creditLimit": "Limit kredytów",
    "settings.remaining": "Pozostało",
    "settings.usedMonth": "Zużyto w tym miesiącu",
    "settings.localStorage": "Pamięć lokalna",
    "settings.clearAll": "Wyczyść wszystkie dane",
    "settings.export": "Eksportuj",
    "settings.import": "Importuj",
    "settings.close": "Zamknij",
    "settings.saveSettings": "Zapisz ustawienia",
    "settings.languageLabel": "Język",
    "settings.languageHint": "Język interfejsu (odśwież stronę, jeśli brakuje)",
    "settings.languageChanged": "Język zaktualizowany",
    "settings.clearConfirm": "Usunąć WSZYSTKIE karty, ustawienia i historię czatu? Tej operacji nie można cofnąć.",
    "settings.providerCustom": "Własny (zgodny z OpenAI)",
    "settings.noModels": "Nie znaleziono modeli",
    "settings.loadMore": "Załaduj więcej ({{count}} pozostało)",
    "settings.showingModels": "Pokazano {{shown}} z {{total}} modeli",
    "wizard.title": "Utwórz postać",
    "wizard.step.basics": "Podstawy",
    "wizard.step.concept": "Koncepcja",
    "wizard.step.personality": "Osobowość",
    "wizard.step.scenario": "Scenariusz",
    "wizard.step.generate": "Generuj",
    "wizard.basicsTitle": "Podstawy postaci",
    "wizard.nameLabel": "Imię postaci",
    "wizard.namePlaceholder": "np. Elara Nightwhisper",
    "wizard.genderLabel": "Płeć / Zaimki",
    "wizard.genderSelect": "Wybierz...",
    "wizard.gender.female": "Kobieta (ona)",
    "wizard.gender.male": "Mężczyzna (on)",
    "wizard.gender.nonbinary": "Niebinarny (ono/they)",
    "wizard.gender.other": "Inna...",
    "wizard.genderCustom": "Własne zaimki (np. ono/ono)",
    "wizard.tagsLabel": "Tagi",
    "wizard.tagsSub": "(oddzielone przecinkami, pomagają organizować bibliotekę)",
    "wizard.tagsPlaceholder": "fantasy, wojowniczka, elfka, oryginalna",
    "wizard.creatorLabel": "Twórca",
    "wizard.creatorPlaceholder": "Twoje imię / pseudonim",
    "wizard.conceptTitle": "Koncepcja i świat",
    "wizard.typeLabel": "Typ postaci",
    "wizard.type.original": "Postać oryginalna",
    "wizard.type.fanfic": "Fan fiction",
    "wizard.type.game": "Postać z gry",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Książka / Film / Serial",
    "wizard.type.historical": "Postać historyczna",
    "wizard.type.mythological": "Mitologiczna / Folklorystyczna",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Inna",
    "wizard.languageLabel": "Język",
    "wizard.language.other": "Inny",
    "wizard.languageSpecify": "Określ język",
    "wizard.genreLabel": "Gatunek / Świat",
    "wizard.genreSub": "(zaznacz wszystkie pasujące)",
    "wizard.moodLabel": "Nastrój / Ton",
    "wizard.moodSub": "(zaznacz wszystkie pasujące)",
    "wizard.personalityTitle": "Osobowość i wygląd",
    "wizard.personalityTraits": "Cechy osobowości",
    "wizard.personalityTraitsSub": "(opisz 3-5 kluczowych cech, to pomaga AI)",
    "wizard.personalityTraitsPlaceholder": "np. Odważna, ale lekkomyślna, bardzo lojalna wobec przyjaciół, suche poczucie humoru, trudno jej zaufać, potajemnie kocha zwierzęta",
    "wizard.appearanceLabel": "Wygląd fizyczny",
    "wizard.appearanceSub": "(krótki opis tego, jak wygląda)",
    "wizard.appearancePlaceholder": "np. Wysoka kobieta ze srebrnymi włosami do pasa, dłonie pokryte bliznami, nosi ciemną skórzaną kurtkę, przenikliwe zielone oczy",
    "wizard.abilitiesLabel": "Specjalne zdolności / Dziwactwa",
    "wizard.abilitiesSub": "(opcjonalnie, dowolne unikalne cechy)",
    "wizard.abilitiesPlaceholder": "np. Potrafi rozmawiać ze zwierzętami, ma pamięć fotograficzną, zawsze nosi znoszony dziennik",
    "wizard.scenarioTitle": "Scenariusz i pierwsza wiadomość",
    "wizard.scenarioLabel": "Scenariusz / Ustawienie",
    "wizard.scenarioSub": "(od czego zaczyna się historia?)",
    "wizard.scenarioPlaceholder": "np. Deszczowa noc w mieście oświetlonym neonami. Postać prowadzi mały warsztat, który naprawia zarówno maszyny, jak i złamane serca.",
    "wizard.relationshipLabel": "Relacja z {{user}}",
    "wizard.relationshipSub": "(jak postać postrzega użytkownika?)",
    "wizard.relationshipPlaceholder": "np. Nowy klient, który wszedł do warsztatu z tajemniczym zepsutym urządzeniem. Postać jest ciekawa, ale ostrożna.",
    "wizard.openingLabel": "Charakter pierwszej wiadomości",
    "wizard.openingSub": "(jak powinna brzmieć wiadomość otwierająca?)",
    "wizard.notesLabel": "Dodatkowe notatki",
    "wizard.notesSub": "(cokolwiek innego, co AI powinno wiedzieć?)",
    "wizard.notesPlaceholder": "np. Zachowaj naturalny dialog, unikaj zbyt formalnego tonu, dołącz opisy akcji w gwiazdkach",
    "wizard.generateTitle": "Generuj postać",
    "wizard.refImage": "Obraz referencyjny",
    "wizard.refImageSub": "(opcjonalnie, z waifu.im)",
    "wizard.fetchImages": "Pobierz 3 obrazy",
    "wizard.refetchOthers": "Pobierz inne",
    "wizard.fetching": "Pobieranie...",
    "wizard.useSelected": "Użyj zaznaczonego",
    "wizard.clear": "Wyczyść",
    "wizard.generateAI": "Generuj z AI",
    "wizard.generateAISub": "Pełna karta postaci na podstawie Twoich odpowiedzi",
    "wizard.createBlank": "Utwórz pustą kartę",
    "wizard.createBlankSub": "Zacznij z wstępnie wypełnioną nazwą i tagami",
    "wizard.back": "Wstecz",
    "wizard.next": "Dalej",
    "wizard.stepLabel": "Krok {{step}} z {{total}}",
    "wizard.ready": "Gotowe do generowania!",
    "wizard.nameRequired": "Podaj imię postaci",
    "wizard.summary.name": "Imię",
    "wizard.summary.gender": "Płeć",
    "wizard.summary.type": "Typ",
    "wizard.summary.language": "Język",
    "wizard.summary.tags": "Tagi",
    "wizard.summary.genres": "Gatunki",
    "wizard.summary.mood": "Nastrój",
    "wizard.summary.opening": "Otwarcie",
    "wizard.summary.personality": "Osobowość",
    "wizard.summary.appearance": "Wygląd",
    "wizard.summary.scenario": "Scenariusz",
    "wizard.summary.relationship": "Relacja",
    "wizard.summary.notes": "Notatki",
    "wizard.chip.fantasy": "Fantasy",
    "wizard.chip.scifi": "Sci-Fi",
    "wizard.chip.modern": "Współczesny",
    "wizard.chip.historical": "Historyczny",
    "wizard.chip.horror": "Horror",
    "wizard.chip.romance": "Romans",
    "wizard.chip.comedy": "Komedia",
    "wizard.chip.sliceOfLife": "Codzienność",
    "wizard.chip.adventure": "Przygoda",
    "wizard.chip.mystery": "Tajemnica",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Postapokalipsa",
    "wizard.chip.supernatural": "Nadprzyrodzony",
    "wizard.chip.military": "Wojskowy",
    "wizard.chip.surreal": "Surrealistyczny",
    "wizard.chip.serious": "Poważny",
    "wizard.chip.playful": "Zabawny",
    "wizard.chip.dark": "Mroczny",
    "wizard.chip.lighthearted": "Lekki",
    "wizard.chip.mysterious": "Tajemniczy",
    "wizard.chip.romantic": "Romantyczny",
    "wizard.chip.intense": "Intensywny",
    "wizard.chip.wholesome": "Słodki i pozytywny",
    "wizard.chip.chaotic": "Chaotyczny",
    "wizard.chip.melancholic": "Melancholijny",
    "wizard.chip.sarcastic": "Sarkastyczny",
    "wizard.chip.stoic": "Stoicki",
    "wizard.chip.greeting": "Ciepłe powitanie",
    "wizard.chip.action": "W sam środek akcji",
    "wizard.chip.question": "Ciekawe pytanie",
    "wizard.chip.conflict": "Natychmiastowy konflikt",
    "wizard.chip.atmospheric": "Nastrojowy",
    "wizard.editStep": "Edytuj tę sekcję",
    "wizard.draftRestored": "Przywrócono szkic — Twoje wcześniejsze odpowiedzi wróciły",
    "wizard.imagePlaceholder": "Kliknij Pobierz",
    "diff.title": "Podgląd odpowiedzi AI",
    "diff.removed": "Usunięte",
    "diff.added": "Dodane",
    "diff.current": "Obecna",
    "diff.proposed": "Proponowana",
    "diff.empty": "(puste)",
    "diff.discard": "Odrzuć",
    "diff.apply": "Zastosuj zmiany",
    "shortcuts.title": "Skróty",
    "shortcuts.save": "Zapisz kartę",
    "shortcuts.newCard": "Nowa karta",
    "shortcuts.undo": "Cofnij",
    "shortcuts.redo": "Ponów",
    "shortcuts.sendAi": "Wyślij wiadomość AI",
    "shortcuts.newLine": "Nowa linia w czacie AI",
    "shortcuts.focus": "Tryb skupienia",
    "shortcuts.collapsePanel": "Zwiń/rozwiń panel AI",
    "toast.loadFailed": "Niepowodzenie: {{name}}",
    "toast.loaded": "Załadowano {{count}} kart",
    "toast.importDupe": "Ta sama treść co istniejąca karta — zaimportowano jako {{name}}",
    "toast.largeImage": "Duży obraz osadzony w {{name}} ({{size}} MB) - rozważ jego usunięcie, aby zaoszczędzić miejsce.",
    "toast.noValid": "Nie znaleziono prawidłowych kart. Upuść pliki PNG lub JSON.",
    "toast.noSelected": "Nie zaznaczono kart",
    "toast.cardsDeleted": "Usunięto karty",
    "toast.deleteFailed": "Nie udało się usunąć karty",
    "toast.exported": "Wyeksportowano {{count}} kart",
    "toast.newBlank": "Utworzono nową pustą kartę",
    "toast.noCardSave": "Brak karty do zapisania",
    "toast.cardSaved": "Karta zapisana!",
    "toast.noCardDup": "Brak karty do zduplikowania",
    "toast.cardDup": "Karta zduplikowana",
    "toast.cardRestored": "Przywrócono kartę",
    "toast.selectCard": "Najpierw wybierz kartę",
    "toast.avatarUpdated": "Zaktualizowano awatar",
    "toast.imgFailed": "Nie udało się załadować obrazu",
    "toast.firstMesUpdated": "Pierwsza wiadomość zaktualizowana!",
    "toast.settingsSaved": "Ustawienia zapisane!",
    "toast.modelsFailed": "Nie udało się załadować modeli: {{error}}",
    "toast.modelSet": "Ustawiono model: {{model}}",
    "toast.dataCleared": "Wszystkie dane wyczyszczone",
    "toast.settingsExported": "Wyeksportowano ustawienia",
    "toast.settingsImported": "Zaimportowano ustawienia!",
    "toast.invalidFile": "Nieprawidłowy plik ustawień",
    "toast.apiKey": "Ustaw klucz API w Ustawieniach",
    "toast.selectModel": "Najpierw wybierz model z paska nawigacji lub z ustawień.",
    "toast.genStopped": "Generowanie zatrzymane.",
    "toast.aiError": "Błąd AI: {{error}}",
    "toast.cardUpdatedAI": "Karta zaktualizowana na podstawie odpowiedzi AI!",
    "toast.jsonParseFailed": "Nie można sparsować odpowiedzi AI jako JSON. Sprawdź czat.",
    "toast.emptyResponse": "AI zwróciła pustą zawartość — nie ma nic do zastosowania.",
    "toast.jsonInvalid": "AI nie zwróciło prawidłowego JSON. Odpowiedź znajduje się w czacie — możesz ją skopiować ręcznie.",
    "toast.fieldUpdated": 'Zaktualizowano "{{field}}"!',
    "toast.greetingsUpdated": "Wygenerowano {{count}} powitań!",
    "toast.tagsUpdated": "Tagi zaktualizowane — dodano {{count}} nowych!",
    "toast.greetingsParseFailed": "Nie można sparsować powitań z odpowiedzi AI.",
    "toast.createCardFirst": "Najpierw utwórz lub wybierz kartę",
    "toast.wizardCreated": "Karta utworzona! Zacznij edytować lub użyj AI, aby uzupełnić szczegóły.",
    "toast.wizardApi": "Najpierw ustaw klucz API w Ustawieniach",
    "toast.wizardModel": "Wybierz model lub ustaw własny ID modelu w Ustawieniach",
    "toast.wizardFetchFailed": "Nie udało się pobrać obrazów: {{error}}",
    "toast.wizardName": "Podaj imię postaci",
    "toast.storageFull": "Pamięć pełna! Spróbuj usunąć niektóre karty lub je wyeksportować.",
    "toast.exportedJson": "Wyeksportowano jako JSON!",
    "toast.exportedPng": "Wyeksportowano jako PNG z danymi karty!",
    "toast.exportFailed": "Eksport obrazu nie powiódł się. Przechodzę na JSON.",
    "toast.noNameWarning": 'Uwaga: karta nie ma nazwy. Plik zostanie zapisany jako "character.json".',
    "toast.chatCleared": "Czat wyczyszczony",
    "toast.selectField": "Wybierz co najmniej jedno pole do edycji",
    "toast.tooManyFields": "Zbyt wiele pól. Maksymalnie {{max}} naraz.",
    "toast.undo": "Cofnij",
    "toast.redo": "Ponów",
    "toast.reorderFiltered": "Wyłącz wyszukiwanie i filtry, aby zmienić kolejność kart.",
    "error.apiKeyNotSet": "Klucz API nie został ustawiony. Wprowadź klucz API w Ustawieniach.",
    "error.customUrlNotSet": "Nie ustawiono podstawowego adresu URL niestandardowego API. Otwórz Ustawienia → Niestandardowe (zgodne z OpenAI) i wpisz adres URL punktu końcowego (np. http://localhost:1234/v1).",
    "error.customServerError": "Serwer zwrócił błąd: {{detail}}",
    "error.customAuthFailed": "Uwierzytelnianie nie powiodło się (HTTP {{status}}). Sprawdź klucz API dla tego punktu końcowego.",
    "error.customPathNotFound": "Nie znaleziono punktu końcowego (HTTP 404). Sprawdź, czy podstawowy adres URL API jest kompletny (np. zawiera /v1).",
    "error.customUnreachable": "Nie można połączyć się z {{url}}. Sprawdź, czy serwer działa i czy podstawowy adres URL API jest poprawny i dostępny z tego urządzenia.",
    "error.noModel": "Nie wybrano modelu. Wybierz model lub ustaw ID modelu w Ustawieniach.",
    "error.noModelSimple": "Nie wybrano modelu.",
    "error.insufficientCredits": "Niewystarczające kredyty. Uzupełnij saldo konta.",
    "error.storageFull": "Pamięć pełna! Spróbuj usunąć niektóre karty lub je wyeksportować.",
    "gen.empty": "(puste)",
    "gen.free": "Bezpłatnie",
    "gen.unlimited": "Bez limitu",
    "gen.notAvailable": "B/D",
    "gen.unnamed": "Bez nazwy",
    "gen.byCreator": "autorstwa {{name}}",
    "gen.copySuffix": " (Kopia)",
    "gen.toastAutoHide": "Automatycznie ukrywa się po {{s}}s",
    "gen.untagged": "Nie znaleziono tagów",
    "gen.noMatch": "Brak kart pasujących do Twoich filtrów",
    "batch.deleteConfirm": "Usunąć {{count}} kart? Tej operacji nie można cofnąć.",
    "left.selected": "{{count}} zaznaczonych",
    "toast.cardDeleted": 'Usunięto kartę "{{name}}"',
    "ai.apply": "Zastosuj",
    "ai.applyTitle": "Zastosuj te zmiany do karty",
    "ai.errorPrefix": "Błąd: ",
    "ai.translatePrompt": "Na jaki język przetłumaczyć?",
    "ai.translateDefaultLang": "Francuski",
    "ai.tonePrompt": "Jaki ton? (np. formalny, swobodny, mroczny, humorystyczny, poetycki)",
    "ai.toneDefault": "formalny",
    "ai.chatSession": "Sesja czatu",
    "ai.msgs": "{{count}} wiad.",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Przekracza limit!",
    "ai.approachingLimit": " ⚠ Limit bliski",
    "ai.count": "Liczba:",
    "ai.resizeAria": "Zmień rozmiar asystenta AI",
    "ai.chatMessagesAria": "Wiadomości czatu AI",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Przykładowy dialog tutaj...
{{user}}: Odpowiedź użytkownika...
<START>
{{char}}: Inny przykład...`,
    "batch.select2ForCompare": "Wybierz dokładnie 2 karty do porównania",
    "batch.compareLoadFailed": "Nie udało się załadować kart do porównania",
    "batch.comparePrefix": "Porównanie: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Karta A",
    "batch.cardB": "Karta B",
    "editor.charCount": "{{chars}} znaków ~{{tokens}} tokenów",
    "editor.counterWarn": "Zbliżasz się do limitu tokenów wyjściowych ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Przekroczono limit tokenów wyjściowych ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Przenieś w górę",
    "editor.greetingMoveDown": "Przenieś w dół",
    "editor.greetingIsDefault": "To jest obecna pierwsza wiadomość",
    "editor.greetingSetDefault": "Ustaw jako pierwszą wiadomość",
    "editor.greetingRemove": "Usuń",
    "editor.greetingPlaceholder": "Powitanie {{num}}...",
    "editor.loreEntry": "Wpis {{num}}",
    "editor.loreDeleteEntry": "Usuń wpis",
    "editor.lorePrimaryKeys": "Główne słowa kluczowe",
    "editor.lorePrimaryKeysPlaceholder": "Główne słowa kluczowe — oddzielone przecinkami",
    "editor.loreSecondaryKeys": "Pomocnicze słowa kluczowe",
    "editor.loreSecondaryKeysPlaceholder": "Pomocnicze słowa kluczowe",
    "editor.loreComment": "Komentarz",
    "editor.loreCommentPlaceholder": "Komentarz",
    "editor.loreOrder": "Kolejność",
    "editor.loreOrderPlaceholder": "Kolejność",
    "editor.loreConstant": "Stały",
    "editor.loreSelective": "Selektywny",
    "editor.loreBeforeChar": "Przed postacią",
    "editor.loreAfterChar": "Po postaci",
    "editor.loreContent": "Treść",
    "editor.loreContentPlaceholder": "Treść wpisu...",
    "editor.loreNewEntry": "Nowy wpis",
    "error.unknown": "Nieznany błąd",
    "error.unexpected": "Nieoczekiwany błąd: {{message}}",
    "error.requestFailed": "Żądanie nie powiodło się: {{message}}",
    "error.unsupportedFile": "Nieobsługiwany typ pliku: .{{ext}}",
    "error.invalidJson": "Nieprawidłowy JSON: {{message}}",
    "error.notPng": "Nieprawidłowy plik PNG",
    "error.unknownFormat": "Nieznany format karty — to nie jest karta postaci SillyTavern",
    "error.fetchModelsFailed": "Nie udało się pobrać modeli (HTTP {{status}})",
    "error.noChoices": "API nie zwróciło żadnych opcji odpowiedzi",
    "error.emptyResponse": "Pusta odpowiedź z API (brak treści)",
    "gen.newCharacter": "Nowa postać",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Kopia zapasowa",
    "settings.restore": "Przywróć",
    "settings.backupTitle": "Wykonaj kopię zapasową wszystkich kart",
    "settings.restoreTitle": "Przywróć kopię zapasową",
    "settings.exportTitle": "Eksportuj ustawienia",
    "settings.importTitle": "Importuj ustawienia",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "np. deepseek-v4-flash",
    "settings.customModelPlaceholder": "np. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "np. {{provider}}-latest",
    "settings.getApiKeyFrom": "Pobierz klucz API z ",
    "settings.customModelDesc": "Własny model",
    "settings.workspaceExported": "Wyeksportowano obszar roboczy ({{count}} kart)",
    "settings.invalidWorkspace": "Nieprawidłowy format obszaru roboczego",
    "settings.workspaceImported": "Zaimportowano obszar roboczy ({{count}} kart)",
    "settings.workspaceImportFailed": "Nie udało się zaimportować obszaru roboczego: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Przełącz asystenta AI",
    "nav.toggleAIAria": "Przełącz asystenta AI",
    "nav.notificationsAria": "Powiadomienia",
    "left.sortCards": "Sortuj karty",
    "left.compareSelected": "Porównaj zaznaczone karty",
    "left.resizeAria": "Zmień rozmiar biblioteki kart",
    "left.cardListAria": "Biblioteka kart",
    "ui.saved": " Zapisano",
    "ui.collapsePanel": "Zwiń panel",
    "ui.expandPanel": "Rozwiń panel",
    "ui.cardModified": "Niezapisane zmiany",
    "export.minimalPngLabel": "Karta ST",
    "wizard.search": "Szukaj",
    "wizard.quick": "Szybko:",
    "wizard.imageSearchPlaceholder": "Szukaj tagów: kot, sukienka, mundur, cyberpunk...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.tr = {
    "app.title": "ST Card Editor — SillyTavern karakter kartı stüdyosu",
    "nav.selectModel": "Model seçin...",
    "nav.wizard": "AI sihirbazıyla oluştur",
    "nav.newCard": "Yeni boş kart",
    "nav.save": "Kaydet",
    "nav.theme": "Temayı değiştir",
    "nav.shortcuts": "Kısayollar ve yardım",
    "nav.settings": "Ayarlar",
    "nav.focus": "Odak modu",
    "nav.focusAlt": "Odak modu (Alt+F)",
    "left.title": "Kart Kütüphanesi",
    "left.cards": "{{count}} kart",
    "left.drop": "Sürükle ve bırak",
    "left.dropSub": "PNG veya JSON karakter kartları",
    "left.browse": "Dosyalara göz at",
    "left.search": "Kartlarda ara...",
    "left.sort.nameAsc": "İsim A-Z",
    "left.sort.manual": "Manuel",
    "left.sort.nameDesc": "İsim Z-A",
    "left.sort.newest": "En yeniler önce",
    "left.sort.oldest": "En eskiler önce",
    "left.sort.largest": "En büyükler",
    "left.sort.smallest": "En küçükler",
    "left.filterTags": "Etiketlere göre filtrele",
    "left.exportSelected": "Seçilenleri JSON olarak dışa aktar",
    "left.deleteSelected": "Seçilenleri sil",
    "left.empty": "Kart yüklenmedi",
    "left.emptySub": "Bir kart bırakın veya Göz At öğesine tıklayın",
    "center.noCard": "Kart seçilmedi",
    "center.noCardSub": "Kütüphaneden bir kart seçin veya yeni bir kartı sürükleyip bırakın",
    "center.createAI": "AI ile Oluştur",
    "center.blankCard": "Boş Kart",
    "editor.avatar": "Avatarı ayarlamak için bir görsel seçin veya bırakın",
    "editor.avatarAria": "Karakter avatarını ayarla",
    "editor.name": "Karakter Adı",
    "editor.exportJson": "JSON olarak dışa aktar",
    "editor.exportPng": "PNG olarak dışa aktar",
    "editor.duplicate": "Kartı çoğalt",
    "editor.delete": "Kartı sil",
    "editor.tab.core": "Temel",
    "editor.tab.personality": "Kişilik",
    "editor.tab.advanced": "Gelişmiş",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Waifu Görseli",
    "editor.waifuPreview": "Geçerli kart görseli",
    "editor.waifuNoImage": "Henüz görsel ayarlanmadı",
    "editor.waifuSource": "Görsel kaynağı",
    "editor.waifuSourceSnap": "Anime anlık görüntüleri (waifu.im)",
    "editor.waifuSourceChar": "Anime karakterleri (AniList)",
    "editor.waifuGender": "Cinsiyet",
    "editor.waifuGenderAll": "Tümü",
    "editor.waifuGenderFemaleOnly": "Sadece kadın",
    "editor.waifuGenderMaleOnly": "Sadece erkek",
    "editor.waifuGenderFemale": "Kadın",
    "editor.waifuGenderMale": "Erkek",
    "editor.waifuCharSub": "ada göre karakter ara (örn. zoro)",
    "editor.waifuSearch": "waifu.im'de ara",
    "editor.waifuSearchChar": "Karakter ara",
    "editor.waifuSearchPlaceholderChar": "ada göre karakter ara (örn. zoro)",
    "editor.waifuSub": "(etiketle anime tarzı görseller getirir)",
    "editor.waifuSearchPlaceholder": "örn. waifu, elf, hizmetçi...",
    "editor.waifuFetch": "Görselleri getir",
    "editor.waifuRegenTitle": "Sonuçları yeniden oluştur",
    "editor.waifuMixed": "Kadın + Erkek",
    "editor.waifuMixedSub": "tek tıkla dengeli paket: 3 kadın + 3 erkek karakter",
    "editor.waifuUse": "Kart görseli olarak kullan",
    "editor.waifuUpload": "Cihazdan yükle",
    "editor.waifuRemove": "Görseli kaldır",
    "toast.noImage": "Bu kartta kaldırılacak görsel yok",
    "toast.imageRemoved": "Görsel kaldırıldı",
    "editor.desc": "Açıklama",
    "editor.descSub": "(görünüm, geçmiş)",
    "editor.descPlaceholder": "Karakterin görünümünü, geçmişini ve temel özelliklerini açıklayın...",
    "editor.firstMes": "İlk Mesaj",
    "editor.firstMesPlaceholder": "Sohbet başlarken karakterin ilk mesajı...",
    "editor.scenario": "Senaryo",
    "editor.scenarioPlaceholder": "Konuşmanın güncel koşulları ve bağlamı...",
    "editor.creator": "Oluşturan",
    "editor.creatorPlaceholder": "Kart oluşturan / yazar",
    "editor.version": "Karakter Sürümü",
    "editor.tags": "Etiketler",
    "editor.tagsSub": "(virgülle ayrılmış)",
    "editor.tagsPlaceholder": "fantastik, savaşçı, elf",
    "editor.personalitySummary": "Kişilik Özeti",
    "editor.personalityPlaceholder": "Karakterin kişiliğinin kısa bir açıklaması... (karakter kartı formatında kullanılır)",
    "editor.mesExample": "Örnek Mesajlar",
    "editor.mesExampleFormat": "Biçim: {{char}}: ve {{user}}: önekleriyle <START> blokları",
    "editor.systemPrompt": "Sistem Promptu",
    "editor.systemPromptPlaceholder": "Sistem promptunu değiştirin. Varsayılanı eklemek için {{original}} kullanın.",
    "editor.postHistory": "Geçmiş Sonrası Talimatları",
    "editor.postHistoryPlaceholder": "Sohbet geçmişinden sonra eklenen talimatlar. Varsayılan için {{original}} kullanın.",
    "editor.creatorNotes": "Oluşturan Notları",
    "editor.creatorNotesPlaceholder": "Kart kullanıcıları için notlar (model önerileri, kullanım ipuçları...)",
    "editor.greetings": "Alternatif Karşılama Mesajları",
    "editor.addGreeting": "Karşılama Ekle",
    "editor.lorebookTitle": "Karakter Lorebook Girdileri",
    "editor.addEntry": "Girdi Ekle",
    "editor.lorebookSearch": "Girdileri anahtar, içerik veya yoruma göre ara...",
    "editor.lorebookEmpty": "Henüz lorebook girdisi yok. Başlamak için bir tane ekleyin.",
    "editor.noGreetings": "Henüz karşılama yok. <strong>Karşılama Ekle</strong> seçeneğine tıklayın veya AI ile oluşturun.",
    "editor.noEntriesMatch": '"{{query}}" ile eşleşen girdi yok',
    "editor.edit": "Düzenle",
    "editor.preview": "Önizleme",
    "ai.title": "AI Asistanı",
    "ai.clearChat": "Sohbeti temizle",
    "ai.welcomeTitle": "AI Kart Asistanı",
    "ai.welcomeText": "AI'dan karakter kartınızı düzenlemesini, çevirmesini veya geliştirmesini isteyin.",
    "ai.quick.newCard": "Yeni Kart",
    "ai.quick.translate": "Çevir",
    "ai.quick.enhance": "Geliştir",
    "ai.quick.shorten": "Kısalt",
    "ai.quick.tone": "Tonu Değiştir",
    "ai.quick.grammar": "Dilbilgisini Düzelt",
    "ai.quick.personality": "Kişiliği Genişlet",
    "ai.quick.firstmes": "İlk Mesajı İyileştir",
    "ai.quick.scenario": "Senaryoyu Genişlet",
    "ai.quick.greetings": "Karşılama Oluştur",
    "ai.quick.systemprompt": "Sistem Promptunu Geliştir",
    "ai.quick.tags": "Etiket öner",
    "ai.contextTitle": "Kullanılan tahmini tokenler ile model bağlam limiti",
    "ai.contextLabel": "— / — token",
    "ai.placeholder": "AI'dan kartı düzenlemesini isteyin...",
    "ai.send": "Gönder",
    "ai.stop": "Üretmeyi durdur",
    "ai.autoModel": "Model seçin...",
    "ai.target": "Hedef:",
    "ai.target.full": "Tüm Kart",
    "ai.target.description": "Açıklama",
    "ai.target.personality": "Kişilik",
    "ai.target.first_mes": "İlk Mesaj",
    "ai.target.scenario": "Senaryo",
    "ai.target.mes_example": "Örnek Mesajlar",
    "ai.target.system_prompt": "Sistem Promptu",
    "ai.target.post_history_instructions": "Geçmiş Sonrası Talimatları",
    "ai.target.creator_notes": "Oluşturan Notları",
    "ai.target.alternate_greetings": "Alternatif Karşılama Mesajları",
    "ai.selectModel": "Bir model seçin",
    "ai.actionNewCard": "Yeni Kart",
    "ai.actionTranslate": "Çevir",
    "ai.actionEnhance": "Geliştir",
    "ai.actionShorten": "Kısalt",
    "ai.actionTone": "Tonu Değiştir",
    "ai.actionGrammar": "Dilbilgisini Düzelt",
    "ai.actionPersonality": "Kişiliği Genişlet",
    "ai.actionFirstMes": "İlk Mesajı İyileştir",
    "ai.actionScenario": "Senaryoyu Genişlet",
    "ai.actionGreetings": "Karşılama Oluştur",
    "ai.actionSystemprompt": "Sistem Promptunu Geliştir",
    "ai.actionTags": "Etiket öner",
    "ai.chatHistory": "Sohbet geçmişi",
    "ai.historyTitle": "Sohbet Geçmişi",
    "ai.historyEmpty": "Henüz konuşma yok",
    "ai.retry": "Yeniden dene",
    "ai.retryTitle": "Bu yanıtı yeniden üret",
    "ai.reapply": "Yeniden uygula",
    "ai.reapplyTitle": "Bu değişiklikleri uygulamak için diff'i yeniden aç",
    "ai.noCard": "(kart seçilmedi)",
    "ai.editing": "{{count}} alan düzenleniyor...",
    "ai.streaming": "akıyor...",
    "ai.failed": "başarısız",
    "ai.cancelled": "İptal edildi.",
    "ai.doneSummary": "{{done}}/{{total}} tamam · {{errs}} başarısız",
    "ai.viewFullResult": "Tam sonucu görüntüle",
    "ai.showLess": "Daha az göster",
    "ai.reviewApply": "İncele ve Uygula",
    "ai.changesNav": "Değişiklik {{current}} / {{total}}",
    "ai.changesPrev": "Önceki değişiklik",
    "ai.changesNext": "Sonraki değişiklik",
    "ai.applied": "Uygulandı",
    "ai.target.tags": "Etiketler",
    "ai.copy": "Kopyala",
    "ai.copied": "Kopyalandı!",
    "ai.copyFailed": "Başarısız",
    "ai.resultTitle": "Sonuç",
    "ai.close": "Kapat",
    "settings.themeColor": "Tema rengi",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Açık/koyu tema için ayrı ayrı vurgu rengi seçin. Değişiklikler anında uygulanır.",
    "settings.appearance": "Görünüm",
    "settings.accentPresets": "Vurgu ön ayarları",
    "settings.glassDensity": "Cam yoğunluğu",
    "settings.glassSubtle": "İnce",
    "settings.glassDefault": "Varsayılan",
    "settings.glassBold": "Cesur",
    "settings.cardRadius": "Kart köşe yarıçapı",
    "settings.radiusCompact": "Kompakt",
    "settings.radiusRounded": "Yuvarlatılmış",
    "settings.radiusPill": "Hap",
    "settings.vignette": "Kenar vinyeti",
    "settings.appearanceHint": "Her açık/koyu tema için görünümü özelleştirin. Vurgu değişiklikleri anında uygulanır; yoğunluk, yarıçap ve vinyet çalışma alanı yedeklerine dahildir.",
    "settings.resetThemeColor": "Sıfırla",
    "settings.generalTab": "Genel",
    "settings.promptsTab": "AI İstemleri",
    "settings.assistantPrompt": "Asistan sistem istemi",
    "settings.fullCardPrompt": "Tam kart sistem istemi",
    "settings.wizardPrompt": "Karakter oluşturma talimatları",
    "settings.promptPlaceholder": "Yerleşik istemi kullanmak için boş bırakın",
    "settings.chatSystemPrompts": "Sohbet ve sistem talimatları",
    "settings.fullCardInstr": "Tam kart çıktı talimatları (sistem)",
    "settings.fieldsEdit": "Alan düzenleme talimatları (sistem)",
    "settings.greetingsSystem": "Selamlama çıktı talimatları (sistem)",
    "settings.exportPrompts": "İstemleri dışa aktar",
    "settings.importPrompts": "İstemleri içe aktar",
    "settings.promptsExported": "İstemler dışa aktarıldı",
    "settings.promptsImported": "{count} istem içe aktarıldı",
    "settings.quickActionPrompts": "Hızlı işlem istemleri",
    "settings.tagsSystemPrompt": "Etiket çıktısı talimatları (sistem)",
    "settings.restoreDefaultPrompts": "Varsayılan istemleri geri yükle",
    "settings.promptHint": "Bu alanlar geçerli istemleri gösterir. Bir alan boşsa yerleşik varsayılan istem kullanılır. Varsayılanları geri yükleyerek görüntüleyebilir veya eski haline döndürebilirsiniz.",
    "settings.title": "Ayarlar",
    "settings.provider": "Sağlayıcı",
    "settings.providerHint": "Barındırılan model sağlayıcıları veya özel bir uç nokta (LM Studio, Ollama vb.)",
    "settings.apiKey": "API Anahtarı",
    "settings.getApiKey": "API anahtarınızı OpenRouter'dan alın",
    "settings.baseUrl": "API Temel URL",
    "settings.namedApiKeyPlaceholder": "API anahtarınızı girin",
    "settings.customHint": "OpenAI uyumlu uç nokta. Örnekler: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API Anahtarı (isteğe bağlı)",
    "settings.apiKeyLocalPlaceholder": "Yerel sağlayıcılar için boş bırakın",
    "settings.apiKeyLocalHint": "LM Studio veya Ollama gibi yerel sunucular için gerekli değildir.",
    "settings.modelId": "Model Kimliği",
    "settings.modelIdHint": "Sağlayıcınızın beklediği tam model kimliği.",
    "settings.modelIdHintNamed": "Sağlayıcının varsayılan modelini kullanmak için boş bırakın.",
    "settings.security": "API anahtarınız bu adrese bağlı bir anahtarla şifrelenmiş olarak tarayıcınızın localStorage alanında saklanır. Bu uygulamayı paylaşılan cihazlarda kullanmayın.",
    "settings.secretUnreadable": "Güvenlik nedeniyle, kayıtlı bir API anahtarı bu adreste çözülemedi — lütfen Ayar bölümünde yeniden girin.",
    "error.pngInflateFailed": "Bu PNG, sıkıştırması açılamayan karakter verileri içeriyor.",
    "settings.defaultModel": "Varsayılan Model",
    "settings.browseModels": "Aşağıdaki modellere göz atın...",
    "settings.refreshModels": "Modelleri Yenile",
    "settings.maxTokens": "Maksimum Çıktı Tokeni",
    "settings.maxTokensPlaceholder": "0 = model varsayılanını kullan",
    "settings.maxTokensHint": "İstek başına maksimum çıktı tokenini değiştirin. Seçili modelin limitini otomatik kullanmak için 0 yapın (bilinmiyorsa 64k).",
    "settings.copyright": "Dışa aktarımda düzenleyici kredisini ekle",
    "settings.copyrightHint": "Kartları dışa aktarırken oluşturan notlarına bir kredi satırı ekler.",
    "settings.availableModels": "Mevcut Modeller",
    "settings.searchModels": "Modellerde ara...",
    "settings.enterApiKey": "Modelleri yüklemek için API anahtarınızı girin ve yenileyin",
    "settings.credits": "Krediler ve Kullanım",
    "settings.creditLimit": "Kredi Limiti",
    "settings.remaining": "Kalan",
    "settings.usedMonth": "Bu Ay Kullanılan",
    "settings.localStorage": "Yerel Depolama",
    "settings.clearAll": "Tüm Verileri Temizle",
    "settings.export": "Dışa Aktar",
    "settings.import": "İçe Aktar",
    "settings.close": "Kapat",
    "settings.saveSettings": "Ayarları Kaydet",
    "settings.languageLabel": "Dil",
    "settings.languageHint": "Arayüz dili (eksikse sayfayı yenileyin)",
    "settings.languageChanged": "Dil güncellendi",
    "settings.clearConfirm": "TÜM kartlar, ayarlar ve sohbet geçmişi silinsin mi? Bu işlem geri alınamaz.",
    "settings.providerCustom": "Özel (OpenAI uyumlu)",
    "settings.noModels": "Model bulunamadı",
    "settings.loadMore": "Daha fazla yükle ({{count}} kalan)",
    "settings.showingModels": "{{total}} modelden {{shown}} gösteriliyor",
    "wizard.title": "Karakter Oluştur",
    "wizard.step.basics": "Temel",
    "wizard.step.concept": "Konsept",
    "wizard.step.personality": "Kişilik",
    "wizard.step.scenario": "Senaryo",
    "wizard.step.generate": "Oluştur",
    "wizard.basicsTitle": "Karakter Temelleri",
    "wizard.nameLabel": "Karakter Adı",
    "wizard.namePlaceholder": "örn. Elara Nightwhisper",
    "wizard.genderLabel": "Cinsiyet / Zamirler",
    "wizard.genderSelect": "Seçin...",
    "wizard.gender.female": "Kadın (o/onu)",
    "wizard.gender.male": "Erkek (o/onu)",
    "wizard.gender.nonbinary": "Non-binary (onlar)",
    "wizard.gender.other": "Diğer...",
    "wizard.genderCustom": "Özel zamirler (örn. o/onu)",
    "wizard.tagsLabel": "Etiketler",
    "wizard.tagsSub": "(virgülle ayrılmış, kitaplığınızı düzenlemeye yardımcı olur)",
    "wizard.tagsPlaceholder": "fantastik, savaşçı, elf, orijinal",
    "wizard.creatorLabel": "Oluşturan",
    "wizard.creatorPlaceholder": "Adınız / takma adınız",
    "wizard.conceptTitle": "Konsept ve Ortam",
    "wizard.typeLabel": "Karakter Türü",
    "wizard.type.original": "Orijinal Karakter",
    "wizard.type.fanfic": "Hayran Kurgusu",
    "wizard.type.game": "Oyun Karakteri",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Kitap / Film / Dizi",
    "wizard.type.historical": "Tarihî Şahsiyet",
    "wizard.type.mythological": "Mitolojik / Halkbilim",
    "wizard.type.vtuber": "VTuber / Yayıncı",
    "wizard.type.other": "Diğer",
    "wizard.languageLabel": "Dil",
    "wizard.language.other": "Diğer",
    "wizard.languageSpecify": "Dili belirtin",
    "wizard.genreLabel": "Tür / Dünya",
    "wizard.genreSub": "(geçerli olanların tümünü seçin)",
    "wizard.moodLabel": "Ruh Hali / Ton",
    "wizard.moodSub": "(geçerli olanların tümünü seçin)",
    "wizard.personalityTitle": "Kişilik ve Görünüm",
    "wizard.personalityTraits": "Kişilik Özellikleri",
    "wizard.personalityTraitsSub": "(3-5 temel özellik açıklayın, bu AI'ya yardımcı olur)",
    "wizard.personalityTraitsPlaceholder": "örn. Cesur ama pervasız, arkadaşlarına son derece sadık, kuru bir mizah anlayışı var, güvenmekte zorlanıyor, gizlice hayvanları seviyor",
    "wizard.appearanceLabel": "Fiziksel Görünüm",
    "wizard.appearanceSub": "(nasıl göründüğünün kısa açıklaması)",
    "wizard.appearancePlaceholder": "örn. Beline kadar uzanan gümüş saçlı, yara izli elleri olan uzun boylu bir kadın, koyu deri ceket giyiyor, delici yeşil gözleri var",
    "wizard.abilitiesLabel": "Özel Yetenekler / Tuhaflıklar",
    "wizard.abilitiesSub": "(isteğe bağlı, benzersiz özellikler)",
    "wizard.abilitiesPlaceholder": "örn. Hayvanlarla konuşabiliyor, fotoğrafik hafızası var, hep eski püskü bir günlük taşıyor",
    "wizard.scenarioTitle": "Senaryo ve İlk Mesaj",
    "wizard.scenarioLabel": "Senaryo / Ortam",
    "wizard.scenarioSub": "(hikaye nerede başlıyor?)",
    "wizard.scenarioPlaceholder": "örn. Neon ışıklı bir şehirde yağmurlu bir gece. Karakter hem makineleri hem de kırık kalpleri onaran küçük bir tamir atölyesi işletiyor.",
    "wizard.relationshipLabel": "{{user}} ile İlişki",
    "wizard.relationshipSub": "(karakter kullanıcıyı nasıl görüyor?)",
    "wizard.relationshipPlaceholder": "örn. Gizemli bozuk bir cihazla atölyeye giren yeni bir müşteri. Karakter meraklı ama temkinli.",
    "wizard.openingLabel": "İlk Mesaj Havası",
    "wizard.openingSub": "(açılış mesajı nasıl hissettirmeli?)",
    "wizard.notesLabel": "Ek Notlar",
    "wizard.notesSub": "(AI'nın bilmesi gereken başka bir şey?)",
    "wizard.notesPlaceholder": "örn. Diyaloğu doğal tutun, aşırı resmi olmaktan kaçının, yıldız işaretleri içinde aksiyon betimlemeleri ekleyin",
    "wizard.generateTitle": "Karakter Oluştur",
    "wizard.refImage": "Referans Görseli",
    "wizard.refImageSub": "(isteğe bağlı, waifu.im'den)",
    "wizard.fetchImages": "3 Görsel Getir",
    "wizard.refetchOthers": "Diğerlerini Yeniden Getir",
    "wizard.fetching": "Getiriliyor...",
    "wizard.useSelected": "Seçileni Kullan",
    "wizard.clear": "Temizle",
    "wizard.generateAI": "AI ile Oluştur",
    "wizard.generateAISub": "Yanıtlarınızdan eksiksiz karakter kartı",
    "wizard.createBlank": "Boş Kart Oluştur",
    "wizard.createBlankSub": "Ad ve etiketler doldurulmuş olarak başlayın",
    "wizard.back": "Geri",
    "wizard.next": "İleri",
    "wizard.stepLabel": "Adım {{step}} / {{total}}",
    "wizard.ready": "Oluşturmaya hazır!",
    "wizard.nameRequired": "Lütfen bir karakter adı girin",
    "wizard.summary.name": "Ad",
    "wizard.summary.gender": "Cinsiyet",
    "wizard.summary.type": "Tür",
    "wizard.summary.language": "Dil",
    "wizard.summary.tags": "Etiketler",
    "wizard.summary.genres": "Türler",
    "wizard.summary.mood": "Ruh Hali",
    "wizard.summary.opening": "Açılış",
    "wizard.summary.personality": "Kişilik",
    "wizard.summary.appearance": "Görünüm",
    "wizard.summary.scenario": "Senaryo",
    "wizard.summary.relationship": "İlişki",
    "wizard.summary.notes": "Notlar",
    "wizard.chip.fantasy": "Fantastik",
    "wizard.chip.scifi": "Bilim Kurgu",
    "wizard.chip.modern": "Modern",
    "wizard.chip.historical": "Tarihî",
    "wizard.chip.horror": "Korku",
    "wizard.chip.romance": "Romantik",
    "wizard.chip.comedy": "Komedi",
    "wizard.chip.sliceOfLife": "Gündelik Hayat",
    "wizard.chip.adventure": "Macera",
    "wizard.chip.mystery": "Gizem",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Kıyamet Sonrası",
    "wizard.chip.supernatural": "Doğaüstü",
    "wizard.chip.military": "Askeri",
    "wizard.chip.surreal": "Gerçeküstü",
    "wizard.chip.serious": "Ciddi",
    "wizard.chip.playful": "Şakacı",
    "wizard.chip.dark": "Karanlık",
    "wizard.chip.lighthearted": "Neşeli",
    "wizard.chip.mysterious": "Gizemli",
    "wizard.chip.romantic": "Romantik",
    "wizard.chip.intense": "Yoğun",
    "wizard.chip.wholesome": "İçten",
    "wizard.chip.chaotic": "Kaotik",
    "wizard.chip.melancholic": "Hüzünlü",
    "wizard.chip.sarcastic": "Alaycı",
    "wizard.chip.stoic": "Stoacı",
    "wizard.chip.greeting": "Sıcak Karşılama",
    "wizard.chip.action": "Olayın Ortasında",
    "wizard.chip.question": "Merak Uyandıran Soru",
    "wizard.chip.conflict": "Anında Çatışma",
    "wizard.chip.atmospheric": "Atmosferik",
    "wizard.editStep": "Bu bölümü düzenle",
    "wizard.draftRestored": "Taslak geri yüklendi — önceki yanıtlarınız geri geldi",
    "wizard.imagePlaceholder": "Getir'e tıklayın",
    "diff.title": "AI Yanıtı Önizlemesi",
    "diff.removed": "Kaldırıldı",
    "diff.added": "Eklendi",
    "diff.current": "Mevcut",
    "diff.proposed": "Önerilen",
    "diff.empty": "(boş)",
    "diff.discard": "Vazgeç",
    "diff.apply": "Değişiklikleri Uygula",
    "shortcuts.title": "Kısayollar",
    "shortcuts.save": "Kartı kaydet",
    "shortcuts.newCard": "Yeni kart",
    "shortcuts.undo": "Geri al",
    "shortcuts.redo": "Yinele",
    "shortcuts.sendAi": "AI mesajı gönder",
    "shortcuts.newLine": "AI sohbetinde yeni satır",
    "shortcuts.focus": "Odak modu",
    "shortcuts.collapsePanel": "AI panelini daralt/genişlet",
    "toast.loadFailed": "Başarısız: {{name}}",
    "toast.loaded": "{{count}} kart yüklendi",
    "toast.importDupe": "Mevcut bir kartla aynı içerik — {{name}} olarak içe aktarıldı",
    "toast.largeImage": "{{name}} içine gömülü büyük resim ({{size}} MB) - yerden tasarruf etmek için kaldırmayı düşünün.",
    "toast.noValid": "Geçerli kart bulunamadı. PNG veya JSON dosyaları bırakın.",
    "toast.noSelected": "Kart seçilmedi",
    "toast.cardsDeleted": "Kartlar silindi",
    "toast.deleteFailed": "Kart silinemedi",
    "toast.exported": "{{count}} kart dışa aktarıldı",
    "toast.newBlank": "Yeni boş kart oluşturuldu",
    "toast.noCardSave": "Kaydedilecek kart yok",
    "toast.cardSaved": "Kart kaydedildi!",
    "toast.noCardDup": "Çoğaltılacak kart yok",
    "toast.cardDup": "Kart çoğaltıldı",
    "toast.cardRestored": "Kart geri yüklendi",
    "toast.selectCard": "Önce bir kart seçin",
    "toast.avatarUpdated": "Avatar güncellendi",
    "toast.imgFailed": "Görsel yüklenemedi",
    "toast.firstMesUpdated": "İlk mesaj güncellendi!",
    "toast.settingsSaved": "Ayarlar kaydedildi!",
    "toast.modelsFailed": "Modeller yüklenemedi: {{error}}",
    "toast.modelSet": "Model ayarlandı: {{model}}",
    "toast.dataCleared": "Tüm veriler temizlendi",
    "toast.settingsExported": "Ayarlar dışa aktarıldı",
    "toast.settingsImported": "Ayarlar içe aktarıldı!",
    "toast.invalidFile": "Geçersiz ayar dosyası",
    "toast.apiKey": "API anahtarınızı Ayarlar'dan belirleyin",
    "toast.selectModel": "Önce gezinti çubuğundan veya ayarlardan bir model seçin.",
    "toast.genStopped": "Üretim durduruldu.",
    "toast.aiError": "AI Hatası: {{error}}",
    "toast.cardUpdatedAI": "Kart AI yanıtından güncellendi!",
    "toast.jsonParseFailed": "AI yanıtı JSON olarak ayrıştırılamadı. Sohbeti kontrol edin.",
    "toast.emptyResponse": "AI boş içerik döndürdü — uygulanacak bir şey yok.",
    "toast.jsonInvalid": "AI geçerli JSON döndürmedi. Yanıt sohbette — elle kopyalayabilirsiniz.",
    "toast.fieldUpdated": '"{{field}}" güncellendi!',
    "toast.greetingsUpdated": "{{count}} karşılama oluşturuldu!",
    "toast.tagsUpdated": "Etiketler güncellendi — {{count}} yeni eklendi!",
    "toast.greetingsParseFailed": "Karşılamalar AI yanıtından ayrıştırılamadı.",
    "toast.createCardFirst": "Önce bir kart oluşturun veya seçin",
    "toast.wizardCreated": "Kart oluşturuldu! Düzenlemeye başlayın veya ayrıntıları doldurmak için AI kullanın.",
    "toast.wizardApi": "Önce API anahtarınızı Ayarlar'dan belirleyin",
    "toast.wizardModel": "Bir model seçin veya Ayarlar'da özel bir model kimliği belirleyin",
    "toast.wizardFetchFailed": "Görseller getirilemedi: {{error}}",
    "toast.wizardName": "Lütfen bir karakter adı girin",
    "toast.storageFull": "Depolama dolu! Bazı kartları kaldırmayı veya dışa aktarmayı deneyin.",
    "toast.exportedJson": "JSON olarak dışa aktarıldı!",
    "toast.exportedPng": "Kart verileriyle PNG olarak dışa aktarıldı!",
    "toast.exportFailed": "Görsel dışa aktarımı başarısız. JSON'a geçiliyor.",
    "toast.noNameWarning": 'Uyarı: Kartın adı yok. Dosya "character.json" olarak kaydedilecek.',
    "toast.chatCleared": "Sohbet temizlendi",
    "toast.selectField": "Düzenlemek için en az bir alan seçin",
    "toast.tooManyFields": "Çok fazla alan seçildi. En fazla {{max}}.",
    "toast.undo": "Geri al",
    "toast.redo": "Yinele",
    "toast.reorderFiltered": "Kartları yeniden sıralamak için aramayı ve filtreleri kapatın.",
    "error.apiKeyNotSet": "API anahtarı ayarlanmadı. API anahtarınızı Ayarlar bölümüne girin.",
    "error.customUrlNotSet": "Özel API temel URL'si ayarlanmadı. Ayarlar → Özel (OpenAI uyumlu) bölümünü açın ve uç nokta URL'sini girin (örn. http://localhost:1234/v1).",
    "error.customAuthFailed": "Kimlik doğrulama başarısız (HTTP {{status}}). Bu uç nokta için API anahtarını kontrol edin.",
    "error.customPathNotFound": "Uç nokta bulunamadı (HTTP 404). API temel URL'sinin eksiksiz olduğunu (örn. /v1 içerdiğini) kontrol edin.",
    "error.customUnreachable": "{{url}} adresine ulaşılamıyor. Sunucunun çalıştığını ve API temel URL'sinin doğru olduğunu ve bu cihazdan erişilebildiğini kontrol edin.",
    "error.noModel": "Model seçilmedi. Bir model seçin veya Ayarlar'da bir model kimliği belirleyin.",
    "error.noModelSimple": "Model seçilmedi.",
    "error.insufficientCredits": "Yetersiz kredi. Lütfen hesabınıza kredi yükleyin.",
    "error.storageFull": "Depolama dolu! Bazı kartları kaldırmayı veya dışa aktarmayı deneyin.",
    "gen.empty": "(boş)",
    "gen.free": "Ücretsiz",
    "gen.unlimited": "Sınırsız",
    "gen.notAvailable": "Yok",
    "gen.unnamed": "Adsız",
    "gen.byCreator": "{{name}} tarafından",
    "gen.copySuffix": " (Kopya)",
    "gen.toastAutoHide": "{{s}}s içinde otomatik gizlenir",
    "gen.untagged": "Etiket bulunamadı",
    "gen.noMatch": "Filtrelerinizle eşleşen kart yok",
    "batch.deleteConfirm": "{{count}} kart silinsin mi? Bu işlem geri alınamaz.",
    "left.selected": "{{count}} seçildi",
    "toast.cardDeleted": '"{{name}}" kartı silindi',
    "ai.apply": "Uygula",
    "ai.applyTitle": "Bu değişiklikleri karta uygula",
    "ai.errorPrefix": "Hata: ",
    "ai.translatePrompt": "Hangi dile çevrilsin?",
    "ai.translateDefaultLang": "Fransızca",
    "ai.tonePrompt": "Hangi ton? (örn. resmi, samimi, karanlık, esprili, şiirsel)",
    "ai.toneDefault": "resmi",
    "ai.chatSession": "Sohbet oturumu",
    "ai.msgs": "{{count}} mesaj",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " out · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Limiti aşıyor!",
    "ai.approachingLimit": " ⚠ Limite yaklaşılıyor",
    "ai.count": "Sayım:",
    "ai.resizeAria": "AI asistanını yeniden boyutlandır",
    "ai.chatMessagesAria": "AI sohbet mesajları",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Örnek diyalog burada...
{{user}}: Kullanıcı yanıtı...
<START>
{{char}}: Başka bir örnek...`,
    "batch.select2ForCompare": "Karşılaştırmak için tam 2 kart seçin",
    "batch.compareLoadFailed": "Karşılaştırma için kartlar yüklenemedi",
    "batch.comparePrefix": "Karşılaştır: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Kart A",
    "batch.cardB": "Kart B",
    "editor.charCount": "{{chars}} karakter ~{{tokens}} token",
    "editor.counterWarn": "Çıktı token sınırına yaklaşılıyor ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Çıktı token sınırı aşıldı ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Yukarı taşı",
    "editor.greetingMoveDown": "Aşağı taşı",
    "editor.greetingIsDefault": "Bu, mevcut ilk mesajdır",
    "editor.greetingSetDefault": "İlk mesaj olarak ayarla",
    "editor.greetingRemove": "Kaldır",
    "editor.greetingPlaceholder": "Karşılama {{num}}...",
    "editor.loreEntry": "Girdi {{num}}",
    "editor.loreDeleteEntry": "Girdiyi sil",
    "editor.lorePrimaryKeys": "Birincil Anahtar Kelimeler",
    "editor.lorePrimaryKeysPlaceholder": "Birincil anahtar kelimeler — virgülle ayrılmış",
    "editor.loreSecondaryKeys": "İkincil Anahtar Kelimeler",
    "editor.loreSecondaryKeysPlaceholder": "İkincil anahtar kelimeler",
    "editor.loreComment": "Yorum",
    "editor.loreCommentPlaceholder": "Yorum",
    "editor.loreOrder": "Sıra",
    "editor.loreOrderPlaceholder": "Sıra",
    "editor.loreConstant": "Sabit",
    "editor.loreSelective": "Seçmeli",
    "editor.loreBeforeChar": "Karakterden önce",
    "editor.loreAfterChar": "Karakterden sonra",
    "editor.loreContent": "İçerik",
    "editor.loreContentPlaceholder": "Girdi içeriği...",
    "editor.loreNewEntry": "Yeni Girdi",
    "error.unknown": "Bilinmeyen hata",
    "error.unexpected": "Beklenmeyen hata: {{message}}",
    "error.requestFailed": "İstek başarısız: {{message}}",
    "error.unsupportedFile": "Desteklenmeyen dosya türü: .{{ext}}",
    "error.invalidJson": "Geçersiz JSON: {{message}}",
    "error.notPng": "Geçerli bir PNG dosyası değil",
    "error.unknownFormat": "Bilinmeyen kart formatı — bu bir SillyTavern karakter kartı değil",
    "error.fetchModelsFailed": "Modeller getirilemedi (HTTP {{status}})",
    "error.noChoices": "API yanıt seçeneği döndürmedi",
    "error.customServerError": "Sunucu bir hata döndürdü: {{detail}}",
    "error.emptyResponse": "API'dan boş yanıt (gövde yok)",
    "gen.newCharacter": "Yeni Karakter",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Yedekle",
    "settings.restore": "Geri Yükle",
    "settings.backupTitle": "Tüm kartları yedekle",
    "settings.restoreTitle": "Yedeği geri yükle",
    "settings.exportTitle": "Ayarları dışa aktar",
    "settings.importTitle": "Ayarları içe aktar",
    "settings.modelAuto": "Otomatik",
    "settings.modelIdPlaceholder": "örn. deepseek-v4-flash",
    "settings.customModelPlaceholder": "örn. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "örn. {{provider}}-latest",
    "settings.getApiKeyFrom": "API anahtarını şuradan alın: ",
    "settings.customModelDesc": "Özel model",
    "settings.workspaceExported": "Çalışma alanı dışa aktarıldı ({{count}} kart)",
    "settings.invalidWorkspace": "Geçersiz çalışma alanı biçimi",
    "settings.workspaceImported": "Çalışma alanı içe aktarıldı ({{count}} kart)",
    "settings.workspaceImportFailed": "Çalışma alanı içe aktarılamadı: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "AI Asistanını Aç/Kapat",
    "nav.toggleAIAria": "AI Asistanını Aç/Kapat",
    "nav.notificationsAria": "Bildirimler",
    "left.sortCards": "Kartları sırala",
    "left.compareSelected": "Seçilen kartları karşılaştır",
    "left.resizeAria": "Kart kütüphanesini yeniden boyutlandır",
    "left.cardListAria": "Kart kütüphanesi",
    "ui.saved": " Kaydedildi",
    "ui.collapsePanel": "Paneli daralt",
    "ui.expandPanel": "Paneli genişlet",
    "ui.cardModified": "Kaydedilmemiş değişiklikler",
    "export.minimalPngLabel": "ST Kart",
    "wizard.search": "Ara",
    "wizard.quick": "Hızlı:",
    "wizard.imageSearchPlaceholder": "Etiket ara: kedi, elbise, üniforma, cyberpunk...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.nl = {
    "app.title": "ST Card Editor — SillyTavern personagekaartenstudio",
    "nav.selectModel": "Selecteer model...",
    "nav.wizard": "Maak met AI-wizard",
    "nav.newCard": "Nieuwe blanco kaart",
    "nav.save": "Opslaan",
    "nav.theme": "Thema wisselen",
    "nav.shortcuts": "Sneltoetsen en help",
    "nav.settings": "Instellingen",
    "nav.focus": "Focusmodus",
    "nav.focusAlt": "Focusmodus (Alt+F)",
    "left.title": "Kaartenbibliotheek",
    "left.cards": "{{count}} kaarten",
    "left.drop": "Sleep en zet neer",
    "left.dropSub": "PNG- of JSON-personagekaarten",
    "left.browse": "Bladeren door bestanden",
    "left.search": "Kaarten zoeken...",
    "left.sort.nameAsc": "Naam A-Z",
    "left.sort.nameDesc": "Naam Z-A",
    "left.sort.manual": "Handmatig",
    "left.sort.newest": "Nieuwste eerst",
    "left.sort.oldest": "Oudste eerst",
    "left.sort.largest": "Grootste",
    "left.sort.smallest": "Kleinste",
    "left.filterTags": "Filteren op tags",
    "left.exportSelected": "Geselecteerde exporteren als JSON",
    "left.deleteSelected": "Geselecteerde verwijderen",
    "left.empty": "Geen kaarten geladen",
    "left.emptySub": "Zet een kaart neer of klik op Bladeren",
    "center.noCard": "Geen kaart geselecteerd",
    "center.noCardSub": "Selecteer een kaart uit de bibliotheek of sleep een nieuwe naar binnen",
    "center.createAI": "Maken met AI",
    "center.blankCard": "Blanco kaart",
    "editor.avatar": "Klik of sleep een afbeelding om de avatar in te stellen",
    "editor.avatarAria": "Personage-avatar instellen",
    "editor.name": "Personagenaam",
    "editor.exportJson": "Exporteren als JSON",
    "editor.exportPng": "Exporteren als PNG",
    "editor.duplicate": "Kaart dupliceren",
    "editor.delete": "Kaart verwijderen",
    "editor.tab.core": "Kern",
    "editor.tab.personality": "Persoonlijkheid",
    "editor.tab.advanced": "Geavanceerd",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Waifu-afbeelding",
    "editor.waifuPreview": "Huidige kaartafbeelding",
    "editor.waifuNoImage": "Nog geen afbeelding ingesteld",
    "editor.waifuSource": "Afbeeldingsbron",
    "editor.waifuSourceSnap": "Anime-momenten (waifu.im)",
    "editor.waifuSourceChar": "Anime-personages (AniList)",
    "editor.waifuGender": "Geslacht",
    "editor.waifuGenderAll": "Elk geslacht",
    "editor.waifuGenderFemaleOnly": "Alleen vrouwen",
    "editor.waifuGenderMaleOnly": "Alleen mannen",
    "editor.waifuGenderFemale": "Vrouwelijk",
    "editor.waifuGenderMale": "Mannelijk",
    "editor.waifuCharSub": "zoek een personage op naam (bijv. zoro)",
    "editor.waifuSearch": "Zoeken op waifu.im",
    "editor.waifuSearchChar": "Personages zoeken",
    "editor.waifuSearchPlaceholderChar": "zoek een personage op naam (bijv. zoro)",
    "editor.waifuSub": "(haalt anime-stijl afbeeldingen op op tag)",
    "editor.waifuSearchPlaceholder": "bijv. waifu, elf, meid...",
    "editor.waifuFetch": "Afbeeldingen ophalen",
    "editor.waifuRegenTitle": "Resultaten opnieuw genereren",
    "editor.waifuMixed": "Vrouwen + Mannen",
    "editor.waifuMixedSub": "gebalanceerd pakket in één klik: 3 vrouwelijke + 3 mannelijke personages",
    "editor.waifuUse": "Gebruiken als kaartafbeelding",
    "editor.waifuUpload": "Uploaden vanaf apparaat",
    "editor.waifuRemove": "Afbeelding verwijderen",
    "toast.noImage": "Deze kaart heeft geen afbeelding om te verwijderen",
    "toast.imageRemoved": "Afbeelding verwijderd",
    "editor.desc": "Beschrijving",
    "editor.descSub": "(uiterlijk, achtergrond)",
    "editor.descPlaceholder": "Beschrijf het uiterlijk, de achtergrond en de belangrijkste kenmerken van het personage...",
    "editor.firstMes": "Eerste bericht",
    "editor.firstMesPlaceholder": "Het eerste bericht van het personage bij het starten van een chat...",
    "editor.scenario": "Scenario",
    "editor.scenarioPlaceholder": "Huidige omstandigheden en context van het gesprek...",
    "editor.creator": "Maker",
    "editor.creatorPlaceholder": "Kaartmaker / auteur",
    "editor.version": "Personageversie",
    "editor.tags": "Tags",
    "editor.tagsSub": "(gescheiden door komma's)",
    "editor.tagsPlaceholder": "fantasy, krijger, elf",
    "editor.personalitySummary": "Persoonlijkheidssamenvatting",
    "editor.personalityPlaceholder": "Een korte beschrijving van de persoonlijkheid van het personage... (gebruikt in het personagekaartformaat)",
    "editor.mesExample": "Voorbeeldberichten",
    "editor.mesExampleFormat": "Formaat: <START>-blokken met {{char}}: en {{user}}: voorvoegsels",
    "editor.systemPrompt": "Systeemprompt",
    "editor.systemPromptPlaceholder": "Vervang de systeemprompt. Gebruik {{original}} om de standaard op te nemen.",
    "editor.postHistory": "Instructies na geschiedenis",
    "editor.postHistoryPlaceholder": "Instructies die na de chatgeschiedenis worden ingevoegd. Gebruik {{original}} voor de standaard.",
    "editor.creatorNotes": "Notities van de maker",
    "editor.creatorNotesPlaceholder": "Notities voor kaartgebruikers (modelaanbevelingen, gebruikstips...)",
    "editor.greetings": "Alternatieve begroetingen",
    "editor.addGreeting": "Begroeting toevoegen",
    "editor.lorebookTitle": "Personage-lorebook-items",
    "editor.addEntry": "Item toevoegen",
    "editor.lorebookSearch": "Zoek items op sleutel, inhoud of opmerking...",
    "editor.lorebookEmpty": "Nog geen lorebook-items. Voeg er een toe om te beginnen.",
    "editor.noGreetings": "Nog geen begroetingen. Klik op <strong>Begroeting toevoegen</strong> of gebruik AI om er te genereren.",
    "editor.noEntriesMatch": 'Geen items gevonden voor "{{query}}"',
    "editor.edit": "Bewerken",
    "editor.preview": "Voorbeeld",
    "ai.title": "AI-assistent",
    "ai.clearChat": "Chat wissen",
    "ai.welcomeTitle": "AI-kaartassistent",
    "ai.welcomeText": "Vraag de AI om uw personagekaart te bewerken, te vertalen of te verbeteren.",
    "ai.quick.newCard": "Nieuwe kaart",
    "ai.quick.translate": "Vertalen",
    "ai.quick.enhance": "Verbeteren",
    "ai.quick.shorten": "Inkorten",
    "ai.quick.tone": "Toon wijzigen",
    "ai.quick.grammar": "Grammatica corrigeren",
    "ai.quick.personality": "Persoonlijkheid uitbreiden",
    "ai.quick.firstmes": "Eerste bericht verbeteren",
    "ai.quick.scenario": "Scenario uitbreiden",
    "ai.quick.greetings": "Begroetingen genereren",
    "ai.quick.systemprompt": "Systeemprompt verbeteren",
    "ai.quick.tags": "Tags voorstellen",
    "ai.contextTitle": "Geschatte gebruikte tokens versus modelcontextlimiet",
    "ai.contextLabel": "— / — tokens",
    "ai.placeholder": "Vraag de AI om de kaart te bewerken...",
    "ai.send": "Verzenden",
    "ai.stop": "Genereren stoppen",
    "ai.autoModel": "Selecteer model...",
    "ai.target": "Doel:",
    "ai.target.full": "Volledige kaart",
    "ai.target.description": "Beschrijving",
    "ai.target.personality": "Persoonlijkheid",
    "ai.target.first_mes": "Eerste bericht",
    "ai.target.scenario": "Scenario",
    "ai.target.mes_example": "Voorbeeldberichten",
    "ai.target.system_prompt": "Systeemprompt",
    "ai.target.post_history_instructions": "Instructies na geschiedenis",
    "ai.target.creator_notes": "Notities van de maker",
    "ai.target.alternate_greetings": "Alternatieve begroetingen",
    "ai.selectModel": "Selecteer een model",
    "ai.actionNewCard": "Nieuwe kaart",
    "ai.actionTranslate": "Vertalen",
    "ai.actionEnhance": "Verbeteren",
    "ai.actionShorten": "Inkorten",
    "ai.actionTone": "Toon wijzigen",
    "ai.actionGrammar": "Grammatica corrigeren",
    "ai.actionPersonality": "Persoonlijkheid uitbreiden",
    "ai.actionFirstMes": "Eerste bericht verbeteren",
    "ai.actionScenario": "Scenario uitbreiden",
    "ai.actionGreetings": "Begroetingen genereren",
    "ai.actionSystemprompt": "Systeemprompt verbeteren",
    "ai.actionTags": "Tags voorstellen",
    "ai.chatHistory": "Chatgeschiedenis",
    "ai.historyTitle": "Chatgeschiedenis",
    "ai.historyEmpty": "Nog geen gesprekken",
    "ai.retry": "Opnieuw proberen",
    "ai.retryTitle": "Dit antwoord opnieuw genereren",
    "ai.reapply": "Opnieuw toepassen",
    "ai.reapplyTitle": "Open de diff opnieuw om deze wijzigingen toe te passen",
    "ai.noCard": "(geen kaart geselecteerd)",
    "ai.editing": "{{count}} veld(en) bewerken...",
    "ai.streaming": "streamen...",
    "ai.failed": "mislukt",
    "ai.cancelled": "Geannuleerd.",
    "ai.doneSummary": "{{done}}/{{total}} klaar · {{errs}} mislukt",
    "ai.viewFullResult": "Volledig resultaat bekijken",
    "ai.showLess": "Minder tonen",
    "ai.reviewApply": "Controleren en toepassen",
    "ai.changesNav": "Wijziging {{current}} van {{total}}",
    "ai.changesPrev": "Vorige wijziging",
    "ai.changesNext": "Volgende wijziging",
    "ai.applied": "Toegepast",
    "ai.target.tags": "Tags",
    "ai.copy": "Kopiëren",
    "ai.copied": "Gekopieerd!",
    "ai.copyFailed": "Mislukt",
    "ai.resultTitle": "Resultaat",
    "ai.close": "Sluiten",
    "settings.themeColor": "Themakleur",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Kies een aparte accentkleur voor het lichte en het donkere thema. Wijzigingen worden direct toegepast.",
    "settings.appearance": "Uiterlijk",
    "settings.accentPresets": "Accent-voorinstellingen",
    "settings.glassDensity": "Glasdichtheid",
    "settings.glassSubtle": "Subtiel",
    "settings.glassDefault": "Standaard",
    "settings.glassBold": "Gedurfd",
    "settings.cardRadius": "Kaarthoekradius",
    "settings.radiusCompact": "Compact",
    "settings.radiusRounded": "Afgerond",
    "settings.radiusPill": "Pil",
    "settings.vignette": "Randvignet",
    "settings.appearanceHint": "Pas het uiterlijk van elk licht/donker thema aan. Accentwijzigingen worden direct toegepast; dichtheid, radius en het vignet zitten in de back-ups van de werkruimte.",
    "settings.resetThemeColor": "Herstellen",
    "settings.generalTab": "Algemeen",
    "settings.promptsTab": "AI-prompts",
    "settings.assistantPrompt": "Systeemprompt van de assistent",
    "settings.fullCardPrompt": "Systeemprompt voor de volledige kaart",
    "settings.wizardPrompt": "Instructies voor het genereren van personages",
    "settings.promptPlaceholder": "Leeg laten om de ingebouwde prompt te gebruiken",
    "settings.chatSystemPrompts": "Chat- en systeeminstructies",
    "settings.fullCardInstr": "Uitvoerinstructies volledige kaart (systeem)",
    "settings.fieldsEdit": "Veldbewerkingsinstructies (systeem)",
    "settings.greetingsSystem": "Uitvoerinstructies begroetingen (systeem)",
    "settings.exportPrompts": "Prompts exporteren",
    "settings.importPrompts": "Prompts importeren",
    "settings.promptsExported": "Prompts geëxporteerd",
    "settings.promptsImported": "{count} prompts geïmporteerd",
    "settings.quickActionPrompts": "Snelle-actie prompts",
    "settings.tagsSystemPrompt": "Taguitvoerinstructies (systeem)",
    "settings.restoreDefaultPrompts": "Standaardprompts herstellen",
    "settings.promptHint": "Deze velden tonen de huidige prompts. Is een veld leeg, dan wordt de ingebouwde standaardprompt gebruikt. Herstel de standaardwaarden om ze te bekijken of terug te zetten.",
    "settings.title": "Instellingen",
    "settings.provider": "Provider",
    "settings.providerHint": "Gehoste modelproviders of een eigen endpoint (LM Studio, Ollama, enz.)",
    "settings.apiKey": "API-sleutel",
    "settings.getApiKey": "Haal uw API-sleutel op bij OpenRouter",
    "settings.baseUrl": "API-basis-URL",
    "settings.namedApiKeyPlaceholder": "Voer uw API-sleutel in",
    "settings.customHint": "Het OpenAI-compatibele endpoint. Voorbeelden: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API-sleutel (optioneel)",
    "settings.apiKeyLocalPlaceholder": "Laat leeg voor lokale providers",
    "settings.apiKeyLocalHint": "Niet nodig voor lokale servers zoals LM Studio of Ollama.",
    "settings.modelId": "Model-ID",
    "settings.modelIdHint": "De exacte model-ID die uw provider verwacht.",
    "settings.modelIdHintNamed": "Laat leeg om het standaardmodel van de provider te gebruiken.",
    "settings.security": "Uw API-sleutel wordt versleuteld opgeslagen in de localStorage van uw browser (sleutel gebonden aan dit adres). Gebruik deze app niet op gedeelde apparaten.",
    "settings.secretUnreadable": "Om veiligheidsredenen kon een opgeslagen API-sleutel niet worden ontgrendeld op dit adres — voer deze opnieuw in in de Instellingen.",
    "error.pngInflateFailed": "Deze PNG bevat persoonsgegevens die niet konden worden gedecomprimeerd.",
    "settings.defaultModel": "Standaardmodel",
    "settings.browseModels": "Blader hieronder door modellen...",
    "settings.refreshModels": "Modellen verversen",
    "settings.maxTokens": "Maximale uitvoertokens",
    "settings.maxTokensPlaceholder": "0 = standaard van het model gebruiken",
    "settings.maxTokensHint": "Overschrijf het maximum aantal uitvoertokens per verzoek. Zet op 0 om automatisch de limiet van het geselecteerde model te gebruiken (of 64k indien onbekend).",
    "settings.copyright": "Makertegoed van editor toevoegen bij exporteren",
    "settings.copyrightHint": "Voegt een tegoedregel toe aan de notities van de maker bij het exporteren van kaarten.",
    "settings.availableModels": "Beschikbare modellen",
    "settings.searchModels": "Modellen zoeken...",
    "settings.enterApiKey": "Voer uw API-sleutel in en ververs om modellen te laden",
    "settings.credits": "Credits en gebruik",
    "settings.creditLimit": "Credietlimiet",
    "settings.remaining": "Resterend",
    "settings.usedMonth": "Deze maand gebruikt",
    "settings.localStorage": "Lokale opslag",
    "settings.clearAll": "Alle gegevens wissen",
    "settings.export": "Exporteren",
    "settings.import": "Importeren",
    "settings.close": "Sluiten",
    "settings.saveSettings": "Instellingen opslaan",
    "settings.languageLabel": "Taal",
    "settings.languageHint": "Interfacetaal (ververs de pagina als deze ontbreekt)",
    "settings.languageChanged": "Taal bijgewerkt",
    "settings.clearConfirm": "Alle kaarten, instellingen en chatgeschiedenis verwijderen? Dit kan niet ongedaan worden gemaakt.",
    "settings.providerCustom": "Eigen (OpenAI-compatibel)",
    "settings.noModels": "Geen modellen gevonden",
    "settings.loadMore": "Meer laden ({{count}} resterend)",
    "settings.showingModels": "{{shown}} van {{total}} modellen weergegeven",
    "wizard.title": "Personage maken",
    "wizard.step.basics": "Basis",
    "wizard.step.concept": "Concept",
    "wizard.step.personality": "Persoonlijkheid",
    "wizard.step.scenario": "Scenario",
    "wizard.step.generate": "Genereren",
    "wizard.basicsTitle": "Personagebasis",
    "wizard.nameLabel": "Personagenaam",
    "wizard.namePlaceholder": "bijv. Elara Nightwhisper",
    "wizard.genderLabel": "Geslacht / Voornaamwoorden",
    "wizard.genderSelect": "Selecteren...",
    "wizard.gender.female": "Vrouw (zij/haar)",
    "wizard.gender.male": "Man (hij/hem)",
    "wizard.gender.nonbinary": "Non-binair (die/hun)",
    "wizard.gender.other": "Anders...",
    "wizard.genderCustom": "Eigen voornaamwoorden (bijv. het/hen)",
    "wizard.tagsLabel": "Tags",
    "wizard.tagsSub": "(gescheiden door komma's, helpt uw bibliotheek ordenen)",
    "wizard.tagsPlaceholder": "fantasy, krijger, elf, origineel",
    "wizard.creatorLabel": "Maker",
    "wizard.creatorPlaceholder": "Uw naam / alias",
    "wizard.conceptTitle": "Concept en setting",
    "wizard.typeLabel": "Personagetype",
    "wizard.type.original": "Origineel personage",
    "wizard.type.fanfic": "Fanfiction",
    "wizard.type.game": "Spelpersonage",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Boek / Film / Serie",
    "wizard.type.historical": "Historische figuur",
    "wizard.type.mythological": "Mythologisch / Volksverhaal",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Anders",
    "wizard.languageLabel": "Taal",
    "wizard.language.other": "Anders",
    "wizard.languageSpecify": "Taal opgeven",
    "wizard.genreLabel": "Genre / Wereld",
    "wizard.genreSub": "(selecteer alles wat van toepassing is)",
    "wizard.moodLabel": "Stemming / Toon",
    "wizard.moodSub": "(selecteer alles wat van toepassing is)",
    "wizard.personalityTitle": "Persoonlijkheid en uiterlijk",
    "wizard.personalityTraits": "Persoonlijkheidskenmerken",
    "wizard.personalityTraitsSub": "(beschrijf 3-5 belangrijkste kenmerken, dit helpt de AI)",
    "wizard.personalityTraitsPlaceholder": "bijv. Moedig maar roekeloos, onwrikbaar loyaal aan vrienden, heeft een droge humor, vindt vertrouwen moeilijk, houdt stiekem van dieren",
    "wizard.appearanceLabel": "Fysiek uiterlijk",
    "wizard.appearanceSub": "(korte beschrijving van hoe ze eruitzien)",
    "wizard.appearancePlaceholder": "bijv. Lange vrouw met zilver haar tot aan haar middel, littekens op haar handen, draagt een donkere leren jas, doordringende groene ogen",
    "wizard.abilitiesLabel": "Speciale vaardigheden / Eigenaardigheden",
    "wizard.abilitiesSub": "(optioneel, alle unieke kenmerken)",
    "wizard.abilitiesPlaceholder": "bijv. Kan met dieren praten, heeft een fotografisch geheugen, draagt altijd een versleten dagboek bij zich",
    "wizard.scenarioTitle": "Scenario en eerste bericht",
    "wizard.scenarioLabel": "Scenario / Setting",
    "wizard.scenarioSub": "(waar begint het verhaal?)",
    "wizard.scenarioPlaceholder": "bijv. Een regenachtige nacht in een stad vol neonlicht. Het personage runt een kleine reparatiewerkplaats die zowel machines als gebroken harten repareert.",
    "wizard.relationshipLabel": "Relatie met {{user}}",
    "wizard.relationshipSub": "(hoe ziet het personage de gebruiker?)",
    "wizard.relationshipPlaceholder": "bijv. Een nieuwe klant die met een mysterieus kapot apparaat de winkel binnenliep. Het personage is nieuwsgierig maar voorzichtig.",
    "wizard.openingLabel": "Sfeer eerste bericht",
    "wizard.openingSub": "(hoe moet het openingsbericht voelen?)",
    "wizard.notesLabel": "Extra notities",
    "wizard.notesSub": "(iets anders dat de AI moet weten?)",
    "wizard.notesPlaceholder": "bijv. Houd de dialoog natuurlijk, vermijd overdreven formeel taalgebruik, neem actiebeschrijvingen tussen sterretjes op",
    "wizard.generateTitle": "Personage genereren",
    "wizard.refImage": "Referentieafbeelding",
    "wizard.refImageSub": "(optioneel, van waifu.im)",
    "wizard.fetchImages": "3 afbeeldingen ophalen",
    "wizard.refetchOthers": "Andere ophalen",
    "wizard.fetching": "Bezig met ophalen...",
    "wizard.useSelected": "Geselecteerde gebruiken",
    "wizard.clear": "Wissen",
    "wizard.generateAI": "Genereren met AI",
    "wizard.generateAISub": "Volledige personagekaart op basis van uw antwoorden",
    "wizard.createBlank": "Blanco kaart maken",
    "wizard.createBlankSub": "Begin met naam en tags al ingevuld",
    "wizard.back": "Terug",
    "wizard.next": "Volgende",
    "wizard.stepLabel": "Stap {{step}} van {{total}}",
    "wizard.ready": "Klaar om te genereren!",
    "wizard.nameRequired": "Voer een personagenaam in",
    "wizard.summary.name": "Naam",
    "wizard.summary.gender": "Geslacht",
    "wizard.summary.type": "Type",
    "wizard.summary.language": "Taal",
    "wizard.summary.tags": "Tags",
    "wizard.summary.genres": "Genres",
    "wizard.summary.mood": "Stemming",
    "wizard.summary.opening": "Opening",
    "wizard.summary.personality": "Persoonlijkheid",
    "wizard.summary.appearance": "Uiterlijk",
    "wizard.summary.scenario": "Scenario",
    "wizard.summary.relationship": "Relatie",
    "wizard.summary.notes": "Notities",
    "wizard.chip.fantasy": "Fantasy",
    "wizard.chip.scifi": "Sci-Fi",
    "wizard.chip.modern": "Modern",
    "wizard.chip.historical": "Historisch",
    "wizard.chip.horror": "Horror",
    "wizard.chip.romance": "Romantiek",
    "wizard.chip.comedy": "Komedie",
    "wizard.chip.sliceOfLife": "Dagelijks leven",
    "wizard.chip.adventure": "Avontuur",
    "wizard.chip.mystery": "Mysterie",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Post-apocalyptisch",
    "wizard.chip.supernatural": "Bovennatuurlijk",
    "wizard.chip.military": "Militair",
    "wizard.chip.surreal": "Surrealistisch",
    "wizard.chip.serious": "Serieus",
    "wizard.chip.playful": "Speels",
    "wizard.chip.dark": "Donker",
    "wizard.chip.lighthearted": "Onbezorgd",
    "wizard.chip.mysterious": "Mysterieus",
    "wizard.chip.romantic": "Romantisch",
    "wizard.chip.intense": "Intens",
    "wizard.chip.wholesome": "Hartverwarmend",
    "wizard.chip.chaotic": "Chaotisch",
    "wizard.chip.melancholic": "Melancholisch",
    "wizard.chip.sarcastic": "Sarcastisch",
    "wizard.chip.stoic": "Stoïcijns",
    "wizard.chip.greeting": "Warme begroeting",
    "wizard.chip.action": "In medias res",
    "wizard.chip.question": "Nieuwsgierige vraag",
    "wizard.chip.conflict": "Onmiddellijk conflict",
    "wizard.chip.atmospheric": "Sfeervol",
    "wizard.editStep": "Deze sectie bewerken",
    "wizard.draftRestored": "Concept hersteld — uw eerdere antwoorden zijn terug",
    "wizard.imagePlaceholder": "Klik op Ophalen",
    "diff.title": "Voorbeeld van AI-antwoord",
    "diff.removed": "Verwijderd",
    "diff.added": "Toegevoegd",
    "diff.current": "Huidig",
    "diff.proposed": "Voorgesteld",
    "diff.empty": "(leeg)",
    "diff.discard": "Verwerpen",
    "diff.apply": "Wijzigingen toepassen",
    "shortcuts.title": "Sneltoetsen",
    "shortcuts.save": "Kaart opslaan",
    "shortcuts.newCard": "Nieuwe kaart",
    "shortcuts.undo": "Ongedaan maken",
    "shortcuts.redo": "Opnieuw",
    "shortcuts.sendAi": "AI-bericht verzenden",
    "shortcuts.newLine": "Nieuwe regel in AI-chat",
    "shortcuts.focus": "Focusmodus",
    "shortcuts.collapsePanel": "AI-paneel in-/uitklappen",
    "toast.loadFailed": "Mislukt: {{name}}",
    "toast.loaded": "{{count}} kaarten geladen",
    "toast.importDupe": "Zelfde inhoud als een bestaande kaart — geïmporteerd als {{name}}",
    "toast.largeImage": "Grote afbeelding ingesloten in {{name}} ({{size}} MB) - overweeg deze te verwijderen om opslagruimte te besparen.",
    "toast.noValid": "Geen geldige kaarten gevonden. Zet PNG- of JSON-bestanden neer.",
    "toast.noSelected": "Geen kaarten geselecteerd",
    "toast.cardsDeleted": "Kaarten verwijderd",
    "toast.deleteFailed": "Kan kaart niet verwijderen",
    "toast.exported": "{{count}} kaarten geëxporteerd",
    "toast.newBlank": "Nieuwe blanco kaart gemaakt",
    "toast.noCardSave": "Geen kaart om op te slaan",
    "toast.cardSaved": "Kaart opgeslagen!",
    "toast.noCardDup": "Geen kaart om te dupliceren",
    "toast.cardDup": "Kaart gedupliceerd",
    "toast.cardRestored": "Kaart hersteld",
    "toast.selectCard": "Selecteer eerst een kaart",
    "toast.avatarUpdated": "Avatar bijgewerkt",
    "toast.imgFailed": "Afbeelding laden mislukt",
    "toast.firstMesUpdated": "Eerste bericht bijgewerkt!",
    "toast.settingsSaved": "Instellingen opgeslagen!",
    "toast.modelsFailed": "Modellen laden mislukt: {{error}}",
    "toast.modelSet": "Model ingesteld: {{model}}",
    "toast.dataCleared": "Alle gegevens gewist",
    "toast.settingsExported": "Instellingen geëxporteerd",
    "toast.settingsImported": "Instellingen geïmporteerd!",
    "toast.invalidFile": "Ongeldig instellingenbestand",
    "toast.apiKey": "Stel uw API-sleutel in bij Instellingen",
    "toast.selectModel": "Selecteer eerst een model via de navigatiebalk of de instellingen.",
    "toast.genStopped": "Genereren gestopt.",
    "toast.aiError": "AI-fout: {{error}}",
    "toast.cardUpdatedAI": "Kaart bijgewerkt op basis van AI-antwoord!",
    "toast.jsonParseFailed": "AI-antwoord kon niet als JSON worden geparseerd. Controleer de chat.",
    "toast.emptyResponse": "De AI gaf lege inhoud terug — niets om toe te passen.",
    "toast.jsonInvalid": "AI heeft geen geldige JSON geretourneerd. Het antwoord staat in de chat — u kunt het handmatig kopiëren.",
    "toast.fieldUpdated": '"{{field}}" bijgewerkt!',
    "toast.greetingsUpdated": "{{count}} begroeting(en) gegenereerd!",
    "toast.tagsUpdated": "Tags bijgewerkt — {{count}} nieuwe toegevoegd!",
    "toast.greetingsParseFailed": "Begroetingen konden niet uit het AI-antwoord worden geparseerd.",
    "toast.createCardFirst": "Maak of selecteer eerst een kaart",
    "toast.wizardCreated": "Kaart gemaakt! Begin met bewerken of gebruik AI om de details in te vullen.",
    "toast.wizardApi": "Stel eerst uw API-sleutel in bij Instellingen",
    "toast.wizardModel": "Selecteer een model of stel een eigen model-ID in bij Instellingen",
    "toast.wizardFetchFailed": "Afbeeldingen ophalen mislukt: {{error}}",
    "toast.wizardName": "Voer een personagenaam in",
    "toast.storageFull": "Opslag vol! Probeer enkele kaarten te verwijderen of te exporteren.",
    "toast.exportedJson": "Geëxporteerd als JSON!",
    "toast.exportedPng": "Geëxporteerd als PNG met kaartgegevens!",
    "toast.exportFailed": "Afbeeldingsexport mislukt. Terugvallen op JSON.",
    "toast.noNameWarning": 'Waarschuwing: kaart heeft geen naam. Bestand wordt opgeslagen als "character.json".',
    "toast.chatCleared": "Chat gewist",
    "toast.selectField": "Selecteer ten minste één veld om te bewerken",
    "toast.tooManyFields": "Te veel velden geselecteerd. Maximaal {{max}} tegelijk.",
    "toast.undo": "Ongedaan maken",
    "toast.redo": "Opnieuw",
    "toast.reorderFiltered": "Schakel zoeken en filters uit om kaarten te herordenen.",
    "error.apiKeyNotSet": "API-sleutel niet ingesteld. Voer uw API-sleutel in bij Instellingen.",
    "error.customUrlNotSet": "De basis-URL van de aangepaste API is niet ingesteld. Open Instellingen → Aangepast (OpenAI-compatibel) en voer de endpoint-URL in (bijv. http://localhost:1234/v1).",
    "error.customServerError": "De server gaf een fout terug: {{detail}}",
    "error.customAuthFailed": "Authenticatie mislukt (HTTP {{status}}). Controleer de API-sleutel voor dit endpoint.",
    "error.customPathNotFound": "Endpoint niet gevonden (HTTP 404). Controleer of de API-basis-URL volledig is (bijv. /v1 bevat).",
    "error.customUnreachable": "Kan {{url}} niet bereiken. Controleer of de server draait en of de API-basis-URL correct is en vanaf dit apparaat bereikbaar is.",
    "error.noModel": "Geen model geselecteerd. Kies een model of stel een model-ID in bij Instellingen.",
    "error.noModelSimple": "Geen model geselecteerd.",
    "error.insufficientCredits": "Onvoldoende credits. Laad uw account op.",
    "error.storageFull": "Opslag vol! Probeer enkele kaarten te verwijderen of te exporteren.",
    "gen.empty": "(leeg)",
    "gen.free": "Gratis",
    "gen.unlimited": "Onbeperkt",
    "gen.notAvailable": "N/B",
    "gen.unnamed": "Naamloos",
    "gen.byCreator": "door {{name}}",
    "gen.copySuffix": " (kopie)",
    "gen.toastAutoHide": "Verdwijnt automatisch over {{s}}s",
    "gen.untagged": "Geen tags gevonden",
    "gen.noMatch": "Geen kaarten voldoen aan uw filters",
    "batch.deleteConfirm": "{{count}} kaart(en) verwijderen? Dit kan niet ongedaan worden gemaakt.",
    "left.selected": "{{count}} geselecteerd",
    "toast.cardDeleted": 'Kaart "{{name}}" verwijderd',
    "ai.apply": "Toepassen",
    "ai.applyTitle": "Deze wijzigingen op de kaart toepassen",
    "ai.errorPrefix": "Fout: ",
    "ai.translatePrompt": "Naar welke taal vertalen?",
    "ai.translateDefaultLang": "Frans",
    "ai.tonePrompt": "Welke toon? (bijv. formeel, informeel, duister, humoristisch, poëtisch)",
    "ai.toneDefault": "formeel",
    "ai.chatSession": "Chatsessie",
    "ai.msgs": "{{count}} ber.",
    "ai.tokensIn": " in · ",
    "ai.tokensOut": " uit · ",
    "ai.tokensCtx": " ctx",
    "ai.exceedsLimit": " ⚠ Overschrijdt limiet!",
    "ai.approachingLimit": " ⚠ Limiet bijna bereikt",
    "ai.count": "Aantal:",
    "ai.resizeAria": "AI-assistent vergroten/verkleinen",
    "ai.chatMessagesAria": "AI-chatberichten",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Voorbeelddialoog hier...
{{user}}: Gebruikersreactie...
<START>
{{char}}: Nog een voorbeeld...`,
    "batch.select2ForCompare": "Selecteer precies 2 kaarten om te vergelijken",
    "batch.compareLoadFailed": "Kaarten laden voor vergelijking mislukt",
    "batch.comparePrefix": "Vergelijk: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Kaart A",
    "batch.cardB": "Kaart B",
    "editor.charCount": "{{chars}} tekens ~{{tokens}} tokens",
    "editor.counterWarn": "Dicht bij de uitvoer-tokenlimiet ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Boven de uitvoer-tokenlimiet ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Omhoog verplaatsen",
    "editor.greetingMoveDown": "Omlaag verplaatsen",
    "editor.greetingIsDefault": "Dit is het huidige eerste bericht",
    "editor.greetingSetDefault": "Instellen als eerste bericht",
    "editor.greetingRemove": "Verwijderen",
    "editor.greetingPlaceholder": "Begroeting {{num}}...",
    "editor.loreEntry": "Item {{num}}",
    "editor.loreDeleteEntry": "Item verwijderen",
    "editor.lorePrimaryKeys": "Primaire trefwoorden",
    "editor.lorePrimaryKeysPlaceholder": "Primaire trefwoorden — gescheiden door komma's",
    "editor.loreSecondaryKeys": "Secundaire trefwoorden",
    "editor.loreSecondaryKeysPlaceholder": "Secundaire trefwoorden",
    "editor.loreComment": "Opmerking",
    "editor.loreCommentPlaceholder": "Opmerking",
    "editor.loreOrder": "Volgorde",
    "editor.loreOrderPlaceholder": "Volgorde",
    "editor.loreConstant": "Constant",
    "editor.loreSelective": "Selectief",
    "editor.loreBeforeChar": "Vóór personage",
    "editor.loreAfterChar": "Na personage",
    "editor.loreContent": "Inhoud",
    "editor.loreContentPlaceholder": "Iteminhoud...",
    "editor.loreNewEntry": "Nieuw item",
    "error.unknown": "Onbekende fout",
    "error.unexpected": "Onverwachte fout: {{message}}",
    "error.requestFailed": "Verzoek mislukt: {{message}}",
    "error.unsupportedFile": "Niet-ondersteund bestandstype: .{{ext}}",
    "error.invalidJson": "Ongeldige JSON: {{message}}",
    "error.notPng": "Geen geldig PNG-bestand",
    "error.unknownFormat": "Onbekend kaartformaat — dit is geen SillyTavern-personagekaart",
    "error.fetchModelsFailed": "Modellen ophalen mislukt (HTTP {{status}})",
    "error.noChoices": "API heeft geen antwoordopties geretourneerd",
    "error.emptyResponse": "Lege reactie van API (geen inhoud)",
    "gen.newCharacter": "Nieuw personage",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Back-up",
    "settings.restore": "Herstellen",
    "settings.backupTitle": "Back-up van alle kaarten maken",
    "settings.restoreTitle": "Back-up herstellen",
    "settings.exportTitle": "Instellingen exporteren",
    "settings.importTitle": "Instellingen importeren",
    "settings.modelAuto": "Auto",
    "settings.modelIdPlaceholder": "bijv. deepseek-v4-flash",
    "settings.customModelPlaceholder": "bijv. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "bijv. {{provider}}-latest",
    "settings.getApiKeyFrom": "API-sleutel ophalen van ",
    "settings.customModelDesc": "Eigen model",
    "settings.workspaceExported": "Werkruimte geëxporteerd ({{count}} kaarten)",
    "settings.invalidWorkspace": "Ongeldig werkruimteformaat",
    "settings.workspaceImported": "Werkruimte geïmporteerd ({{count}} kaarten)",
    "settings.workspaceImportFailed": "Werkruimte importeren mislukt: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "AI-assistent in-/uitschakelen",
    "nav.toggleAIAria": "AI-assistent in-/uitschakelen",
    "nav.notificationsAria": "Meldingen",
    "left.sortCards": "Kaarten sorteren",
    "left.compareSelected": "Geselecteerde kaarten vergelijken",
    "left.resizeAria": "Kaartenbibliotheek vergroten/verkleinen",
    "left.cardListAria": "Kaartenbibliotheek",
    "ui.saved": " Opgeslagen",
    "ui.collapsePanel": "Paneel inklappen",
    "ui.expandPanel": "Paneel uitklappen",
    "ui.cardModified": "Niet-opgeslagen wijzigingen",
    "export.minimalPngLabel": "ST-kaart",
    "wizard.search": "Zoeken",
    "wizard.quick": "Snel:",
    "wizard.imageSearchPlaceholder": "Zoek tags: kat, jurk, uniform, cyberpunk...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.uk = {
    "app.title": "ST Card Editor — Студія карток персонажів SillyTavern",
    "nav.selectModel": "Виберіть модель...",
    "nav.wizard": "Створити за допомогою AI-майстра",
    "nav.newCard": "Нова порожня картка",
    "nav.save": "Зберегти",
    "nav.theme": "Перемкнути тему",
    "nav.shortcuts": "Гарячі клавіші та довідка",
    "nav.settings": "Налаштування",
    "nav.focus": "Режим фокусу",
    "nav.focusAlt": "Режим фокусу (Alt+F)",
    "left.title": "Бібліотека карток",
    "left.cards": "{{count}} карток",
    "left.drop": "Перетягніть сюди",
    "left.dropSub": "Картки персонажів PNG або JSON",
    "left.browse": "Огляд файлів",
    "left.search": "Пошук карток...",
    "left.sort.nameAsc": "Назва А-Я",
    "left.sort.nameDesc": "Назва Я-А",
    "left.sort.manual": "Вручну",
    "left.sort.newest": "Спочатку нові",
    "left.sort.oldest": "Спочатку старі",
    "left.sort.largest": "Найбільші",
    "left.sort.smallest": "Найменші",
    "left.filterTags": "Фільтр за тегами",
    "left.exportSelected": "Експортувати вибрані як JSON",
    "left.deleteSelected": "Видалити вибрані",
    "left.empty": "Картки не завантажено",
    "left.emptySub": "Перетягніть картку або натисніть «Огляд»",
    "center.noCard": "Картку не вибрано",
    "center.noCardSub": "Виберіть картку з бібліотеки або перетягніть нову",
    "center.createAI": "Створити з AI",
    "center.blankCard": "Порожня картка",
    "editor.avatar": "Натисніть або перетягніть зображення, щоб встановити аватар",
    "editor.avatarAria": "Встановити аватар персонажа",
    "editor.name": "Ім'я персонажа",
    "editor.exportJson": "Експортувати як JSON",
    "editor.exportPng": "Експортувати як PNG",
    "editor.duplicate": "Дублювати картку",
    "editor.delete": "Видалити картку",
    "editor.tab.core": "Основне",
    "editor.tab.personality": "Особистість",
    "editor.tab.advanced": "Додатково",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Зображення Waifu",
    "editor.waifuPreview": "Поточне зображення картки",
    "editor.waifuNoImage": "Зображення ще не встановлено",
    "editor.waifuSource": "Джерело зображення",
    "editor.waifuSourceSnap": "Аніме-знімки (waifu.im)",
    "editor.waifuSourceChar": "Аніме-персонажі (AniList)",
    "editor.waifuGender": "Стать",
    "editor.waifuGenderAll": "Будь-яка стать",
    "editor.waifuGenderFemaleOnly": "Лише жінки",
    "editor.waifuGenderMaleOnly": "Лише чоловіки",
    "editor.waifuGenderFemale": "Жіноча",
    "editor.waifuGenderMale": "Чоловіча",
    "editor.waifuCharSub": "пошук персонажа за ім'ям (напр., zoro)",
    "editor.waifuSearch": "Пошук на waifu.im",
    "editor.waifuSearchChar": "Пошук персонажів",
    "editor.waifuSearchPlaceholderChar": "пошук персонажа за ім'ям (напр., zoro)",
    "editor.waifuSub": "(отримує зображення в аніме-стилі за тегом)",
    "editor.waifuSearchPlaceholder": "напр.: waifu, ельф, служниця...",
    "editor.waifuFetch": "Отримати зображення",
    "editor.waifuRegenTitle": "Перегенерувати результати",
    "editor.waifuMixed": "Жінки + Чоловіки",
    "editor.waifuMixedSub": "збалансований набір одним кліком: 3 жіночі + 3 чоловічі персонажі",
    "editor.waifuUse": "Використати як зображення картки",
    "editor.waifuUpload": "Завантажити з пристрою",
    "editor.waifuRemove": "Видалити зображення",
    "toast.noImage": "У цієї картки немає зображення для видалення",
    "toast.imageRemoved": "Зображення видалено",
    "editor.desc": "Опис",
    "editor.descSub": "(зовнішність, передісторія)",
    "editor.descPlaceholder": "Опишіть зовнішність, передісторію та ключові риси персонажа...",
    "editor.firstMes": "Перше повідомлення",
    "editor.firstMesPlaceholder": "Перше повідомлення персонажа на початку чату...",
    "editor.scenario": "Сценарій",
    "editor.scenarioPlaceholder": "Поточні обставини та контекст розмови...",
    "editor.creator": "Автор",
    "editor.creatorPlaceholder": "Автор / творець картки",
    "editor.version": "Версія персонажа",
    "editor.tags": "Теги",
    "editor.tagsSub": "(через кому)",
    "editor.tagsPlaceholder": "фентезі, воїн, ельф",
    "editor.personalitySummary": "Короткий опис особистості",
    "editor.personalityPlaceholder": "Короткий опис особистості персонажа... (використовується у форматі картки персонажа)",
    "editor.mesExample": "Приклади повідомлень",
    "editor.mesExampleFormat": "Формат: блоки <START> з префіксами {{char}}: та {{user}}:",
    "editor.systemPrompt": "Системний промпт",
    "editor.systemPromptPlaceholder": "Замініть системний промпт. Використовуйте {{original}}, щоб включити стандартний.",
    "editor.postHistory": "Інструкції після історії",
    "editor.postHistoryPlaceholder": "Інструкції, що додаються після історії чату. Використовуйте {{original}} для стандартних.",
    "editor.creatorNotes": "Нотатки автора",
    "editor.creatorNotesPlaceholder": "Нотатки для користувачів картки (рекомендації щодо моделей, поради з використання...)",
    "editor.greetings": "Альтернативні привітання",
    "editor.addGreeting": "Додати привітання",
    "editor.lorebookTitle": "Записи lorebook персонажа",
    "editor.addEntry": "Додати запис",
    "editor.lorebookSearch": "Пошук записів за ключем, вмістом або коментарем...",
    "editor.lorebookEmpty": "Записів у lorebook ще немає. Додайте один, щоб почати.",
    "editor.noGreetings": "Привітань ще немає. Натисніть <strong>Додати привітання</strong> або згенеруйте їх за допомогою AI.",
    "editor.noEntriesMatch": 'Немає записів, що відповідають "{{query}}"',
    "editor.edit": "Редагувати",
    "editor.preview": "Попередній перегляд",
    "ai.title": "AI-асистент",
    "ai.clearChat": "Очистити чат",
    "ai.welcomeTitle": "AI-асистент карток",
    "ai.welcomeText": "Попросіть AI відредагувати, перекласти або покращити вашу картку персонажа.",
    "ai.quick.newCard": "Нова картка",
    "ai.quick.translate": "Перекласти",
    "ai.quick.enhance": "Покращити",
    "ai.quick.shorten": "Скоротити",
    "ai.quick.tone": "Змінити тон",
    "ai.quick.grammar": "Виправити граматику",
    "ai.quick.personality": "Розширити особистість",
    "ai.quick.firstmes": "Покращити перше повідомлення",
    "ai.quick.scenario": "Розширити сценарій",
    "ai.quick.greetings": "Згенерувати привітання",
    "ai.quick.systemprompt": "Покращити системний промпт",
    "ai.quick.tags": "Запропонувати теги",
    "ai.contextTitle": "Орієнтовні використані токени порівняно з лімітом контексту моделі",
    "ai.contextLabel": "— / — токенів",
    "ai.placeholder": "Попросіть AI відредагувати картку...",
    "ai.send": "Надіслати",
    "ai.stop": "Зупинити генерацію",
    "ai.autoModel": "Виберіть модель...",
    "ai.target": "Ціль:",
    "ai.target.full": "Уся картка",
    "ai.target.description": "Опис",
    "ai.target.personality": "Особистість",
    "ai.target.first_mes": "Перше повідомлення",
    "ai.target.scenario": "Сценарій",
    "ai.target.mes_example": "Приклади повідомлень",
    "ai.target.system_prompt": "Системний промпт",
    "ai.target.post_history_instructions": "Інструкції після історії",
    "ai.target.creator_notes": "Нотатки автора",
    "ai.target.alternate_greetings": "Альтернативні привітання",
    "ai.selectModel": "Виберіть модель",
    "ai.actionNewCard": "Нова картка",
    "ai.actionTranslate": "Перекласти",
    "ai.actionEnhance": "Покращити",
    "ai.actionShorten": "Скоротити",
    "ai.actionTone": "Змінити тон",
    "ai.actionGrammar": "Виправити граматику",
    "ai.actionPersonality": "Розширити особистість",
    "ai.actionFirstMes": "Покращити перше повідомлення",
    "ai.actionScenario": "Розширити сценарій",
    "ai.actionGreetings": "Згенерувати привітання",
    "ai.actionSystemprompt": "Покращити системний промпт",
    "ai.actionTags": "Запропонувати теги",
    "ai.chatHistory": "Історія чату",
    "ai.historyTitle": "Історія чату",
    "ai.historyEmpty": "Розмов ще немає",
    "ai.retry": "Повторити",
    "ai.retryTitle": "Згенерувати цю відповідь заново",
    "ai.reapply": "Застосувати повторно",
    "ai.reapplyTitle": "Відкрити diff повторно, щоб застосувати ці зміни",
    "ai.noCard": "(картку не вибрано)",
    "ai.editing": "Редагування {{count}} полів...",
    "ai.streaming": "потокова передача...",
    "ai.failed": "помилка",
    "ai.cancelled": "Скасовано.",
    "ai.doneSummary": "{{done}}/{{total}} готово · {{errs}} помилок",
    "ai.viewFullResult": "Переглянути повний результат",
    "ai.showLess": "Показати менше",
    "ai.reviewApply": "Переглянути та застосувати",
    "ai.changesNav": "Зміна {{current}} з {{total}}",
    "ai.changesPrev": "Попередня зміна",
    "ai.changesNext": "Наступна зміна",
    "ai.applied": "Застосовано",
    "ai.target.tags": "Теги",
    "ai.copy": "Копіювати",
    "ai.copied": "Скопійовано!",
    "ai.copyFailed": "Помилка",
    "ai.resultTitle": "Результат",
    "ai.close": "Закрити",
    "settings.themeColor": "Колір теми",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Виберіть окремий акцентний колір для світлої та темної тем. Зміни застосовуються одразу.",
    "settings.appearance": "Вигляд",
    "settings.accentPresets": "Пресети акценту",
    "settings.glassDensity": "Щільність скла",
    "settings.glassSubtle": "Тонкий",
    "settings.glassDefault": "За замовчуванням",
    "settings.glassBold": "Сміливий",
    "settings.cardRadius": "Радіус карток",
    "settings.radiusCompact": "Компактний",
    "settings.radiusRounded": "Заокруглений",
    "settings.radiusPill": "Пігулка",
    "settings.vignette": "Віньєтка по краях",
    "settings.appearanceHint": "Налаштуйте вигляд кожної світлої/темної теми. Зміни акценту застосовуються одразу; щільність, радіус і віньєтка входять до резервних копій робочої області.",
    "settings.resetThemeColor": "Скинути",
    "settings.generalTab": "Загальні",
    "settings.promptsTab": "ІІ-промпти",
    "settings.assistantPrompt": "Системний промпт асистента",
    "settings.fullCardPrompt": "Системний промпт усієї картки",
    "settings.wizardPrompt": "Інструкції генерації персонажа",
    "settings.promptPlaceholder": "Залиште порожнім, щоб використати вбудований промпт",
    "settings.chatSystemPrompts": "Інструкції чату та системи",
    "settings.fullCardInstr": "Інструкції виводу повної картки (система)",
    "settings.fieldsEdit": "Інструкції редагування поля (система)",
    "settings.greetingsSystem": "Інструкції виводу привітань (система)",
    "settings.exportPrompts": "Експортувати промпти",
    "settings.importPrompts": "Імпортувати промпти",
    "settings.promptsExported": "Промпти експортовано",
    "settings.promptsImported": "Імпортовано промптів: {count}",
    "settings.quickActionPrompts": "Промпти швидких дій",
    "settings.tagsSystemPrompt": "Інструкції виводу тегів (система)",
    "settings.restoreDefaultPrompts": "Відновити промпти за замовчуванням",
    "settings.promptHint": "У цих полях показано поточні промпти. Якщо поле порожнє, використовується вбудований промпт за замовчуванням. Натисніть «Відновити за замовчуванням», щоб переглянути або повернути початкові промпти.",
    "settings.title": "Налаштування",
    "settings.provider": "Провайдер",
    "settings.providerHint": "Хмарні провайдери моделей або власна кінцева точка (LM Studio, Ollama тощо)",
    "settings.apiKey": "API-ключ",
    "settings.getApiKey": "Отримайте API-ключ від OpenRouter",
    "settings.baseUrl": "Базовий URL API",
    "settings.namedApiKeyPlaceholder": "Введіть ваш API-ключ",
    "settings.customHint": "Сумісна з OpenAI кінцева точка. Приклади: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API-ключ (необов'язково)",
    "settings.apiKeyLocalPlaceholder": "Залиште порожнім для локальних провайдерів",
    "settings.apiKeyLocalHint": "Не потрібен для локальних серверів, як-от LM Studio або Ollama.",
    "settings.modelId": "ID моделі",
    "settings.modelIdHint": "Точний ID моделі, який очікує ваш провайдер.",
    "settings.modelIdHintNamed": "Залиште порожнім, щоб використовувати модель провайдера за замовчуванням.",
    "settings.security": "Ваш API-ключ зберігається у зашифрованому вигляді в localStorage браузера (ключ прив'язаний до цієї адреси). Не використовуйте цю програму на спільних пристроях.",
    "settings.secretUnreadable": "З міркувань безпеки збережений API-ключ не вдалося розблокувати за цією адресою — введіть його заново в налаштуваннях.",
    "error.pngInflateFailed": "Цей PNG містить дані персонажа, які не вдалося розпакувати.",
    "settings.defaultModel": "Модель за замовчуванням",
    "settings.browseModels": "Перегляньте моделі нижче...",
    "settings.refreshModels": "Оновити моделі",
    "settings.maxTokens": "Максимум вихідних токенів",
    "settings.maxTokensPlaceholder": "0 = використати модель за замовчуванням",
    "settings.maxTokensHint": "Перевизначте максимальну кількість вихідних токенів на запит. Поставте 0, щоб автоматично використовувати ліміт вибраної моделі (або 64k, якщо невідомо).",
    "settings.copyright": "Додавати згадку про редактор при експорті",
    "settings.copyrightHint": "Додає рядок із згадкою автора до нотаток творця під час експорту карток.",
    "settings.availableModels": "Доступні моделі",
    "settings.searchModels": "Пошук моделей...",
    "settings.enterApiKey": "Введіть API-ключ і оновіть, щоб завантажити моделі",
    "settings.credits": "Кредити та використання",
    "settings.creditLimit": "Ліміт кредитів",
    "settings.remaining": "Залишилось",
    "settings.usedMonth": "Використано цього місяця",
    "settings.localStorage": "Локальне сховище",
    "settings.clearAll": "Очистити всі дані",
    "settings.export": "Експорт",
    "settings.import": "Імпорт",
    "settings.close": "Закрити",
    "settings.saveSettings": "Зберегти налаштування",
    "settings.languageLabel": "Мова",
    "settings.languageHint": "Мова інтерфейсу (перезавантажте сторінку, якщо відсутня)",
    "settings.languageChanged": "Мову оновлено",
    "settings.clearConfirm": "Видалити ВСІ картки, налаштування та історію чату? Цю дію неможливо скасувати.",
    "settings.providerCustom": "Власний (сумісний з OpenAI)",
    "settings.noModels": "Моделі не знайдено",
    "settings.loadMore": "Завантажити ще ({{count}} залишилось)",
    "settings.showingModels": "Показано {{shown}} з {{total}} моделей",
    "wizard.title": "Створити персонажа",
    "wizard.step.basics": "Основне",
    "wizard.step.concept": "Концепція",
    "wizard.step.personality": "Особистість",
    "wizard.step.scenario": "Сценарій",
    "wizard.step.generate": "Згенерувати",
    "wizard.basicsTitle": "Основа персонажа",
    "wizard.nameLabel": "Ім'я персонажа",
    "wizard.namePlaceholder": "напр. Елара Найтвіспер",
    "wizard.genderLabel": "Стать / Займенники",
    "wizard.genderSelect": "Виберіть...",
    "wizard.gender.female": "Жіноча (вона)",
    "wizard.gender.male": "Чоловіча (він)",
    "wizard.gender.nonbinary": "Небінарна (вони)",
    "wizard.gender.other": "Інше...",
    "wizard.genderCustom": "Власні займенники (напр. воно)",
    "wizard.tagsLabel": "Теги",
    "wizard.tagsSub": "(через кому, допомагає впорядкувати бібліотеку)",
    "wizard.tagsPlaceholder": "фентезі, воїн, ельф, оригінальний",
    "wizard.creatorLabel": "Автор",
    "wizard.creatorPlaceholder": "Ваше ім'я / псевдонім",
    "wizard.conceptTitle": "Концепція та світ",
    "wizard.typeLabel": "Тип персонажа",
    "wizard.type.original": "Оригінальний персонаж",
    "wizard.type.fanfic": "Фанфік",
    "wizard.type.game": "Ігровий персонаж",
    "wizard.type.anime": "Аніме / Манга",
    "wizard.type.book": "Книга / Фільм / Серіал",
    "wizard.type.historical": "Історична постать",
    "wizard.type.mythological": "Міфологічний / Фольклорний",
    "wizard.type.vtuber": "VTuber / Стрімер",
    "wizard.type.other": "Інше",
    "wizard.languageLabel": "Мова",
    "wizard.language.other": "Інша",
    "wizard.languageSpecify": "Вкажіть мову",
    "wizard.genreLabel": "Жанр / Світ",
    "wizard.genreSub": "(виберіть усі відповідні)",
    "wizard.moodLabel": "Настрій / Тон",
    "wizard.moodSub": "(виберіть усі відповідні)",
    "wizard.personalityTitle": "Особистість та зовнішність",
    "wizard.personalityTraits": "Риси особистості",
    "wizard.personalityTraitsSub": "(опишіть 3-5 ключових рис, це допомагає AI)",
    "wizard.personalityTraitsPlaceholder": "напр. Смілива, але нерозважлива, віддана друзям, сухе почуття гумору, важко довіряє людям, таємно любить тварин",
    "wizard.appearanceLabel": "Зовнішність",
    "wizard.appearanceSub": "(короткий опис того, як виглядає)",
    "wizard.appearancePlaceholder": "напр. Висока жінка зі сріблястим волоссям до пояса, руки в шрамах, носить темну шкіряну куртку, пронизливі зелені очі",
    "wizard.abilitiesLabel": "Особливі здібності / Дивацтва",
    "wizard.abilitiesSub": "(необов'язково, будь-які унікальні риси)",
    "wizard.abilitiesPlaceholder": "напр. Уміє розмовляти з тваринами, має фотографічну пам'ять, завжди носить поношений щоденник",
    "wizard.scenarioTitle": "Сценарій та перше повідомлення",
    "wizard.scenarioLabel": "Сценарій / Обстановка",
    "wizard.scenarioSub": "(з чого починається історія?)",
    "wizard.scenarioPlaceholder": "напр. Дощова ніч у місті, залитому неоном. Персонаж тримає невелику майстерню, яка ремонтує і машини, і розбиті серця.",
    "wizard.relationshipLabel": "Ставлення до {{user}}",
    "wizard.relationshipSub": "(як персонаж бачить користувача?)",
    "wizard.relationshipPlaceholder": "напр. Новий клієнт, який зайшов у майстерню з таємничим зламаним пристроєм. Персонаж цікавий, але обережний.",
    "wizard.openingLabel": "Настрій першого повідомлення",
    "wizard.openingSub": "(яким має бути початкове повідомлення?)",
    "wizard.notesLabel": "Додаткові нотатки",
    "wizard.notesSub": "(щось ще, що має знати AI?)",
    "wizard.notesPlaceholder": "напр. Тримайте діалог природним, уникайте надто офіційного тону, додавайте описи дій у зірочках",
    "wizard.generateTitle": "Згенерувати персонажа",
    "wizard.refImage": "Референсне зображення",
    "wizard.refImageSub": "(необов'язково, з waifu.im)",
    "wizard.fetchImages": "Отримати 3 зображення",
    "wizard.refetchOthers": "Отримати інші",
    "wizard.fetching": "Отримання...",
    "wizard.useSelected": "Використати вибране",
    "wizard.clear": "Очистити",
    "wizard.generateAI": "Згенерувати за допомогою AI",
    "wizard.generateAISub": "Повна картка персонажа з ваших відповідей",
    "wizard.createBlank": "Створити порожню картку",
    "wizard.createBlankSub": "Почніть із заповненими ім'ям та тегами",
    "wizard.back": "Назад",
    "wizard.next": "Далі",
    "wizard.stepLabel": "Крок {{step}} з {{total}}",
    "wizard.ready": "Готово до генерації!",
    "wizard.nameRequired": "Будь ласка, введіть ім'я персонажа",
    "wizard.summary.name": "Ім'я",
    "wizard.summary.gender": "Стать",
    "wizard.summary.type": "Тип",
    "wizard.summary.language": "Мова",
    "wizard.summary.tags": "Теги",
    "wizard.summary.genres": "Жанри",
    "wizard.summary.mood": "Настрій",
    "wizard.summary.opening": "Початок",
    "wizard.summary.personality": "Особистість",
    "wizard.summary.appearance": "Зовнішність",
    "wizard.summary.scenario": "Сценарій",
    "wizard.summary.relationship": "Ставлення",
    "wizard.summary.notes": "Нотатки",
    "wizard.chip.fantasy": "Фентезі",
    "wizard.chip.scifi": "Наукова фантастика",
    "wizard.chip.modern": "Сучасний",
    "wizard.chip.historical": "Історичний",
    "wizard.chip.horror": "Жахи",
    "wizard.chip.romance": "Романтика",
    "wizard.chip.comedy": "Комедія",
    "wizard.chip.sliceOfLife": "Повсякденність",
    "wizard.chip.adventure": "Пригоди",
    "wizard.chip.mystery": "Детектив",
    "wizard.chip.cyberpunk": "Кіберпанк",
    "wizard.chip.postApocalyptic": "Постапокаліпсис",
    "wizard.chip.supernatural": "Надприродне",
    "wizard.chip.military": "Військовий",
    "wizard.chip.surreal": "Сюрреалістичний",
    "wizard.chip.serious": "Серйозний",
    "wizard.chip.playful": "Грайливий",
    "wizard.chip.dark": "Темний",
    "wizard.chip.lighthearted": "Легкий",
    "wizard.chip.mysterious": "Загадковий",
    "wizard.chip.romantic": "Романтичний",
    "wizard.chip.intense": "Інтенсивний",
    "wizard.chip.wholesome": "Теплий і щирий",
    "wizard.chip.chaotic": "Хаотичний",
    "wizard.chip.melancholic": "Меланхолійний",
    "wizard.chip.sarcastic": "Саркастичний",
    "wizard.chip.stoic": "Стоїчний",
    "wizard.chip.greeting": "Тепле привітання",
    "wizard.chip.action": "З розпалу подій",
    "wizard.chip.question": "Цікаве питання",
    "wizard.chip.conflict": "Негайний конфлікт",
    "wizard.chip.atmospheric": "Атмосферний",
    "wizard.editStep": "Редагувати цей розділ",
    "wizard.draftRestored": "Чернетку відновлено — ваші попередні відповіді повернуто",
    "wizard.imagePlaceholder": "Натисніть «Отримати»",
    "diff.title": "Попередній перегляд відповіді AI",
    "diff.removed": "Видалено",
    "diff.added": "Додано",
    "diff.current": "Поточна",
    "diff.proposed": "Запропонована",
    "diff.empty": "(порожньо)",
    "diff.discard": "Відхилити",
    "diff.apply": "Застосувати зміни",
    "shortcuts.title": "Гарячі клавіші",
    "shortcuts.save": "Зберегти картку",
    "shortcuts.newCard": "Нова картка",
    "shortcuts.undo": "Скасувати",
    "shortcuts.redo": "Повторити",
    "shortcuts.sendAi": "Надіслати повідомлення AI",
    "shortcuts.newLine": "Новий рядок у чаті AI",
    "shortcuts.focus": "Режим фокусу",
    "shortcuts.collapsePanel": "Згорнути/розгорнути панель ШІ",
    "toast.loadFailed": "Помилка: {{name}}",
    "toast.loaded": "Завантажено {{count}} карток",
    "toast.importDupe": "Вміст збігається з наявною карткою — імпортовано як {{name}}",
    "toast.largeImage": "У {{name}} вбудовано велике зображення ({{size}} МБ) - видаліть його, щоб заощадити місце.",
    "toast.noValid": "Валідних карток не знайдено. Перетягніть файли PNG або JSON.",
    "toast.noSelected": "Картки не вибрано",
    "toast.cardsDeleted": "Картки видалено",
    "toast.deleteFailed": "Не вдалося видалити картку",
    "toast.exported": "Експортовано {{count}} карток",
    "toast.newBlank": "Створено нову порожню картку",
    "toast.noCardSave": "Немає картки для збереження",
    "toast.cardSaved": "Картку збережено!",
    "toast.noCardDup": "Немає картки для дублювання",
    "toast.cardDup": "Картку дубльовано",
    "toast.cardRestored": "Картку відновлено",
    "toast.selectCard": "Спочатку виберіть картку",
    "toast.avatarUpdated": "Аватар оновлено",
    "toast.imgFailed": "Не вдалося завантажити зображення",
    "toast.firstMesUpdated": "Перше повідомлення оновлено!",
    "toast.settingsSaved": "Налаштування збережено!",
    "toast.modelsFailed": "Не вдалося завантажити моделі: {{error}}",
    "toast.modelSet": "Модель встановлено: {{model}}",
    "toast.dataCleared": "Усі дані очищено",
    "toast.settingsExported": "Налаштування експортовано",
    "toast.settingsImported": "Налаштування імпортовано!",
    "toast.invalidFile": "Недійсний файл налаштувань",
    "toast.apiKey": "Встановіть API-ключ у Налаштуваннях",
    "toast.selectModel": "Спочатку виберіть модель у панелі навігації або в налаштуваннях.",
    "toast.genStopped": "Генерацію зупинено.",
    "toast.aiError": "Помилка AI: {{error}}",
    "toast.cardUpdatedAI": "Картку оновлено з відповіді AI!",
    "toast.jsonParseFailed": "Не вдалося розібрати відповідь AI як JSON. Перевірте чат.",
    "toast.emptyResponse": "AI повернув порожній вміст — застосувати нічого.",
    "toast.jsonInvalid": "AI не повернув дійсний JSON. Відповідь у чаті — ви можете скопіювати її вручну.",
    "toast.fieldUpdated": '"{{field}}" оновлено!',
    "toast.greetingsUpdated": "Згенеровано {{count}} привітань!",
    "toast.tagsUpdated": "Теги оновлено — додано {{count}} нових!",
    "toast.greetingsParseFailed": "Не вдалося розібрати привітання з відповіді AI.",
    "toast.createCardFirst": "Спочатку створіть або виберіть картку",
    "toast.wizardCreated": "Картку створено! Почніть редагувати або використайте AI для заповнення деталей.",
    "toast.wizardApi": "Спочатку встановіть API-ключ у Налаштуваннях",
    "toast.wizardModel": "Виберіть модель або встановіть власний ID моделі в Налаштуваннях",
    "toast.wizardFetchFailed": "Не вдалося отримати зображення: {{error}}",
    "toast.wizardName": "Будь ласка, введіть ім'я персонажа",
    "toast.storageFull": "Сховище заповнене! Спробуйте видалити кілька карток або експортувати їх.",
    "toast.exportedJson": "Експортовано як JSON!",
    "toast.exportedPng": "Експортовано як PNG із даними картки!",
    "toast.exportFailed": "Експорт зображення не вдався. Повертаємось до JSON.",
    "toast.noNameWarning": 'Попередження: картка не має назви. Файл буде збережено як "character.json".',
    "toast.chatCleared": "Чат очищено",
    "toast.selectField": "Виберіть принаймні одне поле для редагування",
    "toast.tooManyFields": "Забагато вибраних полів. Максимум {{max}} одночасно.",
    "toast.undo": "Скасувати",
    "toast.redo": "Повторити",
    "toast.reorderFiltered": "Вимкніть пошук і фільтри, щоб змінити порядок карток.",
    "error.apiKeyNotSet": "Ключ API не встановлено. Введіть ключ API в налаштуваннях.",
    "error.customUrlNotSet": "Базовий URL користувацького API не встановлено. Відкрийте Налаштування → Користувацький (сумісний з OpenAI) і введіть URL кінцевої точки (наприклад, http://localhost:1234/v1).",
    "error.customServerError": "Сервер повернув помилку: {{detail}}",
    "error.customAuthFailed": "Помилка автентифікації (HTTP {{status}}). Перевірте ключ API для цієї кінцевої точки.",
    "error.customPathNotFound": "Кінцеву точку не знайдено (HTTP 404). Перевірте, чи повний базовий URL API (наприклад, містить /v1).",
    "error.customUnreachable": "Не вдається підключитися до {{url}}. Перевірте, що сервер запущено, а базовий URL API правильний і доступний з цього пристроя.",
    "error.noModel": "Модель не вибрано. Виберіть модель або встановіть ID моделі в Налаштуваннях.",
    "error.noModelSimple": "Модель не вибрано.",
    "error.insufficientCredits": "Недостатньо кредитів. Поповніть рахунок.",
    "error.storageFull": "Сховище заповнене! Спробуйте видалити кілька карток або експортувати їх.",
    "gen.empty": "(порожньо)",
    "gen.free": "Безкоштовно",
    "gen.unlimited": "Безлімітно",
    "gen.notAvailable": "Н/Д",
    "gen.unnamed": "Без назви",
    "gen.byCreator": "від {{name}}",
    "gen.copySuffix": " (Копія)",
    "gen.toastAutoHide": "Автоматично зникає через {{s}}с",
    "gen.untagged": "Тегів не знайдено",
    "gen.noMatch": "Жодна картка не відповідає вашим фільтрам",
    "batch.deleteConfirm": "Видалити {{count}} карток? Цю дію неможливо скасувати.",
    "left.selected": "Вибрано: {{count}}",
    "toast.cardDeleted": 'Картку "{{name}}" видалено',
    "ai.apply": "Застосувати",
    "ai.applyTitle": "Застосувати ці зміни до картки",
    "ai.errorPrefix": "Помилка: ",
    "ai.translatePrompt": "Перекласти якою мовою?",
    "ai.translateDefaultLang": "Французька",
    "ai.tonePrompt": "Який тон? (напр. офіційний, невимушений, похмурий, гумористичний, поетичний)",
    "ai.toneDefault": "офіційний",
    "ai.chatSession": "Сесія чату",
    "ai.msgs": "{{count}} повідомлень",
    "ai.tokensIn": " вхід · ",
    "ai.tokensOut": " вихід · ",
    "ai.tokensCtx": " контекст",
    "ai.exceedsLimit": " ⚠ Перевищує ліміт!",
    "ai.approachingLimit": " ⚠ Ліміт близький",
    "ai.count": "Кількість:",
    "ai.resizeAria": "Змінити розмір AI-асистента",
    "ai.chatMessagesAria": "Повідомлення чату AI",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Приклад діалогу тут...
{{user}}: Відповідь користувача...
<START>
{{char}}: Ще один приклад...`,
    "batch.select2ForCompare": "Виберіть рівно 2 картки для порівняння",
    "batch.compareLoadFailed": "Не вдалося завантажити картки для порівняння",
    "batch.comparePrefix": "Порівняння: ",
    "batch.compareVs": " проти ",
    "batch.cardA": "Картка A",
    "batch.cardB": "Картка B",
    "editor.charCount": "{{chars}} символів ~{{tokens}} токенів",
    "editor.counterWarn": "Близько до ліміту токенів виводу ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Перевищено ліміт токенів виводу ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Вгору",
    "editor.greetingMoveDown": "Вниз",
    "editor.greetingIsDefault": "Це поточне перше повідомлення",
    "editor.greetingSetDefault": "Зробити першим повідомленням",
    "editor.greetingRemove": "Видалити",
    "editor.greetingPlaceholder": "Привітання {{num}}...",
    "editor.loreEntry": "Запис {{num}}",
    "editor.loreDeleteEntry": "Видалити запис",
    "editor.lorePrimaryKeys": "Основні ключові слова",
    "editor.lorePrimaryKeysPlaceholder": "Основні ключові слова — через кому",
    "editor.loreSecondaryKeys": "Додаткові ключові слова",
    "editor.loreSecondaryKeysPlaceholder": "Додаткові ключові слова",
    "editor.loreComment": "Коментар",
    "editor.loreCommentPlaceholder": "Коментар",
    "editor.loreOrder": "Порядок",
    "editor.loreOrderPlaceholder": "Порядок",
    "editor.loreConstant": "Постійний",
    "editor.loreSelective": "Вибірковий",
    "editor.loreBeforeChar": "Перед персонажем",
    "editor.loreAfterChar": "Після персонажа",
    "editor.loreContent": "Вміст",
    "editor.loreContentPlaceholder": "Вміст запису...",
    "editor.loreNewEntry": "Новий запис",
    "error.unknown": "Невідома помилка",
    "error.unexpected": "Неочікувана помилка: {{message}}",
    "error.requestFailed": "Помилка запиту: {{message}}",
    "error.unsupportedFile": "Непідтримуваний тип файлу: .{{ext}}",
    "error.invalidJson": "Недійсний JSON: {{message}}",
    "error.notPng": "Не є дійсним файлом PNG",
    "error.unknownFormat": "Невідомий формат картки — це не картка персонажа SillyTavern",
    "error.fetchModelsFailed": "Не вдалося отримати моделі (HTTP {{status}})",
    "error.noChoices": "API не повернуло варіантів відповіді",
    "error.emptyResponse": "Порожня відповідь від API (немає тіла)",
    "gen.newCharacter": "Новий персонаж",
    "gen.bytes": " Б",
    "gen.kilobytes": " КБ",
    "gen.megabytes": " МБ",
    "settings.backup": "Резервна копія",
    "settings.restore": "Відновити",
    "settings.backupTitle": "Створити резервну копію всіх карток",
    "settings.restoreTitle": "Відновити резервну копію",
    "settings.exportTitle": "Експортувати налаштування",
    "settings.importTitle": "Імпортувати налаштування",
    "settings.modelAuto": "Авто",
    "settings.modelIdPlaceholder": "напр. deepseek-v4-flash",
    "settings.customModelPlaceholder": "напр. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "напр. {{provider}}-latest",
    "settings.getApiKeyFrom": "Отримати API-ключ від ",
    "settings.customModelDesc": "Власна модель",
    "settings.workspaceExported": "Робочий простір експортовано ({{count}} карток)",
    "settings.invalidWorkspace": "Недійсний формат робочого простору",
    "settings.workspaceImported": "Робочий простір імпортовано ({{count}} карток)",
    "settings.workspaceImportFailed": "Не вдалося імпортувати робочий простір: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Увімкнути/вимкнути AI-асистента",
    "nav.toggleAIAria": "Увімкнути/вимкнути AI-асистента",
    "nav.notificationsAria": "Сповіщення",
    "left.sortCards": "Сортувати картки",
    "left.compareSelected": "Порівняти вибрані картки",
    "left.resizeAria": "Змінити розмір бібліотеки карток",
    "left.cardListAria": "Бібліотека карток",
    "ui.saved": " Збережено",
    "ui.collapsePanel": "Згорнути панель",
    "ui.expandPanel": "Розгорнути панель",
    "ui.cardModified": "Незбережені зміни",
    "export.minimalPngLabel": "Картка ST",
    "wizard.search": "Пошук",
    "wizard.quick": "Швидко:",
    "wizard.imageSearchPlaceholder": "Пошук тегів: кіт, сукня, форма, кіберпанк...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.vi = {
    "app.title": "ST Card Editor — Xưởng thẻ nhân vật SillyTavern",
    "nav.selectModel": "Chọn mô hình...",
    "nav.wizard": "Tạo bằng trình hướng dẫn AI",
    "nav.newCard": "Thẻ trống mới",
    "nav.save": "Lưu",
    "nav.theme": "Đổi giao diện",
    "nav.shortcuts": "Phím tắt và trợ giúp",
    "nav.settings": "Cài đặt",
    "nav.focus": "Chế độ tập trung",
    "nav.focusAlt": "Chế độ tập trung (Alt+F)",
    "left.title": "Thư viện thẻ",
    "left.cards": "{{count}} thẻ",
    "left.drop": "Kéo và thả",
    "left.dropSub": "Thẻ nhân vật PNG hoặc JSON",
    "left.browse": "Duyệt tệp",
    "left.search": "Tìm thẻ...",
    "left.sort.nameAsc": "Tên A-Z",
    "left.sort.manual": "Thủ công",
    "left.sort.nameDesc": "Tên Z-A",
    "left.sort.newest": "Mới nhất trước",
    "left.sort.oldest": "Cũ nhất trước",
    "left.sort.largest": "Lớn nhất",
    "left.sort.smallest": "Nhỏ nhất",
    "left.filterTags": "Lọc theo thẻ",
    "left.exportSelected": "Xuất mục đã chọn dưới dạng JSON",
    "left.deleteSelected": "Xóa mục đã chọn",
    "left.empty": "Chưa có thẻ nào được tải",
    "left.emptySub": "Thả một thẻ hoặc bấm Duyệt",
    "center.noCard": "Chưa chọn thẻ",
    "center.noCardSub": "Chọn một thẻ từ thư viện hoặc kéo thả thẻ mới",
    "center.createAI": "Tạo bằng AI",
    "center.blankCard": "Thẻ trống",
    "editor.avatar": "Bấm hoặc kéo thả ảnh để đặt hình đại diện",
    "editor.avatarAria": "Đặt hình đại diện nhân vật",
    "editor.name": "Tên nhân vật",
    "editor.exportJson": "Xuất dưới dạng JSON",
    "editor.exportPng": "Xuất dưới dạng PNG",
    "editor.duplicate": "Nhân bản thẻ",
    "editor.delete": "Xóa thẻ",
    "editor.tab.core": "Cơ bản",
    "editor.tab.personality": "Tính cách",
    "editor.tab.advanced": "Nâng cao",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Ảnh Waifu",
    "editor.waifuPreview": "Ảnh thẻ hiện tại",
    "editor.waifuNoImage": "Chưa đặt ảnh",
    "editor.waifuSource": "Nguồn ảnh",
    "editor.waifuSourceSnap": "Ảnh anime ngẫu nhiên (waifu.im)",
    "editor.waifuSourceChar": "Nhân vật anime (AniList)",
    "editor.waifuGender": "Giới tính",
    "editor.waifuGenderAll": "Tất cả",
    "editor.waifuGenderFemaleOnly": "Chỉ nữ",
    "editor.waifuGenderMaleOnly": "Chỉ nam",
    "editor.waifuGenderFemale": "Nữ",
    "editor.waifuGenderMale": "Nam",
    "editor.waifuCharSub": "tìm nhân vật theo tên (vd: zoro)",
    "editor.waifuSearch": "Tìm kiếm trên waifu.im",
    "editor.waifuSearchChar": "Tìm nhân vật",
    "editor.waifuSearchPlaceholderChar": "tìm nhân vật theo tên (vd: zoro)",
    "editor.waifuSub": "(lấy ảnh phong cách anime theo thẻ)",
    "editor.waifuSearchPlaceholder": "vd: waifu, elf, hầu gái...",
    "editor.waifuFetch": "Lấy ảnh",
    "editor.waifuRegenTitle": "Tạo lại kết quả",
    "editor.waifuMixed": "Nữ + Nam",
    "editor.waifuMixedSub": "gói cân bằng một cú nhấp: 3 nhân vật nữ + 3 nam",
    "editor.waifuUse": "Dùng làm ảnh thẻ",
    "editor.waifuUpload": "Tải lên từ thiết bị",
    "editor.waifuRemove": "Xóa ảnh",
    "toast.noImage": "Thẻ này không có ảnh để xóa",
    "toast.imageRemoved": "Đã xóa ảnh",
    "editor.desc": "Mô tả",
    "editor.descSub": "(ngoại hình, lai lịch)",
    "editor.descPlaceholder": "Mô tả ngoại hình, lai lịch và những nét chính của nhân vật...",
    "editor.firstMes": "Tin nhắn đầu tiên",
    "editor.firstMesPlaceholder": "Tin nhắn đầu tiên của nhân vật khi bắt đầu trò chuyện...",
    "editor.scenario": "Bối cảnh",
    "editor.scenarioPlaceholder": "Hoàn cảnh hiện tại và bối cảnh của cuộc trò chuyện...",
    "editor.creator": "Người tạo",
    "editor.creatorPlaceholder": "Người tạo / tác giả thẻ",
    "editor.version": "Phiên bản nhân vật",
    "editor.tags": "Thẻ",
    "editor.tagsSub": "(phân cách bằng dấu phẩy)",
    "editor.tagsPlaceholder": "kỳ ảo, chiến binh, yêu tinh",
    "editor.personalitySummary": "Tóm tắt tính cách",
    "editor.personalityPlaceholder": "Mô tả ngắn về tính cách của nhân vật... (được dùng trong định dạng thẻ nhân vật)",
    "editor.mesExample": "Tin nhắn ví dụ",
    "editor.mesExampleFormat": "Định dạng: các khối <START> với tiền tố {{char}}: và {{user}}:",
    "editor.systemPrompt": "Lời nhắc hệ thống",
    "editor.systemPromptPlaceholder": "Ghi đè lời nhắc hệ thống. Dùng {{original}} để bao gồm lời nhắc mặc định.",
    "editor.postHistory": "Hướng dẫn sau lịch sử",
    "editor.postHistoryPlaceholder": "Hướng dẫn được chèn sau lịch sử trò chuyện. Dùng {{original}} cho mặc định.",
    "editor.creatorNotes": "Ghi chú của người tạo",
    "editor.creatorNotesPlaceholder": "Ghi chú cho người dùng thẻ (đề xuất mô hình, mẹo sử dụng...)",
    "editor.greetings": "Lời chào thay thế",
    "editor.addGreeting": "Thêm lời chào",
    "editor.lorebookTitle": "Mục lorebook của nhân vật",
    "editor.addEntry": "Thêm mục",
    "editor.lorebookSearch": "Tìm mục theo khóa, nội dung hoặc bình luận...",
    "editor.lorebookEmpty": "Chưa có mục lorebook nào. Thêm một mục để bắt đầu.",
    "editor.noGreetings": "Chưa có lời chào nào. Bấm <strong>Thêm lời chào</strong> hoặc dùng AI để tạo.",
    "editor.noEntriesMatch": 'Không có mục nào khớp với "{{query}}"',
    "editor.edit": "Chỉnh sửa",
    "editor.preview": "Xem trước",
    "ai.title": "Trợ lý AI",
    "ai.clearChat": "Xóa trò chuyện",
    "ai.welcomeTitle": "Trợ lý thẻ AI",
    "ai.welcomeText": "Yêu cầu AI chỉnh sửa, dịch hoặc cải thiện thẻ nhân vật của bạn.",
    "ai.quick.newCard": "Thẻ mới",
    "ai.quick.translate": "Dịch",
    "ai.quick.enhance": "Cải thiện",
    "ai.quick.shorten": "Rút gọn",
    "ai.quick.tone": "Đổi giọng điệu",
    "ai.quick.grammar": "Sửa ngữ pháp",
    "ai.quick.personality": "Mở rộng tính cách",
    "ai.quick.firstmes": "Cải thiện tin nhắn đầu tiên",
    "ai.quick.scenario": "Mở rộng bối cảnh",
    "ai.quick.greetings": "Tạo lời chào",
    "ai.quick.systemprompt": "Cải thiện lời nhắc hệ thống",
    "ai.quick.tags": "Gợi ý thẻ",
    "ai.contextTitle": "Token ước tính đã dùng so với giới hạn ngữ cảnh của mô hình",
    "ai.contextLabel": "— / — token",
    "ai.placeholder": "Yêu cầu AI chỉnh sửa thẻ...",
    "ai.send": "Gửi",
    "ai.stop": "Dừng tạo",
    "ai.autoModel": "Chọn mô hình...",
    "ai.target": "Mục tiêu:",
    "ai.target.full": "Toàn bộ thẻ",
    "ai.target.description": "Mô tả",
    "ai.target.personality": "Tính cách",
    "ai.target.first_mes": "Tin nhắn đầu tiên",
    "ai.target.scenario": "Bối cảnh",
    "ai.target.mes_example": "Tin nhắn ví dụ",
    "ai.target.system_prompt": "Lời nhắc hệ thống",
    "ai.target.post_history_instructions": "Hướng dẫn sau lịch sử",
    "ai.target.creator_notes": "Ghi chú của người tạo",
    "ai.target.alternate_greetings": "Lời chào thay thế",
    "ai.selectModel": "Chọn một mô hình",
    "ai.actionNewCard": "Thẻ mới",
    "ai.actionTranslate": "Dịch",
    "ai.actionEnhance": "Cải thiện",
    "ai.actionShorten": "Rút gọn",
    "ai.actionTone": "Đổi giọng điệu",
    "ai.actionGrammar": "Sửa ngữ pháp",
    "ai.actionPersonality": "Mở rộng tính cách",
    "ai.actionFirstMes": "Cải thiện tin nhắn đầu tiên",
    "ai.actionScenario": "Mở rộng bối cảnh",
    "ai.actionGreetings": "Tạo lời chào",
    "ai.actionSystemprompt": "Cải thiện lời nhắc hệ thống",
    "ai.actionTags": "Gợi ý thẻ",
    "ai.chatHistory": "Lịch sử trò chuyện",
    "ai.historyTitle": "Lịch sử trò chuyện",
    "ai.historyEmpty": "Chưa có cuộc trò chuyện nào",
    "ai.retry": "Thử lại",
    "ai.retryTitle": "Tạo lại phản hồi này",
    "ai.reapply": "Áp dụng lại",
    "ai.reapplyTitle": "Mở lại phần so sánh để áp dụng các thay đổi này",
    "ai.noCard": "(chưa chọn thẻ)",
    "ai.editing": "Đang chỉnh sửa {{count}} trường...",
    "ai.streaming": "đang phát trực tiếp...",
    "ai.failed": "thất bại",
    "ai.cancelled": "Đã hủy.",
    "ai.doneSummary": "{{done}}/{{total}} xong · {{errs}} thất bại",
    "ai.viewFullResult": "Xem kết quả đầy đủ",
    "ai.showLess": "Hiển thị ít hơn",
    "ai.reviewApply": "Xem lại và áp dụng",
    "ai.changesNav": "Thay đổi {{current}} / {{total}}",
    "ai.changesPrev": "Thay đổi trước",
    "ai.changesNext": "Thay đổi tiếp theo",
    "ai.applied": "Đã áp dụng",
    "ai.target.tags": "Thẻ",
    "ai.copy": "Sao chép",
    "ai.copied": "Đã sao chép!",
    "ai.copyFailed": "Thất bại",
    "ai.resultTitle": "Kết quả",
    "ai.close": "Đóng",
    "settings.themeColor": "Màu chủ đề",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Chọn màu nhấn riêng cho từng chủ đề sáng/tối. Thay đổi được áp dụng ngay lập tức.",
    "settings.appearance": "Giao diện",
    "settings.accentPresets": "Cài đặt sẵn điểm nhấn",
    "settings.glassDensity": "Độ trong suốt",
    "settings.glassSubtle": "Nhẹ",
    "settings.glassDefault": "Mặc định",
    "settings.glassBold": "Đậm",
    "settings.cardRadius": "Bán kính bo góc",
    "settings.radiusCompact": "Gọn",
    "settings.radiusRounded": "Bo tròn",
    "settings.radiusPill": "Viên nang",
    "settings.vignette": "Vignette mép",
    "settings.appearanceHint": "Tùy chỉnh giao diện cho từng chủ đề sáng/tối. Các thay đổi điểm nhấn áp dụng ngay; độ trong suốt, bo góc và vignette được đưa vào bản sao lưu không gian làm việc.",
    "settings.resetThemeColor": "Đặt lại",
    "settings.generalTab": "Chung",
    "settings.promptsTab": "Prompt AI",
    "settings.assistantPrompt": "Prompt hệ thống của trợ lý",
    "settings.fullCardPrompt": "Prompt hệ thống cho toàn bộ thẻ",
    "settings.wizardPrompt": "Hướng dẫn tạo nhân vật",
    "settings.promptPlaceholder": "Để trống để dùng prompt có sẵn",
    "settings.chatSystemPrompts": "Hướng dẫn trò chuyện và hệ thống",
    "settings.fullCardInstr": "Hướng dẫn xuất toàn bộ thẻ (hệ thống)",
    "settings.fieldsEdit": "Hướng dẫn chỉnh sửa trường (hệ thống)",
    "settings.greetingsSystem": "Hướng dẫn xuất lời chào (hệ thống)",
    "settings.exportPrompts": "Xuất prompt",
    "settings.importPrompts": "Nhập prompt",
    "settings.promptsExported": "Đã xuất prompt",
    "settings.promptsImported": "Đã nhập {count} prompt",
    "settings.quickActionPrompts": "Lời nhắc hành động nhanh",
    "settings.tagsSystemPrompt": "Hướng dẫn xuất thẻ (hệ thống)",
    "settings.restoreDefaultPrompts": "Khôi phục prompt mặc định",
    "settings.promptHint": "Các trường này hiển thị prompt hiện tại. Nếu để trống, prompt mặc định có sẵn sẽ được dùng. Khôi phục mặc định để xem hoặc trả lại prompt gốc.",
    "settings.title": "Cài đặt",
    "settings.provider": "Nhà cung cấp",
    "settings.providerHint": "Nhà cung cấp mô hình lưu trữ hoặc điểm cuối tùy chỉnh (LM Studio, Ollama, v.v.)",
    "settings.apiKey": "Khóa API",
    "settings.getApiKey": "Lấy khóa API từ OpenRouter",
    "settings.baseUrl": "URL cơ sở API",
    "settings.namedApiKeyPlaceholder": "Nhập khóa API của bạn",
    "settings.customHint": "Điểm cuối tương thích OpenAI. Ví dụ: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "Khóa API (tùy chọn)",
    "settings.apiKeyLocalPlaceholder": "Để trống cho nhà cung cấp cục bộ",
    "settings.apiKeyLocalHint": "Không cần cho máy chủ cục bộ như LM Studio hoặc Ollama.",
    "settings.modelId": "ID mô hình",
    "settings.modelIdHint": "ID chính xác của mô hình mà nhà cung cấp của bạn yêu cầu.",
    "settings.modelIdHintNamed": "Để trống để dùng mô hình mặc định của nhà cung cấp.",
    "settings.security": "Khóa API của bạn được mã hóa khi lưu trong localStorage của trình duyệt bằng khóa gắn với địa chỉ này. Không sử dụng ứng dụng này trên thiết bị dùng chung.",
    "settings.secretUnreadable": "Vì lý do bảo mật, một khóa API đã lưu không thể được mở khóa tại địa chỉ này — vui lòng nhập lại khóa trong Cài đặt.",
    "error.pngInflateFailed": "PNG này chứa dữ liệu nhân vật không thể giải nén.",
    "settings.defaultModel": "Mô hình mặc định",
    "settings.browseModels": "Duyệt mô hình bên dưới...",
    "settings.refreshModels": "Làm mới mô hình",
    "settings.maxTokens": "Token đầu ra tối đa",
    "settings.maxTokensPlaceholder": "0 = dùng mặc định của mô hình",
    "settings.maxTokensHint": "Ghi đè số token đầu ra tối đa cho mỗi yêu cầu. Đặt 0 để tự động dùng giới hạn của mô hình đã chọn (hoặc 64k nếu không biết).",
    "settings.copyright": "Chèn ghi chú của trình soạn thảo khi xuất",
    "settings.copyrightHint": "Thêm một dòng ghi công vào ghi chú của người tạo khi xuất thẻ.",
    "settings.availableModels": "Mô hình khả dụng",
    "settings.searchModels": "Tìm mô hình...",
    "settings.enterApiKey": "Nhập khóa API và làm mới để tải mô hình",
    "settings.credits": "Tín dụng và mức sử dụng",
    "settings.creditLimit": "Hạn mức tín dụng",
    "settings.remaining": "Còn lại",
    "settings.usedMonth": "Đã dùng tháng này",
    "settings.localStorage": "Bộ nhớ cục bộ",
    "settings.clearAll": "Xóa toàn bộ dữ liệu",
    "settings.export": "Xuất",
    "settings.import": "Nhập",
    "settings.close": "Đóng",
    "settings.saveSettings": "Lưu cài đặt",
    "settings.languageLabel": "Ngôn ngữ",
    "settings.languageHint": "Ngôn ngữ giao diện (tải lại trang nếu thiếu)",
    "settings.languageChanged": "Đã cập nhật ngôn ngữ",
    "settings.clearConfirm": "Xóa TẤT CẢ thẻ, cài đặt và lịch sử trò chuyện? Hành động này không thể hoàn tác.",
    "settings.providerCustom": "Tùy chỉnh (tương thích OpenAI)",
    "settings.noModels": "Không tìm thấy mô hình",
    "settings.loadMore": "Tải thêm (còn {{count}} mô hình)",
    "settings.showingModels": "Hiển thị {{shown}} trong {{total}} mô hình",
    "wizard.title": "Tạo nhân vật",
    "wizard.step.basics": "Cơ bản",
    "wizard.step.concept": "Ý tưởng",
    "wizard.step.personality": "Tính cách",
    "wizard.step.scenario": "Bối cảnh",
    "wizard.step.generate": "Tạo",
    "wizard.basicsTitle": "Thông tin cơ bản của nhân vật",
    "wizard.nameLabel": "Tên nhân vật",
    "wizard.namePlaceholder": "vd. Elara Nightwhisper",
    "wizard.genderLabel": "Giới tính / Đại từ",
    "wizard.genderSelect": "Chọn...",
    "wizard.gender.female": "Nữ (cô ấy)",
    "wizard.gender.male": "Nam (anh ấy)",
    "wizard.gender.nonbinary": "Phi nhị nguyên (họ)",
    "wizard.gender.other": "Khác...",
    "wizard.genderCustom": "Đại từ tùy chỉnh (vd. nó)",
    "wizard.tagsLabel": "Thẻ",
    "wizard.tagsSub": "(phân cách bằng dấu phẩy, giúp sắp xếp thư viện của bạn)",
    "wizard.tagsPlaceholder": "kỳ ảo, chiến binh, yêu tinh, nguyên bản",
    "wizard.creatorLabel": "Người tạo",
    "wizard.creatorPlaceholder": "Tên / biệt danh của bạn",
    "wizard.conceptTitle": "Ý tưởng và bối cảnh",
    "wizard.typeLabel": "Loại nhân vật",
    "wizard.type.original": "Nhân vật nguyên bản",
    "wizard.type.fanfic": "Fan fiction",
    "wizard.type.game": "Nhân vật trò chơi",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Sách / Phim / Chương trình",
    "wizard.type.historical": "Nhân vật lịch sử",
    "wizard.type.mythological": "Thần thoại / Văn hóa dân gian",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Khác",
    "wizard.languageLabel": "Ngôn ngữ",
    "wizard.language.other": "Khác",
    "wizard.languageSpecify": "Chỉ định ngôn ngữ",
    "wizard.genreLabel": "Thể loại / Thế giới",
    "wizard.genreSub": "(chọn tất cả những mục phù hợp)",
    "wizard.moodLabel": "Tâm trạng / Giọng điệu",
    "wizard.moodSub": "(chọn tất cả những mục phù hợp)",
    "wizard.personalityTitle": "Tính cách và ngoại hình",
    "wizard.personalityTraits": "Nét tính cách",
    "wizard.personalityTraitsSub": "(mô tả 3-5 nét chính, điều này giúp ích cho AI)",
    "wizard.personalityTraitsPlaceholder": "vd. Dũng cảm nhưng liều lĩnh, cực kỳ trung thành với bạn bè, có khiếu hài hước khô khan, khó tin người, thầm yêu động vật",
    "wizard.appearanceLabel": "Ngoại hình",
    "wizard.appearanceSub": "(mô tả ngắn về diện mạo của họ)",
    "wizard.appearancePlaceholder": "vd. Người phụ nữ cao ráo với mái tóc bạc dài đến thắt lưng, bàn tay chằng chịt sẹo, mặc áo khoác da tối màu, đôi mắt xanh lục sắc bén",
    "wizard.abilitiesLabel": "Khả năng đặc biệt / Điều kỳ lạ",
    "wizard.abilitiesSub": "(tùy chọn, mọi nét độc đáo)",
    "wizard.abilitiesPlaceholder": "vd. Có thể nói chuyện với động vật, có trí nhớ chụp ảnh, luôn mang theo một cuốn nhật ký cũ sờn",
    "wizard.scenarioTitle": "Bối cảnh và tin nhắn đầu tiên",
    "wizard.scenarioLabel": "Bối cảnh / Khung cảnh",
    "wizard.scenarioSub": "(câu chuyện bắt đầu ở đâu?)",
    "wizard.scenarioPlaceholder": "vd. Một đêm mưa trong thành phố đầy ánh đèn neon. Nhân vật điều hành một tiệm sửa chữa nhỏ chuyên sửa cả máy móc lẫn những trái tim tan vỡ.",
    "wizard.relationshipLabel": "Mối quan hệ với {{user}}",
    "wizard.relationshipSub": "(nhân vật nhìn nhận người dùng như thế nào?)",
    "wizard.relationshipPlaceholder": "vd. Một khách hàng mới bước vào tiệm với một thiết bị hỏng bí ẩn. Nhân vật tò mò nhưng thận trọng.",
    "wizard.openingLabel": "Cảm giác của tin nhắn đầu tiên",
    "wizard.openingSub": "(tin nhắn mở đầu nên mang lại cảm giác gì?)",
    "wizard.notesLabel": "Ghi chú bổ sung",
    "wizard.notesSub": "(còn điều gì khác AI nên biết không?)",
    "wizard.notesPlaceholder": "vd. Giữ hội thoại tự nhiên, tránh quá trang trọng, thêm mô tả hành động trong dấu hoa thị",
    "wizard.generateTitle": "Tạo nhân vật",
    "wizard.refImage": "Ảnh tham khảo",
    "wizard.refImageSub": "(tùy chọn, từ waifu.im)",
    "wizard.fetchImages": "Lấy 3 ảnh",
    "wizard.refetchOthers": "Lấy ảnh khác",
    "wizard.fetching": "Đang tải...",
    "wizard.useSelected": "Dùng ảnh đã chọn",
    "wizard.clear": "Xóa",
    "wizard.generateAI": "Tạo bằng AI",
    "wizard.generateAISub": "Thẻ nhân vật đầy đủ từ câu trả lời của bạn",
    "wizard.createBlank": "Tạo thẻ trống",
    "wizard.createBlankSub": "Bắt đầu với tên và thẻ đã điền sẵn",
    "wizard.back": "Quay lại",
    "wizard.next": "Tiếp theo",
    "wizard.stepLabel": "Bước {{step}} trên {{total}}",
    "wizard.ready": "Sẵn sàng tạo!",
    "wizard.nameRequired": "Vui lòng nhập tên nhân vật",
    "wizard.summary.name": "Tên",
    "wizard.summary.gender": "Giới tính",
    "wizard.summary.type": "Loại",
    "wizard.summary.language": "Ngôn ngữ",
    "wizard.summary.tags": "Thẻ",
    "wizard.summary.genres": "Thể loại",
    "wizard.summary.mood": "Tâm trạng",
    "wizard.summary.opening": "Mở đầu",
    "wizard.summary.personality": "Tính cách",
    "wizard.summary.appearance": "Ngoại hình",
    "wizard.summary.scenario": "Bối cảnh",
    "wizard.summary.relationship": "Mối quan hệ",
    "wizard.summary.notes": "Ghi chú",
    "wizard.chip.fantasy": "Kỳ ảo",
    "wizard.chip.scifi": "Khoa học viễn tưởng",
    "wizard.chip.modern": "Hiện đại",
    "wizard.chip.historical": "Lịch sử",
    "wizard.chip.horror": "Kinh dị",
    "wizard.chip.romance": "Lãng mạn",
    "wizard.chip.comedy": "Hài hước",
    "wizard.chip.sliceOfLife": "Đời thường",
    "wizard.chip.adventure": "Phiêu lưu",
    "wizard.chip.mystery": "Bí ẩn",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Hậu tận thế",
    "wizard.chip.supernatural": "Siêu nhiên",
    "wizard.chip.military": "Quân sự",
    "wizard.chip.surreal": "Siêu thực",
    "wizard.chip.serious": "Nghiêm túc",
    "wizard.chip.playful": "Vui tươi",
    "wizard.chip.dark": "Tăm tối",
    "wizard.chip.lighthearted": "Nhẹ nhàng",
    "wizard.chip.mysterious": "Bí ẩn",
    "wizard.chip.romantic": "Lãng mạn",
    "wizard.chip.intense": "Mãnh liệt",
    "wizard.chip.wholesome": "Ấm áp trong sáng",
    "wizard.chip.chaotic": "Hỗn loạn",
    "wizard.chip.melancholic": "U sầu",
    "wizard.chip.sarcastic": "Châm biếm",
    "wizard.chip.stoic": "Khắc kỷ",
    "wizard.chip.greeting": "Lời chào nồng ấm",
    "wizard.chip.action": "Giữa dòng sự kiện",
    "wizard.chip.question": "Câu hỏi tò mò",
    "wizard.chip.conflict": "Xung đột tức thì",
    "wizard.chip.atmospheric": "Đậm chất không khí",
    "wizard.editStep": "Chỉnh sửa phần này",
    "wizard.draftRestored": "Đã khôi phục bản nháp — câu trả lời trước của bạn đã trở lại",
    "wizard.imagePlaceholder": "Bấm Lấy ảnh",
    "diff.title": "Xem trước phản hồi AI",
    "diff.removed": "Đã xóa",
    "diff.added": "Đã thêm",
    "diff.current": "Hiện tại",
    "diff.proposed": "Đề xuất",
    "diff.empty": "(trống)",
    "diff.discard": "Hủy bỏ",
    "diff.apply": "Áp dụng thay đổi",
    "shortcuts.title": "Phím tắt",
    "shortcuts.save": "Lưu thẻ",
    "shortcuts.newCard": "Thẻ mới",
    "shortcuts.undo": "Hoàn tác",
    "shortcuts.redo": "Làm lại",
    "shortcuts.sendAi": "Gửi tin nhắn AI",
    "shortcuts.newLine": "Dòng mới trong AI",
    "shortcuts.focus": "Chế độ tập trung",
    "shortcuts.collapsePanel": "Thu gọn/mở rộng bảng AI",
    "toast.loadFailed": "Thất bại: {{name}}",
    "toast.loaded": "Đã tải {{count}} thẻ",
    "toast.importDupe": "Nội dung giống một thẻ hiện có — đã nhập dưới tên {{name}}",
    "toast.largeImage": "Hình ảnh lớn được nhúng trong {{name}} ({{size}} MB) - hãy cân nhắc xóa nó để tiết kiệm dung lượng.",
    "toast.noValid": "Không tìm thấy thẻ hợp lệ. Thả tệp PNG hoặc JSON.",
    "toast.noSelected": "Chưa chọn thẻ nào",
    "toast.cardsDeleted": "Đã xóa thẻ",
    "toast.deleteFailed": "Không thể xóa thẻ",
    "toast.exported": "Đã xuất {{count}} thẻ",
    "toast.newBlank": "Đã tạo thẻ trống mới",
    "toast.noCardSave": "Không có thẻ để lưu",
    "toast.cardSaved": "Đã lưu thẻ!",
    "toast.noCardDup": "Không có thẻ để nhân bản",
    "toast.cardDup": "Đã nhân bản thẻ",
    "toast.cardRestored": "Đã khôi phục thẻ",
    "toast.selectCard": "Trước tiên hãy chọn một thẻ",
    "toast.avatarUpdated": "Đã cập nhật hình đại diện",
    "toast.imgFailed": "Không thể tải ảnh",
    "toast.firstMesUpdated": "Đã cập nhật tin nhắn đầu tiên!",
    "toast.settingsSaved": "Đã lưu cài đặt!",
    "toast.modelsFailed": "Không thể tải mô hình: {{error}}",
    "toast.modelSet": "Đã đặt mô hình: {{model}}",
    "toast.dataCleared": "Đã xóa toàn bộ dữ liệu",
    "toast.settingsExported": "Đã xuất cài đặt",
    "toast.settingsImported": "Đã nhập cài đặt!",
    "toast.invalidFile": "Tệp cài đặt không hợp lệ",
    "toast.apiKey": "Đặt khóa API của bạn trong Cài đặt",
    "toast.selectModel": "Vui lòng chọn một mô hình từ thanh điều hướng hoặc cài đặt trước.",
    "toast.genStopped": "Đã dừng tạo.",
    "toast.aiError": "Lỗi AI: {{error}}",
    "toast.cardUpdatedAI": "Đã cập nhật thẻ từ phản hồi AI!",
    "toast.jsonParseFailed": "Không thể phân tích phản hồi AI dưới dạng JSON. Kiểm tra cuộc trò chuyện.",
    "toast.emptyResponse": "AI trả về nội dung trống — không có gì để áp dụng.",
    "toast.jsonInvalid": "AI không trả về JSON hợp lệ. Phản hồi nằm trong cuộc trò chuyện — bạn có thể sao chép thủ công.",
    "toast.fieldUpdated": 'Đã cập nhật "{{field}}"!',
    "toast.greetingsUpdated": "Đã tạo {{count}} lời chào!",
    "toast.tagsUpdated": "Đã cập nhật thẻ — thêm {{count}} thẻ mới!",
    "toast.greetingsParseFailed": "Không thể phân tích lời chào từ phản hồi AI.",
    "toast.createCardFirst": "Trước tiên hãy tạo hoặc chọn một thẻ",
    "toast.wizardCreated": "Đã tạo thẻ! Bắt đầu chỉnh sửa hoặc dùng AI để điền chi tiết.",
    "toast.wizardApi": "Trước tiên hãy đặt khóa API trong Cài đặt",
    "toast.wizardModel": "Chọn một mô hình hoặc đặt ID mô hình tùy chỉnh trong Cài đặt",
    "toast.wizardFetchFailed": "Không thể lấy ảnh: {{error}}",
    "toast.wizardName": "Vui lòng nhập tên nhân vật",
    "toast.storageFull": "Bộ nhớ đầy! Hãy thử xóa một số thẻ hoặc xuất chúng.",
    "toast.exportedJson": "Đã xuất dưới dạng JSON!",
    "toast.exportedPng": "Đã xuất dưới dạng PNG kèm dữ liệu thẻ!",
    "toast.exportFailed": "Xuất ảnh thất bại. Chuyển sang JSON.",
    "toast.noNameWarning": 'Cảnh báo: Thẻ không có tên. Tệp sẽ được lưu là "character.json".',
    "toast.chatCleared": "Đã xóa trò chuyện",
    "toast.selectField": "Chọn ít nhất một trường để chỉnh sửa",
    "toast.tooManyFields": "Chọn quá nhiều trường. Tối đa {{max}} mỗi lần.",
    "toast.undo": "Hoàn tác",
    "toast.redo": "Làm lại",
    "toast.reorderFiltered": "Tắt tìm kiếm và bộ lọc để sắp xếp lại thẻ.",
    "error.apiKeyNotSet": "Chưa đặt khóa API. Nhập khóa API của bạn trong Cài đặt.",
    "error.customUrlNotSet": "URL cơ sở của API tùy chỉnh chưa được đặt. Mở Cài đặt → Tùy chỉnh (tương thích OpenAI) và nhập URL điểm cuối (ví dụ: http://localhost:1234/v1).",
    "error.customServerError": "Máy chủ đã trả về lỗi: {{detail}}",
    "error.customAuthFailed": "Xác thực thất bại (HTTP {{status}}). Kiểm tra khóa API cho điểm cuối này.",
    "error.customPathNotFound": "Không tìm thấy điểm cuối (HTTP 404). Kiểm tra URL cơ sở của API đã đầy đủ chưa (ví dụ: bao gồm /v1).",
    "error.customUnreachable": "Không thể truy cập {{url}}. Kiểm tra máy chủ đang chạy và URL cơ sở của API đúng và truy cập được từ thiết bị này.",
    "error.noModel": "Chưa chọn mô hình. Vui lòng chọn một mô hình hoặc đặt ID mô hình trong Cài đặt.",
    "error.noModelSimple": "Chưa chọn mô hình.",
    "error.insufficientCredits": "Không đủ tín dụng. Vui lòng nạp thêm vào tài khoản của bạn.",
    "error.storageFull": "Bộ nhớ đầy! Hãy thử xóa một số thẻ hoặc xuất chúng.",
    "gen.empty": "(trống)",
    "gen.free": "Miễn phí",
    "gen.unlimited": "Không giới hạn",
    "gen.notAvailable": "N/A",
    "gen.unnamed": "Chưa đặt tên",
    "gen.byCreator": "bởi {{name}}",
    "gen.copySuffix": " (Bản sao)",
    "gen.toastAutoHide": "Tự ẩn sau {{s}}s",
    "gen.untagged": "Không tìm thấy thẻ",
    "gen.noMatch": "Không có thẻ nào khớp với bộ lọc của bạn",
    "batch.deleteConfirm": "Xóa {{count}} thẻ? Hành động này không thể hoàn tác.",
    "left.selected": "Đã chọn {{count}}",
    "toast.cardDeleted": 'Đã xóa thẻ "{{name}}"',
    "ai.apply": "Áp dụng",
    "ai.applyTitle": "Áp dụng các thay đổi này vào thẻ",
    "ai.errorPrefix": "Lỗi: ",
    "ai.translatePrompt": "Dịch sang ngôn ngữ nào?",
    "ai.translateDefaultLang": "Tiếng Pháp",
    "ai.tonePrompt": "Giọng điệu nào? (vd. trang trọng, thân mật, u tối, hài hước, trữ tình)",
    "ai.toneDefault": "trang trọng",
    "ai.chatSession": "Phiên trò chuyện",
    "ai.msgs": "{{count}} tin",
    "ai.tokensIn": " vào · ",
    "ai.tokensOut": " ra · ",
    "ai.tokensCtx": " ngữ cảnh",
    "ai.exceedsLimit": " ⚠ Vượt giới hạn!",
    "ai.approachingLimit": " ⚠ Sắp đạt giới hạn",
    "ai.count": "Đếm:",
    "ai.resizeAria": "Thay đổi kích thước trợ lý AI",
    "ai.chatMessagesAria": "Tin nhắn trò chuyện AI",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Đoạn hội thoại ví dụ ở đây...
{{user}}: Phản hồi của người dùng...
<START>
{{char}}: Một ví dụ khác...`,
    "batch.select2ForCompare": "Chọn chính xác 2 thẻ để so sánh",
    "batch.compareLoadFailed": "Không thể tải thẻ để so sánh",
    "batch.comparePrefix": "So sánh: ",
    "batch.compareVs": " với ",
    "batch.cardA": "Thẻ A",
    "batch.cardB": "Thẻ B",
    "editor.charCount": "{{chars}} ký tự ~{{tokens}} token",
    "editor.counterWarn": "Sắp chạm giới hạn token đầu ra ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Vượt quá giới hạn token đầu ra ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Di chuyển lên",
    "editor.greetingMoveDown": "Di chuyển xuống",
    "editor.greetingIsDefault": "Đây là tin nhắn đầu tiên hiện tại",
    "editor.greetingSetDefault": "Đặt làm tin nhắn đầu tiên",
    "editor.greetingRemove": "Xóa",
    "editor.greetingPlaceholder": "Lời chào {{num}}...",
    "editor.loreEntry": "Mục {{num}}",
    "editor.loreDeleteEntry": "Xóa mục",
    "editor.lorePrimaryKeys": "Từ khóa chính",
    "editor.lorePrimaryKeysPlaceholder": "Từ khóa chính — phân cách bằng dấu phẩy",
    "editor.loreSecondaryKeys": "Từ khóa phụ",
    "editor.loreSecondaryKeysPlaceholder": "Từ khóa phụ",
    "editor.loreComment": "Bình luận",
    "editor.loreCommentPlaceholder": "Bình luận",
    "editor.loreOrder": "Thứ tự",
    "editor.loreOrderPlaceholder": "Thứ tự",
    "editor.loreConstant": "Hằng số",
    "editor.loreSelective": "Chọn lọc",
    "editor.loreBeforeChar": "Trước nhân vật",
    "editor.loreAfterChar": "Sau nhân vật",
    "editor.loreContent": "Nội dung",
    "editor.loreContentPlaceholder": "Nội dung mục...",
    "editor.loreNewEntry": "Mục mới",
    "error.unknown": "Lỗi không xác định",
    "error.unexpected": "Lỗi không mong muốn: {{message}}",
    "error.requestFailed": "Yêu cầu thất bại: {{message}}",
    "error.unsupportedFile": "Loại tệp không được hỗ trợ: .{{ext}}",
    "error.invalidJson": "JSON không hợp lệ: {{message}}",
    "error.notPng": "Không phải tệp PNG hợp lệ",
    "error.unknownFormat": "Định dạng thẻ không xác định — không phải thẻ nhân vật SillyTavern",
    "error.fetchModelsFailed": "Không thể lấy mô hình (HTTP {{status}})",
    "error.noChoices": "API không trả về lựa chọn phản hồi nào",
    "error.emptyResponse": "Phản hồi trống từ API (không có nội dung)",
    "gen.newCharacter": "Nhân vật mới",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Sao lưu",
    "settings.restore": "Khôi phục",
    "settings.backupTitle": "Sao lưu tất cả thẻ",
    "settings.restoreTitle": "Khôi phục bản sao lưu",
    "settings.exportTitle": "Xuất cài đặt",
    "settings.importTitle": "Nhập cài đặt",
    "settings.modelAuto": "Tự động",
    "settings.modelIdPlaceholder": "vd. deepseek-v4-flash",
    "settings.customModelPlaceholder": "vd. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "vd. {{provider}}-latest",
    "settings.getApiKeyFrom": "Lấy khóa API từ ",
    "settings.customModelDesc": "Mô hình tùy chỉnh",
    "settings.workspaceExported": "Đã xuất không gian làm việc ({{count}} thẻ)",
    "settings.invalidWorkspace": "Định dạng không gian làm việc không hợp lệ",
    "settings.workspaceImported": "Đã nhập không gian làm việc ({{count}} thẻ)",
    "settings.workspaceImportFailed": "Không thể nhập không gian làm việc: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Bật/tắt trợ lý AI",
    "nav.toggleAIAria": "Bật/tắt trợ lý AI",
    "nav.notificationsAria": "Thông báo",
    "left.sortCards": "Sắp xếp thẻ",
    "left.compareSelected": "So sánh thẻ đã chọn",
    "left.resizeAria": "Thay đổi kích thước thư viện thẻ",
    "left.cardListAria": "Thư viện thẻ",
    "ui.saved": " Đã lưu",
    "ui.collapsePanel": "Thu gọn bảng",
    "ui.expandPanel": "Mở rộng bảng",
    "ui.cardModified": "Các thay đổi chưa lưu",
    "export.minimalPngLabel": "Thẻ ST",
    "wizard.search": "Tìm kiếm",
    "wizard.quick": "Nhanh:",
    "wizard.imageSearchPlaceholder": "Tìm thẻ: mèo, váy, đồng phục, cyberpunk...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.id = {
    "app.title": "ST Card Editor — Studio kartu karakter SillyTavern",
    "nav.selectModel": "Pilih model...",
    "nav.wizard": "Buat dengan wizard AI",
    "nav.newCard": "Kartu kosong baru",
    "nav.save": "Simpan",
    "nav.theme": "Ganti tema",
    "nav.shortcuts": "Pintasan & bantuan",
    "nav.settings": "Pengaturan",
    "nav.focus": "Mode fokus",
    "nav.focusAlt": "Mode fokus (Alt+F)",
    "left.title": "Perpustakaan Kartu",
    "left.cards": "{{count}} kartu",
    "left.drop": "Seret dan lepas",
    "left.sort.manual": "Manual",
    "left.dropSub": "Kartu karakter PNG atau JSON",
    "left.browse": "Jelajahi file",
    "left.search": "Cari kartu...",
    "left.sort.nameAsc": "Nama A-Z",
    "left.sort.nameDesc": "Nama Z-A",
    "left.sort.newest": "Terbaru dulu",
    "left.sort.oldest": "Terlama dulu",
    "left.sort.largest": "Terbesar",
    "left.sort.smallest": "Terkecil",
    "left.filterTags": "Filter berdasarkan tag",
    "left.exportSelected": "Ekspor yang dipilih sebagai JSON",
    "left.deleteSelected": "Hapus yang dipilih",
    "left.empty": "Belum ada kartu dimuat",
    "left.emptySub": "Letakkan kartu atau klik Jelajahi",
    "center.noCard": "Belum ada kartu dipilih",
    "center.noCardSub": "Pilih kartu dari perpustakaan atau seret lepas kartu baru",
    "center.createAI": "Buat dengan AI",
    "center.blankCard": "Kartu Kosong",
    "editor.avatar": "Klik atau letakkan gambar untuk mengatur avatar",
    "editor.avatarAria": "Atur avatar karakter",
    "editor.name": "Nama Karakter",
    "editor.exportJson": "Ekspor sebagai JSON",
    "editor.exportPng": "Ekspor sebagai PNG",
    "editor.duplicate": "Duplikat kartu",
    "editor.delete": "Hapus kartu",
    "editor.tab.core": "Inti",
    "editor.tab.personality": "Kepribadian",
    "editor.tab.advanced": "Lanjutan",
    "editor.tab.lorebook": "Lorebook",
    "editor.tab.waifu": "Gambar Waifu",
    "editor.waifuPreview": "Gambar kartu saat ini",
    "editor.waifuNoImage": "Belum ada gambar",
    "editor.waifuSource": "Sumber gambar",
    "editor.waifuSourceSnap": "Cuplikan anime (waifu.im)",
    "editor.waifuSourceChar": "Karakter anime (AniList)",
    "editor.waifuGender": "Jenis kelamin",
    "editor.waifuGenderAll": "Semua",
    "editor.waifuGenderFemaleOnly": "Hanya perempuan",
    "editor.waifuGenderMaleOnly": "Hanya laki-laki",
    "editor.waifuGenderFemale": "Perempuan",
    "editor.waifuGenderMale": "Laki-laki",
    "editor.waifuCharSub": "cari karakter berdasarkan nama (mis. zoro)",
    "editor.waifuSearch": "Cari di waifu.im",
    "editor.waifuSearchChar": "Cari karakter",
    "editor.waifuSearchPlaceholderChar": "cari karakter berdasarkan nama (mis. zoro)",
    "editor.waifuSub": "(mengambil gambar gaya anime berdasarkan tag)",
    "editor.waifuSearchPlaceholder": "mis. waifu, elf, pelayan...",
    "editor.waifuFetch": "Ambil gambar",
    "editor.waifuRegenTitle": "Hasilkan ulang hasil",
    "editor.waifuMixed": "Perempuan + Laki-laki",
    "editor.waifuMixedSub": "paket seimbang sekali klik: 3 karakter perempuan + 3 laki-laki",
    "editor.waifuUse": "Gunakan sebagai gambar kartu",
    "editor.waifuUpload": "Unggah dari perangkat",
    "editor.waifuRemove": "Hapus gambar",
    "toast.noImage": "Kartu ini tidak memiliki gambar untuk dihapus",
    "toast.imageRemoved": "Gambar dihapus",
    "editor.desc": "Deskripsi",
    "editor.descSub": "(penampilan, latar belakang)",
    "editor.descPlaceholder": "Deskripsikan penampilan, latar belakang, dan sifat utama karakter...",
    "editor.firstMes": "Pesan Pertama",
    "editor.firstMesPlaceholder": "Pesan pertama karakter saat memulai obrolan...",
    "editor.scenario": "Skenario",
    "editor.scenarioPlaceholder": "Keadaan dan konteks percakapan saat ini...",
    "editor.creator": "Pembuat",
    "editor.creatorPlaceholder": "Pembuat / penulis kartu",
    "editor.version": "Versi Karakter",
    "editor.tags": "Tag",
    "editor.tagsSub": "(dipisahkan koma)",
    "editor.tagsPlaceholder": "fantasi, prajurit, elf",
    "editor.personalitySummary": "Ringkasan Kepribadian",
    "editor.personalityPlaceholder": "Deskripsi singkat tentang kepribadian karakter... (digunakan dalam format kartu karakter)",
    "editor.mesExample": "Pesan Contoh",
    "editor.mesExampleFormat": "Format: blok <START> dengan awalan {{char}}: dan {{user}}:",
    "editor.systemPrompt": "Prompt Sistem",
    "editor.systemPromptPlaceholder": "Ganti prompt sistem. Gunakan {{original}} untuk menyertakan yang default.",
    "editor.postHistory": "Instruksi Pasca-Riwayat",
    "editor.postHistoryPlaceholder": "Instruksi yang disisipkan setelah riwayat obrolan. Gunakan {{original}} untuk default.",
    "editor.creatorNotes": "Catatan Pembuat",
    "editor.creatorNotesPlaceholder": "Catatan untuk pengguna kartu (rekomendasi model, tips penggunaan...)",
    "editor.greetings": "Sapaan Alternatif",
    "editor.addGreeting": "Tambah Sapaan",
    "editor.lorebookTitle": "Entri Lorebook Karakter",
    "editor.addEntry": "Tambah Entri",
    "editor.lorebookSearch": "Cari entri berdasarkan kunci, isi, atau komentar...",
    "editor.lorebookEmpty": "Belum ada entri lorebook. Tambahkan satu untuk memulai.",
    "editor.noGreetings": "Belum ada sapaan. Klik <strong>Tambah Sapaan</strong> atau gunakan AI untuk membuatnya.",
    "editor.noEntriesMatch": 'Tidak ada entri yang cocok dengan "{{query}}"',
    "editor.edit": "Edit",
    "editor.preview": "Pratinjau",
    "ai.title": "Asisten AI",
    "ai.clearChat": "Bersihkan obrolan",
    "ai.welcomeTitle": "Asisten Kartu AI",
    "ai.welcomeText": "Minta AI untuk mengedit, menerjemahkan, atau meningkatkan kartu karakter Anda.",
    "ai.quick.newCard": "Kartu Baru",
    "ai.quick.translate": "Terjemahkan",
    "ai.quick.enhance": "Tingkatkan",
    "ai.quick.shorten": "Perpendek",
    "ai.quick.tone": "Ubah Nada",
    "ai.quick.grammar": "Perbaiki Tata Bahasa",
    "ai.quick.personality": "Perluas Kepribadian",
    "ai.quick.firstmes": "Perbaiki Pesan Pertama",
    "ai.quick.scenario": "Perluas Skenario",
    "ai.quick.greetings": "Buat Sapaan",
    "ai.quick.systemprompt": "Tingkatkan Prompt Sistem",
    "ai.quick.tags": "Sarankan tag",
    "ai.contextTitle": "Perkiraan token terpakai vs. batas konteks model",
    "ai.contextLabel": "— / — token",
    "ai.placeholder": "Minta AI untuk mengedit kartu...",
    "ai.send": "Kirim",
    "ai.stop": "Hentikan pembuatan",
    "ai.autoModel": "Pilih model...",
    "ai.target": "Target:",
    "ai.target.full": "Kartu Lengkap",
    "ai.target.description": "Deskripsi",
    "ai.target.personality": "Kepribadian",
    "ai.target.first_mes": "Pesan Pertama",
    "ai.target.scenario": "Skenario",
    "ai.target.mes_example": "Pesan Contoh",
    "ai.target.system_prompt": "Prompt Sistem",
    "ai.target.post_history_instructions": "Instruksi Pasca-Riwayat",
    "ai.target.creator_notes": "Catatan Pembuat",
    "ai.target.alternate_greetings": "Sapaan Alternatif",
    "ai.selectModel": "Pilih model",
    "ai.actionNewCard": "Kartu Baru",
    "ai.actionTranslate": "Terjemahkan",
    "ai.actionEnhance": "Tingkatkan",
    "ai.actionShorten": "Perpendek",
    "ai.actionTone": "Ubah Nada",
    "ai.actionGrammar": "Perbaiki Tata Bahasa",
    "ai.actionPersonality": "Perluas Kepribadian",
    "ai.actionFirstMes": "Perbaiki Pesan Pertama",
    "ai.actionScenario": "Perluas Skenario",
    "ai.actionGreetings": "Buat Sapaan",
    "ai.actionSystemprompt": "Tingkatkan Prompt Sistem",
    "ai.actionTags": "Sarankan tag",
    "ai.chatHistory": "Riwayat obrolan",
    "ai.historyTitle": "Riwayat Obrolan",
    "ai.historyEmpty": "Belum ada percakapan",
    "ai.retry": "Coba lagi",
    "ai.retryTitle": "Hasilkan ulang respons ini",
    "ai.reapply": "Terapkan ulang",
    "ai.reapplyTitle": "Buka kembali diff untuk menerapkan perubahan ini",
    "ai.noCard": "(belum ada kartu dipilih)",
    "ai.editing": "Mengedit {{count}} kolom...",
    "ai.streaming": "menstreaming...",
    "ai.failed": "gagal",
    "ai.cancelled": "Dibatalkan.",
    "ai.doneSummary": "{{done}}/{{total}} selesai · {{errs}} gagal",
    "ai.viewFullResult": "Lihat hasil lengkap",
    "ai.showLess": "Tampilkan lebih sedikit",
    "ai.reviewApply": "Tinjau & Terapkan",
    "ai.changesNav": "Perubahan {{current}} dari {{total}}",
    "ai.changesPrev": "Perubahan sebelumnya",
    "ai.changesNext": "Perubahan berikutnya",
    "ai.applied": "Diterapkan",
    "ai.target.tags": "Tag",
    "ai.copy": "Salin",
    "ai.copied": "Tersalin!",
    "ai.copyFailed": "Gagal",
    "ai.resultTitle": "Hasil",
    "ai.close": "Tutup",
    "settings.themeColor": "Warna tema",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "Pilih warna aksen terpisah untuk tema terang/gelap. Perubahan langsung diterapkan.",
    "settings.appearance": "Tampilan",
    "settings.accentPresets": "Praset aksen",
    "settings.glassDensity": "Kepadatan kaca",
    "settings.glassSubtle": "Halus",
    "settings.glassDefault": "Bawaan",
    "settings.glassBold": "Berani",
    "settings.cardRadius": "Radius sudut kartu",
    "settings.radiusCompact": "Kompak",
    "settings.radiusRounded": "Membulat",
    "settings.radiusPill": "Pil",
    "settings.vignette": "Vignette tepi",
    "settings.appearanceHint": "Sesuaikan tampilan setiap tema terang/gelap. Perubahan aksen langsung diterapkan; kepadatan, radius, dan vignette disertakan dalam cadangan ruang kerja.",
    "settings.resetThemeColor": "Atur ulang",
    "settings.generalTab": "Umum",
    "settings.promptsTab": "Prompt AI",
    "settings.assistantPrompt": "Prompt sistem asisten",
    "settings.fullCardPrompt": "Prompt sistem kartu lengkap",
    "settings.wizardPrompt": "Instruksi pembuatan karakter",
    "settings.promptPlaceholder": "Biarkan kosong untuk memakai prompt bawaan",
    "settings.chatSystemPrompts": "Instruksi chat dan sistem",
    "settings.fullCardInstr": "Instruksi keluaran kartu lengkap (sistem)",
    "settings.fieldsEdit": "Instruksi pengeditan field (sistem)",
    "settings.greetingsSystem": "Instruksi keluaran sapaan (sistem)",
    "settings.exportPrompts": "Ekspor prompt",
    "settings.importPrompts": "Impor prompt",
    "settings.promptsExported": "Prompt diekspor",
    "settings.promptsImported": "{count} prompt diimpor",
    "settings.quickActionPrompts": "Prompt tindakan cepat",
    "settings.tagsSystemPrompt": "Instruksi keluaran tag (sistem)",
    "settings.restoreDefaultPrompts": "Pulihkan prompt bawaan",
    "settings.promptHint": "Kolom ini menampilkan prompt saat ini. Jika kosong, prompt bawaan default yang digunakan. Pulihkan default untuk melihat atau mengembalikan prompt asli.",
    "settings.title": "Pengaturan",
    "settings.provider": "Penyedia",
    "settings.providerHint": "Penyedia model terhosting atau endpoint kustom (LM Studio, Ollama, dll.)",
    "settings.apiKey": "Kunci API",
    "settings.getApiKey": "Dapatkan kunci API Anda dari OpenRouter",
    "settings.baseUrl": "URL Dasar API",
    "settings.namedApiKeyPlaceholder": "Masukkan kunci API Anda",
    "settings.customHint": "Endpoint yang kompatibel dengan OpenAI. Contoh: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "Kunci API (opsional)",
    "settings.apiKeyLocalPlaceholder": "Kosongkan untuk penyedia lokal",
    "settings.apiKeyLocalHint": "Tidak diperlukan untuk server lokal seperti LM Studio atau Ollama.",
    "settings.modelId": "ID Model",
    "settings.modelIdHint": "ID model persis yang diharapkan penyedia Anda.",
    "settings.modelIdHintNamed": "Kosongkan untuk menggunakan model default penyedia.",
    "settings.security": "Kunci API Anda dienkripsi saat disimpan di localStorage browser dengan kunci yang terikat ke alamat ini. Jangan gunakan aplikasi ini di perangkat bersama.",
    "settings.secretUnreadable": "Demi keamanan, kunci API yang tersimpan tidak dapat dibuka di alamat ini — silakan masukkan ulang di Pengaturan.",
    "error.pngInflateFailed": "PNG ini berisi data karakter yang tidak dapat didekompresi.",
    "settings.defaultModel": "Model Default",
    "settings.browseModels": "Jelajahi model di bawah ini...",
    "settings.refreshModels": "Segarkan Model",
    "settings.maxTokens": "Token Output Maks",
    "settings.maxTokensPlaceholder": "0 = gunakan default model",
    "settings.maxTokensHint": "Timpa jumlah maksimum token output per permintaan. Setel ke 0 untuk otomatis memakai batas model yang dipilih (atau 64k jika tidak diketahui).",
    "settings.copyright": "Sisipkan kredit editor saat mengekspor",
    "settings.copyrightHint": "Menambahkan baris kredit ke catatan pembuat saat mengekspor kartu.",
    "settings.availableModels": "Model Tersedia",
    "settings.searchModels": "Cari model...",
    "settings.enterApiKey": "Masukkan kunci API dan segarkan untuk memuat model",
    "settings.credits": "Kredit & Pemakaian",
    "settings.creditLimit": "Batas Kredit",
    "settings.remaining": "Sisa",
    "settings.usedMonth": "Terpakai Bulan Ini",
    "settings.localStorage": "Penyimpanan Lokal",
    "settings.clearAll": "Hapus Semua Data",
    "settings.export": "Ekspor",
    "settings.import": "Impor",
    "settings.close": "Tutup",
    "settings.saveSettings": "Simpan Pengaturan",
    "settings.languageLabel": "Bahasa",
    "settings.languageHint": "Bahasa antarmuka (muat ulang halaman jika tidak ada)",
    "settings.languageChanged": "Bahasa diperbarui",
    "settings.clearConfirm": "Hapus SEMUA kartu, pengaturan, dan riwayat obrolan? Tindakan ini tidak dapat dibatalkan.",
    "settings.providerCustom": "Kustom (kompatibel OpenAI)",
    "settings.noModels": "Tidak ada model ditemukan",
    "settings.loadMore": "Muat lebih banyak ({{count}} tersisa)",
    "settings.showingModels": "Menampilkan {{shown}} dari {{total}} model",
    "wizard.title": "Buat Karakter",
    "wizard.step.basics": "Dasar",
    "wizard.step.concept": "Konsep",
    "wizard.step.personality": "Kepribadian",
    "wizard.step.scenario": "Skenario",
    "wizard.step.generate": "Hasilkan",
    "wizard.basicsTitle": "Dasar Karakter",
    "wizard.nameLabel": "Nama Karakter",
    "wizard.namePlaceholder": "mis. Elara Nightwhisper",
    "wizard.genderLabel": "Gender / Pronomina",
    "wizard.genderSelect": "Pilih...",
    "wizard.gender.female": "Perempuan (dia)",
    "wizard.gender.male": "Laki-laki (dia)",
    "wizard.gender.nonbinary": "Non-biner (mereka)",
    "wizard.gender.other": "Lainnya...",
    "wizard.genderCustom": "Pronomina kustom (mis. itu)",
    "wizard.tagsLabel": "Tag",
    "wizard.tagsSub": "(dipisahkan koma, membantu mengatur perpustakaan)",
    "wizard.tagsPlaceholder": "fantasi, prajurit, elf, orisinal",
    "wizard.creatorLabel": "Pembuat",
    "wizard.creatorPlaceholder": "Nama / alias Anda",
    "wizard.conceptTitle": "Konsep & Latar",
    "wizard.typeLabel": "Jenis Karakter",
    "wizard.type.original": "Karakter Orisinal",
    "wizard.type.fanfic": "Fiksi Penggemar",
    "wizard.type.game": "Karakter Game",
    "wizard.type.anime": "Anime / Manga",
    "wizard.type.book": "Buku / Film / Acara",
    "wizard.type.historical": "Tokoh Sejarah",
    "wizard.type.mythological": "Mitologi / Cerita Rakyat",
    "wizard.type.vtuber": "VTuber / Streamer",
    "wizard.type.other": "Lainnya",
    "wizard.languageLabel": "Bahasa",
    "wizard.language.other": "Lainnya",
    "wizard.languageSpecify": "Tentukan bahasa",
    "wizard.genreLabel": "Genre / Dunia",
    "wizard.genreSub": "(pilih semua yang berlaku)",
    "wizard.moodLabel": "Suasana / Nada",
    "wizard.moodSub": "(pilih semua yang berlaku)",
    "wizard.personalityTitle": "Kepribadian & Penampilan",
    "wizard.personalityTraits": "Sifat Kepribadian",
    "wizard.personalityTraitsSub": "(deskripsikan 3-5 sifat utama, ini membantu AI)",
    "wizard.personalityTraitsPlaceholder": "mis. Berani tapi ceroboh, sangat setia pada teman, punya selera humor kering, sulit percaya, diam-diam mencintai hewan",
    "wizard.appearanceLabel": "Penampilan Fisik",
    "wizard.appearanceSub": "(deskripsi singkat tentang penampilan mereka)",
    "wizard.appearancePlaceholder": "mis. Wanita tinggi berambut perak sepinggang, tangan berluka, mengenakan jaket kulit gelap, mata hijau tajam",
    "wizard.abilitiesLabel": "Kemampuan Khusus / Keunikan",
    "wizard.abilitiesSub": "(opsional, sifat unik apa pun)",
    "wizard.abilitiesPlaceholder": "mis. Bisa bicara dengan hewan, punya memori fotografis, selalu membawa jurnal usang",
    "wizard.scenarioTitle": "Skenario & Pesan Pertama",
    "wizard.scenarioLabel": "Skenario / Latar",
    "wizard.scenarioSub": "(di mana cerita dimulai?)",
    "wizard.scenarioPlaceholder": "mis. Malam hujan di kota bercahaya neon. Karakter mengelola bengkel kecil yang memperbaiki mesin dan hati yang patah.",
    "wizard.relationshipLabel": "Hubungan dengan {{user}}",
    "wizard.relationshipSub": "(bagaimana karakter memandang pengguna?)",
    "wizard.relationshipPlaceholder": "mis. Pelanggan baru yang masuk ke bengkel dengan perangkat rusak misterius. Karakter penasaran tetapi waspada.",
    "wizard.openingLabel": "Nuansa Pesan Pertama",
    "wizard.openingSub": "(bagaimana pesan pembuka seharusnya terasa?)",
    "wizard.notesLabel": "Catatan Tambahan",
    "wizard.notesSub": "(hal lain yang perlu diketahui AI?)",
    "wizard.notesPlaceholder": "mis. Jaga dialog tetap alami, hindari terlalu formal, sertakan deskripsi aksi dalam tanda bintang",
    "wizard.generateTitle": "Hasilkan Karakter",
    "wizard.refImage": "Gambar Referensi",
    "wizard.refImageSub": "(opsional, dari waifu.im)",
    "wizard.fetchImages": "Ambil 3 Gambar",
    "wizard.refetchOthers": "Ambil Ulang Lainnya",
    "wizard.fetching": "Mengambil...",
    "wizard.useSelected": "Gunakan yang Dipilih",
    "wizard.clear": "Bersihkan",
    "wizard.generateAI": "Hasilkan dengan AI",
    "wizard.generateAISub": "Kartu karakter lengkap dari jawaban Anda",
    "wizard.createBlank": "Buat Kartu Kosong",
    "wizard.createBlankSub": "Mulai dengan nama dan tag terisi",
    "wizard.back": "Kembali",
    "wizard.next": "Berikutnya",
    "wizard.stepLabel": "Langkah {{step}} dari {{total}}",
    "wizard.ready": "Siap untuk membuat!",
    "wizard.nameRequired": "Silakan masukkan nama karakter",
    "wizard.summary.name": "Nama",
    "wizard.summary.gender": "Gender",
    "wizard.summary.type": "Jenis",
    "wizard.summary.language": "Bahasa",
    "wizard.summary.tags": "Tag",
    "wizard.summary.genres": "Genre",
    "wizard.summary.mood": "Suasana",
    "wizard.summary.opening": "Pembuka",
    "wizard.summary.personality": "Kepribadian",
    "wizard.summary.appearance": "Penampilan",
    "wizard.summary.scenario": "Skenario",
    "wizard.summary.relationship": "Hubungan",
    "wizard.summary.notes": "Catatan",
    "wizard.chip.fantasy": "Fantasi",
    "wizard.chip.scifi": "Fiksi Ilmiah",
    "wizard.chip.modern": "Modern",
    "wizard.chip.historical": "Sejarah",
    "wizard.chip.horror": "Horor",
    "wizard.chip.romance": "Romansa",
    "wizard.chip.comedy": "Komedi",
    "wizard.chip.sliceOfLife": "Kehidupan Sehari-hari",
    "wizard.chip.adventure": "Petualangan",
    "wizard.chip.mystery": "Misteri",
    "wizard.chip.cyberpunk": "Cyberpunk",
    "wizard.chip.postApocalyptic": "Pasca-Apokalips",
    "wizard.chip.supernatural": "Gaib",
    "wizard.chip.military": "Militer",
    "wizard.chip.surreal": "Sureal",
    "wizard.chip.serious": "Serius",
    "wizard.chip.playful": "Ceria",
    "wizard.chip.dark": "Gelap",
    "wizard.chip.lighthearted": "Ringan",
    "wizard.chip.mysterious": "Misterius",
    "wizard.chip.romantic": "Romantis",
    "wizard.chip.intense": "Intens",
    "wizard.chip.wholesome": "Hangat dan Positif",
    "wizard.chip.chaotic": "Kacau",
    "wizard.chip.melancholic": "Melankolis",
    "wizard.chip.sarcastic": "Sarkastis",
    "wizard.chip.stoic": "Stois",
    "wizard.chip.greeting": "Sapaan Hangat",
    "wizard.chip.action": "Di Tengah Peristiwa",
    "wizard.chip.question": "Pertanyaan Menarik",
    "wizard.chip.conflict": "Konflik Segera",
    "wizard.chip.atmospheric": "Atmosferik",
    "wizard.editStep": "Edit bagian ini",
    "wizard.draftRestored": "Draf dipulihkan — jawaban Anda sebelumnya kembali",
    "wizard.imagePlaceholder": "Klik Ambil",
    "diff.title": "Pratinjau Respons AI",
    "diff.removed": "Dihapus",
    "diff.added": "Ditambahkan",
    "diff.current": "Saat Ini",
    "diff.proposed": "Diusulkan",
    "diff.empty": "(kosong)",
    "diff.discard": "Buang",
    "diff.apply": "Terapkan Perubahan",
    "shortcuts.title": "Pintasan",
    "shortcuts.save": "Simpan kartu",
    "shortcuts.newCard": "Kartu baru",
    "shortcuts.undo": "Urungkan",
    "shortcuts.redo": "Ulangi",
    "shortcuts.sendAi": "Kirim pesan AI",
    "shortcuts.newLine": "Baris baru di AI",
    "shortcuts.focus": "Mode fokus",
    "shortcuts.collapsePanel": "Ciutkan/perluas panel AI",
    "toast.loadFailed": "Gagal: {{name}}",
    "toast.loaded": "Memuat {{count}} kartu",
    "toast.importDupe": "Konten sama dengan kartu yang ada — diimpor sebagai {{name}}",
    "toast.largeImage": "Gambar besar tertanam di {{name}} ({{size}} MB) - pertimbangkan untuk menghapusnya agar hemat penyimpanan.",
    "toast.noValid": "Tidak ada kartu valid. Letakkan file PNG atau JSON.",
    "toast.noSelected": "Belum ada kartu dipilih",
    "toast.cardsDeleted": "Kartu dihapus",
    "toast.deleteFailed": "Gagal menghapus kartu",
    "toast.exported": "Mengekspor {{count}} kartu",
    "toast.newBlank": "Kartu kosong baru dibuat",
    "toast.noCardSave": "Tidak ada kartu untuk disimpan",
    "toast.cardSaved": "Kartu disimpan!",
    "toast.noCardDup": "Tidak ada kartu untuk diduplikasi",
    "toast.cardDup": "Kartu diduplikasi",
    "toast.cardRestored": "Kartu dipulihkan",
    "toast.selectCard": "Pilih kartu terlebih dahulu",
    "toast.avatarUpdated": "Avatar diperbarui",
    "toast.imgFailed": "Gagal memuat gambar",
    "toast.firstMesUpdated": "Pesan pertama diperbarui!",
    "toast.settingsSaved": "Pengaturan disimpan!",
    "toast.modelsFailed": "Gagal memuat model: {{error}}",
    "toast.modelSet": "Model disetel: {{model}}",
    "toast.dataCleared": "Semua data dihapus",
    "toast.settingsExported": "Pengaturan diekspor",
    "toast.settingsImported": "Pengaturan diimpor!",
    "toast.invalidFile": "File pengaturan tidak valid",
    "toast.apiKey": "Atur kunci API Anda di Pengaturan",
    "toast.selectModel": "Silakan pilih model dari navbar atau pengaturan terlebih dahulu.",
    "toast.genStopped": "Pembuatan dihentikan.",
    "toast.aiError": "Kesalahan AI: {{error}}",
    "toast.cardUpdatedAI": "Kartu diperbarui dari respons AI!",
    "toast.jsonParseFailed": "Tidak dapat mengurai respons AI sebagai JSON. Periksa obrolan.",
    "toast.emptyResponse": "AI mengembalikan konten kosong — tidak ada yang bisa diterapkan.",
    "toast.jsonInvalid": "AI tidak mengembalikan JSON valid. Responsnya ada di obrolan — Anda dapat menyalinnya secara manual.",
    "toast.fieldUpdated": '"{{field}}" diperbarui!',
    "toast.greetingsUpdated": "{{count}} sapaan dibuat!",
    "toast.tagsUpdated": "Tag diperbarui — {{count}} tag baru ditambahkan!",
    "toast.greetingsParseFailed": "Tidak dapat mengurai sapaan dari respons AI.",
    "toast.createCardFirst": "Buat atau pilih kartu terlebih dahulu",
    "toast.wizardCreated": "Kartu dibuat! Mulai mengedit atau gunakan AI untuk mengisi detailnya.",
    "toast.wizardApi": "Atur kunci API Anda di Pengaturan terlebih dahulu",
    "toast.wizardModel": "Pilih model atau atur ID model kustom di Pengaturan",
    "toast.wizardFetchFailed": "Gagal mengambil gambar: {{error}}",
    "toast.wizardName": "Silakan masukkan nama karakter",
    "toast.storageFull": "Penyimpanan penuh! Coba hapus beberapa kartu atau ekspor kartu tersebut.",
    "toast.exportedJson": "Diekspor sebagai JSON!",
    "toast.exportedPng": "Diekspor sebagai PNG dengan data kartu!",
    "toast.exportFailed": "Ekspor gambar gagal. Beralih ke JSON.",
    "toast.noNameWarning": 'Peringatan: Kartu tidak memiliki nama. File akan disimpan sebagai "character.json".',
    "toast.chatCleared": "Obrolan dibersihkan",
    "toast.selectField": "Pilih setidaknya satu kolom untuk diedit",
    "toast.tooManyFields": "Terlalu banyak kolom dipilih. Maksimal {{max}} sekaligus.",
    "toast.undo": "Urungkan",
    "toast.redo": "Ulangi",
    "toast.reorderFiltered": "Matikan pencarian dan filter untuk mengurutkan ulang kartu.",
    "error.apiKeyNotSet": "Kunci API belum diatur. Masukkan kunci API Anda di Pengaturan.",
    "error.customUrlNotSet": "URL dasar API kustom belum diatur. Buka Pengaturan → Kustom (kompatibel OpenAI) dan masukkan URL endpoint (mis. http://localhost:1234/v1).",
    "error.customServerError": "Server mengembalikan kesalahan: {{detail}}",
    "error.customAuthFailed": "Otentikasi gagal (HTTP {{status}}). Periksa kunci API untuk endpoint ini.",
    "error.customPathNotFound": "Endpoint tidak ditemukan (HTTP 404). Periksa apakah URL dasar API sudah lengkap (mis. menyertakan /v1).",
    "error.customUnreachable": "Tidak dapat menjangkau {{url}}. Periksa apakah server berjalan dan URL dasar API benar serta dapat diakses dari perangkat ini.",
    "error.noModel": "Belum ada model dipilih. Pilih model atau setel ID model di Pengaturan.",
    "error.noModelSimple": "Belum ada model dipilih.",
    "error.insufficientCredits": "Kredit tidak mencukupi. Silakan isi ulang akun Anda.",
    "error.storageFull": "Penyimpanan penuh! Coba hapus beberapa kartu atau ekspor kartu tersebut.",
    "gen.empty": "(kosong)",
    "gen.free": "Gratis",
    "gen.unlimited": "Tanpa batas",
    "gen.notAvailable": "N/A",
    "gen.unnamed": "Tanpa nama",
    "gen.byCreator": "oleh {{name}}",
    "gen.copySuffix": " (Salinan)",
    "gen.toastAutoHide": "Otomatis hilang dalam {{s}}d",
    "gen.untagged": "Tidak ada tag ditemukan",
    "gen.noMatch": "Tidak ada kartu yang cocok dengan filter Anda",
    "batch.deleteConfirm": "Hapus {{count}} kartu? Tindakan ini tidak dapat dibatalkan.",
    "left.selected": "{{count}} dipilih",
    "toast.cardDeleted": 'Kartu "{{name}}" dihapus',
    "ai.apply": "Terapkan",
    "ai.applyTitle": "Terapkan perubahan ini ke kartu",
    "ai.errorPrefix": "Kesalahan: ",
    "ai.translatePrompt": "Terjemahkan ke bahasa apa?",
    "ai.translateDefaultLang": "Prancis",
    "ai.tonePrompt": "Nada apa? (mis. formal, santai, gelap, humoris, puitis)",
    "ai.toneDefault": "formal",
    "ai.chatSession": "Sesi obrolan",
    "ai.msgs": "{{count}} pesan",
    "ai.tokensIn": " masuk · ",
    "ai.tokensOut": " keluar · ",
    "ai.tokensCtx": " konteks",
    "ai.exceedsLimit": " ⚠ Melebihi batas!",
    "ai.approachingLimit": " ⚠ Mendekati batas",
    "ai.count": "Hitung:",
    "ai.resizeAria": "Ubah ukuran asisten AI",
    "ai.chatMessagesAria": "Pesan obrolan AI",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: Contoh dialog di sini...
{{user}}: Respons pengguna...
<START>
{{char}}: Contoh lainnya...`,
    "batch.select2ForCompare": "Pilih tepat 2 kartu untuk dibandingkan",
    "batch.compareLoadFailed": "Gagal memuat kartu untuk perbandingan",
    "batch.comparePrefix": "Bandingkan: ",
    "batch.compareVs": " vs ",
    "batch.cardA": "Kartu A",
    "batch.cardB": "Kartu B",
    "editor.charCount": "{{chars}} karakter ~{{tokens}} token",
    "editor.counterWarn": "Mendekati batas token keluaran ({{tokens}}/{{max}}).",
    "editor.counterDanger": "Melebihi batas token keluaran ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "Pindah ke atas",
    "editor.greetingMoveDown": "Pindah ke bawah",
    "editor.greetingIsDefault": "Ini adalah pesan pertama saat ini",
    "editor.greetingSetDefault": "Setel sebagai pesan pertama",
    "editor.greetingRemove": "Hapus",
    "editor.greetingPlaceholder": "Sapaan {{num}}...",
    "editor.loreEntry": "Entri {{num}}",
    "editor.loreDeleteEntry": "Hapus entri",
    "editor.lorePrimaryKeys": "Kata Kunci Utama",
    "editor.lorePrimaryKeysPlaceholder": "Kata kunci utama — dipisahkan koma",
    "editor.loreSecondaryKeys": "Kata Kunci Sekunder",
    "editor.loreSecondaryKeysPlaceholder": "Kata kunci sekunder",
    "editor.loreComment": "Komentar",
    "editor.loreCommentPlaceholder": "Komentar",
    "editor.loreOrder": "Urutan",
    "editor.loreOrderPlaceholder": "Urutan",
    "editor.loreConstant": "Konstan",
    "editor.loreSelective": "Selektif",
    "editor.loreBeforeChar": "Sebelum karakter",
    "editor.loreAfterChar": "Setelah karakter",
    "editor.loreContent": "Isi",
    "editor.loreContentPlaceholder": "Isi entri...",
    "editor.loreNewEntry": "Entri Baru",
    "error.unknown": "Kesalahan tidak diketahui",
    "error.unexpected": "Kesalahan tak terduga: {{message}}",
    "error.requestFailed": "Permintaan gagal: {{message}}",
    "error.unsupportedFile": "Jenis file tidak didukung: .{{ext}}",
    "error.invalidJson": "JSON tidak valid: {{message}}",
    "error.notPng": "Bukan file PNG yang valid",
    "error.unknownFormat": "Format kartu tidak dikenal — bukan kartu karakter SillyTavern",
    "error.fetchModelsFailed": "Gagal mengambil model (HTTP {{status}})",
    "error.noChoices": "API tidak mengembalikan pilihan respons",
    "error.emptyResponse": "Respons kosong dari API (tidak ada isi)",
    "gen.newCharacter": "Karakter Baru",
    "gen.bytes": " B",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "Cadangkan",
    "settings.restore": "Pulihkan",
    "settings.backupTitle": "Cadangkan semua kartu",
    "settings.restoreTitle": "Pulihkan cadangan",
    "settings.exportTitle": "Ekspor pengaturan",
    "settings.importTitle": "Impor pengaturan",
    "settings.modelAuto": "Otomatis",
    "settings.modelIdPlaceholder": "mis. deepseek-v4-flash",
    "settings.customModelPlaceholder": "mis. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "mis. {{provider}}-latest",
    "settings.getApiKeyFrom": "Dapatkan kunci API dari ",
    "settings.customModelDesc": "Model kustom",
    "settings.workspaceExported": "Ruang kerja diekspor ({{count}} kartu)",
    "settings.invalidWorkspace": "Format ruang kerja tidak valid",
    "settings.workspaceImported": "Ruang kerja diimpor ({{count}} kartu)",
    "settings.workspaceImportFailed": "Gagal mengimpor ruang kerja: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "Nyalakan/matikan Asisten AI",
    "nav.toggleAIAria": "Nyalakan/matikan Asisten AI",
    "nav.notificationsAria": "Notifikasi",
    "left.sortCards": "Urutkan kartu",
    "left.compareSelected": "Bandingkan kartu yang dipilih",
    "left.resizeAria": "Ubah ukuran perpustakaan kartu",
    "left.cardListAria": "Perpustakaan kartu",
    "ui.saved": " Tersimpan",
    "ui.collapsePanel": "Ciutkan panel",
    "ui.expandPanel": "Perluas panel",
    "ui.cardModified": "Perubahan belum disimpan",
    "export.minimalPngLabel": "Kartu ST",
    "wizard.search": "Cari",
    "wizard.quick": "Cepat:",
    "wizard.imageSearchPlaceholder": "Cari tag: kucing, gaun, seragam, cyberpunk...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.hi = {
    "app.title": "ST Card Editor — SillyTavern कैरेक्टर कार्ड स्टूडियो",
    "nav.selectModel": "मॉडल चुनें...",
    "nav.wizard": "AI विज़ार्ड से बनाएं",
    "nav.newCard": "नया खाली कार्ड",
    "nav.save": "सहेजें",
    "nav.theme": "थीम बदलें",
    "nav.shortcuts": "शॉर्टकट और सहायता",
    "nav.settings": "सेटिंग्स",
    "nav.focus": "फ़ोकस मोड",
    "nav.focusAlt": "फ़ोकस मोड (Alt+F)",
    "left.title": "कार्ड लाइब्रेरी",
    "left.cards": "{{count}} कार्ड",
    "left.sort.manual": "मैन्युअल",
    "left.drop": "खींचकर छोड़ें",
    "left.dropSub": "PNG या JSON कैरेक्टर कार्ड",
    "left.browse": "फ़ाइलें ब्राउज़ करें",
    "left.search": "कार्ड खोजें...",
    "left.sort.nameAsc": "नाम A-Z",
    "left.sort.nameDesc": "नाम Z-A",
    "left.sort.newest": "नए पहले",
    "left.sort.oldest": "पुराने पहले",
    "left.sort.largest": "सबसे बड़े",
    "left.sort.smallest": "सबसे छोटे",
    "left.filterTags": "टैग से फ़िल्टर करें",
    "left.exportSelected": "चयनित को JSON के रूप में निर्यात करें",
    "left.deleteSelected": "चयनित हटाएं",
    "left.empty": "कोई कार्ड लोड नहीं",
    "left.emptySub": "कार्ड छोड़ें या ब्राउज़ पर क्लिक करें",
    "center.noCard": "कोई कार्ड चयनित नहीं",
    "center.noCardSub": "लाइब्रेरी से कार्ड चुनें या नया कार्ड खींचकर छोड़ें",
    "center.createAI": "AI से बनाएं",
    "center.blankCard": "खाली कार्ड",
    "editor.avatar": "अवतार सेट करने के लिए छवि पर क्लिक करें या छोड़ें",
    "editor.avatarAria": "कैरेक्टर अवतार सेट करें",
    "editor.name": "कैरेक्टर का नाम",
    "editor.exportJson": "JSON के रूप में निर्यात करें",
    "editor.exportPng": "PNG के रूप में निर्यात करें",
    "editor.duplicate": "कार्ड डुप्लिकेट करें",
    "editor.delete": "कार्ड हटाएं",
    "editor.tab.core": "मुख्य",
    "editor.tab.personality": "व्यक्तित्व",
    "editor.tab.advanced": "उन्नत",
    "editor.tab.lorebook": "लोरबुक",
    "editor.tab.waifu": "Waifu छवि",
    "editor.waifuPreview": "वर्तमान कार्ड छवि",
    "editor.waifuNoImage": "अभी तक कोई छवि निर्धारित नहीं",
    "editor.waifuSource": "छवि स्रोत",
    "editor.waifuSourceSnap": "एनीमे स्नैपशॉट (waifu.im)",
    "editor.waifuSourceChar": "एनीमे पात्र (AniList)",
    "editor.waifuGender": "लिंग",
    "editor.waifuGenderAll": "कोई भी",
    "editor.waifuGenderFemaleOnly": "केवल महिला",
    "editor.waifuGenderMaleOnly": "केवल पुरुष",
    "editor.waifuGenderFemale": "महिला",
    "editor.waifuGenderMale": "पुरुष",
    "editor.waifuCharSub": "नाम से पात्र खोजें (जैसे: zoro)",
    "editor.waifuSearch": "waifu.im पर खोजें",
    "editor.waifuSearchChar": "पात्र खोजें",
    "editor.waifuSearchPlaceholderChar": "नाम से पात्र खोजें (जैसे: zoro)",
    "editor.waifuSub": "(टैग द्वारा एनीमे-शैली छवियाँ लाता है)",
    "editor.waifuSearchPlaceholder": "जैसे: waifu, योगिनी, नौकरानी...",
    "editor.waifuFetch": "छवियाँ लाएँ",
    "editor.waifuRegenTitle": "परिणाम दोबारा बनाएँ",
    "editor.waifuMixed": "महिला + पुरुष",
    "editor.waifuMixedSub": "एक क्लिक संतुलित पैक: 3 महिला + 3 पुरुष पात्र",
    "editor.waifuUse": "कार्ड छवि के रूप में उपयोग करें",
    "editor.waifuUpload": "डिवाइस से अपलोड करें",
    "editor.waifuRemove": "छवि हटाएँ",
    "toast.noImage": "इस कार्ड में हटाने के लिए कोई छवि नहीं है",
    "toast.imageRemoved": "छवि हटाई गई",
    "editor.desc": "विवरण",
    "editor.descSub": "(दिखावट, पृष्ठभूमि)",
    "editor.descPlaceholder": "कैरेक्टर की दिखावट, पृष्ठभूमि और मुख्य विशेषताओं का वर्णन करें...",
    "editor.firstMes": "पहला संदेश",
    "editor.firstMesPlaceholder": "चैट शुरू होने पर कैरेक्टर का पहला संदेश...",
    "editor.scenario": "परिदृश्य",
    "editor.scenarioPlaceholder": "बातचीत की वर्तमान परिस्थितियाँ और संदर्भ...",
    "editor.creator": "निर्माता",
    "editor.creatorPlaceholder": "कार्ड निर्माता / लेखक",
    "editor.version": "कैरेक्टर संस्करण",
    "editor.tags": "टैग",
    "editor.tagsSub": "(अल्पविराम से अलग)",
    "editor.tagsPlaceholder": "फंतासी, योद्धा, परी",
    "editor.personalitySummary": "व्यक्तित्व सारांश",
    "editor.personalityPlaceholder": "कैरेक्टर के व्यक्तित्व का संक्षिप्त विवरण... (कैरेक्टर कार्ड प्रारूप में उपयोग होता है)",
    "editor.mesExample": "उदाहरण संदेश",
    "editor.mesExampleFormat": "प्रारूप: {{char}}: और {{user}}: उपसर्गों के साथ <START> ब्लॉक",
    "editor.systemPrompt": "सिस्टम प्रॉम्प्ट",
    "editor.systemPromptPlaceholder": "सिस्टम प्रॉम्प्ट को बदलें। डिफ़ॉल्ट शामिल करने के लिए {{original}} का उपयोग करें।",
    "editor.postHistory": "इतिहास-पश्चात निर्देश",
    "editor.postHistoryPlaceholder": "चैट इतिहास के बाद जोड़े जाने वाले निर्देश। डिफ़ॉल्ट के लिए {{original}} का उपयोग करें।",
    "editor.creatorNotes": "निर्माता नोट्स",
    "editor.creatorNotesPlaceholder": "कार्ड उपयोगकर्ताओं के लिए नोट्स (मॉडल सुझाव, उपयोग युक्तियाँ...)",
    "editor.greetings": "वैकल्पिक अभिवादन",
    "editor.addGreeting": "अभिवादन जोड़ें",
    "editor.lorebookTitle": "कैरेक्टर लोरबुक प्रविष्टियाँ",
    "editor.addEntry": "प्रविष्टि जोड़ें",
    "editor.lorebookSearch": "कुंजी, सामग्री या टिप्पणी से प्रविष्टियाँ खोजें...",
    "editor.lorebookEmpty": "अभी कोई लोरबुक प्रविष्टि नहीं। शुरू करने के लिए एक जोड़ें।",
    "editor.noGreetings": "अभी कोई अभिवादन नहीं। <strong>अभिवादन जोड़ें</strong> पर क्लिक करें या AI से बनवाएं।",
    "editor.noEntriesMatch": '"{{query}}" से मेल खाती कोई प्रविष्टि नहीं',
    "editor.edit": "संपादित करें",
    "editor.preview": "पूर्वावलोकन",
    "ai.title": "AI सहायक",
    "ai.clearChat": "चैट साफ़ करें",
    "ai.welcomeTitle": "AI कार्ड सहायक",
    "ai.welcomeText": "AI से अपने कैरेक्टर कार्ड को संपादित, अनुवादित या बेहतर बनाने के लिए कहें।",
    "ai.quick.newCard": "नया कार्ड",
    "ai.quick.translate": "अनुवाद करें",
    "ai.quick.enhance": "बेहतर बनाएं",
    "ai.quick.shorten": "छोटा करें",
    "ai.quick.tone": "लहजा बदलें",
    "ai.quick.grammar": "व्याकरण सुधारें",
    "ai.quick.personality": "व्यक्तित्व विस्तारित करें",
    "ai.quick.firstmes": "पहला संदेश सुधारें",
    "ai.quick.scenario": "परिदृश्य विस्तारित करें",
    "ai.quick.greetings": "अभिवादन बनाएं",
    "ai.quick.systemprompt": "सिस्टम प्रॉम्प्ट बेहतर बनाएं",
    "ai.quick.tags": "टैग सुझाएँ",
    "ai.contextTitle": "मॉडल संदर्भ सीमा बनाम अनुमानित उपयोग किए गए टोकन",
    "ai.contextLabel": "— / — टोकन",
    "ai.placeholder": "AI से कार्ड संपादित करने को कहें...",
    "ai.send": "भेजें",
    "ai.stop": "जनरेशन रोकें",
    "ai.autoModel": "मॉडल चुनें...",
    "ai.target": "लक्ष्य:",
    "ai.target.full": "पूरा कार्ड",
    "ai.target.description": "विवरण",
    "ai.target.personality": "व्यक्तित्व",
    "ai.target.first_mes": "पहला संदेश",
    "ai.target.scenario": "परिदृश्य",
    "ai.target.mes_example": "उदाहरण संदेश",
    "ai.target.system_prompt": "सिस्टम प्रॉम्प्ट",
    "ai.target.post_history_instructions": "इतिहास-पश्चात निर्देश",
    "ai.target.creator_notes": "निर्माता नोट्स",
    "ai.target.alternate_greetings": "वैकल्पिक अभिवादन",
    "ai.selectModel": "मॉडल चुनें",
    "ai.actionNewCard": "नया कार्ड",
    "ai.actionTranslate": "अनुवाद करें",
    "ai.actionEnhance": "बेहतर बनाएं",
    "ai.actionShorten": "छोटा करें",
    "ai.actionTone": "लहजा बदलें",
    "ai.actionGrammar": "व्याकरण सुधारें",
    "ai.actionPersonality": "व्यक्तित्व विस्तारित करें",
    "ai.actionFirstMes": "पहला संदेश सुधारें",
    "ai.actionScenario": "परिदृश्य विस्तारित करें",
    "ai.actionGreetings": "अभिवादन बनाएं",
    "ai.actionSystemprompt": "सिस्टम प्रॉम्प्ट बेहतर बनाएं",
    "ai.actionTags": "टैग सुझाएँ",
    "ai.chatHistory": "चैट इतिहास",
    "ai.historyTitle": "चैट इतिहास",
    "ai.historyEmpty": "अभी कोई बातचीत नहीं",
    "ai.retry": "पुनः प्रयास करें",
    "ai.retryTitle": "इस प्रतिक्रिया को फिर से बनाएं",
    "ai.reapply": "फिर से लागू करें",
    "ai.reapplyTitle": "इन परिवर्तनों को लागू करने के लिए डिफ़ फिर से खोलें",
    "ai.noCard": "(कोई कार्ड चयनित नहीं)",
    "ai.editing": "{{count}} फ़ील्ड संपादित की जा रही हैं...",
    "ai.streaming": "स्ट्रीमिंग...",
    "ai.failed": "विफल",
    "ai.cancelled": "रद्द किया गया।",
    "ai.doneSummary": "{{done}}/{{total}} पूर्ण · {{errs}} विफल",
    "ai.viewFullResult": "पूरा परिणाम देखें",
    "ai.showLess": "कम दिखाएं",
    "ai.reviewApply": "समीक्षा करें और लागू करें",
    "ai.changesNav": "बदलाव {{current}} / {{total}}",
    "ai.changesPrev": "पिछला बदलाव",
    "ai.changesNext": "अगला बदलाव",
    "ai.applied": "लागू किया गया",
    "ai.target.tags": "टैग",
    "ai.copy": "कॉपी करें",
    "ai.copied": "कॉपी हो गया!",
    "ai.copyFailed": "विफल",
    "ai.resultTitle": "परिणाम",
    "ai.close": "बंद करें",
    "settings.themeColor": "थीम रंग",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "हल्के/गहरे थीम के लिए अलग-अलग एक्सेंट रंग चुनें। बदलाव तुरंत लागू होते हैं।",
    "settings.appearance": "रूप",
    "settings.accentPresets": "एक्सेंट प्रीसेट",
    "settings.glassDensity": "कांच घनत्व",
    "settings.glassSubtle": "सूक्ष्म",
    "settings.glassDefault": "डिफ़ॉल्ट",
    "settings.glassBold": "बोल्ड",
    "settings.cardRadius": "कार्ड त्रिज्या",
    "settings.radiusCompact": "कॉम्पैक्ट",
    "settings.radiusRounded": "गोल",
    "settings.radiusPill": "पिल",
    "settings.vignette": "किनारा विग्नेट",
    "settings.appearanceHint": "प्रत्येक लाइट/डार्क थीम के रूप को अनुकूलित करें। एक्सेंट बदलाव तुरंत लागू होते हैं; घनत्व, त्रिज्या और विग्नेट वर्कस्पेस बैकअप में शामिल हैं।",
    "settings.resetThemeColor": "रीसेट करें",
    "settings.generalTab": "सामान्य",
    "settings.promptsTab": "AI प्रॉम्प्ट",
    "settings.assistantPrompt": "असिस्टेंट सिस्टम प्रॉम्प्ट",
    "settings.fullCardPrompt": "पूर्ण कार्ड सिस्टम प्रॉम्प्ट",
    "settings.wizardPrompt": "कैरेक्टर जनरेशन निर्देश",
    "settings.promptPlaceholder": "बिल्ट-इन प्रॉम्प्ट उपयोग करने के लिए खाली छोड़ें",
    "settings.chatSystemPrompts": "चैट और सिस्टम निर्देश",
    "settings.fullCardInstr": "पूर्ण कार्ड आउटपुट निर्देश (सिस्टम)",
    "settings.fieldsEdit": "फ़ील्ड संपादन निर्देश (सिस्टम)",
    "settings.greetingsSystem": "अभिवादन आउटपुट निर्देश (सिस्टम)",
    "settings.exportPrompts": "प्रॉम्प्ट निर्यात करें",
    "settings.importPrompts": "प्रॉम्प्ट आयात करें",
    "settings.promptsExported": "प्रॉम्प्ट निर्यात किए गए",
    "settings.promptsImported": "{count} प्रॉम्प्ट आयात किए गए",
    "settings.quickActionPrompts": "क्विक-एक्शन प्रॉम्प्ट",
    "settings.tagsSystemPrompt": "टैग आउटपुट निर्देश (सिस्टम)",
    "settings.restoreDefaultPrompts": "डिफ़ॉल्ट प्रॉम्प्ट पुनर्स्थापित करें",
    "settings.promptHint": "ये फ़ील्ड वर्तमान प्रॉम्प्ट दिखाते हैं। खाली छोड़ने पर बिल्ट-इन डिफ़ॉल्ट प्रॉम्प्ट उपयोग होता है। मूल प्रॉम्प्ट देखने या पुनर्स्थापित करने के लिए डिफ़ॉल्ट पुनर्स्थापित करें।",
    "settings.title": "सेटिंग्स",
    "settings.provider": "प्रदाता",
    "settings.providerHint": "होस्ट किए गए मॉडल प्रदाता या कस्टम एंडपॉइंट (LM Studio, Ollama, आदि)",
    "settings.apiKey": "API कुंजी",
    "settings.getApiKey": "OpenRouter से अपनी API कुंजी प्राप्त करें",
    "settings.baseUrl": "API बेस URL",
    "settings.namedApiKeyPlaceholder": "अपनी API कुंजी दर्ज करें",
    "settings.customHint": "OpenAI-संगत एंडपॉइंट। उदाहरण: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "API कुंजी (वैकल्पिक)",
    "settings.apiKeyLocalPlaceholder": "स्थानीय प्रदाताओं के लिए खाली छोड़ें",
    "settings.apiKeyLocalHint": "LM Studio या Ollama जैसे स्थानीय सर्वरों के लिए आवश्यक नहीं।",
    "settings.modelId": "मॉडल ID",
    "settings.modelIdHint": "आपके प्रदाता द्वारा अपेक्षित सटीक मॉडल ID।",
    "settings.modelIdHintNamed": "प्रदाता के डिफ़ॉल्ट मॉडल का उपयोग करने के लिए खाली छोड़ें।",
    "settings.security": "आपकी API कुंजी इस पते से जुड़ी कुंजी से एन्क्रिप्ट होकर ब्राउज़र के localStorage में संग्रहीत होती है। साझा डिवाइसों पर इस ऐप का उपयोग न करें।",
    "settings.secretUnreadable": "सुरक्षा कारणों से, इस पते पर सहेजी गई API कुंजी अनलॉक नहीं की जा सकी — कृपया सेटिंग्स में फिर से दर्ज करें।",
    "error.pngInflateFailed": "इस PNG में ऐसा कैरेक्टर डेटा है जिसे डीकंप्रेस नहीं किया जा सका।",
    "settings.defaultModel": "डिफ़ॉल्ट मॉडल",
    "settings.browseModels": "नीचे मॉडल ब्राउज़ करें...",
    "settings.refreshModels": "मॉडल ताज़ा करें",
    "settings.maxTokens": "अधिकतम आउटपुट टोकन",
    "settings.maxTokensPlaceholder": "0 = मॉडल डिफ़ॉल्ट उपयोग करें",
    "settings.maxTokensHint": "प्रति अनुरोध अधिकतम आउटपुट टोकन बदलें। चयनित मॉडल की सीमा स्वतः उपयोग करने के लिए 0 रखें (अज्ञात होने पर 64k)।",
    "settings.copyright": "निर्यात पर संपादक श्रेय जोड़ें",
    "settings.copyrightHint": "कार्ड निर्यात करते समय निर्माता नोट्स में श्रेय पंक्ति जोड़ता है।",
    "settings.availableModels": "उपलब्ध मॉडल",
    "settings.searchModels": "मॉडल खोजें...",
    "settings.enterApiKey": "मॉडल लोड करने के लिए अपनी API कुंजी दर्ज करें और ताज़ा करें",
    "settings.credits": "क्रेडिट और उपयोग",
    "settings.creditLimit": "क्रेडिट सीमा",
    "settings.remaining": "शेष",
    "settings.usedMonth": "इस माह उपयोग",
    "settings.localStorage": "स्थानीय संग्रहण",
    "settings.clearAll": "सभी डेटा साफ़ करें",
    "settings.export": "निर्यात",
    "settings.import": "आयात",
    "settings.close": "बंद करें",
    "settings.saveSettings": "सेटिंग्स सहेजें",
    "settings.languageLabel": "भाषा",
    "settings.languageHint": "इंटरफ़ेस भाषा (अनुपलब्ध होने पर पृष्ठ पुनः लोड करें)",
    "settings.languageChanged": "भाषा अद्यतन हुई",
    "settings.clearConfirm": "सभी कार्ड, सेटिंग्स और चैट इतिहास हटाएं? इसे पूर्ववत नहीं किया जा सकता।",
    "settings.providerCustom": "कस्टम (OpenAI-संगत)",
    "settings.noModels": "कोई मॉडल नहीं मिला",
    "settings.loadMore": "और लोड करें ({{count}} शेष)",
    "settings.showingModels": "{{total}} में से {{shown}} मॉडल दिखाए जा रहे हैं",
    "wizard.title": "कैरेक्टर बनाएं",
    "wizard.step.basics": "मूल बातें",
    "wizard.step.concept": "अवधारणा",
    "wizard.step.personality": "व्यक्तित्व",
    "wizard.step.scenario": "परिदृश्य",
    "wizard.step.generate": "बनाएं",
    "wizard.basicsTitle": "कैरेक्टर मूल बातें",
    "wizard.nameLabel": "कैरेक्टर का नाम",
    "wizard.namePlaceholder": "उदा. एलारा नाइटविस्पर",
    "wizard.genderLabel": "लिंग / सर्वनाम",
    "wizard.genderSelect": "चुनें...",
    "wizard.gender.female": "महिला (वह/उसे)",
    "wizard.gender.male": "पुरुष (वह/उसे)",
    "wizard.gender.nonbinary": "नॉन-बाइनरी (वे)",
    "wizard.gender.other": "अन्य...",
    "wizard.genderCustom": "कस्टम सर्वनाम (उदा. यह)",
    "wizard.tagsLabel": "टैग",
    "wizard.tagsSub": "(अल्पविराम से अलग, लाइब्रेरी व्यवस्थित करने में मदद करता है)",
    "wizard.tagsPlaceholder": "फंतासी, योद्धा, परी, मूल",
    "wizard.creatorLabel": "निर्माता",
    "wizard.creatorPlaceholder": "आपका नाम / उपनाम",
    "wizard.conceptTitle": "अवधारणा और सेटिंग",
    "wizard.typeLabel": "कैरेक्टर प्रकार",
    "wizard.type.original": "मूल कैरेक्टर",
    "wizard.type.fanfic": "फैन फिक्शन",
    "wizard.type.game": "गेम कैरेक्टर",
    "wizard.type.anime": "एनीमे / मंगा",
    "wizard.type.book": "पुस्तक / फ़िल्म / शो",
    "wizard.type.historical": "ऐतिहासिक व्यक्ति",
    "wizard.type.mythological": "पौराणिक / लोककथा",
    "wizard.type.vtuber": "VTuber / स्ट्रीमर",
    "wizard.type.other": "अन्य",
    "wizard.languageLabel": "भाषा",
    "wizard.language.other": "अन्य",
    "wizard.languageSpecify": "भाषा निर्दिष्ट करें",
    "wizard.genreLabel": "शैली / दुनिया",
    "wizard.genreSub": "(सभी लागू विकल्प चुनें)",
    "wizard.moodLabel": "मनोदशा / लहजा",
    "wizard.moodSub": "(सभी लागू विकल्प चुनें)",
    "wizard.personalityTitle": "व्यक्तित्व और दिखावट",
    "wizard.personalityTraits": "व्यक्तित्व विशेषताएँ",
    "wizard.personalityTraitsSub": "(3-5 मुख्य विशेषताएँ बताएं, इससे AI को मदद मिलती है)",
    "wizard.personalityTraitsPlaceholder": "उदा. बहादुर लेकिन लापरवाह, दोस्तों के प्रति अत्यंत वफादार, सूखा हास्य, भरोसा करने में कठिनाई, गुप्त रूप से जानवरों से प्यार",
    "wizard.appearanceLabel": "शारीरिक दिखावट",
    "wizard.appearanceSub": "(वे कैसे दिखते हैं इसका संक्षिप्त विवरण)",
    "wizard.appearancePlaceholder": "उदा. लंबी महिला, कमर तक चांदी के बाल, घावों से भरे हाथ, गहरी चमड़े की जैकेट, तीखी हरी आँखें",
    "wizard.abilitiesLabel": "विशेष क्षमताएँ / विचित्रताएँ",
    "wizard.abilitiesSub": "(वैकल्पिक, कोई भी अनूठी विशेषता)",
    "wizard.abilitiesPlaceholder": "उदा. जानवरों से बात कर सकते हैं, फोटोग्राफिक मेमोरी है, हमेशा एक पुरानी डायरी ले जाते हैं",
    "wizard.scenarioTitle": "परिदृश्य और पहला संदेश",
    "wizard.scenarioLabel": "परिदृश्य / सेटिंग",
    "wizard.scenarioSub": "(कहानी कहाँ शुरू होती है?)",
    "wizard.scenarioPlaceholder": "उदा. नियॉन-रोशनी वाले शहर में बरसाती रात। कैरेक्टर एक छोटी मरम्मत की दुकान चलाता है जो मशीनें और टूटे दिल दोनों ठीक करती है।",
    "wizard.relationshipLabel": "{{user}} से संबंध",
    "wizard.relationshipSub": "(कैरेक्टर उपयोगकर्ता को कैसे देखता है?)",
    "wizard.relationshipPlaceholder": "उदा. एक नया ग्राहक जो रहस्यमय टूटे उपकरण के साथ दुकान में आया। कैरेक्टर उत्सुक लेकिन सतर्क है।",
    "wizard.openingLabel": "पहले संदेश का माहौल",
    "wizard.openingSub": "(उद्घाटन संदेश कैसा महसूस होना चाहिए?)",
    "wizard.notesLabel": "अतिरिक्त नोट्स",
    "wizard.notesSub": "(कोई और बात जो AI को पता होनी चाहिए?)",
    "wizard.notesPlaceholder": "उदा. संवाद स्वाभाविक रखें, अत्यधिक औपचारिक होने से बचें, तारांकन में क्रिया विवरण शामिल करें",
    "wizard.generateTitle": "कैरेक्टर बनाएं",
    "wizard.refImage": "संदर्भ छवि",
    "wizard.refImageSub": "(वैकल्पिक, waifu.im से)",
    "wizard.fetchImages": "3 छवियाँ लाएं",
    "wizard.refetchOthers": "अन्य फिर से लाएं",
    "wizard.fetching": "लाया जा रहा है...",
    "wizard.useSelected": "चयनित का उपयोग करें",
    "wizard.clear": "साफ़ करें",
    "wizard.generateAI": "AI से बनाएं",
    "wizard.generateAISub": "आपके उत्तरों से पूर्ण कैरेक्टर कार्ड",
    "wizard.createBlank": "खाली कार्ड बनाएं",
    "wizard.createBlankSub": "नाम और टैग पहले से भरे हुए शुरू करें",
    "wizard.back": "पीछे",
    "wizard.next": "आगे",
    "wizard.stepLabel": "चरण {{step}} / {{total}}",
    "wizard.ready": "बनाने के लिए तैयार!",
    "wizard.nameRequired": "कृपया कैरेक्टर का नाम दर्ज करें",
    "wizard.summary.name": "नाम",
    "wizard.summary.gender": "लिंग",
    "wizard.summary.type": "प्रकार",
    "wizard.summary.language": "भाषा",
    "wizard.summary.tags": "टैग",
    "wizard.summary.genres": "शैलियाँ",
    "wizard.summary.mood": "मनोदशा",
    "wizard.summary.opening": "उद्घाटन",
    "wizard.summary.personality": "व्यक्तित्व",
    "wizard.summary.appearance": "दिखावट",
    "wizard.summary.scenario": "परिदृश्य",
    "wizard.summary.relationship": "संबंध",
    "wizard.summary.notes": "नोट्स",
    "wizard.chip.fantasy": "फंतासी",
    "wizard.chip.scifi": "विज्ञान-कथा",
    "wizard.chip.modern": "आधुनिक",
    "wizard.chip.historical": "ऐतिहासिक",
    "wizard.chip.horror": "डरावना",
    "wizard.chip.romance": "रोमांस",
    "wizard.chip.comedy": "कॉमेडी",
    "wizard.chip.sliceOfLife": "रोजमर्रा की ज़िंदगी",
    "wizard.chip.adventure": "रोमांच",
    "wizard.chip.mystery": "रहस्य",
    "wizard.chip.cyberpunk": "साइबरपंक",
    "wizard.chip.postApocalyptic": "प्रलय-पश्चात",
    "wizard.chip.supernatural": "अलौकिक",
    "wizard.chip.military": "सैन्य",
    "wizard.chip.surreal": "अतियथार्थवादी",
    "wizard.chip.serious": "गंभीर",
    "wizard.chip.playful": "चंचल",
    "wizard.chip.dark": "अंधकारमय",
    "wizard.chip.lighthearted": "प्रसन्नचित्त",
    "wizard.chip.mysterious": "रहस्यमय",
    "wizard.chip.romantic": "रोमांटिक",
    "wizard.chip.intense": "तीव्र",
    "wizard.chip.wholesome": "स्वच्छ और सकारात्मक",
    "wizard.chip.chaotic": "अराजक",
    "wizard.chip.melancholic": "उदासीन",
    "wizard.chip.sarcastic": "व्यंग्यात्मक",
    "wizard.chip.stoic": "स्थिरचित्त",
    "wizard.chip.greeting": "गर्मजोशी भरा अभिवादन",
    "wizard.chip.action": "घटना के बीच से",
    "wizard.chip.question": "जिज्ञासु प्रश्न",
    "wizard.chip.conflict": "तत्काल संघर्ष",
    "wizard.chip.atmospheric": "वातावरणीय",
    "wizard.editStep": "इस अनुभाग को संपादित करें",
    "wizard.draftRestored": "ड्राफ्ट पुनर्स्थापित — आपके पिछले उत्तर वापस आ गए",
    "wizard.imagePlaceholder": "लाएं पर क्लिक करें",
    "diff.title": "AI प्रतिक्रिया पूर्वावलोकन",
    "diff.removed": "हटाया गया",
    "diff.added": "जोड़ा गया",
    "diff.current": "वर्तमान",
    "diff.proposed": "प्रस्तावित",
    "diff.empty": "(खाली)",
    "diff.discard": "त्यागें",
    "diff.apply": "परिवर्तन लागू करें",
    "shortcuts.title": "शॉर्टकट",
    "shortcuts.save": "कार्ड सहेजें",
    "shortcuts.newCard": "नया कार्ड",
    "shortcuts.undo": "पूर्ववत करें",
    "shortcuts.redo": "फिर से करें",
    "shortcuts.sendAi": "AI संदेश भेजें",
    "shortcuts.newLine": "AI में नई पंक्ति",
    "shortcuts.focus": "फ़ोकस मोड",
    "shortcuts.collapsePanel": "AI पैनल बंद करें/खोलें",
    "toast.loadFailed": "विफल: {{name}}",
    "toast.loaded": "{{count}} कार्ड लोड हुए",
    "toast.importDupe": "मौजूदा कार्ड जैसी ही सामग्री — {{name}} के रूप में आयात किया गया",
    "toast.largeImage": "{{name}} में बड़ी छवि एम्बेड की गई है ({{size}} MB) - स्थान बचाने के लिए इसे हटाने पर विचार करें।",
    "toast.noValid": "कोई मान्य कार्ड नहीं मिला। PNG या JSON फ़ाइलें छोड़ें।",
    "toast.noSelected": "कोई कार्ड चयनित नहीं",
    "toast.cardsDeleted": "कार्ड हटाए गए",
    "toast.deleteFailed": "कार्ड हटाने में विफल",
    "toast.exported": "{{count}} कार्ड निर्यात हुए",
    "toast.newBlank": "नया खाली कार्ड बनाया गया",
    "toast.noCardSave": "सहेजने के लिए कोई कार्ड नहीं",
    "toast.cardSaved": "कार्ड सहेजा गया!",
    "toast.noCardDup": "डुप्लिकेट करने के लिए कोई कार्ड नहीं",
    "toast.cardDup": "कार्ड डुप्लिकेट हुआ",
    "toast.cardRestored": "कार्ड पुनर्स्थापित हुआ",
    "toast.selectCard": "पहले एक कार्ड चुनें",
    "toast.avatarUpdated": "अवतार अद्यतन हुआ",
    "toast.imgFailed": "छवि लोड करने में विफल",
    "toast.firstMesUpdated": "पहला संदेश अद्यतन हुआ!",
    "toast.settingsSaved": "सेटिंग्स सहेजी गईं!",
    "toast.modelsFailed": "मॉडल लोड करने में विफल: {{error}}",
    "toast.modelSet": "मॉडल सेट: {{model}}",
    "toast.dataCleared": "सभी डेटा साफ़ हो गया",
    "toast.settingsExported": "सेटिंग्स निर्यात हुईं",
    "toast.settingsImported": "सेटिंग्स आयात हुईं!",
    "toast.invalidFile": "अमान्य सेटिंग्स फ़ाइल",
    "toast.apiKey": "सेटिंग्स में अपनी API कुंजी सेट करें",
    "toast.selectModel": "कृपया पहले नेवबार या सेटिंग्स से मॉडल चुनें।",
    "toast.genStopped": "जनरेशन रोका गया।",
    "toast.aiError": "AI त्रुटि: {{error}}",
    "toast.cardUpdatedAI": "AI प्रतिक्रिया से कार्ड अद्यतन हुआ!",
    "toast.jsonParseFailed": "AI प्रतिक्रिया को JSON के रूप में पार्स नहीं किया जा सका। चैट जांचें।",
    "toast.emptyResponse": "AI ने खाली सामग्री लौटाई — लागू करने के लिए कुछ नहीं।",
    "toast.jsonInvalid": "AI ने मान्य JSON नहीं लौटाया। प्रतिक्रिया चैट में है — आप इसे मैन्युअल रूप से कॉपी कर सकते हैं।",
    "toast.fieldUpdated": '"{{field}}" अद्यतन हुआ!',
    "toast.greetingsUpdated": "{{count}} अभिवादन बनाए गए!",
    "toast.tagsUpdated": "टैग अपडेट — {{count}} नए जोड़े गए!",
    "toast.greetingsParseFailed": "AI प्रतिक्रिया से अभिवादन पार्स नहीं किए जा सके।",
    "toast.createCardFirst": "पहले कार्ड बनाएं या चुनें",
    "toast.wizardCreated": "कार्ड बनाया गया! संपादन शुरू करें या विवरण भरने के लिए AI का उपयोग करें।",
    "toast.wizardApi": "पहले सेटिंग्स में अपनी API कुंजी सेट करें",
    "toast.wizardModel": "मॉडल चुनें या सेटिंग्स में कस्टम मॉडल ID सेट करें",
    "toast.wizardFetchFailed": "छवियाँ लाने में विफल: {{error}}",
    "toast.wizardName": "कृपया कैरेक्टर का नाम दर्ज करें",
    "toast.storageFull": "संग्रहण भर गया! कुछ कार्ड हटाने या निर्यात करने का प्रयास करें।",
    "toast.exportedJson": "JSON के रूप में निर्यात हुआ!",
    "toast.exportedPng": "कार्ड डेटा के साथ PNG के रूप में निर्यात हुआ!",
    "toast.exportFailed": "छवि निर्यात विफल। JSON पर वापस जा रहे हैं।",
    "toast.noNameWarning": 'चेतावनी: कार्ड का कोई नाम नहीं है। फ़ाइल "character.json" के रूप में सहेजी जाएगी।',
    "toast.chatCleared": "चैट साफ़ हुई",
    "toast.selectField": "संपादित करने के लिए कम से कम एक फ़ील्ड चुनें",
    "toast.tooManyFields": "बहुत अधिक फ़ील्ड चुनी गईं। अधिकतम {{max}} एक साथ।",
    "toast.undo": "पूर्ववत करें",
    "toast.redo": "फिर से करें",
    "toast.reorderFiltered": "कार्ड पुनः क्रमित करने के लिए खोज और फ़िल्टर बंद करें।",
    "error.apiKeyNotSet": "API कुंजी सेट नहीं है। सेटिंग्स में अपनी API कुंजी दर्ज करें।",
    "error.customUrlNotSet": "कस्टम API का बेस URL सेट नहीं है। सेटिंग्स → कस्टम (OpenAI-संगत) खोलें और एंडपॉइंट URL दर्ज करें (जैसे http://localhost:1234/v1)।",
    "error.customServerError": "सर्वर ने एक त्रुटि लौटाई: {{detail}}",
    "error.customAuthFailed": "प्रमाणीकरण विफल (HTTP {{status}})। इस एंडपॉइंट के लिए API कुंजी जांचें।",
    "error.customPathNotFound": "एंडपॉइंट नहीं मिला (HTTP 404)। जांचें कि API बेस URL पूर्ण है (जैसे /v1 शामिल है)।",
    "error.customUnreachable": "{{url}} तक नहीं पहुंच सकता। जांचें कि सर्वर चल रहा है और API बेस URL सही है और इस डिवाइस से पहुंच योग्य है।",
    "error.noModel": "कोई मॉडल चयनित नहीं। मॉडल चुनें या सेटिंग्स में मॉडल ID सेट करें।",
    "error.noModelSimple": "कोई मॉडल चयनित नहीं।",
    "error.insufficientCredits": "अपर्याप्त क्रेडिट। कृपया अपना खाता टॉप अप करें।",
    "error.storageFull": "संग्रहण भर गया! कुछ कार्ड हटाने या निर्यात करने का प्रयास करें।",
    "gen.empty": "(खाली)",
    "gen.free": "मुफ्त",
    "gen.unlimited": "असीमित",
    "gen.notAvailable": "N/A",
    "gen.unnamed": "बिना नाम",
    "gen.byCreator": "{{name}} द्वारा",
    "gen.copySuffix": " (प्रति)",
    "gen.toastAutoHide": "{{s}} सेकंड में स्वतः छिप जाएगा",
    "gen.untagged": "कोई टैग नहीं मिला",
    "gen.noMatch": "आपके फ़िल्टर से मेल खाता कोई कार्ड नहीं",
    "batch.deleteConfirm": "{{count}} कार्ड हटाएं? इसे पूर्ववत नहीं किया जा सकता।",
    "left.selected": "{{count}} चयनित",
    "toast.cardDeleted": 'कार्ड "{{name}}" हटाया गया',
    "ai.apply": "लागू करें",
    "ai.applyTitle": "इन परिवर्तनों को कार्ड पर लागू करें",
    "ai.errorPrefix": "त्रुटि: ",
    "ai.translatePrompt": "किस भाषा में अनुवाद करें?",
    "ai.translateDefaultLang": "फ़्रेंच",
    "ai.tonePrompt": "कौन सा लहजा? (उदा. औपचारिक, अनौपचारिक, अंधकारमय, विनोदी, काव्यात्मक)",
    "ai.toneDefault": "औपचारिक",
    "ai.chatSession": "चैट सत्र",
    "ai.msgs": "{{count}} संदेश",
    "ai.tokensIn": " इनपुट · ",
    "ai.tokensOut": " आउटपुट · ",
    "ai.tokensCtx": " संदर्भ",
    "ai.exceedsLimit": " ⚠ सीमा से अधिक!",
    "ai.approachingLimit": " ⚠ सीमा निकट",
    "ai.count": "गिनती:",
    "ai.resizeAria": "AI सहायक का आकार बदलें",
    "ai.chatMessagesAria": "AI चैट संदेश",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: उदाहरण संवाद यहाँ...
{{user}}: उपयोगकर्ता प्रतिक्रिया...
<START>
{{char}}: एक और उदाहरण...`,
    "batch.select2ForCompare": "तुलना के लिए ठीक 2 कार्ड चुनें",
    "batch.compareLoadFailed": "तुलना के लिए कार्ड लोड करने में विफल",
    "batch.comparePrefix": "तुलना: ",
    "batch.compareVs": " बनाम ",
    "batch.cardA": "कार्ड A",
    "batch.cardB": "कार्ड B",
    "editor.charCount": "{{chars}} अक्षर ~{{tokens}} टोकन",
    "editor.counterWarn": "आउटपुट टोकन सीमा के करीब ({{tokens}}/{{max}})।",
    "editor.counterDanger": "आउटपुट टोकन सीमा पार ({{tokens}}/{{max}})।",
    "editor.greetingMoveUp": "ऊपर ले जाएं",
    "editor.greetingMoveDown": "नीचे ले जाएं",
    "editor.greetingIsDefault": "यह वर्तमान पहला संदेश है",
    "editor.greetingSetDefault": "पहले संदेश के रूप में सेट करें",
    "editor.greetingRemove": "हटाएं",
    "editor.greetingPlaceholder": "अभिवादन {{num}}...",
    "editor.loreEntry": "प्रविष्टि {{num}}",
    "editor.loreDeleteEntry": "प्रविष्टि हटाएं",
    "editor.lorePrimaryKeys": "प्राथमिक कीवर्ड",
    "editor.lorePrimaryKeysPlaceholder": "प्राथमिक कीवर्ड — अल्पविराम से अलग",
    "editor.loreSecondaryKeys": "द्वितीयक कीवर्ड",
    "editor.loreSecondaryKeysPlaceholder": "द्वितीयक कीवर्ड",
    "editor.loreComment": "टिप्पणी",
    "editor.loreCommentPlaceholder": "टिप्पणी",
    "editor.loreOrder": "क्रम",
    "editor.loreOrderPlaceholder": "क्रम",
    "editor.loreConstant": "स्थिर",
    "editor.loreSelective": "चयनात्मक",
    "editor.loreBeforeChar": "कैरेक्टर से पहले",
    "editor.loreAfterChar": "कैरेक्टर के बाद",
    "editor.loreContent": "सामग्री",
    "editor.loreContentPlaceholder": "प्रविष्टि सामग्री...",
    "editor.loreNewEntry": "नई प्रविष्टि",
    "error.unknown": "अज्ञात त्रुटि",
    "error.unexpected": "अप्रत्याशित त्रुटि: {{message}}",
    "error.requestFailed": "अनुरोध विफल: {{message}}",
    "error.unsupportedFile": "असमर्थित फ़ाइल प्रकार: .{{ext}}",
    "error.invalidJson": "अमान्य JSON: {{message}}",
    "error.notPng": "मान्य PNG फ़ाइल नहीं",
    "error.unknownFormat": "अज्ञात कार्ड प्रारूप — SillyTavern कैरेक्टर कार्ड नहीं",
    "error.fetchModelsFailed": "मॉडल लाने में विफल (HTTP {{status}})",
    "error.noChoices": "API ने कोई प्रतिक्रिया विकल्प नहीं लौटाया",
    "error.emptyResponse": "API से खाली प्रतिक्रिया (कोई बॉडी नहीं)",
    "gen.newCharacter": "नया कैरेक्टर",
    "gen.bytes": " बाइट",
    "gen.kilobytes": " KB",
    "gen.megabytes": " MB",
    "settings.backup": "बैकअप",
    "settings.restore": "पुनर्स्थापित करें",
    "settings.backupTitle": "सभी कार्ड का बैकअप लें",
    "settings.restoreTitle": "बैकअप पुनर्स्थापित करें",
    "settings.exportTitle": "सेटिंग्स निर्यात करें",
    "settings.importTitle": "सेटिंग्स आयात करें",
    "settings.modelAuto": "ऑटो",
    "settings.modelIdPlaceholder": "उदा. deepseek-v4-flash",
    "settings.customModelPlaceholder": "उदा. llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "उदा. {{provider}}-latest",
    "settings.getApiKeyFrom": "API कुंजी यहाँ से प्राप्त करें: ",
    "settings.customModelDesc": "कस्टम मॉडल",
    "settings.workspaceExported": "वर्कस्पेस निर्यात हुआ ({{count}} कार्ड)",
    "settings.invalidWorkspace": "अमान्य वर्कस्पेस प्रारूप",
    "settings.workspaceImported": "वर्कस्पेस आयात हुआ ({{count}} कार्ड)",
    "settings.workspaceImportFailed": "वर्कस्पेस आयात करने में विफल: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "AI सहायक चालू/बंद करें",
    "nav.toggleAIAria": "AI सहायक चालू/बंद करें",
    "nav.notificationsAria": "सूचनाएँ",
    "left.sortCards": "कार्ड क्रमित करें",
    "left.compareSelected": "चयनित कार्ड तुलना करें",
    "left.resizeAria": "कार्ड लाइब्रेरी का आकार बदलें",
    "left.cardListAria": "कार्ड लाइब्रेरी",
    "ui.saved": " सहेजा गया",
    "ui.collapsePanel": "पैनल बंद करें",
    "ui.expandPanel": "पैनल खोलें",
    "ui.cardModified": "असहेजे गए परिवर्तन",
    "export.minimalPngLabel": "ST कार्ड",
    "wizard.search": "खोजें",
    "wizard.quick": "त्वरित:",
    "wizard.imageSearchPlaceholder": "टैग खोजें: बिल्ली, पोशाक, वर्दी, साइबरपंक...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.ar = {
    "app.title": "ST Card Editor — استوديو بطاقات الشخصيات SillyTavern",
    "nav.selectModel": "اختر النموذج...",
    "nav.wizard": "إنشاء باستخدام معالج الذكاء الاصطناعي",
    "nav.newCard": "بطاقة فارغة جديدة",
    "nav.save": "حفظ",
    "nav.theme": "تبديل المظهر",
    "nav.shortcuts": "الاختصارات والمساعدة",
    "nav.settings": "الإعدادات",
    "nav.focus": "وضع التركيز",
    "nav.focusAlt": "وضع التركيز (Alt+F)",
    "left.title": "مكتبة البطاقات",
    "left.cards": "{{count}} بطاقة",
    "left.drop": "اسحب وأفلت",
    "left.sort.manual": "يدوي",
    "left.dropSub": "بطاقات شخصيات PNG أو JSON",
    "left.browse": "تصفح الملفات",
    "left.search": "البحث في البطاقات...",
    "left.sort.nameAsc": "الاسم أ-ي",
    "left.sort.nameDesc": "الاسم ي-أ",
    "left.sort.newest": "الأحدث أولاً",
    "left.sort.oldest": "الأقدم أولاً",
    "left.sort.largest": "الأكبر",
    "left.sort.smallest": "الأصغر",
    "left.filterTags": "تصفية حسب الوسوم",
    "left.exportSelected": "تصدير المحدد كـ JSON",
    "left.deleteSelected": "حذف المحدد",
    "left.empty": "لم يتم تحميل أي بطاقات",
    "left.emptySub": "أفلت بطاقة أو انقر على تصفح",
    "center.noCard": "لم يتم تحديد بطاقة",
    "center.noCardSub": "حدد بطاقة من المكتبة أو اسحب وأفلت بطاقة جديدة",
    "center.createAI": "إنشاء بالذكاء الاصطناعي",
    "center.blankCard": "بطاقة فارغة",
    "editor.avatar": "انقر أو أفلت صورة لتعيين الصورة الرمزية",
    "editor.avatarAria": "تعيين الصورة الرمزية للشخصية",
    "editor.name": "اسم الشخصية",
    "editor.exportJson": "تصدير كـ JSON",
    "editor.exportPng": "تصدير كـ PNG",
    "editor.duplicate": "تكرار البطاقة",
    "editor.delete": "حذف البطاقة",
    "editor.tab.core": "أساسي",
    "editor.tab.personality": "الشخصية",
    "editor.tab.advanced": "متقدم",
    "editor.tab.lorebook": "سجل العالم",
    "editor.tab.waifu": "صورة Waifu",
    "editor.waifuPreview": "صورة البطاقة الحالية",
    "editor.waifuNoImage": "لم يتم تعيين صورة بعد",
    "editor.waifuSource": "مصدر الصورة",
    "editor.waifuSourceSnap": "لقطات الأنمي (waifu.im)",
    "editor.waifuSourceChar": "شخصيات الأنمي (AniList)",
    "editor.waifuGender": "الجنس",
    "editor.waifuGenderAll": "أي جنس",
    "editor.waifuGenderFemaleOnly": "أنثى فقط",
    "editor.waifuGenderMaleOnly": "ذكر فقط",
    "editor.waifuGenderFemale": "أنثى",
    "editor.waifuGenderMale": "ذكر",
    "editor.waifuCharSub": "ابحث عن شخصية بالاسم (مثل: zoro)",
    "editor.waifuSearch": "بحث في waifu.im",
    "editor.waifuSearchChar": "بحث عن الشخصيات",
    "editor.waifuSearchPlaceholderChar": "ابحث عن شخصية بالاسم (مثل: zoro)",
    "editor.waifuSub": "(يجلب صورًا بأسلوب الأنمي حسب الوسم)",
    "editor.waifuSearchPlaceholder": "مثال: waifu، جنية، خادمة...",
    "editor.waifuFetch": "جلب الصور",
    "editor.waifuRegenTitle": "إعادة توليد النتائج",
    "editor.waifuMixed": "نساء + رجال",
    "editor.waifuMixedSub": "حزمة متوازنة بنقرة واحدة: 3 شخصيات أنثى + 3 ذكور",
    "editor.waifuUse": "استخدام كصورة البطاقة",
    "editor.waifuUpload": "رفع من الجهاز",
    "editor.waifuRemove": "إزالة الصورة",
    "toast.noImage": "لا توجد صورة لإزالتها في هذه البطاقة",
    "toast.imageRemoved": "تمت إزالة الصورة",
    "editor.desc": "الوصف",
    "editor.descSub": "(المظهر، الخلفية)",
    "editor.descPlaceholder": "صف مظهر الشخصية وخلفيتها وسماتها الرئيسية...",
    "editor.firstMes": "الرسالة الأولى",
    "editor.firstMesPlaceholder": "الرسالة الأولى للشخصية عند بدء محادثة...",
    "editor.scenario": "السيناريو",
    "editor.scenarioPlaceholder": "الظروف الحالية وسياق المحادثة...",
    "editor.creator": "المنشئ",
    "editor.creatorPlaceholder": "منشئ البطاقة / المؤلف",
    "editor.version": "إصدار الشخصية",
    "editor.tags": "الوسوم",
    "editor.tagsSub": "(مفصولة بفواصل)",
    "editor.tagsPlaceholder": "خيال، محارب، قزم",
    "editor.personalitySummary": "ملخص الشخصية",
    "editor.personalityPlaceholder": "وصف موجز لشخصية الشخصية... (يُستخدم في تنسيق بطاقة الشخصية)",
    "editor.mesExample": "رسائل مثال",
    "editor.mesExampleFormat": "التنسيق: كتل <START> مع بادئات {{char}}: و{{user}}:",
    "editor.systemPrompt": "موجه النظام",
    "editor.systemPromptPlaceholder": "استبدل موجه النظام. استخدم {{original}} لتضمين الموجه الافتراضي.",
    "editor.postHistory": "تعليمات ما بعد السجل",
    "editor.postHistoryPlaceholder": "تعليمات تُدرج بعد سجل المحادثة. استخدم {{original}} للإعداد الافتراضي.",
    "editor.creatorNotes": "ملاحظات المنشئ",
    "editor.creatorNotesPlaceholder": "ملاحظات لمستخدمي البطاقة (توصيات النماذج، نصائح الاستخدام...)",
    "editor.greetings": "تحيات بديلة",
    "editor.addGreeting": "إضافة تحية",
    "editor.lorebookTitle": "مدخلات سجل العالم للشخصية",
    "editor.addEntry": "إضافة مدخل",
    "editor.lorebookSearch": "البحث في المدخلات حسب المفتاح أو المحتوى أو التعليق...",
    "editor.lorebookEmpty": "لا توجد مدخلات في سجل العالم بعد. أضف واحدة للبدء.",
    "editor.noGreetings": "لا توجد تحيات بعد. انقر على <strong>إضافة تحية</strong> أو استخدم الذكاء الاصطناعي لإنشاء بعضها.",
    "editor.noEntriesMatch": 'لا توجد مدخلات تطابق "{{query}}"',
    "editor.edit": "تعديل",
    "editor.preview": "معاينة",
    "ai.title": "مساعد الذكاء الاصطناعي",
    "ai.clearChat": "مسح المحادثة",
    "ai.welcomeTitle": "مساعد بطاقات الذكاء الاصطناعي",
    "ai.welcomeText": "اطلب من الذكاء الاصطناعي تعديل بطاقة الشخصية أو ترجمتها أو تحسينها.",
    "ai.quick.newCard": "بطاقة جديدة",
    "ai.quick.translate": "ترجمة",
    "ai.quick.enhance": "تحسين",
    "ai.quick.shorten": "اختصار",
    "ai.quick.tone": "تغيير النبرة",
    "ai.quick.grammar": "تصحيح القواعد",
    "ai.quick.personality": "توسيع الشخصية",
    "ai.quick.firstmes": "تحسين الرسالة الأولى",
    "ai.quick.scenario": "توسيع السيناريو",
    "ai.quick.greetings": "إنشاء تحيات",
    "ai.quick.systemprompt": "تحسين موجه النظام",
    "ai.quick.tags": "اقتراح وسوم",
    "ai.contextTitle": "الرموز المستخدمة التقديرية مقابل حد سياق النموذج",
    "ai.contextLabel": "— / — رمز",
    "ai.placeholder": "اطلب من الذكاء الاصطناعي تعديل البطاقة...",
    "ai.send": "إرسال",
    "ai.stop": "إيقاف التوليد",
    "ai.autoModel": "اختر النموذج...",
    "ai.target": "الهدف:",
    "ai.target.full": "البطاقة كاملة",
    "ai.target.description": "الوصف",
    "ai.target.personality": "الشخصية",
    "ai.target.first_mes": "الرسالة الأولى",
    "ai.target.scenario": "السيناريو",
    "ai.target.mes_example": "رسائل مثال",
    "ai.target.system_prompt": "موجه النظام",
    "ai.target.post_history_instructions": "تعليمات ما بعد السجل",
    "ai.target.creator_notes": "ملاحظات المنشئ",
    "ai.target.alternate_greetings": "تحيات بديلة",
    "ai.selectModel": "اختر نموذجًا",
    "ai.actionNewCard": "بطاقة جديدة",
    "ai.actionTranslate": "ترجمة",
    "ai.actionEnhance": "تحسين",
    "ai.actionShorten": "اختصار",
    "ai.actionTone": "تغيير النبرة",
    "ai.actionGrammar": "تصحيح القواعد",
    "ai.actionPersonality": "توسيع الشخصية",
    "ai.actionFirstMes": "تحسين الرسالة الأولى",
    "ai.actionScenario": "توسيع السيناريو",
    "ai.actionGreetings": "إنشاء تحيات",
    "ai.actionSystemprompt": "تحسين موجه النظام",
    "ai.actionTags": "اقتراح وسوم",
    "ai.chatHistory": "سجل المحادثة",
    "ai.historyTitle": "سجل المحادثة",
    "ai.historyEmpty": "لا توجد محادثات بعد",
    "ai.retry": "إعادة المحاولة",
    "ai.retryTitle": "إعادة توليد هذا الرد",
    "ai.reapply": "إعادة تطبيق",
    "ai.reapplyTitle": "أعد فتح الفرق لتطبيق هذه التغييرات",
    "ai.noCard": "(لم يتم تحديد بطاقة)",
    "ai.editing": "جارٍ تعديل {{count}} حقل...",
    "ai.streaming": "جارٍ البث...",
    "ai.failed": "فشل",
    "ai.cancelled": "تم الإلغاء.",
    "ai.doneSummary": "{{done}}/{{total}} اكتمل · {{errs}} فشل",
    "ai.viewFullResult": "عرض النتيجة الكاملة",
    "ai.showLess": "عرض أقل",
    "ai.reviewApply": "مراجعة وتطبيق",
    "ai.changesNav": "التغيير {{current}} من {{total}}",
    "ai.changesPrev": "التغيير السابق",
    "ai.changesNext": "التغيير التالي",
    "ai.applied": "تم التطبيق",
    "ai.target.tags": "الوسوم",
    "ai.copy": "نسخ",
    "ai.copied": "تم النسخ!",
    "ai.copyFailed": "فشل",
    "ai.resultTitle": "النتيجة",
    "ai.close": "إغلاق",
    "settings.themeColor": "لون السمة",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "اختر لونًا مميزًا منفصلًا لكل سمة فاتحة/داكنة. تُطبَّق التغييرات فورًا.",
    "settings.appearance": "المظهر",
    "settings.accentPresets": "إعدادات التمييز",
    "settings.glassDensity": "كثافة الزجاج",
    "settings.glassSubtle": "ناعم",
    "settings.glassDefault": "الافتراضي",
    "settings.glassBold": "جريء",
    "settings.cardRadius": "زوايا البطاقة",
    "settings.radiusCompact": "مضغوط",
    "settings.radiusRounded": "مدوَّر",
    "settings.radiusPill": "حبة",
    "settings.vignette": "تظليل الحواف",
    "settings.appearanceHint": "خصّص مظهر كل سمة فاتحة/داكنة. تُطبَّق تغييرات التمييز فورًا؛ تُضمَّن الكثافة والزوايا والتظليل في نسخ مساحة العمل الاحتياطية.",
    "settings.resetThemeColor": "إعادة تعيين",
    "settings.generalTab": "عام",
    "settings.promptsTab": "أوامر الذكاء الاصطناعي",
    "settings.assistantPrompt": "أمر نظام المساعد",
    "settings.fullCardPrompt": "أمر نظام البطاقة الكاملة",
    "settings.wizardPrompt": "تعليمات إنشاء الشخصية",
    "settings.promptPlaceholder": "اتركه فارغًا لاستخدام الأمر المدمج",
    "settings.chatSystemPrompts": "تعليمات الدردشة والنظام",
    "settings.fullCardInstr": "تعليمات إخراج البطاقة الكاملة (النظام)",
    "settings.fieldsEdit": "تعليمات تحرير الحقل (النظام)",
    "settings.greetingsSystem": "تعليمات إخراج التحيات (النظام)",
    "settings.exportPrompts": "تصدير الأوامر",
    "settings.importPrompts": "استيراد الأوامر",
    "settings.promptsExported": "تم تصدير الأوامر",
    "settings.promptsImported": "تم استيراد {count} أمر",
    "settings.quickActionPrompts": "أوامر الإجراءات السريعة",
    "settings.tagsSystemPrompt": "تعليمات إخراج الوسوم (النظام)",
    "settings.restoreDefaultPrompts": "استعادة الأوامر الافتراضية",
    "settings.promptHint": 'تعرض هذه الحقول الأوامر الحالية. إذا كان الحقل فارغًا، يُستخدم الأمر المدمج الافتراضي. استخدم "استعادة الافتراضي" لعرض الأوامر الأصلية أو استعادتها.',
    "settings.title": "الإعدادات",
    "settings.provider": "المزود",
    "settings.providerHint": "مزودو النماذج المستضافة أو نقطة نهاية مخصصة (LM Studio، Ollama، إلخ.)",
    "settings.apiKey": "مفتاح API",
    "settings.getApiKey": "احصل على مفتاح API الخاص بك من OpenRouter",
    "settings.baseUrl": "عنوان URL الأساسي لواجهة API",
    "settings.namedApiKeyPlaceholder": "أدخل مفتاح API الخاص بك",
    "settings.customHint": "نقطة نهاية متوافقة مع OpenAI. أمثلة: LM Studio http://localhost:1234/v1، Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "مفتاح API (اختياري)",
    "settings.apiKeyLocalPlaceholder": "اتركه فارغًا للمزودين المحليين",
    "settings.apiKeyLocalHint": "غير مطلوب للخوادم المحلية مثل LM Studio أو Ollama.",
    "settings.modelId": "معرّف النموذج",
    "settings.modelIdHint": "معرّف النموذج الدقيق الذي يتوقعه مزودك.",
    "settings.modelIdHintNamed": "اتركه فارغًا لاستخدام النموذج الافتراضي للمزود.",
    "settings.security": "يتم تشفير مفتاح API الخاص بك عند تخزينه في localStorage بالمتصفح بمفتاح مرتبط بهذا العنوان. لا تستخدم هذا التطبيق على أجهزة مشتركة.",
    "settings.secretUnreadable": "لأسباب أمنية، تعذر فتح قفل مفتاح API المحفوظ على هذا العنوان — يرجى إعادة إدخاله في الإعدادات.",
    "error.pngInflateFailed": "يحتوي ملف PNG هذا على بيانات شخصية تعذر فك ضغطها.",
    "settings.defaultModel": "النموذج الافتراضي",
    "settings.browseModels": "تصفح النماذج أدناه...",
    "settings.refreshModels": "تحديث النماذج",
    "settings.maxTokens": "أقصى رموز الإخراج",
    "settings.maxTokensPlaceholder": "0 = استخدام افتراضي النموذج",
    "settings.maxTokensHint": "تجاوز الحد الأقصى لرموز الإخراج لكل طلب. اضبطه على 0 لاستخدام حد النموذج المحدد تلقائيًا (أو 64 ألفًا إذا كان غير معروف).",
    "settings.copyright": "إدراج إشعار المحرر عند التصدير",
    "settings.copyrightHint": "يضيف سطر إشعار إلى ملاحظات المنشئ عند تصدير البطاقات.",
    "settings.availableModels": "النماذج المتاحة",
    "settings.searchModels": "البحث في النماذج...",
    "settings.enterApiKey": "أدخل مفتاح API وحدّث لتحميل النماذج",
    "settings.credits": "الرصيد والاستخدام",
    "settings.creditLimit": "حد الرصيد",
    "settings.remaining": "المتبقي",
    "settings.usedMonth": "المستخدم هذا الشهر",
    "settings.localStorage": "التخزين المحلي",
    "settings.clearAll": "مسح جميع البيانات",
    "settings.export": "تصدير",
    "settings.import": "استيراد",
    "settings.close": "إغلاق",
    "settings.saveSettings": "حفظ الإعدادات",
    "settings.languageLabel": "اللغة",
    "settings.languageHint": "لغة الواجهة (أعد تحميل الصفحة إذا كانت مفقودة)",
    "settings.languageChanged": "تم تحديث اللغة",
    "settings.clearConfirm": "حذف جميع البطاقات والإعدادات وسجل المحادثة؟ لا يمكن التراجع عن هذا الإجراء.",
    "settings.providerCustom": "مخصص (متوافق مع OpenAI)",
    "settings.noModels": "لم يتم العثور على نماذج",
    "settings.loadMore": "تحميل المزيد ({{count}} متبقي)",
    "settings.showingModels": "عرض {{shown}} من {{total}} نموذجًا",
    "wizard.title": "إنشاء شخصية",
    "wizard.step.basics": "الأساسيات",
    "wizard.step.concept": "المفهوم",
    "wizard.step.personality": "الشخصية",
    "wizard.step.scenario": "السيناريو",
    "wizard.step.generate": "توليد",
    "wizard.basicsTitle": "أساسيات الشخصية",
    "wizard.nameLabel": "اسم الشخصية",
    "wizard.namePlaceholder": "مثل: إيلارا نايتويسبير",
    "wizard.genderLabel": "الجنس / الضمائر",
    "wizard.genderSelect": "اختر...",
    "wizard.gender.female": "أنثى (هي)",
    "wizard.gender.male": "ذكر (هو)",
    "wizard.gender.nonbinary": "غير ثنائي (هم)",
    "wizard.gender.other": "أخرى...",
    "wizard.genderCustom": "ضمائر مخصصة (مثل: هو/هي)",
    "wizard.tagsLabel": "الوسوم",
    "wizard.tagsSub": "(مفصولة بفواصل، تساعد في تنظيم مكتبتك)",
    "wizard.tagsPlaceholder": "خيال، محارب، قزم، أصلي",
    "wizard.creatorLabel": "المنشئ",
    "wizard.creatorPlaceholder": "اسمك / اسمك المستعار",
    "wizard.conceptTitle": "المفهوم والإعداد",
    "wizard.typeLabel": "نوع الشخصية",
    "wizard.type.original": "شخصية أصلية",
    "wizard.type.fanfic": "قصة معجبين",
    "wizard.type.game": "شخصية لعبة",
    "wizard.type.anime": "أنمي / مانغا",
    "wizard.type.book": "كتاب / فيلم / مسلسل",
    "wizard.type.historical": "شخصية تاريخية",
    "wizard.type.mythological": "أسطورية / تراث شعبي",
    "wizard.type.vtuber": "VTuber / ستريمر",
    "wizard.type.other": "أخرى",
    "wizard.languageLabel": "اللغة",
    "wizard.language.other": "أخرى",
    "wizard.languageSpecify": "حدد اللغة",
    "wizard.genreLabel": "النوع / العالم",
    "wizard.genreSub": "(حدد كل ما ينطبق)",
    "wizard.moodLabel": "المزاج / النبرة",
    "wizard.moodSub": "(حدد كل ما ينطبق)",
    "wizard.personalityTitle": "الشخصية والمظهر",
    "wizard.personalityTraits": "سمات الشخصية",
    "wizard.personalityTraitsSub": "(صف 3-5 سمات رئيسية، هذا يساعد الذكاء الاصطناعي)",
    "wizard.personalityTraitsPlaceholder": "مثل: شجاعة ولكن متهورة، وفية بشدة لأصدقائها، تمتلك حس فكاهة جاف، تجد صعوبة في الثقة، تحب الحيوانات سرًا",
    "wizard.appearanceLabel": "المظهر الجسدي",
    "wizard.appearanceSub": "(وصف موجز لشكلهم)",
    "wizard.appearancePlaceholder": "مثل: امرأة طويلة بشعر فضي يصل إلى خصرها، يداها متندبتان، ترتدي سترة جلدية داكنة، عيناها خضراوان ثاقبتان",
    "wizard.abilitiesLabel": "قدرات خاصة / غرائب",
    "wizard.abilitiesSub": "(اختياري، أي سمات فريدة)",
    "wizard.abilitiesPlaceholder": "مثل: تستطيع التحدث مع الحيوانات، لديها ذاكرة فوتوغرافية، تحمل دائمًا يوميات مهترئة",
    "wizard.scenarioTitle": "السيناريو والرسالة الأولى",
    "wizard.scenarioLabel": "السيناريو / الإعداد",
    "wizard.scenarioSub": "(أين تبدأ القصة؟)",
    "wizard.scenarioPlaceholder": "مثل: ليلة ممطرة في مدينة مضاءة بالنيون. تدير الشخصية ورشة إصلاح صغيرة تصلح الآلات والقلوب المكسورة معًا.",
    "wizard.relationshipLabel": "العلاقة مع {{user}}",
    "wizard.relationshipSub": "(كيف ترى الشخصية المستخدم؟)",
    "wizard.relationshipPlaceholder": "مثل: زبون جديد دخل الورشة بجهاز معطل غامض. الشخصية فضولية لكنها حذرة.",
    "wizard.openingLabel": "أجواء الرسالة الأولى",
    "wizard.openingSub": "(كيف يجب أن تبدو رسالة الافتتاح؟)",
    "wizard.notesLabel": "ملاحظات إضافية",
    "wizard.notesSub": "(أي شيء آخر يجب أن يعرفه الذكاء الاصطناعي؟)",
    "wizard.notesPlaceholder": "مثل: حافظ على الحوار طبيعيًا، تجنب الرسمية المفرطة، أدرج أوصاف الأفعال بين علامتي نجمتين",
    "wizard.generateTitle": "توليد شخصية",
    "wizard.refImage": "صورة مرجعية",
    "wizard.refImageSub": "(اختياري، من waifu.im)",
    "wizard.fetchImages": "جلب 3 صور",
    "wizard.refetchOthers": "جلب أخرى",
    "wizard.fetching": "جارٍ الجلب...",
    "wizard.useSelected": "استخدام المحدد",
    "wizard.clear": "مسح",
    "wizard.generateAI": "توليد بالذكاء الاصطناعي",
    "wizard.generateAISub": "بطاقة شخصية كاملة من إجاباتك",
    "wizard.createBlank": "إنشاء بطاقة فارغة",
    "wizard.createBlankSub": "ابدأ بالاسم والوسوم معبأة مسبقًا",
    "wizard.back": "رجوع",
    "wizard.next": "التالي",
    "wizard.stepLabel": "الخطوة {{step}} من {{total}}",
    "wizard.ready": "جاهز للتوليد!",
    "wizard.nameRequired": "يرجى إدخال اسم الشخصية",
    "wizard.summary.name": "الاسم",
    "wizard.summary.gender": "الجنس",
    "wizard.summary.type": "النوع",
    "wizard.summary.language": "اللغة",
    "wizard.summary.tags": "الوسوم",
    "wizard.summary.genres": "الأنواع",
    "wizard.summary.mood": "المزاج",
    "wizard.summary.opening": "الافتتاح",
    "wizard.summary.personality": "الشخصية",
    "wizard.summary.appearance": "المظهر",
    "wizard.summary.scenario": "السيناريو",
    "wizard.summary.relationship": "العلاقة",
    "wizard.summary.notes": "الملاحظات",
    "wizard.chip.fantasy": "خيال",
    "wizard.chip.scifi": "خيال علمي",
    "wizard.chip.modern": "حديث",
    "wizard.chip.historical": "تاريخي",
    "wizard.chip.horror": "رعب",
    "wizard.chip.romance": "رومانسي",
    "wizard.chip.comedy": "كوميديا",
    "wizard.chip.sliceOfLife": "شريحة من الحياة",
    "wizard.chip.adventure": "مغامرة",
    "wizard.chip.mystery": "غموض",
    "wizard.chip.cyberpunk": "سايبربانك",
    "wizard.chip.postApocalyptic": "ما بعد نهاية العالم",
    "wizard.chip.supernatural": "خارق للطبيعة",
    "wizard.chip.military": "عسكري",
    "wizard.chip.surreal": "سريالي",
    "wizard.chip.serious": "جاد",
    "wizard.chip.playful": "مرح",
    "wizard.chip.dark": "قاتم",
    "wizard.chip.lighthearted": "خفيف الظل",
    "wizard.chip.mysterious": "غامض",
    "wizard.chip.romantic": "رومانسي",
    "wizard.chip.intense": "مكثف",
    "wizard.chip.wholesome": "دافئ وإيجابي",
    "wizard.chip.chaotic": "فوضوي",
    "wizard.chip.melancholic": "كئيب",
    "wizard.chip.sarcastic": "ساخر",
    "wizard.chip.stoic": "رواقي",
    "wizard.chip.greeting": "تحية دافئة",
    "wizard.chip.action": "في خضم الأحداث",
    "wizard.chip.question": "سؤال مثير للفضول",
    "wizard.chip.conflict": "صراع فوري",
    "wizard.chip.atmospheric": "جوي",
    "wizard.editStep": "تعديل هذا القسم",
    "wizard.draftRestored": "تمت استعادة المسودة — عادت إجاباتك السابقة",
    "wizard.imagePlaceholder": "انقر على جلب",
    "diff.title": "معاينة رد الذكاء الاصطناعي",
    "diff.removed": "تمت الإزالة",
    "diff.added": "تمت الإضافة",
    "diff.current": "الحالي",
    "diff.proposed": "المقترح",
    "diff.empty": "(فارغ)",
    "diff.discard": "تجاهل",
    "diff.apply": "تطبيق التغييرات",
    "shortcuts.title": "الاختصارات",
    "shortcuts.save": "حفظ البطاقة",
    "shortcuts.newCard": "بطاقة جديدة",
    "shortcuts.undo": "تراجع",
    "shortcuts.redo": "إعادة",
    "shortcuts.sendAi": "إرسال رسالة للذكاء الاصطناعي",
    "shortcuts.newLine": "سطر جديد في الذكاء الاصطناعي",
    "shortcuts.focus": "وضع التركيز",
    "shortcuts.collapsePanel": "طي/توسيع لوحة الذكاء الاصطناعي",
    "toast.loadFailed": "فشل: {{name}}",
    "toast.loaded": "تم تحميل {{count}} بطاقة",
    "toast.importDupe": "نفس محتوى بطاقة موجودة — تم الاستيراد باسم {{name}}",
    "toast.largeImage": "صورة كبيرة مضمنة في {{name}} ({{size}} م.ب) - فكّر في إزالتها لتوفير المساحة.",
    "toast.noValid": "لم يتم العثور على بطاقات صالحة. أفلت ملفات PNG أو JSON.",
    "toast.noSelected": "لم يتم تحديد بطاقات",
    "toast.cardsDeleted": "تم حذف البطاقات",
    "toast.deleteFailed": "فشل حذف البطاقة",
    "toast.exported": "تم تصدير {{count}} بطاقة",
    "toast.newBlank": "تم إنشاء بطاقة فارغة جديدة",
    "toast.noCardSave": "لا توجد بطاقة للحفظ",
    "toast.cardSaved": "تم حفظ البطاقة!",
    "toast.noCardDup": "لا توجد بطاقة لتكرارها",
    "toast.cardDup": "تم تكرار البطاقة",
    "toast.cardRestored": "تمت استعادة البطاقة",
    "toast.selectCard": "حدد بطاقة أولاً",
    "toast.avatarUpdated": "تم تحديث الصورة الرمزية",
    "toast.imgFailed": "فشل تحميل الصورة",
    "toast.firstMesUpdated": "تم تحديث الرسالة الأولى!",
    "toast.settingsSaved": "تم حفظ الإعدادات!",
    "toast.modelsFailed": "فشل تحميل النماذج: {{error}}",
    "toast.modelSet": "تم تعيين النموذج: {{model}}",
    "toast.dataCleared": "تم مسح جميع البيانات",
    "toast.settingsExported": "تم تصدير الإعدادات",
    "toast.settingsImported": "تم استيراد الإعدادات!",
    "toast.invalidFile": "ملف إعدادات غير صالح",
    "toast.apiKey": "عيّن مفتاح API الخاص بك في الإعدادات",
    "toast.selectModel": "يرجى اختيار نموذج من شريط التنقل أو الإعدادات أولاً.",
    "toast.genStopped": "تم إيقاف التوليد.",
    "toast.aiError": "خطأ في الذكاء الاصطناعي: {{error}}",
    "toast.cardUpdatedAI": "تم تحديث البطاقة من رد الذكاء الاصطناعي!",
    "toast.jsonParseFailed": "تعذر تحليل رد الذكاء الاصطناعي كـ JSON. تحقق من المحادثة.",
    "toast.emptyResponse": "أعادت AI محتوى فارغ — لا شيء لتطبيقه.",
    "toast.jsonInvalid": "لم يُرجع الذكاء الاصطناعي JSON صالحًا. الرد موجود في المحادثة — يمكنك نسخه يدويًا.",
    "toast.fieldUpdated": 'تم تحديث "{{field}}"!',
    "toast.greetingsUpdated": "تم توليد {{count}} تحية!",
    "toast.tagsUpdated": "تم تحديث الوسوم — أُضيف {{count}} وسم جديد!",
    "toast.greetingsParseFailed": "تعذر تحليل التحيات من رد الذكاء الاصطناعي.",
    "toast.createCardFirst": "أنشئ بطاقة أو حددها أولاً",
    "toast.wizardCreated": "تم إنشاء البطاقة! ابدأ التعديل أو استخدم الذكاء الاصطناعي لملء التفاصيل.",
    "toast.wizardApi": "عيّن مفتاح API الخاص بك في الإعدادات أولاً",
    "toast.wizardModel": "اختر نموذجًا أو عيّن معرّف نموذج مخصص في الإعدادات",
    "toast.wizardFetchFailed": "فشل جلب الصور: {{error}}",
    "toast.wizardName": "يرجى إدخال اسم الشخصية",
    "toast.storageFull": "التخزين ممتلئ! جرّب إزالة بعض البطاقات أو تصديرها.",
    "toast.exportedJson": "تم التصدير كـ JSON!",
    "toast.exportedPng": "تم التصدير كـ PNG مع بيانات البطاقة!",
    "toast.exportFailed": "فشل تصدير الصورة. الرجوع إلى JSON.",
    "toast.noNameWarning": 'تحذير: البطاقة بدون اسم. سيتم حفظ الملف باسم "character.json".',
    "toast.chatCleared": "تم مسح المحادثة",
    "toast.selectField": "حدد حقلًا واحدًا على الأقل للتعديل",
    "toast.tooManyFields": "عدد حقول محدد كبير جدًا. الحد الأقصى {{max}} في المرة الواحدة.",
    "toast.undo": "تراجع",
    "toast.redo": "إعادة",
    "toast.reorderFiltered": "أوقف تشغيل البحث والفلاتر لإعادة ترتيب البطاقات.",
    "error.apiKeyNotSet": "لم يتم تعيين مفتاح API. أدخل مفتاح API الخاص بك في الإعدادات.",
    "error.customUrlNotSet": "لم يتم تعيين عنوان URL الأساسي لواجهة برمجة التطبيقات المخصصة. افتح الإعدادات ← مخصص (متوافق مع OpenAI) وأدخل عنوان URL لنقطة النهاية (مثل http://localhost:1234/v1).",
    "error.customServerError": "أعاد الخادم خطأً: {{detail}}",
    "error.customAuthFailed": "فشل المصادقة (HTTP {{status}}). تحقق من مفتاح API لهذه النقطة.",
    "error.customPathNotFound": "نقطة النهاية غير موجودة (HTTP 404). تحقق من أن عنوان URL الأساسي لواجهة برمجة التطبيقات مكتمل (مثل يتضمن /v1).",
    "error.customUnreachable": "تعذر الوصول إلى {{url}}. تحقق من أن الخادم يعمل وأن عنوان URL الأساسي لواجهة برمجة التطبيقات صحيح ويمكن الوصول إليه من هذا الجهاز.",
    "error.noModel": "لم يتم تحديد نموذج. اختر نموذجًا أو عيّن معرّف نموذج في الإعدادات.",
    "error.noModelSimple": "لم يتم تحديد نموذج.",
    "error.insufficientCredits": "رصيد غير كافٍ. يرجى تعبئة حسابك.",
    "error.storageFull": "التخزين ممتلئ! جرّب إزالة بعض البطاقات أو تصديرها.",
    "gen.empty": "(فارغ)",
    "gen.free": "مجاني",
    "gen.unlimited": "غير محدود",
    "gen.notAvailable": "غير متاح",
    "gen.unnamed": "بدون اسم",
    "gen.byCreator": "بواسطة {{name}}",
    "gen.copySuffix": " (نسخة)",
    "gen.toastAutoHide": "يختفي تلقائيًا خلال {{s}} ثانية",
    "gen.untagged": "لم يتم العثور على وسوم",
    "gen.noMatch": "لا توجد بطاقات تطابق فلاترك",
    "batch.deleteConfirm": "حذف {{count}} بطاقة؟ لا يمكن التراجع عن هذا الإجراء.",
    "left.selected": "تم تحديد {{count}}",
    "toast.cardDeleted": 'تم حذف البطاقة "{{name}}"',
    "ai.apply": "تطبيق",
    "ai.applyTitle": "تطبيق هذه التغييرات على البطاقة",
    "ai.errorPrefix": "خطأ: ",
    "ai.translatePrompt": "إلى أي لغة تريد الترجمة؟",
    "ai.translateDefaultLang": "الفرنسية",
    "ai.tonePrompt": "أي نبرة؟ (مثل: رسمية، غير رسمية، قاتمة، فكاهية، شعرية)",
    "ai.toneDefault": "رسمية",
    "ai.chatSession": "جلسة المحادثة",
    "ai.msgs": "{{count}} رسالة",
    "ai.tokensIn": " إدخال · ",
    "ai.tokensOut": " إخراج · ",
    "ai.tokensCtx": " سياق",
    "ai.exceedsLimit": " ⚠ يتجاوز الحد!",
    "ai.approachingLimit": " ⚠ الحد قريب",
    "ai.count": "العدد:",
    "ai.resizeAria": "تغيير حجم مساعد الذكاء الاصطناعي",
    "ai.chatMessagesAria": "رسائل محادثة الذكاء الاصطناعي",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: حوار مثال هنا...
{{user}}: رد المستخدم...
<START>
{{char}}: مثال آخر...`,
    "batch.select2ForCompare": "حدد بطاقتين بالضبط للمقارنة",
    "batch.compareLoadFailed": "فشل تحميل البطاقات للمقارنة",
    "batch.comparePrefix": "مقارنة: ",
    "batch.compareVs": " مقابل ",
    "batch.cardA": "البطاقة أ",
    "batch.cardB": "البطاقة ب",
    "editor.charCount": "{{chars}} حرفًا ~{{tokens}} رمزًا",
    "editor.counterWarn": "قريب من حد رموز الإخراج ({{tokens}}/{{max}}).",
    "editor.counterDanger": "تجاوز حد رموز الإخراج ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "تحريك لأعلى",
    "editor.greetingMoveDown": "تحريك لأسفل",
    "editor.greetingIsDefault": "هذه هي الرسالة الأولى الحالية",
    "editor.greetingSetDefault": "تعيين كرسالة أولى",
    "editor.greetingRemove": "إزالة",
    "editor.greetingPlaceholder": "تحية {{num}}...",
    "editor.loreEntry": "مدخل {{num}}",
    "editor.loreDeleteEntry": "حذف المدخل",
    "editor.lorePrimaryKeys": "الكلمات المفتاحية الأساسية",
    "editor.lorePrimaryKeysPlaceholder": "الكلمات المفتاحية الأساسية — مفصولة بفواصل",
    "editor.loreSecondaryKeys": "الكلمات المفتاحية الثانوية",
    "editor.loreSecondaryKeysPlaceholder": "الكلمات المفتاحية الثانوية",
    "editor.loreComment": "تعليق",
    "editor.loreCommentPlaceholder": "تعليق",
    "editor.loreOrder": "الترتيب",
    "editor.loreOrderPlaceholder": "الترتيب",
    "editor.loreConstant": "ثابت",
    "editor.loreSelective": "انتقائي",
    "editor.loreBeforeChar": "قبل الشخصية",
    "editor.loreAfterChar": "بعد الشخصية",
    "editor.loreContent": "المحتوى",
    "editor.loreContentPlaceholder": "محتوى المدخل...",
    "editor.loreNewEntry": "مدخل جديد",
    "error.unknown": "خطأ غير معروف",
    "error.unexpected": "خطأ غير متوقع: {{message}}",
    "error.requestFailed": "فشل الطلب: {{message}}",
    "error.unsupportedFile": "نوع ملف غير مدعوم: .{{ext}}",
    "error.invalidJson": "JSON غير صالح: {{message}}",
    "error.notPng": "ليس ملف PNG صالحًا",
    "error.unknownFormat": "تنسيق بطاقة غير معروف — ليست بطاقة شخصية SillyTavern",
    "error.fetchModelsFailed": "فشل جلب النماذج (HTTP {{status}})",
    "error.noChoices": "لم تُرجع واجهة API أي خيارات للرد",
    "error.emptyResponse": "رد فارغ من واجهة API (لا يوجد محتوى)",
    "gen.newCharacter": "شخصية جديدة",
    "gen.bytes": " بايت",
    "gen.kilobytes": " كيلوبايت",
    "gen.megabytes": " ميجابايت",
    "settings.backup": "نسخ احتياطي",
    "settings.restore": "استعادة",
    "settings.backupTitle": "نسخ احتياطي لجميع البطاقات",
    "settings.restoreTitle": "استعادة النسخة الاحتياطية",
    "settings.exportTitle": "تصدير الإعدادات",
    "settings.importTitle": "استيراد الإعدادات",
    "settings.modelAuto": "تلقائي",
    "settings.modelIdPlaceholder": "مثل: deepseek-v4-flash",
    "settings.customModelPlaceholder": "مثل: llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "مثل: {{provider}}-latest",
    "settings.getApiKeyFrom": "احصل على مفتاح API من ",
    "settings.customModelDesc": "نموذج مخصص",
    "settings.workspaceExported": "تم تصدير مساحة العمل ({{count}} بطاقة)",
    "settings.invalidWorkspace": "تنسيق مساحة عمل غير صالح",
    "settings.workspaceImported": "تم استيراد مساحة العمل ({{count}} بطاقة)",
    "settings.workspaceImportFailed": "فشل استيراد مساحة العمل: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "تبديل مساعد الذكاء الاصطناعي",
    "nav.toggleAIAria": "تبديل مساعد الذكاء الاصطناعي",
    "nav.notificationsAria": "الإشعارات",
    "left.sortCards": "فرز البطاقات",
    "left.compareSelected": "مقارنة البطاقات المحددة",
    "left.resizeAria": "تغيير حجم مكتبة البطاقات",
    "left.cardListAria": "مكتبة البطاقات",
    "ui.saved": " تم الحفظ",
    "ui.collapsePanel": "طي اللوحة",
    "ui.expandPanel": "توسيع اللوحة",
    "ui.cardModified": "تغييرات غير محفوظة",
    "export.minimalPngLabel": "بطاقة ST",
    "wizard.search": "بحث",
    "wizard.quick": "سريع:",
    "wizard.imageSearchPlaceholder": "ابحث عن وسوم: قطة، فستان، زي رسمي، سايبربانك...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.he = {
    "app.title": "ST Card Editor — סטודיו לכרטיסי דמויות SillyTavern",
    "nav.selectModel": "בחרו מודל...",
    "nav.wizard": "יצירה עם אשף ה-AI",
    "nav.newCard": "כרטיס ריק חדש",
    "nav.save": "שמירה",
    "nav.theme": "מעבר בין ערכות נושא",
    "nav.shortcuts": "קיצורי דרך ועזרה",
    "nav.settings": "הגדרות",
    "nav.focus": "מצב מיקוד",
    "nav.focusAlt": "מצב מיקוד (Alt+F)",
    "left.title": "ספריית כרטיסים",
    "left.cards": "{{count}} כרטיסים",
    "left.drop": "גרירה ושחרור",
    "left.sort.manual": "ידני",
    "left.dropSub": "כרטיסי דמות בפורמט PNG או JSON",
    "left.browse": "עיון בקבצים",
    "left.search": "חיפוש כרטיסים...",
    "left.sort.nameAsc": "שם א-ת",
    "left.sort.nameDesc": "שם ת-א",
    "left.sort.newest": "החדשים ביותר ראשונים",
    "left.sort.oldest": "הוותיקים ביותר ראשונים",
    "left.sort.largest": "הגדולים ביותר",
    "left.sort.smallest": "הקטנים ביותר",
    "left.filterTags": "סינון לפי תגיות",
    "left.exportSelected": "ייצוא הנבחרים כ-JSON",
    "left.deleteSelected": "מחיקת הנבחרים",
    "left.empty": "לא נטענו כרטיסים",
    "left.emptySub": "שחררו כרטיס או לחצו על עיון",
    "center.noCard": "לא נבחר כרטיס",
    "center.noCardSub": "בחרו כרטיס מהספרייה או גררו ושחררו כרטיס חדש",
    "center.createAI": "יצירה עם AI",
    "center.blankCard": "כרטיס ריק",
    "editor.avatar": "לחצו או שחררו תמונה כדי להגדיר את התמונה הראשית",
    "editor.avatarAria": "הגדרת תמונה ראשית לדמות",
    "editor.name": "שם הדמות",
    "editor.exportJson": "ייצוא כ-JSON",
    "editor.exportPng": "ייצוא כ-PNG",
    "editor.duplicate": "שכפול כרטיס",
    "editor.delete": "מחיקת כרטיס",
    "editor.tab.core": "עיקרי",
    "editor.tab.personality": "אישיות",
    "editor.tab.advanced": "מתקדם",
    "editor.tab.lorebook": "ספר העולם",
    "editor.tab.waifu": "תמונת Waifu",
    "editor.waifuPreview": "תמונת הכרטיס הנוכחית",
    "editor.waifuNoImage": "עדיין לא הוגדרה תמונה",
    "editor.waifuSource": "מקור התמונה",
    "editor.waifuSourceSnap": "רגעי אנימה (waifu.im)",
    "editor.waifuSourceChar": "דמויות אנימה (AniList)",
    "editor.waifuGender": "מגדר",
    "editor.waifuGenderAll": "כל מגדר",
    "editor.waifuGenderFemaleOnly": "נשים בלבד",
    "editor.waifuGenderMaleOnly": "גברים בלבד",
    "editor.waifuGenderFemale": "נקבה",
    "editor.waifuGenderMale": "זכר",
    "editor.waifuCharSub": "חפש דמות לפי שם (למשל: zoro)",
    "editor.waifuSearch": "חיפוש ב-waifu.im",
    "editor.waifuSearchChar": "חיפוש דמויות",
    "editor.waifuSearchPlaceholderChar": "חפש דמות לפי שם (למשל: zoro)",
    "editor.waifuSub": "(מביא תמונות בסגנון אנימה לפי תג)",
    "editor.waifuSearchPlaceholder": "למשל: waifu, שדונית, משרתת...",
    "editor.waifuFetch": "הבא תמונות",
    "editor.waifuRegenTitle": "צור מחדש תוצאות",
    "editor.waifuMixed": "נשים + גברים",
    "editor.waifuMixedSub": "חבילה מאוזנת בקליק אחד: 3 נקבות + 3 זכרים",
    "editor.waifuUse": "השתמש כתמונת כרטיס",
    "editor.waifuUpload": "העלה מהמכשיר",
    "editor.waifuRemove": "הסר תמונה",
    "toast.noImage": "לכרטיס זה אין תמונה להסרה",
    "toast.imageRemoved": "התמונה הוסרה",
    "editor.desc": "תיאור",
    "editor.descSub": "(מראה, רקע)",
    "editor.descPlaceholder": "תארו את המראה, הרקע והתכונות המרכזיות של הדמות...",
    "editor.firstMes": "הודעה ראשונה",
    "editor.firstMesPlaceholder": "ההודעה הראשונה של הדמות בתחילת שיחה...",
    "editor.scenario": "תרחיש",
    "editor.scenarioPlaceholder": "הנסיבות הנוכחיות וההקשר של השיחה...",
    "editor.creator": "יוצר",
    "editor.creatorPlaceholder": "יוצר / מחבר הכרטיס",
    "editor.version": "גרסת הדמות",
    "editor.tags": "תגיות",
    "editor.tagsSub": "(מופרדות בפסיקים)",
    "editor.tagsPlaceholder": "פנטזיה, לוחם, אלף",
    "editor.personalitySummary": "סיכום אישיות",
    "editor.personalityPlaceholder": "תיאור קצר של אישיות הדמות... (משמש בפורמט כרטיס הדמות)",
    "editor.mesExample": "הודעות לדוגמה",
    "editor.mesExampleFormat": "פורמט: בלוקים של <START> עם קידומות {{char}}: ו-{{user}}:",
    "editor.systemPrompt": "הנחיית מערכת",
    "editor.systemPromptPlaceholder": "החליפו את הנחיית המערכת. השתמשו ב-{{original}} כדי לכלול את ברירת המחדל.",
    "editor.postHistory": "הוראות לאחר ההיסטוריה",
    "editor.postHistoryPlaceholder": "הוראות המוזרקות לאחר היסטוריית הצ'אט. השתמשו ב-{{original}} לברירת המחדל.",
    "editor.creatorNotes": "הערות יוצר",
    "editor.creatorNotesPlaceholder": "הערות למשתמשי הכרטיס (המלצות מודלים, טיפים לשימוש...)",
    "editor.greetings": "ברכות חלופיות",
    "editor.addGreeting": "הוספת ברכה",
    "editor.lorebookTitle": "ערכות ספר העולם של הדמות",
    "editor.addEntry": "הוספת ערכה",
    "editor.lorebookSearch": "חיפוש ערכות לפי מפתח, תוכן או תגובה...",
    "editor.lorebookEmpty": "אין עדיין ערכות בספר העולם. הוסיפו אחת כדי להתחיל.",
    "editor.noGreetings": "אין עדיין ברכות. לחצו על <strong>הוספת ברכה</strong> או השתמשו ב-AI ליצירתן.",
    "editor.noEntriesMatch": 'אין ערכות תואמות ל"{{query}}"',
    "editor.edit": "עריכה",
    "editor.preview": "תצוגה מקדימה",
    "ai.title": "עוזר AI",
    "ai.clearChat": "ניקוי הצ'אט",
    "ai.welcomeTitle": "עוזר כרטיסי AI",
    "ai.welcomeText": "בקשו מה-AI לערוך, לתרגם או לשפר את כרטיס הדמות שלכם.",
    "ai.quick.newCard": "כרטיס חדש",
    "ai.quick.translate": "תרגום",
    "ai.quick.enhance": "שיפור",
    "ai.quick.shorten": "קיצור",
    "ai.quick.tone": "שינוי נימה",
    "ai.quick.grammar": "תיקון דקדוק",
    "ai.quick.personality": "הרחבת אישיות",
    "ai.quick.firstmes": "שיפור ההודעה הראשונה",
    "ai.quick.scenario": "הרחבת תרחיש",
    "ai.quick.greetings": "יצירת ברכות",
    "ai.quick.systemprompt": "שיפור הנחיית המערכת",
    "ai.quick.tags": "הצעת תגיות",
    "ai.contextTitle": "טוקנים משוערים בשימוש לעומת מגבלת ההקשר של המודל",
    "ai.contextLabel": "— / — טוקנים",
    "ai.placeholder": "בקשו מה-AI לערוך את הכרטיס...",
    "ai.send": "שליחה",
    "ai.stop": "עצירת יצירה",
    "ai.autoModel": "בחרו מודל...",
    "ai.target": "יעד:",
    "ai.target.full": "כל הכרטיס",
    "ai.target.description": "תיאור",
    "ai.target.personality": "אישיות",
    "ai.target.first_mes": "הודעה ראשונה",
    "ai.target.scenario": "תרחיש",
    "ai.target.mes_example": "הודעות לדוגמה",
    "ai.target.system_prompt": "הנחיית מערכת",
    "ai.target.post_history_instructions": "הוראות לאחר ההיסטוריה",
    "ai.target.creator_notes": "הערות יוצר",
    "ai.target.alternate_greetings": "ברכות חלופיות",
    "ai.selectModel": "בחרו מודל",
    "ai.actionNewCard": "כרטיס חדש",
    "ai.actionTranslate": "תרגום",
    "ai.actionEnhance": "שיפור",
    "ai.actionShorten": "קיצור",
    "ai.actionTone": "שינוי נימה",
    "ai.actionGrammar": "תיקון דקדוק",
    "ai.actionPersonality": "הרחבת אישיות",
    "ai.actionFirstMes": "שיפור ההודעה הראשונה",
    "ai.actionScenario": "הרחבת תרחיש",
    "ai.actionGreetings": "יצירת ברכות",
    "ai.actionSystemprompt": "שיפור הנחיית המערכת",
    "ai.actionTags": "הצעת תגיות",
    "ai.chatHistory": "היסטוריית צ'אט",
    "ai.historyTitle": "היסטוריית צ'אט",
    "ai.historyEmpty": "אין עדיין שיחות",
    "ai.retry": "ניסיון חוזר",
    "ai.retryTitle": "יצירה מחדש של תשובה זו",
    "ai.reapply": "החלה מחדש",
    "ai.reapplyTitle": "פתיחה מחדש של ההשוואה להחלת שינויים אלה",
    "ai.noCard": "(לא נבחר כרטיס)",
    "ai.editing": "עריכת {{count}} שדות...",
    "ai.streaming": "זורם...",
    "ai.failed": "נכשל",
    "ai.cancelled": "בוטל.",
    "ai.doneSummary": "{{done}}/{{total}} הושלמו · {{errs}} נכשלו",
    "ai.viewFullResult": "הצגת התוצאה המלאה",
    "ai.showLess": "הצגה פחותה",
    "ai.reviewApply": "סקירה והחלה",
    "ai.changesNav": "שינוי {{current}} מתוך {{total}}",
    "ai.changesPrev": "שינוי קודם",
    "ai.changesNext": "שינוי הבא",
    "ai.applied": "הוחל",
    "ai.target.tags": "תגיות",
    "ai.copy": "העתקה",
    "ai.copied": "הועתק!",
    "ai.copyFailed": "נכשל",
    "ai.resultTitle": "תוצאה",
    "ai.close": "סגירה",
    "settings.themeColor": "צבע ערכת העיצוב",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "בחרו צבע הדגשה נפרד לכל ערכת עיצוב בהירה/כהה. שינויים מוחלים מיד.",
    "settings.appearance": "מראה",
    "settings.accentPresets": "הגדרות מוקדמות של הדגשה",
    "settings.glassDensity": "צפיפות זכוכית",
    "settings.glassSubtle": "עדין",
    "settings.glassDefault": "ברירת מחדל",
    "settings.glassBold": "נועז",
    "settings.cardRadius": "רדיוס כרטיס",
    "settings.radiusCompact": "קומפקטי",
    "settings.radiusRounded": "מעוגל",
    "settings.radiusPill": "גלולה",
    "settings.vignette": "וינייטה לקצוות",
    "settings.appearanceHint": "התאם את המראה לכל ערכת נושא בהירה/כהה. שינויי הדגשה חלים מיד; צפיפות, רדיוס ווינייטה נכללים בגיבוי סביבת העבודה.",
    "settings.resetThemeColor": "איפוס",
    "settings.generalTab": "כללי",
    "settings.promptsTab": "פרומפטים של AI",
    "settings.assistantPrompt": "פרומפט מערכת של העוזר",
    "settings.fullCardPrompt": "פרומפט מערכת לכרטיס המלא",
    "settings.wizardPrompt": "הוראות יצירת דמות",
    "settings.promptPlaceholder": "השאירו ריק לשימוש בפרומפט המובנה",
    "settings.chatSystemPrompts": "הוראות צ'אט ומערכת",
    "settings.fullCardInstr": "הוראות פלט לכרטיס מלא (מערכת)",
    "settings.fieldsEdit": "הוראות עריכת שדה (מערכת)",
    "settings.greetingsSystem": "הוראות פלט ברכות (מערכת)",
    "settings.exportPrompts": "ייצא פרומפטים",
    "settings.importPrompts": "ייבא פרומפטים",
    "settings.promptsExported": "הפרומפטים יוצאו",
    "settings.promptsImported": "יובאו {count} פרומפטים",
    "settings.quickActionPrompts": "פרומפטים לפעולות מהירות",
    "settings.tagsSystemPrompt": "הוראות פלט תגיות (מערכת)",
    "settings.restoreDefaultPrompts": "שחזור פרומפטים לברירת המחדל",
    "settings.promptHint": "השדות האלה מציגים את הפרומפטים הנוכחיים. אם שדה ריק, נעשה שימוש בפרומפט ברירת המחדל המובנה. שחזרו ברירות מחדל כדי להציג או להחזיר את הפרומפטים המקוריים.",
    "settings.title": "הגדרות",
    "settings.provider": "ספק",
    "settings.providerHint": "ספקי מודלים מתארחים או נקודת קצה מותאמת אישית (LM Studio, Ollama וכו')",
    "settings.apiKey": "מפתח API",
    "settings.getApiKey": "קבלו את מפתח ה-API שלכם מ-OpenRouter",
    "settings.baseUrl": "כתובת הבסיס של ה-API",
    "settings.namedApiKeyPlaceholder": "הזינו את מפתח ה-API שלכם",
    "settings.customHint": "נקודת קצה תואמת OpenAI. דוגמאות: LM Studio http://localhost:1234/v1, Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "מפתח API (אופציונלי)",
    "settings.apiKeyLocalPlaceholder": "השאירו ריק עבור ספקים מקומיים",
    "settings.apiKeyLocalHint": "אין צורך בשרתים מקומיים כמו LM Studio או Ollama.",
    "settings.modelId": "מזהה מודל",
    "settings.modelIdHint": "מזהה המודל המדויק שהספק שלכם מצפה לו.",
    "settings.modelIdHintNamed": "השאירו ריק לשימוש במודל ברירת המחדל של הספק.",
    "settings.security": "מפתח ה-API שלכם מוצפן בעת שמירה ב-localStorage של הדפדפן עם מפתח המקושר לכתובת זו. אל תשתמשו באפליקציה זו במכשירים משותפים.",
    "settings.secretUnreadable": "מסיבות אבטחה, לא ניתן היה לבטל את הנעילה של מפתח API שמור בכתובת זו — אנא הזינו אותו שוב בהגדרות.",
    "error.pngInflateFailed": "קובץ PNG זה מכיל נתוני דמות שלא ניתן היה לפתוח.",
    "settings.defaultModel": "מודל ברירת מחדל",
    "settings.browseModels": "עיינו במודלים למטה...",
    "settings.refreshModels": "רענון מודלים",
    "settings.maxTokens": "מקסימום טוקני פלט",
    "settings.maxTokensPlaceholder": "0 = שימוש בברירת המחדל של המודל",
    "settings.maxTokensHint": "עקיפת המספר המקסימלי של טוקני הפלט לכל בקשה. הגדירו 0 לשימוש אוטומטי במגבלת המודל הנבחר (או 64 אלף אם לא ידוע).",
    "settings.copyright": "הזרקת קרדיט לעורך בעת ייצוא",
    "settings.copyrightHint": "מוסיף שורת קרדיט להערות היוצר בעת ייצוא כרטיסים.",
    "settings.availableModels": "מודלים זמינים",
    "settings.searchModels": "חיפוש מודלים...",
    "settings.enterApiKey": "הזינו את מפתח ה-API ורעננו כדי לטעון מודלים",
    "settings.credits": "קרדיטים ושימוש",
    "settings.creditLimit": "מגבלת קרדיט",
    "settings.remaining": "נותר",
    "settings.usedMonth": "שימוש החודש",
    "settings.localStorage": "אחסון מקומי",
    "settings.clearAll": "ניקוי כל הנתונים",
    "settings.export": "ייצוא",
    "settings.import": "ייבוא",
    "settings.close": "סגירה",
    "settings.saveSettings": "שמירת הגדרות",
    "settings.languageLabel": "שפה",
    "settings.languageHint": "שפת הממשק (טעינו מחדש את הדף אם חסרה)",
    "settings.languageChanged": "השפה עודכנה",
    "settings.clearConfirm": "למחוק את כל הכרטיסים, ההגדרות והיסטוריית הצ'אט? לא ניתן לבטל פעולה זו.",
    "settings.providerCustom": "מותאם אישית (תואם OpenAI)",
    "settings.noModels": "לא נמצאו מודלים",
    "settings.loadMore": "טעינת עוד ({{count}} נותרו)",
    "settings.showingModels": "מוצגים {{shown}} מתוך {{total}} מודלים",
    "wizard.title": "יצירת דמות",
    "wizard.step.basics": "יסודות",
    "wizard.step.concept": "קונספט",
    "wizard.step.personality": "אישיות",
    "wizard.step.scenario": "תרחיש",
    "wizard.step.generate": "יצירה",
    "wizard.basicsTitle": "יסודות הדמות",
    "wizard.nameLabel": "שם הדמות",
    "wizard.namePlaceholder": "למשל: אלרה נייטוויספר",
    "wizard.genderLabel": "מגדר / כינויי גוף",
    "wizard.genderSelect": "בחירה...",
    "wizard.gender.female": "נקבה (היא)",
    "wizard.gender.male": "זכר (הוא)",
    "wizard.gender.nonbinary": "לא-בינארי (הם)",
    "wizard.gender.other": "אחר...",
    "wizard.genderCustom": "כינויי גוף מותאמים (למשל: זה)",
    "wizard.tagsLabel": "תגיות",
    "wizard.tagsSub": "(מופרדות בפסיקים, מסייעות לארגון הספרייה)",
    "wizard.tagsPlaceholder": "פנטזיה, לוחם, אלף, מקורי",
    "wizard.creatorLabel": "יוצר",
    "wizard.creatorPlaceholder": "שמכם / הכינוי שלכם",
    "wizard.conceptTitle": "קונספט ורקע",
    "wizard.typeLabel": "סוג דמות",
    "wizard.type.original": "דמות מקורית",
    "wizard.type.fanfic": "סיפורת מעריצים",
    "wizard.type.game": "דמות ממשחק",
    "wizard.type.anime": "אנימה / מנגה",
    "wizard.type.book": "ספר / סרט / סדרה",
    "wizard.type.historical": "דמות היסטורית",
    "wizard.type.mythological": "מיתולוגית / פולקלור",
    "wizard.type.vtuber": "VTuber / סטרימר",
    "wizard.type.other": "אחר",
    "wizard.languageLabel": "שפה",
    "wizard.language.other": "אחרת",
    "wizard.languageSpecify": "ציינו את השפה",
    "wizard.genreLabel": "ז'אנר / עולם",
    "wizard.genreSub": "(בחרו את כל מה שמתאים)",
    "wizard.moodLabel": "מצב רוח / נימה",
    "wizard.moodSub": "(בחרו את כל מה שמתאים)",
    "wizard.personalityTitle": "אישיות ומראה",
    "wizard.personalityTraits": "תכונות אישיות",
    "wizard.personalityTraitsSub": "(תארו 3-5 תכונות מרכזיות, זה עוזר ל-AI)",
    "wizard.personalityTraitsPlaceholder": "למשל: אמיצה אך פזיזה, נאמנה מאוד לחבריה, חוש הומור יבש, מתקשה לבטוח, אוהבת חיות בסתר",
    "wizard.appearanceLabel": "מראה חיצוני",
    "wizard.appearanceSub": "(תיאור קצר של איך הם נראים)",
    "wizard.appearancePlaceholder": "למשל: אישה גבוהה עם שיער כסוף עד מותניה, ידיים מצולקות, לובשת ז'קט עור כהה, עיניים ירוקות נוקבות",
    "wizard.abilitiesLabel": "יכולות מיוחדות / מוזרויות",
    "wizard.abilitiesSub": "(אופציונלי, כל תכונה ייחודית)",
    "wizard.abilitiesPlaceholder": "למשל: יכולה לדבר עם חיות, בעלת זיכרון צילומי, תמיד נושאת יומן בלוי",
    "wizard.scenarioTitle": "תרחיש והודעה ראשונה",
    "wizard.scenarioLabel": "תרחיש / רקע",
    "wizard.scenarioSub": "(היכן הסיפור מתחיל?)",
    "wizard.scenarioPlaceholder": "למשל: לילה גשום בעיר מוארת ניאון. הדמות מנהלת סדנת תיקונים קטנה שמתקנת גם מכונות וגם לבבות שבורים.",
    "wizard.relationshipLabel": "היחסים עם {{user}}",
    "wizard.relationshipSub": "(כיצד הדמות רואה את המשתמש?)",
    "wizard.relationshipPlaceholder": "למשל: לקוח חדש שנכנס לסדנה עם מכשיר שבור ומסתורי. הדמות סקרנית אך זהירה.",
    "wizard.openingLabel": "אווירת ההודעה הראשונה",
    "wizard.openingSub": "(איך הודעה פותחת צריכה להרגיש?)",
    "wizard.notesLabel": "הערות נוספות",
    "wizard.notesSub": "(כל דבר אחר שה-AI צריך לדעת?)",
    "wizard.notesPlaceholder": "למשל: שמרו על דיאלוג טבעי, הימנעו מרשמיות יתר, כללו תיאורי פעולה בכוכביות",
    "wizard.generateTitle": "יצירת דמות",
    "wizard.refImage": "תמונת ייחוס",
    "wizard.refImageSub": "(אופציונלי, מ-waifu.im)",
    "wizard.fetchImages": "הבאת 3 תמונות",
    "wizard.refetchOthers": "הבאת תמונות אחרות",
    "wizard.fetching": "מביא...",
    "wizard.useSelected": "שימוש בנבחר",
    "wizard.clear": "ניקוי",
    "wizard.generateAI": "יצירה עם AI",
    "wizard.generateAISub": "כרטיס דמות מלא מהתשובות שלכם",
    "wizard.createBlank": "יצירת כרטיס ריק",
    "wizard.createBlankSub": "התחילו עם שם ותגיות מלאים מראש",
    "wizard.back": "חזרה",
    "wizard.next": "המשך",
    "wizard.stepLabel": "שלב {{step}} מתוך {{total}}",
    "wizard.ready": "מוכן ליצירה!",
    "wizard.nameRequired": "אנא הזינו שם דמות",
    "wizard.summary.name": "שם",
    "wizard.summary.gender": "מגדר",
    "wizard.summary.type": "סוג",
    "wizard.summary.language": "שפה",
    "wizard.summary.tags": "תגיות",
    "wizard.summary.genres": "ז'אנרים",
    "wizard.summary.mood": "מצב רוח",
    "wizard.summary.opening": "פתיחה",
    "wizard.summary.personality": "אישיות",
    "wizard.summary.appearance": "מראה",
    "wizard.summary.scenario": "תרחיש",
    "wizard.summary.relationship": "יחסים",
    "wizard.summary.notes": "הערות",
    "wizard.chip.fantasy": "פנטזיה",
    "wizard.chip.scifi": "מדע בדיוני",
    "wizard.chip.modern": "מודרני",
    "wizard.chip.historical": "היסטורי",
    "wizard.chip.horror": "אימה",
    "wizard.chip.romance": "רומנטיקה",
    "wizard.chip.comedy": "קומדיה",
    "wizard.chip.sliceOfLife": "חיים יומיומיים",
    "wizard.chip.adventure": "הרפתקה",
    "wizard.chip.mystery": "מסתורין",
    "wizard.chip.cyberpunk": "סייברפאנק",
    "wizard.chip.postApocalyptic": "פוסט-אפוקליפטי",
    "wizard.chip.supernatural": "על-טבעי",
    "wizard.chip.military": "צבאי",
    "wizard.chip.surreal": "סוריאליסטי",
    "wizard.chip.serious": "רציני",
    "wizard.chip.playful": "שובב",
    "wizard.chip.dark": "אפל",
    "wizard.chip.lighthearted": "קליל",
    "wizard.chip.mysterious": "מסתורי",
    "wizard.chip.romantic": "רומנטי",
    "wizard.chip.intense": "עוצמתי",
    "wizard.chip.wholesome": "חם ואמיתי",
    "wizard.chip.chaotic": "כאוטי",
    "wizard.chip.melancholic": "מלנכולי",
    "wizard.chip.sarcastic": "סרקסטי",
    "wizard.chip.stoic": "סטואי",
    "wizard.chip.greeting": "ברכה חמה",
    "wizard.chip.action": "בעיצומו של האירוע",
    "wizard.chip.question": "שאלה מסקרנת",
    "wizard.chip.conflict": "קונפליקט מיידי",
    "wizard.chip.atmospheric": "אווירתי",
    "wizard.editStep": "עריכת קטע זה",
    "wizard.draftRestored": "הטיוטה שוחזרה — התשובות הקודמות שלכם חזרו",
    "wizard.imagePlaceholder": "לחצו על הבאה",
    "diff.title": "תצוגה מקדימה של תשובת ה-AI",
    "diff.removed": "הוסר",
    "diff.added": "נוסף",
    "diff.current": "נוכחי",
    "diff.proposed": "מוצע",
    "diff.empty": "(ריק)",
    "diff.discard": "ביטול",
    "diff.apply": "החלת שינויים",
    "shortcuts.title": "קיצורי דרך",
    "shortcuts.save": "שמירת כרטיס",
    "shortcuts.newCard": "כרטיס חדש",
    "shortcuts.undo": "ביטול",
    "shortcuts.redo": "ביצוע מחדש",
    "shortcuts.sendAi": "שליחת הודעת AI",
    "shortcuts.newLine": "שורה חדשה ב-AI",
    "shortcuts.focus": "מצב מיקוד",
    "shortcuts.collapsePanel": "כווץ/הרחב חלונית AI",
    "toast.loadFailed": "נכשל: {{name}}",
    "toast.loaded": "נטענו {{count}} כרטיסים",
    "toast.importDupe": "תוכן זהה לכרטיס קיים — יובא כ-{{name}}",
    "toast.largeImage": "תמונה גדולה מוטבעת ב-{{name}} ({{size}} מ״ב) - שקול להסיר אותה כדי לחסוך מקום.",
    "toast.noValid": "לא נמצאו כרטיסים תקינים. שחררו קבצי PNG או JSON.",
    "toast.noSelected": "לא נבחרו כרטיסים",
    "toast.cardsDeleted": "הכרטיסים נמחקו",
    "toast.deleteFailed": "שגיאה במחיקת הכרטיס",
    "toast.exported": "יוצאו {{count}} כרטיסים",
    "toast.newBlank": "נוצר כרטיס ריק חדש",
    "toast.noCardSave": "אין כרטיס לשמירה",
    "toast.cardSaved": "הכרטיס נשמר!",
    "toast.noCardDup": "אין כרטיס לשכפול",
    "toast.cardDup": "הכרטיס שוכפל",
    "toast.cardRestored": "הכרטיס שוחזר",
    "toast.selectCard": "בחרו תחילה כרטיס",
    "toast.avatarUpdated": "התמונה הראשית עודכנה",
    "toast.imgFailed": "טעינת התמונה נכשלה",
    "toast.firstMesUpdated": "ההודעה הראשונה עודכנה!",
    "toast.settingsSaved": "ההגדרות נשמרו!",
    "toast.modelsFailed": "טעינת המודלים נכשלה: {{error}}",
    "toast.modelSet": "המודל הוגדר: {{model}}",
    "toast.dataCleared": "כל הנתונים נוקו",
    "toast.settingsExported": "ההגדרות יוצאו",
    "toast.settingsImported": "ההגדרות יובאו!",
    "toast.invalidFile": "קובץ הגדרות לא תקין",
    "toast.apiKey": "הגדירו את מפתח ה-API שלכם בהגדרות",
    "toast.selectModel": "אנא בחרו מודל מסרגל הניווט או מההגדרות תחילה.",
    "toast.genStopped": "היצירה הופסקה.",
    "toast.aiError": "שגיאת AI: {{error}}",
    "toast.cardUpdatedAI": "הכרטיס עודכן מתשובת ה-AI!",
    "toast.jsonParseFailed": "לא ניתן היה לנתח את תשובת ה-AI כ-JSON. בדקו את הצ'אט.",
    "toast.emptyResponse": "AI החזירה תוכן ריק — אין מה להחיל.",
    "toast.jsonInvalid": "ה-AI לא החזיר JSON תקין. התשובה בצ'אט — תוכלו להעתיק אותה ידנית.",
    "toast.fieldUpdated": '"{{field}}" עודכן!',
    "toast.greetingsUpdated": "נוצרו {{count}} ברכות!",
    "toast.tagsUpdated": "התגיות עודכנו — נוספו {{count}} תגיות חדשות!",
    "toast.greetingsParseFailed": "לא ניתן היה לנתח את הברכות מתשובת ה-AI.",
    "toast.createCardFirst": "צרו או בחרו כרטיס תחילה",
    "toast.wizardCreated": "הכרטיס נוצר! התחילו לערוך או השתמשו ב-AI למילוי הפרטים.",
    "toast.wizardApi": "הגדירו תחילה את מפתח ה-API שלכם בהגדרות",
    "toast.wizardModel": "בחרו מודל או הגדירו מזהה מודל מותאם אישית בהגדרות",
    "toast.wizardFetchFailed": "הבאת התמונות נכשלה: {{error}}",
    "toast.wizardName": "אנא הזינו שם דמות",
    "toast.storageFull": "האחסון מלא! נסו להסיר כרטיסים מסוימים או לייצא אותם.",
    "toast.exportedJson": "יוצא כ-JSON!",
    "toast.exportedPng": "יוצא כ-PNG עם נתוני הכרטיס!",
    "toast.exportFailed": "ייצוא התמונה נכשל. מעבר ל-JSON.",
    "toast.noNameWarning": 'אזהרה: לכרטיס אין שם. הקובץ יישמר כ-"character.json".',
    "toast.chatCleared": "הצ'אט נוקה",
    "toast.selectField": "בחרו לפחות שדה אחד לעריכה",
    "toast.tooManyFields": "נבחרו יותר מדי שדות. מקסימום {{max}} בכל פעם.",
    "toast.undo": "ביטול",
    "toast.redo": "ביצוע מחדש",
    "toast.reorderFiltered": "כבו את החיפוש והפילטרים כדי לסדר מחדש את הכרטיסים.",
    "error.apiKeyNotSet": "מפתח ה-API לא הוגדר. הזן את מפתח ה-API שלך בהגדרות.",
    "error.customUrlNotSet": "כתובת ה-URL הבסיסית של ה-API המותאם אינה מוגדרת. פתח את ההגדרות ← מותאם אישית (תואם OpenAI) והזן את כתובת ה-URL של נקודת הקצה (למשל http://localhost:1234/v1).",
    "error.customServerError": "השרת החזיר שגיאה: {{detail}}",
    "error.customAuthFailed": "האימות נכשל (HTTP {{status}}). בדוק את מפתח ה-API עבור נקודת קצה זו.",
    "error.customPathNotFound": "נקודת הקצה לא נמצאה (HTTP 404). בדוק שכתובת ה-URL הבסיסית של ה-API מלאה (לדוגמה כוללת /v1).",
    "error.customUnreachable": "לא ניתן לגשת ל-{{url}}. בדוק שהשרת פועל ושכתובת ה-URL הבסיסית של ה-API נכונה ונגישה ממכשיר זה.",
    "error.noModel": "לא נבחר מודל. בחרו מודל או הגדירו מזהה מודל בהגדרות.",
    "error.noModelSimple": "לא נבחר מודל.",
    "error.insufficientCredits": "קרדיטים לא מספקים. אנא טעינו את החשבון.",
    "error.storageFull": "האחסון מלא! נסו להסיר כרטיסים מסוימים או לייצא אותם.",
    "gen.empty": "(ריק)",
    "gen.free": "חינם",
    "gen.unlimited": "ללא הגבלה",
    "gen.notAvailable": "לא זמין",
    "gen.unnamed": "ללא שם",
    "gen.byCreator": "מאת {{name}}",
    "gen.copySuffix": " (עותק)",
    "gen.toastAutoHide": "נסתר אוטומטית תוך {{s}} שניות",
    "gen.untagged": "לא נמצאו תגיות",
    "gen.noMatch": "אין כרטיסים התואמים לפילטרים שלכם",
    "batch.deleteConfirm": "למחוק {{count}} כרטיסים? לא ניתן לבטל פעולה זו.",
    "left.selected": "{{count}} נבחרו",
    "toast.cardDeleted": 'הכרטיס "{{name}}" נמחק',
    "ai.apply": "החלה",
    "ai.applyTitle": "החלת שינויים אלה על הכרטיס",
    "ai.errorPrefix": "שגיאה: ",
    "ai.translatePrompt": "לאיזו שפה לתרגם?",
    "ai.translateDefaultLang": "צרפתית",
    "ai.tonePrompt": "איזו נימה? (למשל: רשמית, לא רשמית, אפלה, הומוריסטית, פיוטית)",
    "ai.toneDefault": "רשמית",
    "ai.chatSession": "סשן צ'אט",
    "ai.msgs": "{{count}} הודעות",
    "ai.tokensIn": " קלט · ",
    "ai.tokensOut": " פלט · ",
    "ai.tokensCtx": " הקשר",
    "ai.exceedsLimit": " ⚠ חורג מהמגבלה!",
    "ai.approachingLimit": " ⚠ מתקרב למגבלה",
    "ai.count": "ספירה:",
    "ai.resizeAria": "שינוי גודל עוזר ה-AI",
    "ai.chatMessagesAria": "הודעות צ'אט ה-AI",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: דיאלוג לדוגמה כאן...
{{user}}: תגובת המשתמש...
<START>
{{char}}: דוגמה נוספת...`,
    "batch.select2ForCompare": "בחרו בדיוק 2 כרטיסים להשוואה",
    "batch.compareLoadFailed": "טעינת הכרטיסים להשוואה נכשלה",
    "batch.comparePrefix": "השוואה: ",
    "batch.compareVs": " מול ",
    "batch.cardA": "כרטיס א",
    "batch.cardB": "כרטיס ב",
    "editor.charCount": "{{chars}} תווים ~{{tokens}} טוקנים",
    "editor.counterWarn": "מתקרב למגבלת ה-token של הפלט ({{tokens}}/{{max}}).",
    "editor.counterDanger": "עבר את מגבלת ה-token של הפלט ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "הזזה למעלה",
    "editor.greetingMoveDown": "הזזה למטה",
    "editor.greetingIsDefault": "זוהי ההודעה הראשונה הנוכחית",
    "editor.greetingSetDefault": "הגדרה כהודעה ראשונה",
    "editor.greetingRemove": "הסרה",
    "editor.greetingPlaceholder": "ברכה {{num}}...",
    "editor.loreEntry": "ערכה {{num}}",
    "editor.loreDeleteEntry": "מחיקת ערכה",
    "editor.lorePrimaryKeys": "מילות מפתח ראשיות",
    "editor.lorePrimaryKeysPlaceholder": "מילות מפתח ראשיות — מופרדות בפסיקים",
    "editor.loreSecondaryKeys": "מילות מפתח משניות",
    "editor.loreSecondaryKeysPlaceholder": "מילות מפתח משניות",
    "editor.loreComment": "תגובה",
    "editor.loreCommentPlaceholder": "תגובה",
    "editor.loreOrder": "סדר",
    "editor.loreOrderPlaceholder": "סדר",
    "editor.loreConstant": "קבוע",
    "editor.loreSelective": "סלקטיבי",
    "editor.loreBeforeChar": "לפני הדמות",
    "editor.loreAfterChar": "אחרי הדמות",
    "editor.loreContent": "תוכן",
    "editor.loreContentPlaceholder": "תוכן הערכה...",
    "editor.loreNewEntry": "ערכה חדשה",
    "error.unknown": "שגיאה לא ידועה",
    "error.unexpected": "שגיאה בלתי צפויה: {{message}}",
    "error.requestFailed": "הבקשה נכשלה: {{message}}",
    "error.unsupportedFile": "סוג קובץ לא נתמך: .{{ext}}",
    "error.invalidJson": "JSON לא תקין: {{message}}",
    "error.notPng": "אינו קובץ PNG תקין",
    "error.unknownFormat": "פורמט כרטיס לא ידוע — אינו כרטיס דמות של SillyTavern",
    "error.fetchModelsFailed": "הבאת המודלים נכשלה (HTTP {{status}})",
    "error.noChoices": "ה-API לא החזיר אפשרויות תשובה",
    "error.emptyResponse": "תשובה ריקה מה-API (אין גוף)",
    "gen.newCharacter": "דמות חדשה",
    "gen.bytes": " ב",
    "gen.kilobytes": ' ק"ב',
    "gen.megabytes": ' מ"ב',
    "settings.backup": "גיבוי",
    "settings.restore": "שחזור",
    "settings.backupTitle": "גיבוי כל הכרטיסים",
    "settings.restoreTitle": "שחזור גיבוי",
    "settings.exportTitle": "ייצוא הגדרות",
    "settings.importTitle": "ייבוא הגדרות",
    "settings.modelAuto": "אוטומטי",
    "settings.modelIdPlaceholder": "למשל: deepseek-v4-flash",
    "settings.customModelPlaceholder": "למשל: llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "למשל: {{provider}}-latest",
    "settings.getApiKeyFrom": "קבלת מפתח API מ-",
    "settings.customModelDesc": "מודל מותאם אישית",
    "settings.workspaceExported": "סביבת העבודה יוצאה ({{count}} כרטיסים)",
    "settings.invalidWorkspace": "פורמט סביבת עבודה לא תקין",
    "settings.workspaceImported": "סביבת העבודה יובאה ({{count}} כרטיסים)",
    "settings.workspaceImportFailed": "ייבוא סביבת העבודה נכשל: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "הפעלה/כיבוי של עוזר ה-AI",
    "nav.toggleAIAria": "הפעלה/כיבוי של עוזר ה-AI",
    "nav.notificationsAria": "התראות",
    "left.sortCards": "מיון כרטיסים",
    "left.compareSelected": "השוואת הכרטיסים שנבחרו",
    "left.resizeAria": "שינוי גודל ספריית הכרטיסים",
    "left.cardListAria": "ספריית כרטיסים",
    "ui.saved": " נשמר",
    "ui.collapsePanel": "כווץ חלונית",
    "ui.expandPanel": "הרחב חלונית",
    "ui.cardModified": "שינויים שלא נשמרו",
    "export.minimalPngLabel": "כרטיס ST",
    "wizard.search": "חיפוש",
    "wizard.quick": "מהיר:",
    "wizard.imageSearchPlaceholder": "חיפוש תגיות: חתול, שמלה, מדים, סייברפאנק...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  translations.fa = {
    "app.title": "ST Card Editor — استودیو کارت شخصیت SillyTavern",
    "nav.selectModel": "انتخاب مدل...",
    "nav.wizard": "ساخت با جادوگر هوش مصنوعی",
    "nav.newCard": "کارت خالی جدید",
    "nav.save": "ذخیره",
    "nav.theme": "تغییر تم",
    "nav.shortcuts": "میان‌برها و راهنما",
    "nav.settings": "تنظیمات",
    "nav.focus": "حالت تمرکز",
    "nav.focusAlt": "حالت تمرکز (Alt+F)",
    "left.title": "کتابخانه کارت‌ها",
    "left.cards": "{{count}} کارت",
    "left.sort.manual": "دستی",
    "left.drop": "کشیدن و رها کردن",
    "left.dropSub": "کارت شخصیت PNG یا JSON",
    "left.browse": "مرور فایل‌ها",
    "left.search": "جستجوی کارت‌ها...",
    "left.sort.nameAsc": "نام الف-ی",
    "left.sort.nameDesc": "نام ی-الف",
    "left.sort.newest": "جدیدترین‌ها اول",
    "left.sort.oldest": "قدیمی‌ترین‌ها اول",
    "left.sort.largest": "بزرگ‌ترین‌ها",
    "left.sort.smallest": "کوچک‌ترین‌ها",
    "left.filterTags": "فیلتر بر اساس برچسب‌ها",
    "left.exportSelected": "خروجی گرفتن از انتخاب‌شده‌ها به‌صورت JSON",
    "left.deleteSelected": "حذف انتخاب‌شده‌ها",
    "left.empty": "هیچ کارتی بارگذاری نشده",
    "left.emptySub": "یک کارت رها کنید یا روی مرور کلیک کنید",
    "center.noCard": "کارتی انتخاب نشده",
    "center.noCardSub": "یک کارت از کتابخانه انتخاب کنید یا کارت جدیدی را بکشید و رها کنید",
    "center.createAI": "ساخت با هوش مصنوعی",
    "center.blankCard": "کارت خالی",
    "editor.avatar": "برای تنظیم آواتار، روی یک تصویر کلیک کنید یا آن را رها کنید",
    "editor.avatarAria": "تنظیم آواتار شخصیت",
    "editor.name": "نام شخصیت",
    "editor.exportJson": "خروجی به‌صورت JSON",
    "editor.exportPng": "خروجی به‌صورت PNG",
    "editor.duplicate": "تکثیر کارت",
    "editor.delete": "حذف کارت",
    "editor.tab.core": "اصلی",
    "editor.tab.personality": "شخصیت",
    "editor.tab.advanced": "پیشرفته",
    "editor.tab.lorebook": "کتاب داستان",
    "editor.tab.waifu": "تصویر Waifu",
    "editor.waifuPreview": "تصویر فعلی کارت",
    "editor.waifuNoImage": "هنوز تصویری تنظیم نشده",
    "editor.waifuSource": "منبع تصویر",
    "editor.waifuSourceSnap": "نماهای انیمه (waifu.im)",
    "editor.waifuSourceChar": "شخصیت‌های انیمه (AniList)",
    "editor.waifuGender": "جنسیت",
    "editor.waifuGenderAll": "هر جنسیتی",
    "editor.waifuGenderFemaleOnly": "فقط زن",
    "editor.waifuGenderMaleOnly": "فقط مرد",
    "editor.waifuGenderFemale": "مونث",
    "editor.waifuGenderMale": "مذکر",
    "editor.waifuCharSub": "جستجوی شخصیت بر اساس نام (مثلاً: zoro)",
    "editor.waifuSearch": "جستجو در waifu.im",
    "editor.waifuSearchChar": "جستجوی شخصیت",
    "editor.waifuSearchPlaceholderChar": "جستجوی شخصیت بر اساس نام (مثلاً: zoro)",
    "editor.waifuSub": "(تصاویر انیمه‌ای را بر اساس برچسب می‌گیرد)",
    "editor.waifuSearchPlaceholder": "مثال: waifu، الف، خدمتکار...",
    "editor.waifuFetch": "دریافت تصاویر",
    "editor.waifuRegenTitle": "بازتولید نتایج",
    "editor.waifuMixed": "زن + مرد",
    "editor.waifuMixedSub": "پک متوازن با یک کلیک: ۳ شخصیت زن + ۳ مرد",
    "editor.waifuUse": "استفاده به‌عنوان تصویر کارت",
    "editor.waifuUpload": "بارگذاری از دستگاه",
    "editor.waifuRemove": "حذف تصویر",
    "toast.noImage": "این کارت تصویری برای حذف ندارد",
    "toast.imageRemoved": "تصویر حذف شد",
    "editor.desc": "توضیحات",
    "editor.descSub": "(ظاهر، پیشینه)",
    "editor.descPlaceholder": "ظاهر، پیشینه و ویژگی‌های کلیدی شخصیت را توصیف کنید...",
    "editor.firstMes": "اولین پیام",
    "editor.firstMesPlaceholder": "اولین پیام شخصیت هنگام شروع گفتگو...",
    "editor.scenario": "سناریو",
    "editor.scenarioPlaceholder": "شرایط فعلی و زمینه گفتگو...",
    "editor.creator": "سازنده",
    "editor.creatorPlaceholder": "سازنده / نویسنده کارت",
    "editor.version": "نسخه شخصیت",
    "editor.tags": "برچسب‌ها",
    "editor.tagsSub": "(جدا شده با کاما)",
    "editor.tagsPlaceholder": "فانتزی، جنگجو، الف",
    "editor.personalitySummary": "خلاصه شخصیت",
    "editor.personalityPlaceholder": "توضیح کوتاهی از شخصیت کاراکتر... (در قالب کارت شخصیت استفاده می‌شود)",
    "editor.mesExample": "پیام‌های نمونه",
    "editor.mesExampleFormat": "قالب: بلوک‌های <START> با پیشوندهای {{char}}: و {{user}}:",
    "editor.systemPrompt": "پرامپت سیستم",
    "editor.systemPromptPlaceholder": "پرامپت سیستم را جایگزین کنید. برای گنجاندن پیش‌فرض از {{original}} استفاده کنید.",
    "editor.postHistory": "دستورالعمل‌های پس از تاریخچه",
    "editor.postHistoryPlaceholder": "دستورالعمل‌هایی که پس از تاریخچه گفتگو تزریق می‌شوند. برای پیش‌فرض از {{original}} استفاده کنید.",
    "editor.creatorNotes": "یادداشت‌های سازنده",
    "editor.creatorNotesPlaceholder": "یادداشت‌هایی برای کاربران کارت (پیشنهاد مدل، نکات استفاده...)",
    "editor.greetings": "سلام‌های جایگزین",
    "editor.addGreeting": "افزودن سلام",
    "editor.lorebookTitle": "مدخل‌های کتاب داستان شخصیت",
    "editor.addEntry": "افزودن مدخل",
    "editor.lorebookSearch": "جستجوی مدخل‌ها بر اساس کلید، محتوا یا نظر...",
    "editor.lorebookEmpty": "هنوز مدخلی در کتاب داستان نیست. برای شروع یکی اضافه کنید.",
    "editor.noGreetings": "هنوز سلامی نیست. روی <strong>افزودن سلام</strong> کلیک کنید یا از هوش مصنوعی برای تولید استفاده کنید.",
    "editor.noEntriesMatch": 'هیچ مدخلی با "{{query}}" مطابقت ندارد',
    "editor.edit": "ویرایش",
    "editor.preview": "پیش‌نمایش",
    "ai.title": "دستیار هوش مصنوعی",
    "ai.clearChat": "پاک کردن گفتگو",
    "ai.welcomeTitle": "دستیار کارت هوش مصنوعی",
    "ai.welcomeText": "از هوش مصنوعی بخواهید کارت شخصیت شما را ویرایش، ترجمه یا بهبود دهد.",
    "ai.quick.newCard": "کارت جدید",
    "ai.quick.translate": "ترجمه",
    "ai.quick.enhance": "بهبود",
    "ai.quick.shorten": "کوتاه‌کردن",
    "ai.quick.tone": "تغییر لحن",
    "ai.quick.grammar": "اصلاح گرامر",
    "ai.quick.personality": "گسترش شخصیت",
    "ai.quick.firstmes": "بهبود اولین پیام",
    "ai.quick.scenario": "گسترش سناریو",
    "ai.quick.greetings": "تولید سلام‌ها",
    "ai.quick.systemprompt": "بهبود پرامپت سیستم",
    "ai.quick.tags": "پیشنهاد برچسب‌ها",
    "ai.contextTitle": "توکن‌های تخمینی استفاده‌شده در برابر محدودیت زمینه مدل",
    "ai.contextLabel": "— / — توکن",
    "ai.placeholder": "از هوش مصنوعی بخواهید کارت را ویرایش کند...",
    "ai.send": "ارسال",
    "ai.stop": "توقف تولید",
    "ai.autoModel": "انتخاب مدل...",
    "ai.target": "هدف:",
    "ai.target.full": "کل کارت",
    "ai.target.description": "توضیحات",
    "ai.target.personality": "شخصیت",
    "ai.target.first_mes": "اولین پیام",
    "ai.target.scenario": "سناریو",
    "ai.target.mes_example": "پیام‌های نمونه",
    "ai.target.system_prompt": "پرامپت سیستم",
    "ai.target.post_history_instructions": "دستورالعمل‌های پس از تاریخچه",
    "ai.target.creator_notes": "یادداشت‌های سازنده",
    "ai.target.alternate_greetings": "سلام‌های جایگزین",
    "ai.selectModel": "یک مدل انتخاب کنید",
    "ai.actionNewCard": "کارت جدید",
    "ai.actionTranslate": "ترجمه",
    "ai.actionEnhance": "بهبود",
    "ai.actionShorten": "کوتاه‌کردن",
    "ai.actionTone": "تغییر لحن",
    "ai.actionGrammar": "اصلاح گرامر",
    "ai.actionPersonality": "گسترش شخصیت",
    "ai.actionFirstMes": "بهبود اولین پیام",
    "ai.actionScenario": "گسترش سناریو",
    "ai.actionGreetings": "تولید سلام‌ها",
    "ai.actionSystemprompt": "بهبود پرامپت سیستم",
    "ai.actionTags": "پیشنهاد برچسب‌ها",
    "ai.chatHistory": "تاریخچه گفتگو",
    "ai.historyTitle": "تاریخچه گفتگو",
    "ai.historyEmpty": "هنوز گفتگویی وجود ندارد",
    "ai.retry": "تلاش مجدد",
    "ai.retryTitle": "تولید مجدد این پاسخ",
    "ai.reapply": "اعمال مجدد",
    "ai.reapplyTitle": "برای اعمال این تغییرات، diff را دوباره باز کنید",
    "ai.noCard": "(کارتی انتخاب نشده)",
    "ai.editing": "در حال ویرایش {{count}} فیلد...",
    "ai.streaming": "در حال پخش...",
    "ai.failed": "ناموفق",
    "ai.cancelled": "لغو شد.",
    "ai.doneSummary": "{{done}}/{{total}} انجام شد · {{errs}} ناموفق",
    "ai.viewFullResult": "مشاهده نتیجه کامل",
    "ai.showLess": "نمایش کمتر",
    "ai.reviewApply": "بررسی و اعمال",
    "ai.changesNav": "تغییر {{current}} از {{total}}",
    "ai.changesPrev": "تغییر قبلی",
    "ai.changesNext": "تغییر بعدی",
    "ai.applied": "اعمال شد",
    "ai.target.tags": "برچسب‌ها",
    "ai.copy": "کپی",
    "ai.copied": "کپی شد!",
    "ai.copyFailed": "ناموفق",
    "ai.resultTitle": "نتیجه",
    "ai.close": "بستن",
    "settings.themeColor": "رنگ پوسته",
    "settings.themeColorPlaceholder": "#64748B",
    "settings.themeColorHint": "برای هر پوسته روشن/تاریک رنگ تأکید جداگانه‌ای انتخاب کنید. تغییرات فوراً اعمال می‌شوند.",
    "settings.appearance": "ظاهر",
    "settings.accentPresets": "پیش‌تنظیم‌های رنگ برجسته",
    "settings.glassDensity": "تراکم شیشه",
    "settings.glassSubtle": "ملایم",
    "settings.glassDefault": "پیش‌فرض",
    "settings.glassBold": "پررنگ",
    "settings.cardRadius": "شعاع گوشه کارت",
    "settings.radiusCompact": "فشرده",
    "settings.radiusRounded": "گرد",
    "settings.radiusPill": "قرص",
    "settings.vignette": "وینیت لبه",
    "settings.appearanceHint": "ظاهر هر تم روشن/تیره را سفارشی کنید. تغییرات رنگ برجسته فوراً اعمال می‌شوند؛ تراکم، شعاع و وینیت در پشتیبان‌گیری فضای کاری گنجانده می‌شوند.",
    "settings.resetThemeColor": "بازنشانی",
    "settings.generalTab": "عمومی",
    "settings.promptsTab": "پرامپت‌های هوش مصنوعی",
    "settings.assistantPrompt": "پرامپت سیستمی دستیار",
    "settings.fullCardPrompt": "پرامپت سیستمی کارت کامل",
    "settings.wizardPrompt": "دستورالعمل تولید شخصیت",
    "settings.promptPlaceholder": "برای استفاده از پرامپت داخلی، خالی بگذارید",
    "settings.chatSystemPrompts": "دستورالعمل‌های چت و سیستم",
    "settings.fullCardInstr": "دستورالعمل خروجی کارت کامل (سیستم)",
    "settings.fieldsEdit": "دستورالعمل ویرایش فیلد (سیستم)",
    "settings.greetingsSystem": "دستورالعمل خروجی احوالپرسی (سیستم)",
    "settings.exportPrompts": "خروجی پرامپت‌ها",
    "settings.importPrompts": "ورود پرامپت‌ها",
    "settings.promptsExported": "پرامپت‌ها صادر شدند",
    "settings.promptsImported": "{count} پرامپت وارد شد",
    "settings.quickActionPrompts": "پرامپت‌های اقدام سریع",
    "settings.tagsSystemPrompt": "دستورالعمل خروجی برچسب‌ها (سیستم)",
    "settings.restoreDefaultPrompts": "بازگرداندن پرامپت‌های پیش‌فرض",
    "settings.promptHint": "این فیلدها پرامپت‌های فعلی را نشان می‌دهند. اگر فیلدی خالی باشد، پرامپت داخلی پیش‌فرض استفاده می‌شود. برای مشاهده یا بازگرداندن پرامپت‌های اصلی، پیش‌فرض‌ها را بازگردانید.",
    "settings.title": "تنظیمات",
    "settings.provider": "ارائه‌دهنده",
    "settings.providerHint": "ارائه‌دهندگان مدل میزبانی‌شده یا نقطه پایانی سفارشی (LM Studio، Ollama و غیره)",
    "settings.apiKey": "کلید API",
    "settings.getApiKey": "کلید API خود را از OpenRouter دریافت کنید",
    "settings.baseUrl": "URL پایه API",
    "settings.namedApiKeyPlaceholder": "کلید API خود را وارد کنید",
    "settings.customHint": "نقطه پایانی سازگار با OpenAI. مثال‌ها: LM Studio http://localhost:1234/v1، Ollama http://localhost:11434/v1",
    "settings.customApiPlaceholder": "http://localhost:1234/v1",
    "settings.apiKeyOptional": "کلید API (اختیاری)",
    "settings.apiKeyLocalPlaceholder": "برای ارائه‌دهندگان محلی خالی بگذارید",
    "settings.apiKeyLocalHint": "برای سرورهای محلی مانند LM Studio یا Ollama لازم نیست.",
    "settings.modelId": "شناسه مدل",
    "settings.modelIdHint": "شناسه دقیق مدلی که ارائه‌دهنده شما انتظار دارد.",
    "settings.modelIdHintNamed": "برای استفاده از مدل پیش‌فرض ارائه‌دهنده خالی بگذارید.",
    "settings.security": "کلید API شما به‌صورت رمزگذاری‌شده در localStorage مرورگر با کلیدی مرتبط با این آدرس ذخیره می‌شود. از این برنامه روی دستگاه‌های مشترک استفاده نکنید.",
    "settings.secretUnreadable": "به دلایل امنیتی، کلید API ذخیره‌شده در این آدرس قابل باز کردن نبود — لطفاً آن را دوباره در تنظیمات وارد کنید.",
    "error.pngInflateFailed": "این PNG حاوی داده‌های شخصیتی است که قابل استخراج نبود.",
    "settings.defaultModel": "مدل پیش‌فرض",
    "settings.browseModels": "مدل‌ها را در زیر مرور کنید...",
    "settings.refreshModels": "به‌روزرسانی مدل‌ها",
    "settings.maxTokens": "حداکثر توکن خروجی",
    "settings.maxTokensPlaceholder": "0 = استفاده از پیش‌فرض مدل",
    "settings.maxTokensHint": "حداکثر توکن خروجی در هر درخواست را بازنویسی کنید. برای استفاده خودکار از محدودیت مدل انتخاب‌شده (یا 64 هزار در صورت نامشخص) 0 بگذارید.",
    "settings.copyright": "افزودن اعتبار ویرایشگر هنگام خروجی",
    "settings.copyrightHint": "هنگام خروجی کارت‌ها، یک خط اعتبار به یادداشت‌های سازنده اضافه می‌کند.",
    "settings.availableModels": "مدل‌های موجود",
    "settings.searchModels": "جستجوی مدل‌ها...",
    "settings.enterApiKey": "کلید API را وارد کرده و برای بارگذاری مدل‌ها به‌روزرسانی کنید",
    "settings.credits": "اعتبار و استفاده",
    "settings.creditLimit": "سقف اعتبار",
    "settings.remaining": "باقی‌مانده",
    "settings.usedMonth": "مصرف این ماه",
    "settings.localStorage": "ذخیره‌سازی محلی",
    "settings.clearAll": "پاک کردن همه داده‌ها",
    "settings.export": "خروجی",
    "settings.import": "ورودی",
    "settings.close": "بستن",
    "settings.saveSettings": "ذخیره تنظیمات",
    "settings.languageLabel": "زبان",
    "settings.languageHint": "زبان رابط کاربری (در صورت نبود، صفحه را دوباره بارگذاری کنید)",
    "settings.languageChanged": "زبان به‌روزرسانی شد",
    "settings.clearConfirm": "همه کارت‌ها، تنظیمات و تاریخچه گفتگو حذف شوند؟ این عمل قابل بازگشت نیست.",
    "settings.providerCustom": "سفارشی (سازگار با OpenAI)",
    "settings.noModels": "مدلی یافت نشد",
    "settings.loadMore": "بارگذاری بیشتر ({{count}} باقی‌مانده)",
    "settings.showingModels": "نمایش {{shown}} از {{total}} مدل",
    "wizard.title": "ساخت شخصیت",
    "wizard.step.basics": "مبانی",
    "wizard.step.concept": "مفهوم",
    "wizard.step.personality": "شخصیت",
    "wizard.step.scenario": "سناریو",
    "wizard.step.generate": "تولید",
    "wizard.basicsTitle": "مبانی شخصیت",
    "wizard.nameLabel": "نام شخصیت",
    "wizard.namePlaceholder": "مثلاً الارا نایت‌ویسپر",
    "wizard.genderLabel": "جنسیت / ضمایر",
    "wizard.genderSelect": "انتخاب...",
    "wizard.gender.female": "مونث (او)",
    "wizard.gender.male": "مذکر (او)",
    "wizard.gender.nonbinary": "غیردودویی (آن‌ها)",
    "wizard.gender.other": "سایر...",
    "wizard.genderCustom": "ضمایر سفارشی (مثلاً آن)",
    "wizard.tagsLabel": "برچسب‌ها",
    "wizard.tagsSub": "(جدا شده با کاما، به سازمان‌دهی کتابخانه کمک می‌کند)",
    "wizard.tagsPlaceholder": "فانتزی، جنگجو، الف، اصلی",
    "wizard.creatorLabel": "سازنده",
    "wizard.creatorPlaceholder": "نام / نام مستعار شما",
    "wizard.conceptTitle": "مفهوم و محیط",
    "wizard.typeLabel": "نوع شخصیت",
    "wizard.type.original": "شخصیت اصلی",
    "wizard.type.fanfic": "داستان هواداری",
    "wizard.type.game": "شخصیت بازی",
    "wizard.type.anime": "انیمه / مانگا",
    "wizard.type.book": "کتاب / فیلم / سریال",
    "wizard.type.historical": "شخصیت تاریخی",
    "wizard.type.mythological": "اسطوره‌ای / فولکلور",
    "wizard.type.vtuber": "VTuber / استریمر",
    "wizard.type.other": "سایر",
    "wizard.languageLabel": "زبان",
    "wizard.language.other": "سایر",
    "wizard.languageSpecify": "زبان را مشخص کنید",
    "wizard.genreLabel": "ژانر / جهان",
    "wizard.genreSub": "(همه موارد مرتبط را انتخاب کنید)",
    "wizard.moodLabel": "حالت / لحن",
    "wizard.moodSub": "(همه موارد مرتبط را انتخاب کنید)",
    "wizard.personalityTitle": "شخصیت و ظاهر",
    "wizard.personalityTraits": "ویژگی‌های شخصیتی",
    "wizard.personalityTraitsSub": "(۳ تا ۵ ویژگی کلیدی را توصیف کنید، این به هوش مصنوعی کمک می‌کند)",
    "wizard.personalityTraitsPlaceholder": "مثلاً شجاع اما بی‌پروا، بسیار وفادار به دوستان، شوخ‌طبعی خشک، در اعتمادکردن مشکل دارد، مخفیانه عاشق حیوانات است",
    "wizard.appearanceLabel": "ظاهر فیزیکی",
    "wizard.appearanceSub": "(توضیح کوتاهی از ظاهر آن‌ها)",
    "wizard.appearancePlaceholder": "مثلاً زنی بلندقد با موهای نقره‌ای تا کمر، دست‌هایی با جای زخم، کت چرمی تیره، چشمان سبز نافذ",
    "wizard.abilitiesLabel": "توانایی‌های ویژه / ویژگی‌های عجیب",
    "wizard.abilitiesSub": "(اختیاری، هر ویژگی منحصربه‌فرد)",
    "wizard.abilitiesPlaceholder": "مثلاً می‌تواند با حیوانات صحبت کند، حافظه تصویری دارد، همیشه یک دفترچه فرسوده همراه دارد",
    "wizard.scenarioTitle": "سناریو و اولین پیام",
    "wizard.scenarioLabel": "سناریو / محیط",
    "wizard.scenarioSub": "(داستان از کجا شروع می‌شود؟)",
    "wizard.scenarioPlaceholder": "مثلاً شبی بارانی در شهری روشن از نور نئون. شخصیت یک کارگاه تعمیرات کوچک اداره می‌کند که هم ماشین‌ها و هم قلب‌های شکسته را تعمیر می‌کند.",
    "wizard.relationshipLabel": "رابطه با {{user}}",
    "wizard.relationshipSub": "(شخصیت کاربر را چگونه می‌بیند؟)",
    "wizard.relationshipPlaceholder": "مثلاً مشتری جدیدی که با یک دستگاه خراب مرموز وارد کارگاه شد. شخصیت کنجکاو اما محتاط است.",
    "wizard.openingLabel": "حال‌وهوای اولین پیام",
    "wizard.openingSub": "(پیام آغازین باید چه حسی داشته باشد؟)",
    "wizard.notesLabel": "یادداشت‌های تکمیلی",
    "wizard.notesSub": "(چیز دیگری که هوش مصنوعی باید بداند؟)",
    "wizard.notesPlaceholder": "مثلاً گفتگو را طبیعی نگه دارید، از رسمی‌بودن بیش از حد خودداری کنید، توصیف‌های عمل را داخل ستاره بیاورید",
    "wizard.generateTitle": "تولید شخصیت",
    "wizard.refImage": "تصویر مرجع",
    "wizard.refImageSub": "(اختیاری، از waifu.im)",
    "wizard.fetchImages": "دریافت ۳ تصویر",
    "wizard.refetchOthers": "دریافت مجدد سایر",
    "wizard.fetching": "در حال دریافت...",
    "wizard.useSelected": "استفاده از انتخاب‌شده",
    "wizard.clear": "پاک کردن",
    "wizard.generateAI": "تولید با هوش مصنوعی",
    "wizard.generateAISub": "کارت شخصیت کامل از پاسخ‌های شما",
    "wizard.createBlank": "ساخت کارت خالی",
    "wizard.createBlankSub": "با نام و برچسب‌های از پیش پر شده شروع کنید",
    "wizard.back": "بازگشت",
    "wizard.next": "بعدی",
    "wizard.stepLabel": "مرحله {{step}} از {{total}}",
    "wizard.ready": "آماده تولید!",
    "wizard.nameRequired": "لطفاً نام شخصیت را وارد کنید",
    "wizard.summary.name": "نام",
    "wizard.summary.gender": "جنسیت",
    "wizard.summary.type": "نوع",
    "wizard.summary.language": "زبان",
    "wizard.summary.tags": "برچسب‌ها",
    "wizard.summary.genres": "ژانرها",
    "wizard.summary.mood": "حالت",
    "wizard.summary.opening": "آغاز",
    "wizard.summary.personality": "شخصیت",
    "wizard.summary.appearance": "ظاهر",
    "wizard.summary.scenario": "سناریو",
    "wizard.summary.relationship": "رابطه",
    "wizard.summary.notes": "یادداشت‌ها",
    "wizard.chip.fantasy": "فانتزی",
    "wizard.chip.scifi": "علمی-تخیلی",
    "wizard.chip.modern": "مدرن",
    "wizard.chip.historical": "تاریخی",
    "wizard.chip.horror": "ترسناک",
    "wizard.chip.romance": "عاشقانه",
    "wizard.chip.comedy": "کمدی",
    "wizard.chip.sliceOfLife": "زندگی روزمره",
    "wizard.chip.adventure": "ماجراجویی",
    "wizard.chip.mystery": "معمایی",
    "wizard.chip.cyberpunk": "سایبرپانک",
    "wizard.chip.postApocalyptic": "پساآخرالزمانی",
    "wizard.chip.supernatural": "ماوراءطبیعی",
    "wizard.chip.military": "نظامی",
    "wizard.chip.surreal": "سورئال",
    "wizard.chip.serious": "جدی",
    "wizard.chip.playful": "بازیگوش",
    "wizard.chip.dark": "تیره",
    "wizard.chip.lighthearted": "سبک‌روح",
    "wizard.chip.mysterious": "مرموز",
    "wizard.chip.romantic": "عاشقانه",
    "wizard.chip.intense": "پرشور",
    "wizard.chip.wholesome": "گرم و صمیمی",
    "wizard.chip.chaotic": "آشوبگر",
    "wizard.chip.melancholic": "غمگین",
    "wizard.chip.sarcastic": "طعنه‌آمیز",
    "wizard.chip.stoic": "رواقی",
    "wizard.chip.greeting": "سلام گرم",
    "wizard.chip.action": "در میانه ماجرا",
    "wizard.chip.question": "پرسش کنجکاوانه",
    "wizard.chip.conflict": "تعارض فوری",
    "wizard.chip.atmospheric": "اتمسفری",
    "wizard.editStep": "ویرایش این بخش",
    "wizard.draftRestored": "پیش‌نویس بازیابی شد — پاسخ‌های قبلی شما بازگشت",
    "wizard.imagePlaceholder": "روی دریافت کلیک کنید",
    "diff.title": "پیش‌نمایش پاسخ هوش مصنوعی",
    "diff.removed": "حذف‌شده",
    "diff.added": "افزوده‌شده",
    "diff.current": "فعلی",
    "diff.proposed": "پیشنهادی",
    "diff.empty": "(خالی)",
    "diff.discard": "رد کردن",
    "diff.apply": "اعمال تغییرات",
    "shortcuts.title": "میان‌برها",
    "shortcuts.save": "ذخیره کارت",
    "shortcuts.newCard": "کارت جدید",
    "shortcuts.undo": "واگردانی",
    "shortcuts.redo": "بازانجام",
    "shortcuts.sendAi": "ارسال پیام هوش مصنوعی",
    "shortcuts.newLine": "خط جدید در هوش مصنوعی",
    "shortcuts.focus": "حالت تمرکز",
    "shortcuts.collapsePanel": "جمع/باز کردن پنل هوش مصنوعی",
    "toast.loadFailed": "ناموفق: {{name}}",
    "toast.loaded": "{{count}} کارت بارگذاری شد",
    "toast.importDupe": "محتوای یکسان با کارت موجود — به‌عنوان {{name}} وارد شد",
    "toast.largeImage": "تصویر بزرگی در {{name}} جاسازی شده است ({{size}} مگابایت) - برای صرفه‌جویی در فضا حذف آن را در نظر بگیرید.",
    "toast.noValid": "کارت معتبری یافت نشد. فایل PNG یا JSON را رها کنید.",
    "toast.noSelected": "کارتی انتخاب نشده",
    "toast.cardsDeleted": "کارت‌ها حذف شدند",
    "toast.deleteFailed": "حذف کارت ناموفق بود",
    "toast.exported": "{{count}} کارت خروجی گرفته شد",
    "toast.newBlank": "کارت خالی جدید ساخته شد",
    "toast.noCardSave": "کارتی برای ذخیره وجود ندارد",
    "toast.cardSaved": "کارت ذخیره شد!",
    "toast.noCardDup": "کارتی برای تکثیر وجود ندارد",
    "toast.cardDup": "کارت تکثیر شد",
    "toast.cardRestored": "کارت بازیابی شد",
    "toast.selectCard": "ابتدا یک کارت انتخاب کنید",
    "toast.avatarUpdated": "آواتار به‌روزرسانی شد",
    "toast.imgFailed": "بارگذاری تصویر ناموفق بود",
    "toast.firstMesUpdated": "اولین پیام به‌روزرسانی شد!",
    "toast.settingsSaved": "تنظیمات ذخیره شد!",
    "toast.modelsFailed": "بارگذاری مدل‌ها ناموفق بود: {{error}}",
    "toast.modelSet": "مدل تنظیم شد: {{model}}",
    "toast.dataCleared": "همه داده‌ها پاک شد",
    "toast.settingsExported": "تنظیمات خروجی گرفته شد",
    "toast.settingsImported": "تنظیمات وارد شد!",
    "toast.invalidFile": "فایل تنظیمات نامعتبر است",
    "toast.apiKey": "کلید API خود را در تنظیمات تعیین کنید",
    "toast.selectModel": "لطفاً ابتدا از نوار ناوبری یا تنظیمات یک مدل انتخاب کنید.",
    "toast.genStopped": "تولید متوقف شد.",
    "toast.aiError": "خطای هوش مصنوعی: {{error}}",
    "toast.cardUpdatedAI": "کارت از پاسخ هوش مصنوعی به‌روزرسانی شد!",
    "toast.jsonParseFailed": "پاسخ هوش مصنوعی به‌صورت JSON قابل تجزیه نبود. گفتگو را بررسی کنید.",
    "toast.emptyResponse": "AI محتوای خالی بازگرداند — جزئی برای اعمال وجود ندارد.",
    "toast.jsonInvalid": "هوش مصنوعی JSON معتبری برنگرداند. پاسخ در گفتگو است — می‌توانید آن را دستی کپی کنید.",
    "toast.fieldUpdated": '"{{field}}" به‌روزرسانی شد!',
    "toast.greetingsUpdated": "{{count}} سلام تولید شد!",
    "toast.tagsUpdated": "برچسب‌ها به‌روزرسانی شدند — {{count}} برچسب جدید اضافه شد!",
    "toast.greetingsParseFailed": "سلام‌ها از پاسخ هوش مصنوعی قابل تجزیه نبودند.",
    "toast.createCardFirst": "ابتدا یک کارت بسازید یا انتخاب کنید",
    "toast.wizardCreated": "کارت ساخته شد! شروع به ویرایش کنید یا از هوش مصنوعی برای تکمیل جزئیات استفاده کنید.",
    "toast.wizardApi": "ابتدا کلید API خود را در تنظیمات تعیین کنید",
    "toast.wizardModel": "یک مدل انتخاب کنید یا شناسه مدل سفارشی را در تنظیمات تعیین کنید",
    "toast.wizardFetchFailed": "دریافت تصاویر ناموفق بود: {{error}}",
    "toast.wizardName": "لطفاً نام شخصیت را وارد کنید",
    "toast.storageFull": "فضای ذخیره‌سازی پر است! سعی کنید برخی کارت‌ها را حذف یا خروجی بگیرید.",
    "toast.exportedJson": "خروجی به‌صورت JSON!",
    "toast.exportedPng": "خروجی به‌صورت PNG همراه با داده کارت!",
    "toast.exportFailed": "خروجی تصویر ناموفق بود. بازگشت به JSON.",
    "toast.noNameWarning": 'هشدار: کارت نامی ندارد. فایل به‌صورت "character.json" ذخیره می‌شود.',
    "toast.chatCleared": "گفتگو پاک شد",
    "toast.selectField": "حداقل یک فیلد برای ویرایش انتخاب کنید",
    "toast.tooManyFields": "فیلدهای زیادی انتخاب شده‌اند. حداکثر {{max}} در هر بار.",
    "toast.undo": "واگردانی",
    "toast.redo": "بازانجام",
    "toast.reorderFiltered": "برای مرتب‌سازی مجدد کارت‌ها، جستجو و فیلترها را خاموش کنید.",
    "error.apiKeyNotSet": "کلید API تنظیم نشده است. کلید API خود را در تنظیمات وارد کنید.",
    "error.customUrlNotSet": "آدرس پایه API سفارشی تنظیم نشده است. تنظیمات ← سفارشی (سازگار با OpenAI) را باز کنید و آدرس نقطه پایانی را وارد کنید (مثلاً http://localhost:1234/v1).",
    "error.customServerError": "سرور خطایی برگرداند: {{detail}}",
    "error.customAuthFailed": "احراز هویت ناموفق بود (HTTP {{status}}). کلید API این نقطه پایانی را بررسی کنید.",
    "error.customPathNotFound": "نقطه پایانی یافت نشد (HTTP 404). بررسی کنید که آدرس پایه API کامل است (مثلاً شامل /v1 باشد).",
    "error.customUnreachable": "امکان دسترسی به {{url}} وجود ندارد. بررسی کنید که سرور در حال اجراست و آدرس پایه API صحیح و از این دستگاه قابل دسترسی است.",
    "error.noModel": "مدلی انتخاب نشده. یک مدل انتخاب کنید یا شناسه مدل را در تنظیمات تعیین کنید.",
    "error.noModelSimple": "مدلی انتخاب نشده.",
    "error.insufficientCredits": "اعتبار کافی نیست. لطفاً حساب خود را شارژ کنید.",
    "error.storageFull": "فضای ذخیره‌سازی پر است! سعی کنید برخی کارت‌ها را حذف یا خروجی بگیرید.",
    "gen.empty": "(خالی)",
    "gen.free": "رایگان",
    "gen.unlimited": "نامحدود",
    "gen.notAvailable": "ناموجود",
    "gen.unnamed": "بی‌نام",
    "gen.byCreator": "توسط {{name}}",
    "gen.copySuffix": " (کپی)",
    "gen.toastAutoHide": "پس از {{s}} ثانیه به‌صورت خودکار پنهان می‌شود",
    "gen.untagged": "برچسبی یافت نشد",
    "gen.noMatch": "هیچ کارتی با فیلترهای شما مطابقت ندارد",
    "batch.deleteConfirm": "{{count}} کارت حذف شود؟ این عمل قابل بازگشت نیست.",
    "left.selected": "{{count}} انتخاب شده",
    "toast.cardDeleted": 'کارت "{{name}}" حذف شد',
    "ai.apply": "اعمال",
    "ai.applyTitle": "اعمال این تغییرات روی کارت",
    "ai.errorPrefix": "خطا: ",
    "ai.translatePrompt": "به کدام زبان ترجمه شود؟",
    "ai.translateDefaultLang": "فرانسوی",
    "ai.tonePrompt": "کدام لحن؟ (مثلاً رسمی، خودمانی، تاریک، طنزآمیز، شاعرانه)",
    "ai.toneDefault": "رسمی",
    "ai.chatSession": "نشست گفتگو",
    "ai.msgs": "{{count}} پیام",
    "ai.tokensIn": " ورودی · ",
    "ai.tokensOut": " خروجی · ",
    "ai.tokensCtx": " زمینه",
    "ai.exceedsLimit": " ⚠ بیش از حد مجاز!",
    "ai.approachingLimit": " ⚠ نزدیک به حد مجاز",
    "ai.count": "شمارش:",
    "ai.resizeAria": "تغییر اندازه دستیار هوش مصنوعی",
    "ai.chatMessagesAria": "پیام‌های گفتگوی هوش مصنوعی",
    "ai.mesExamplePlaceholder": `<START>
{{char}}: گفتگوی نمونه اینجا...
{{user}}: پاسخ کاربر...
<START>
{{char}}: نمونه دیگری...`,
    "batch.select2ForCompare": "برای مقایسه دقیقاً ۲ کارت انتخاب کنید",
    "batch.compareLoadFailed": "بارگذاری کارت‌ها برای مقایسه ناموفق بود",
    "batch.comparePrefix": "مقایسه: ",
    "batch.compareVs": " در برابر ",
    "batch.cardA": "کارت الف",
    "batch.cardB": "کارت ب",
    "editor.charCount": "{{chars}} نویسه ~{{tokens}} توکن",
    "editor.counterWarn": "نزدیک به محدودیت توکن خروجی ({{tokens}}/{{max}}).",
    "editor.counterDanger": "بیش از محدودیت توکن خروجی ({{tokens}}/{{max}}).",
    "editor.greetingMoveUp": "انتقال به بالا",
    "editor.greetingMoveDown": "انتقال به پایین",
    "editor.greetingIsDefault": "این اولین پیام فعلی است",
    "editor.greetingSetDefault": "تنظیم به‌عنوان اولین پیام",
    "editor.greetingRemove": "حذف",
    "editor.greetingPlaceholder": "سلام {{num}}...",
    "editor.loreEntry": "مدخل {{num}}",
    "editor.loreDeleteEntry": "حذف مدخل",
    "editor.lorePrimaryKeys": "کلیدواژه‌های اصلی",
    "editor.lorePrimaryKeysPlaceholder": "کلیدواژه‌های اصلی — جدا شده با کاما",
    "editor.loreSecondaryKeys": "کلیدواژه‌های ثانویه",
    "editor.loreSecondaryKeysPlaceholder": "کلیدواژه‌های ثانویه",
    "editor.loreComment": "نظر",
    "editor.loreCommentPlaceholder": "نظر",
    "editor.loreOrder": "ترتیب",
    "editor.loreOrderPlaceholder": "ترتیب",
    "editor.loreConstant": "ثابت",
    "editor.loreSelective": "انتخابی",
    "editor.loreBeforeChar": "قبل از شخصیت",
    "editor.loreAfterChar": "بعد از شخصیت",
    "editor.loreContent": "محتوا",
    "editor.loreContentPlaceholder": "محتوای مدخل...",
    "editor.loreNewEntry": "مدخل جدید",
    "error.unknown": "خطای ناشناخته",
    "error.unexpected": "خطای غیرمنتظره: {{message}}",
    "error.requestFailed": "درخواست ناموفق بود: {{message}}",
    "error.unsupportedFile": "نوع فایل پشتیبانی‌نشده: .{{ext}}",
    "error.invalidJson": "JSON نامعتبر: {{message}}",
    "error.notPng": "فایل PNG معتبر نیست",
    "error.unknownFormat": "قالب کارت ناشناخته — کارت شخصیت SillyTavern نیست",
    "error.fetchModelsFailed": "دریافت مدل‌ها ناموفق بود (HTTP {{status}})",
    "error.noChoices": "API هیچ گزینه پاسخی برنگرداند",
    "error.emptyResponse": "پاسخ خالی از API (بدون بدنه)",
    "gen.newCharacter": "شخصیت جدید",
    "gen.bytes": " بایت",
    "gen.kilobytes": " کیلوبایت",
    "gen.megabytes": " مگابایت",
    "settings.backup": "پشتیبان‌گیری",
    "settings.restore": "بازیابی",
    "settings.backupTitle": "پشتیبان‌گیری از همه کارت‌ها",
    "settings.restoreTitle": "بازیابی پشتیبان",
    "settings.exportTitle": "خروجی تنظیمات",
    "settings.importTitle": "ورودی تنظیمات",
    "settings.modelAuto": "خودکار",
    "settings.modelIdPlaceholder": "مثلاً deepseek-v4-flash",
    "settings.customModelPlaceholder": "مثلاً llama-3.2-8b-instruct",
    "settings.namedModelPlaceholder": "مثلاً {{provider}}-latest",
    "settings.getApiKeyFrom": "دریافت کلید API از ",
    "settings.customModelDesc": "مدل سفارشی",
    "settings.workspaceExported": "فضای کار خروجی گرفته شد ({{count}} کارت)",
    "settings.invalidWorkspace": "قالب فضای کار نامعتبر است",
    "settings.workspaceImported": "فضای کار وارد شد ({{count}} کارت)",
    "settings.workspaceImportFailed": "واردکردن فضای کار ناموفق بود: {{error}}",
    "nav.brand": "ST Card Editor",
    "nav.toggleAI": "روشن/خاموش کردن دستیار هوش مصنوعی",
    "nav.toggleAIAria": "روشن/خاموش کردن دستیار هوش مصنوعی",
    "nav.notificationsAria": "اعلان‌ها",
    "left.sortCards": "مرتب‌سازی کارت‌ها",
    "left.compareSelected": "مقایسه کارت‌های انتخاب‌شده",
    "left.resizeAria": "تغییر اندازه کتابخانه کارت‌ها",
    "left.cardListAria": "کتابخانه کارت‌ها",
    "ui.saved": " ذخیره شد",
    "ui.collapsePanel": "جمع کردن پنل",
    "ui.expandPanel": "باز کردن پنل",
    "ui.cardModified": "تغییرات ذخیره‌نشده",
    "export.minimalPngLabel": "کارت ST",
    "wizard.search": "جستجو",
    "wizard.quick": "سریع:",
    "wizard.imageSearchPlaceholder": "جستجوی برچسب‌ها: گربه، لباس، یونیفرم، سایبرپانک...",
    "wizard.language.en": "English",
    "wizard.language.fr": "French",
    "wizard.language.de": "German",
    "wizard.language.ja": "Japanese",
    "wizard.language.it": "Italian",
    "wizard.language.pl": "Polish",
    "wizard.language.tr": "Turkish",
    "wizard.language.nl": "Dutch",
    "wizard.language.uk": "Ukrainian",
    "wizard.language.vi": "Vietnamese",
    "wizard.language.id": "Indonesian",
    "wizard.language.hi": "Hindi",
    "wizard.language.ar": "Arabic",
    "wizard.language.he": "Hebrew",
    "wizard.language.fa": "Persian"
  };
  var I18n2 = {
    _lang: "en",
    getLang() {
      return this._lang;
    },
    init() {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.includes(saved)) {
        this._lang = saved;
      } else {
        const browserLang = (navigator.language || navigator.userLanguage || "").toLowerCase();
        const short = browserLang.split("-")[0];
        this._lang = SUPPORTED.includes(short) ? short : "en";
      }
      document.documentElement.lang = this._lang;
      document.documentElement.dir = RTL_LANGS.includes(this._lang) ? "rtl" : "ltr";
      this._applyBootstrapDir();
      document.title = this.t("app.title");
      var langSel = document.getElementById("languageSelect");
      if (langSel)
        langSel.value = this._lang;
      this.translateDOM();
    },
    t(key, vars) {
      let str = translations[this._lang] && translations[this._lang][key];
      if (str === undefined) {
        str = translations.en && translations.en[key];
      }
      if (str === undefined) {
        console.warn("[i18n] Missing translation key: " + key);
        return key;
      }
      if (vars && typeof str === "string") {
        Object.keys(vars).forEach(function(k) {
          str = str.replace(new RegExp("\\{\\{" + k + "\\}\\}", "g"), function() {
            return vars[k];
          });
        });
      }
      return str;
    },
    setLanguage(lang) {
      if (!SUPPORTED.includes(lang))
        return;
      this._lang = lang;
      localStorage.setItem(STORAGE_KEY, lang);
      document.documentElement.lang = lang;
      document.documentElement.dir = RTL_LANGS.includes(lang) ? "rtl" : "ltr";
      this._applyBootstrapDir();
      document.title = this.t("app.title");
      this.translateDOM();
    },
    _applyBootstrapDir() {
      var rtl = RTL_LANGS.includes(this._lang);
      var ltr = document.getElementById("bootstrapLtr");
      var rtlSheet = document.getElementById("bootstrapRtl");
      if (ltr)
        ltr.disabled = rtl;
      if (rtlSheet)
        rtlSheet.disabled = !rtl;
    },
    translateDOM() {
      var self = this;
      document.querySelectorAll("[data-i18n]").forEach(function(el) {
        var key = el.getAttribute("data-i18n");
        var translated = self.t(key);
        if (translated)
          el.textContent = translated;
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach(function(el) {
        var key = el.getAttribute("data-i18n-placeholder");
        var translated = self.t(key);
        if (translated)
          el.placeholder = translated;
      });
      document.querySelectorAll("[data-i18n-title]").forEach(function(el) {
        var key = el.getAttribute("data-i18n-title");
        var translated = self.t(key);
        if (translated)
          el.title = translated;
      });
      document.querySelectorAll("[data-i18n-aria]").forEach(function(el) {
        var key = el.getAttribute("data-i18n-aria");
        var translated = self.t(key);
        if (translated)
          el.setAttribute("aria-label", translated);
      });
      document.querySelectorAll("[data-i18n-html]").forEach(function(el) {
        var key = el.getAttribute("data-i18n-html");
        var translated = self.t(key);
        if (translated)
          el.innerHTML = translated;
      });
    }
  };
  if (typeof window !== "undefined")
    window.I18n = I18n2;

  // js/ui.js
  window.AppState = { cards: [], activeCard: null, models: [], chatHistory: [], isAiLoading: false, _dirty: false };
  var Ui2 = {
    $(sel) {
      return document.querySelector(sel);
    },
    $$(sel) {
      return document.querySelectorAll(sel);
    },
    showToast(msg, type) {
      type = type || "info";
      const icons = { success: "bi-check-circle-fill text-success", danger: "bi-exclamation-triangle-fill text-danger", warning: "bi-exclamation-circle-fill text-warning", info: "bi-info-circle-fill text-info" };
      const container = document.querySelector("#toastContainer");
      if (!container)
        return;
      while (container.children.length >= 3) {
        const oldest = container.firstChild;
        if (!oldest)
          break;
        oldest.dispatchEvent(new Event("hidden.bs.toast"));
        oldest.remove();
      }
      const el = document.createElement("div");
      el.className = "toast align-items-center border-0";
      el.setAttribute("role", "alert");
      const DURATION = 1e4;
      const initialSecs = Math.ceil(DURATION / 1000);
      const toastLabel = I18n && I18n.t ? I18n.t("gen.toastAutoHide", { s: initialSecs }) : "Auto-hides in " + initialSecs + "s";
      el.innerHTML = '<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2 w-100"><div class="flex-grow-1 d-flex align-items-center gap-2"><i class="bi ' + (icons[type] || icons.info) + '"></i>' + this.escapeHtml(msg) + '</div><div class="toast-timer" style="font-size:0.62rem;white-space:nowrap;font-family:var(--font-mono);min-width:3.2em;text-align:right;">' + toastLabel + '</div><button type="button" class="btn-close btn-close-white ms-2" data-bs-dismiss="toast"></button></div></div>';
      document.querySelector("#toastContainer").appendChild(el);
      const toast = new bootstrap.Toast(el, { delay: DURATION });
      toast.show();
      const timerEl = el.querySelector(".toast-timer");
      if (timerEl) {
        const interval = 200;
        let remaining = DURATION;
        const tick = () => {
          remaining -= interval;
          if (remaining <= 0) {
            timerEl.textContent = "";
            return;
          }
          const secs = Math.ceil(remaining / 1000);
          timerEl.textContent = I18n && I18n.t ? I18n.t("gen.toastAutoHide", { s: secs }) : "Auto-hides in " + secs + "s";
        };
        const timer = setInterval(tick, interval);
        el.addEventListener("hidden.bs.toast", () => {
          clearInterval(timer);
          el.remove();
        });
      } else {
        el.addEventListener("hidden.bs.toast", () => el.remove());
      }
    },
    downloadFile(filename, content, mimeType) {
      this.downloadBlob(new Blob([content], { type: mimeType }), filename);
    },
    downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    escapeHtml(str) {
      if (!str)
        return "";
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    },
    escapeAttr(str) {
      if (str === null || str === undefined)
        return "";
      str = String(str);
      return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    debounce(fn, delay) {
      let timer;
      return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },
    updateUIState() {
      const h = !!window.AppState.activeCard;
      document.querySelector("#btnSaveCard").disabled = !h;
      document.querySelector("#btnExportJson").disabled = !h;
      document.querySelector("#btnExportPng").disabled = !h;
      document.querySelector("#btnDeleteCard").disabled = !h;
      this.setDirty(window.AppState._dirty);
    },
    setDirty(dirty) {
      window.AppState._dirty = dirty;
      if (dirty === false && this._pendingRemoteReload) {
        this._pendingRemoteReload = false;
        const cardId = this._pendingRemoteCardId;
        this._pendingRemoteCardId = null;
        this._mergePendingRemote(cardId);
      }
      const item = document.querySelector(".card-list-item.active");
      if (item) {
        if (dirty) {
          if (!item.querySelector(".card-modified-dot")) {
            const dot2 = document.createElement("span");
            dot2.className = "card-modified-dot";
            dot2.title = I18n.t ? I18n.t("ui.cardModified") : "Unsaved edits";
            item.appendChild(dot2);
          }
        } else {
          item.querySelectorAll(".card-modified-dot").forEach((x) => x.remove());
        }
      }
      const btn = document.querySelector("#btnSaveCard");
      if (!btn)
        return;
      btn.classList.toggle("is-dirty", !!dirty);
      let dot = btn.querySelector(".dirty-dot");
      if (dirty && !dot) {
        dot = document.createElement("span");
        dot.className = "dirty-dot";
        btn.appendChild(dot);
      } else if (!dirty && dot) {
        dot.remove();
      }
    },
    async _reloadActiveCard(expectedCardId) {
      const ac = window.AppState.activeCard;
      if (!ac)
        return;
      if (expectedCardId && ac._id !== expectedCardId)
        return;
      try {
        const updated = await CardStorage.getCard(ac._id);
        if (updated) {
          window.AppState.activeCard = updated;
          try {
            const b64 = await CardStorage.getImage(updated._id);
            if (b64)
              window.AppState.activeCard._imageBase64 = b64;
          } catch (err) {
            console.error("Failed to load image from IndexedDB:", err);
          }
          Editor.populateEditor(window.AppState.activeCard);
        }
      } catch (err) {
        console.error("Failed to reload active card:", err);
      }
    },
    async _mergePendingRemote(expectedCardId) {
      this._pendingRemoteReload = false;
      this._pendingRemoteCardId = null;
      const snapshot = this._pendingRemoteSnapshot;
      const touched = this._pendingRemoteTouched;
      this._pendingRemoteSnapshot = null;
      this._pendingRemoteTouched = null;
      const ac = window.AppState.activeCard;
      if (!ac)
        return;
      if (expectedCardId && ac._id !== expectedCardId)
        return;
      if (!snapshot)
        return;
      const id = ac._id;
      const localB64 = ac._imageBase64;
      const merged = JSON.parse(JSON.stringify(ac));
      let changed = false;
      for (const key of Object.keys(snapshot)) {
        if (key.startsWith("_"))
          continue;
        if (touched && touched.has(key))
          continue;
        if (JSON.stringify(snapshot[key]) !== JSON.stringify(ac[key])) {
          merged[key] = JSON.parse(JSON.stringify(snapshot[key]));
          changed = true;
        }
      }
      if (!changed) {
        this._reloadActiveCard(id);
        return;
      }
      window.AppState.activeCard = merged;
      try {
        const b64 = await CardStorage.getImage(merged._id);
        if (b64)
          window.AppState.activeCard._imageBase64 = b64;
      } catch (err) {
        console.error("Failed to load image from IndexedDB:", err);
      }
      try {
        await CardStorage.upsertCard(window.AppState.activeCard);
        window.AppState.cards = CardStorage.getCards();
        CardManager.renderCardList();
      } catch (err) {
        console.error("Failed to persist merged card:", err);
      }
      Editor.populateEditor(window.AppState.activeCard);
      if (localB64)
        window.AppState.activeCard._imageBase64 = localB64;
    },
    _markdownReady: false,
    _markdownLoading: null,
    _markdownRetryAfter: 0,
    _markdownPending: [],
    _pendingRemoteReload: false,
    _pendingRemoteCardId: null,
    _pendingRemoteSnapshot: null,
    _pendingRemoteTouched: null,
    _markTouchedField(field) {
      if (this._pendingRemoteTouched)
        this._pendingRemoteTouched.add(field);
    },
    _ensureMarkdownLibs() {
      if (this._markdownReady)
        return;
      if (this._markdownLoading)
        return;
      if (Date.now() < this._markdownRetryAfter)
        return;
      this._markdownLoading = true;
      let pending = 2;
      let failed = false;
      const checkReady = () => {
        pending--;
        if (pending <= 0) {
          this._markdownLoading = null;
          if (!failed && typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
            this._markdownReady = true;
            this._markdownRetryAfter = 0;
            const pending2 = this._markdownPending;
            this._markdownPending = [];
            pending2.forEach((item) => {
              if (item.target && item.target.isConnected) {
                item.target.innerHTML = this.renderMarkdown(item.text);
              }
            });
          } else {
            this._markdownRetryAfter = Date.now() + 30000;
          }
        }
      };
      if (typeof marked === "undefined") {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
        s.onload = checkReady;
        s.onerror = () => {
          failed = true;
          checkReady();
        };
        document.head.appendChild(s);
      } else {
        checkReady();
      }
      if (typeof DOMPurify === "undefined") {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js";
        s.onload = checkReady;
        s.onerror = () => {
          failed = true;
          checkReady();
        };
        document.head.appendChild(s);
      } else {
        checkReady();
      }
    },
    renderMarkdown(text, target) {
      if (!text)
        return "";
      if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
        this._ensureMarkdownLibs();
        if (target)
          this._markdownPending.push({ target, text });
        return this.escapeHtml(text).replace(/\n/g, "<br>");
      }
      if (marked.setOptions) {
        marked.setOptions({ breaks: true, gfm: true });
      }
      let html = typeof marked.parse === "function" ? marked.parse(text) : marked(text);
      html = html.replace(/({{char}})\s*:/g, '<span class="dlg-char-name">$1</span><span class="dlg-char">:</span>');
      html = html.replace(/({{user}})\s*:/g, '<span class="dlg-user-name">$1</span><span class="dlg-user">:</span>');
      html = DOMPurify.sanitize(html, { ADD_TAGS: ["span", "strong", "em"] });
      return html;
    },
    formatFileSize(bytes) {
      if (!bytes || bytes <= 0)
        return "";
      if (bytes < 1024)
        return bytes + (I18n.t ? I18n.t("gen.bytes") : " B");
      if (bytes < 1048576)
        return (bytes / 1024).toFixed(1) + (I18n.t ? I18n.t("gen.kilobytes") : " KB");
      return (bytes / 1048576).toFixed(1) + (I18n.t ? I18n.t("gen.megabytes") : " MB");
    },
    _savedTimer: null,
    _savedOrigHTML: null,
    flashSaved() {
      const btn = document.querySelector("#btnSaveCard");
      if (!btn)
        return;
      if (this._savedOrigHTML === null)
        this._savedOrigHTML = btn.innerHTML;
      btn.innerHTML = '<i class="bi bi-check2-all me-1"></i>' + (I18n.t ? I18n.t("ui.saved") : " Saved");
      btn.classList.add("btn-saved-flash");
      if (this._savedTimer)
        clearTimeout(this._savedTimer);
      this._savedTimer = setTimeout(() => {
        btn.innerHTML = this._savedOrigHTML;
        btn.classList.remove("btn-saved-flash");
        this._savedTimer = null;
        this._savedOrigHTML = null;
        if (window.AppState._dirty)
          this.setDirty(true);
      }, 1500);
    }
  };
  if (typeof window !== "undefined")
    window.Ui = Ui2;
  var DEBOUNCE_INPUT_MS = 800;
  var DEBOUNCE_SEARCH_MS2 = 300;
  function initFloatingLabels() {
    const SEL = ".floating-label input, .floating-label select, .floating-label textarea";
    function syncFloatLabels() {
      document.querySelectorAll(".floating-label").forEach((group) => {
        const label = group.querySelector("label");
        const input = group.querySelector("input, select, textarea");
        if (!label || !input)
          return;
        const hasVal = input.value && input.value.trim().length > 0;
        label.classList.toggle("floated", hasVal || document.activeElement === input);
      });
    }
    document.addEventListener("focusin", (e) => {
      if (e.target.matches(SEL)) {
        const label = e.target.closest(".floating-label")?.querySelector("label");
        if (label)
          label.classList.add("floated");
      }
    });
    document.addEventListener("focusout", (e) => {
      if (e.target.matches(SEL)) {
        const label = e.target.closest(".floating-label")?.querySelector("label");
        if (label && !(e.target.value && e.target.value.trim().length > 0)) {
          label.classList.remove("floated");
        }
      }
    });
    document.addEventListener("input", (e) => {
      if (e.target.matches(SEL)) {
        const label = e.target.closest(".floating-label")?.querySelector("label");
        if (label) {
          const hasVal = e.target.value && e.target.value.trim().length > 0;
          label.classList.toggle("floated", hasVal || document.activeElement === e.target);
        }
      }
    });
    document.addEventListener("change", (e) => {
      if (e.target.matches(".floating-label select")) {
        const label = e.target.closest(".floating-label")?.querySelector("label");
        if (label) {
          const hasVal = e.target.value && e.target.value.trim().length > 0;
          label.classList.toggle("floated", hasVal || document.activeElement === e.target);
        }
      }
    });
    window.syncFloatingLabels = syncFloatLabels;
    window.syncFloatLabels = syncFloatLabels;
    syncFloatLabels();
  }
  async function init() {
    const $ = Ui2.$;
    await CardStorage._checkMigration();
    await CardStorage.migrateCardsToIndexedDB();
    await CardManager.migrateImagesToIndexedDB();
    await CardStorage._unlockKeys();
    window.AppState.cards = CardStorage.getCards();
    window.AppState.chatHistory = [];
    const apiKey = CardStorage.getApiKey();
    const defaultModel = CardStorage.getDefaultModel();
    const unreadableOpenrouter = CardStorage._secretWarn.apiKey;
    const unreadableCustom = CardStorage._secretWarn.customApiKey;
    if (unreadableOpenrouter || unreadableCustom) {
      Ui2.showToast(I18n.t ? I18n.t("settings.secretUnreadable") : "Due to security, a saved API key could not be unlocked on this address — please re-enter it in Settings.", "warning");
    }
    if (apiKey) {
      $("#apiKeyInput").value = apiKey;
    }
    if (defaultModel) {
      $("#aiModelSelect").value = defaultModel;
      $("#defaultModelSelect").value = defaultModel;
    }
    const provider = CardStorage.getProvider();
    const customKey = CardStorage.getCustomApiKey();
    AIService.setProvider(provider, provider === "openrouter" ? apiKey : provider === "custom" ? customKey : CardStorage.getProviderKey(provider));
    if (provider === "custom") {
      const customModel = CardStorage.getCustomModelId();
      if (customModel) {
        CardStorage.setDefaultModel(customModel);
        $("#aiModelSelect").value = customModel;
      }
    }
    Settings.populateModelSelects();
    const maxTokens = CardStorage.getMaxTokens();
    if (maxTokens > 0)
      $("#maxTokensInput").value = maxTokens;
    $("#injectCopyrightToggle").checked = CardStorage.getInjectCopyright();
    I18n.init();
    const settingsModal = new bootstrap.Modal("#settingsModal");
    setupModalFocusTraps();
    CardManager.renderCardList();
    AiChat.renderChatHistory();
    const activeId = CardStorage.getActiveCardId();
    if (activeId) {
      const card = await CardStorage.getCard(activeId);
      if (card)
        await CardManager.selectCard(card);
    }
    if (provider === "openrouter" && apiKey)
      Settings.refreshCredits();
    if (provider === "custom" || apiKey)
      Settings.refreshModelsList();
    Ui2.updateUIState();
    bindEvents(settingsModal);
    AiChat.updateContextBar();
    Wizard.init();
    WaifuTab.init();
    AiChat._renderFieldChips();
    initFloatingLabels();
    document.querySelectorAll("#editorTabs .nav-link").forEach((trigger) => {
      trigger.addEventListener("shown.bs.tab", () => {
        Editor.updateCharCounts();
        Editor.autoResizeTextareas();
      });
    });
    window.addEventListener("beforeunload", (e) => {
      if (window.AppState.activeCard) {
        try {
          Editor.syncGreetings();
          Editor.syncEditorToCardSync();
        } catch (_) {}
      }
    });
    window.addEventListener("storage", handleStorageChange);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    setupErrorBoundary();
  }
  function setupModalFocusTraps() {
    const focusableSelector = [
      "button:not([hidden]):not(.d-none):not([disabled])",
      '[href]:not([hidden]):not(.d-none):not([tabindex="-1"])',
      "input:not([hidden]):not(.d-none):not([disabled])",
      "select:not([hidden]):not(.d-none):not([disabled])",
      "textarea:not([hidden]):not(.d-none):not([disabled])",
      '[tabindex]:not([tabindex="-1"]):not([hidden]):not(.d-none):not([disabled])'
    ].join(", ");
    document.querySelectorAll(".modal").forEach((modalEl) => {
      modalEl.addEventListener("shown.bs.modal", () => {
        const firstFocusable = modalEl.querySelector(focusableSelector);
        if (firstFocusable)
          firstFocusable.focus();
      });
      modalEl.addEventListener("keydown", (e) => {
        if (e.key === "Escape")
          return;
        if (e.key !== "Tab")
          return;
        const focusable = modalEl.querySelectorAll(focusableSelector);
        if (!focusable.length)
          return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    });
  }
  function setupErrorBoundary() {
    window.addEventListener("error", (e) => {
      const msg = e.error?.message || e.message || (I18n.t ? I18n.t("error.unknown") : "Unknown error");
      console.error("Global error:", e.error || e);
      if (!window._errorThrottled) {
        window._errorThrottled = true;
        Ui2.showToast(I18n.t ? I18n.t("error.unexpected", { message: msg }) : "Unexpected error: " + msg, "danger");
        setTimeout(() => {
          window._errorThrottled = false;
        }, 5000);
      }
      if (window.AppState.isAiLoading) {
        window.AppState.isAiLoading = false;
        AiChat.updateSendButton();
      }
    });
    window.addEventListener("unhandledrejection", (e) => {
      const msg = e.reason?.message || String(e.reason);
      console.error("Unhandled rejection:", e.reason);
      if (!window._errorThrottled) {
        window._errorThrottled = true;
        Ui2.showToast(I18n.t ? I18n.t("error.requestFailed", { message: msg }) : "Request failed: " + msg, "danger");
        setTimeout(() => {
          window._errorThrottled = false;
        }, 5000);
      }
      if (window.AppState.isAiLoading) {
        window.AppState.isAiLoading = false;
        AiChat.updateSendButton();
      }
    });
  }
  function bindEvents(settingsModal) {
    const $ = Ui2.$;
    const $$ = Ui2.$$;
    const dropZone = $("#dropZone");
    if (!dropZone)
      return;
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", (e) => {
      e.stopPropagation();
      dropZone.classList.remove("drag-over");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("drag-over");
      const files = e.dataTransfer?.files;
      if (files?.length)
        CardManager.processFiles(files);
    });
    dropZone.addEventListener("click", () => $("#fileInput").click());
    $("#btnBrowse").addEventListener("click", (e) => {
      e.stopPropagation();
      $("#fileInput").click();
    });
    $("#fileInput").addEventListener("change", (e) => CardManager.handleFileSelect(e));
    document.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        if (!dropZone.contains(e.target))
          dropZone.classList.add("drag-over");
      }
    });
    document.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget || e.relatedTarget === document.documentElement)
        dropZone.classList.remove("drag-over");
    });
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      if (!dropZone.contains(e.target)) {
        const files = e.dataTransfer?.files;
        if (files?.length)
          CardManager.processFiles(files);
      }
    });
    $("#btnNewCardCenter").addEventListener("click", () => CardManager.createNewCard());
    $("#btnSaveCard").addEventListener("click", () => CardManager.saveCurrentCard());
    $("#btnSettings").addEventListener("click", () => settingsModal.show());
    $("#btnHelp").addEventListener("click", () => {
      Ui2._shortcutsModal = Ui2._shortcutsModal || new bootstrap.Modal("#shortcutsModal");
      Ui2._shortcutsModal.show();
    });
    $("#btnToggleApiKey").addEventListener("click", () => Settings.toggleApiKeyVisibility());
    $("#btnToggleNamedApiKey").addEventListener("click", () => Settings.toggleNamedApiKeyVisibility());
    $("#btnSaveSettings").addEventListener("click", () => Settings.saveSettings(settingsModal));
    $("#btnResetPrompts").addEventListener("click", () => Settings.resetPrompts());
    $("#btnExportPrompts").addEventListener("click", () => Settings.exportPrompts());
    $("#btnImportPrompts").addEventListener("click", () => Settings.importPrompts());
    $("#btnRefreshModels").addEventListener("click", () => Settings.refreshModelsList());
    $("#btnClearStorage").addEventListener("click", () => Settings.confirmClearStorage());
    $("#btnExportSettings").addEventListener("click", () => Settings.exportSettings());
    $("#btnImportSettings").addEventListener("click", () => Settings.importSettings());
    $("#btnExportWorkspace").addEventListener("click", () => Settings.exportWorkspace());
    $("#btnImportWorkspace").addEventListener("click", () => Settings.importWorkspace());
    $("#providerSelect").addEventListener("change", () => Settings.toggleProvider());
    $("#languageSelect").addEventListener("change", (e) => {
      I18n.setLanguage(e.target.value);
      I18n.translateDOM();
      Ui2.showToast(I18n.t("settings.languageChanged"), "success");
    });
    const themeColorPicker = $("#themeColorPicker");
    const themeColorHex = $("#themeColorHex");
    const applyAccentFromControls = () => {
      const theme = document.documentElement.getAttribute("data-theme") || "dark";
      const hex = themeColorHex ? themeColorHex.value.trim() : "";
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
        Settings.applyAccent(theme, hex);
        if (themeColorPicker)
          themeColorPicker.value = hex;
      }
    };
    if (themeColorPicker) {
      themeColorPicker.addEventListener("input", () => {
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        const color = themeColorPicker.value;
        Settings.applyAccent(theme, color);
        if (themeColorHex)
          themeColorHex.value = color;
      });
    }
    if (themeColorHex)
      themeColorHex.addEventListener("input", applyAccentFromControls);
    const btnResetThemeColor = $("#btnResetThemeColor");
    if (btnResetThemeColor) {
      btnResetThemeColor.addEventListener("click", () => {
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        Settings.resetAccent(theme);
      });
    }
    function buildAppearancePresets() {
      const wrap = $("#appearancePresets");
      if (!wrap)
        return;
      const selected = CardStorage.getAccent(document.documentElement.getAttribute("data-theme") || "dark");
      const fragment = document.createDocumentFragment();
      (Settings.APPEARANCE_PRESETS || []).forEach((preset) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "accent-swatch" + (selected === preset.color ? " active" : "");
        btn.dataset.color = preset.color;
        btn.title = preset.name;
        btn.setAttribute("aria-label", "Accent: " + preset.name);
        btn.style.setProperty("--swatch", preset.color);
        btn.appendChild(document.createTextNode(""));
        fragment.appendChild(btn);
      });
      wrap.innerHTML = "";
      wrap.appendChild(fragment);
      wrap.addEventListener("click", (e) => {
        const swatch = e.target.closest(".accent-swatch");
        if (!swatch)
          return;
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        Settings.applyAccent(theme, swatch.dataset.color);
        Settings.syncAccentControls();
        wrap.querySelectorAll(".accent-swatch").forEach((s) => s.classList.toggle("active", s === swatch));
      });
    }
    buildAppearancePresets();
    const glassDensitySelect = $("#glassDensitySelect");
    if (glassDensitySelect) {
      glassDensitySelect.addEventListener("change", () => {
        CardStorage.setGlassDensity(glassDensitySelect.value);
        Settings.applyAppearance();
      });
    }
    const cardRadiusSelect = $("#cardRadiusSelect");
    if (cardRadiusSelect) {
      cardRadiusSelect.addEventListener("change", () => {
        CardStorage.setCardRadius(cardRadiusSelect.value);
        Settings.applyAppearance();
      });
    }
    const vignetteToggle = $("#vignetteToggle");
    if (vignetteToggle) {
      vignetteToggle.addEventListener("change", () => {
        CardStorage.setVignette(vignetteToggle.checked);
        Settings.applyAppearance();
      });
    }
    settingsModal._element.addEventListener("shown.bs.modal", () => {
      Settings.openSettings();
      const wrap = $("#appearancePresets");
      if (wrap) {
        const current = CardStorage.getAccent(document.documentElement.getAttribute("data-theme") || "dark");
        wrap.querySelectorAll(".accent-swatch").forEach((s) => s.classList.toggle("active", s.dataset.color === current));
      }
    });
    settingsModal._element.addEventListener("hidden.bs.modal", () => {
      const savedProvider = CardStorage.getProvider() || "openrouter";
      AIService.setProvider(savedProvider, savedProvider === "openrouter" ? CardStorage.getApiKey() : savedProvider === "custom" ? CardStorage.getCustomApiKey() : CardStorage.getProviderKey(savedProvider));
    });
    $("#aiModelSelect").addEventListener("change", () => {
      const val = $("#aiModelSelect").value;
      if (val) {
        $("#defaultModelSelect").value = val;
        CardStorage.setDefaultModel(val);
      }
    });
    $("#btnExportJson").addEventListener("click", () => ExportUtils.exportAsJSON());
    $("#btnExportPng").addEventListener("click", () => ExportUtils.exportAsPNG());
    $("#btnDeleteCard").addEventListener("click", () => {
      if (confirm(I18n.t ? I18n.t("batch.deleteConfirm", { count: 1 }) : "Delete this card? This cannot be undone.")) {
        CardManager.deleteActiveCard();
      }
    });
    $("#btnDuplicateCard").addEventListener("click", () => CardManager.duplicateCard());
    $("#btnBatchDelete").addEventListener("click", () => CardManager.batchDelete());
    $("#btnBatchExport").addEventListener("click", () => CardManager.batchExportJSON());
    $("#btnBatchCompare").addEventListener("click", () => CardManager.batchCompare());
    const avatar = $("#charAvatar");
    const avatarInput = $("#avatarInput");
    if (avatar) {
      avatar.addEventListener("click", () => avatarInput.click());
      avatar.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          avatarInput.click();
        }
      });
      avatar.addEventListener("dragover", (e) => {
        e.preventDefault();
        avatar.classList.add("drag-over");
      });
      avatar.addEventListener("dragleave", () => avatar.classList.remove("drag-over"));
      avatar.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        avatar.classList.remove("drag-over");
        const f = e.dataTransfer?.files?.[0];
        if (f && f.type.startsWith("image/"))
          Editor.setAvatar(f);
      });
    }
    if (avatarInput)
      avatarInput.addEventListener("change", (e) => {
        const f = e.target.files?.[0];
        if (f)
          Editor.setAvatar(f);
        e.target.value = "";
      });
    [
      "editName",
      "editDescription",
      "editPersonality",
      "editScenario",
      "editFirstMes",
      "editMesExample",
      "editCreatorNotes",
      "editSystemPrompt",
      "editPostHistory",
      "editCreator",
      "editVersion",
      "editTags"
    ].forEach((id) => {
      const el = $("#" + id);
      if (el) {
        const field = id.replace("edit", "");
        const camelField = field.charAt(0).toLowerCase() + field.slice(1);
        el.addEventListener("focus", () => {
          Editor._lastSnapField = null;
        });
        el.addEventListener("beforeinput", () => {
          if (Editor._lastSnapField !== camelField) {
            Editor._snapshot(camelField);
            Editor._lastSnapField = camelField;
          }
        });
        el.addEventListener("input", Ui2.debounce(() => {
          Ui2._markTouchedField(camelField);
          Editor.syncEditorToCard().catch(() => {});
          Editor.updateCharCounts();
          Editor.autoResizeTextareas();
          AiChat.updateContextBar();
        }, DEBOUNCE_INPUT_MS));
      }
    });
    document.querySelectorAll(".field-toggle-group").forEach((group) => {
      const targetId = group.dataset.target;
      group.querySelectorAll(".field-toggle-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.dataset.mode;
          group.querySelectorAll(".field-toggle-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const textarea = document.getElementById(targetId);
          const previewId = "preview" + targetId.replace("edit", "");
          const preview = document.getElementById(previewId);
          if (!textarea || !preview)
            return;
          if (mode === "preview") {
            textarea.style.display = "none";
            preview.innerHTML = Ui2.renderMarkdown(textarea.value, preview);
            preview.classList.add("visible");
          } else {
            textarea.style.display = "";
            preview.classList.remove("visible");
            preview.innerHTML = "";
          }
        });
      });
    });
    $("#btnAiSend").addEventListener("click", () => AiChat.send());
    $("#btnApplyPrev").addEventListener("click", () => AiChat._applyNav(-1));
    $("#btnApplyNext").addEventListener("click", () => AiChat._applyNav(1));
    $("#aiInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        AiChat.send();
      }
    });
    $("#btnClearChat").addEventListener("click", () => AiChat.clearChat());
    $("#btnChatHistory").addEventListener("click", () => AiChat.toggleHistory());
    $("#aiInput").addEventListener("input", Ui2.debounce(() => AiChat.updateContextBar(), 400));
    $("#aiModelSelect").addEventListener("change", () => AiChat.updateContextBar());
    const stopBtn = $("#btnAiStop");
    if (stopBtn)
      stopBtn.addEventListener("click", () => {
        AiChat._abortAll();
        window.AppState.isAiLoading = false;
        AiChat.updateSendButton();
      });
    const greetingCountInput = $("#aiGreetingCountInput");
    if (greetingCountInput) {
      greetingCountInput.addEventListener("change", () => {
        AiChat._greetingCount = parseInt(greetingCountInput.value) || 3;
      });
    }
    $$(".quick-action").forEach((btn) => {
      btn.addEventListener("click", () => AiChat.handleQuickAction(btn.dataset.action));
    });
    $("#modelSearch").addEventListener("input", Ui2.debounce(() => Settings.filterModels(), DEBOUNCE_SEARCH_MS2));
    $("#btnAddLoreEntry").addEventListener("click", () => Editor.addLorebookEntry());
    $("#btnAddGreeting").addEventListener("click", () => Editor.addGreeting());
    const sortSelect = $("#cardSortSelect");
    if (sortSelect) {
      sortSelect.addEventListener("change", () => {
        CardManager._sortMode = sortSelect.value;
        CardManager.renderCardList();
      });
    }
    const tagToggle = $("#btnToggleTagCloud");
    if (tagToggle) {
      tagToggle.addEventListener("click", () => {
        const wrap = $("#tagCloudWrap");
        if (wrap)
          wrap.classList.toggle("open");
      });
    }
    const loreSearch = $("#lorebookSearchInput");
    if (loreSearch) {
      loreSearch.addEventListener("input", Ui2.debounce(() => {
        if (window.AppState.activeCard)
          Editor.renderLorebook(window.AppState.activeCard);
      }, DEBOUNCE_SEARCH_MS2));
    }
    document.addEventListener("keydown", handleKeyboardShortcuts);
    const toggleAI = $("#btnToggleAI");
    if (toggleAI) {
      toggleAI.addEventListener("click", () => {
        document.querySelector("#panelRight").classList.toggle("mobile-open");
      });
    }
    const themeToggle = $("#btnThemeToggle");
    const savedTheme = localStorage.getItem(CardStorage.PREFIX + "theme") || "dark";
    if (savedTheme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    }
    const initialAccent = CardStorage.getAccent(savedTheme);
    if (initialAccent)
      Settings.applyAccent(savedTheme, initialAccent);
    Settings.applyAppearance();
    if (themeToggle) {
      themeToggle.innerHTML = savedTheme === "light" ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-fill"></i>';
      themeToggle.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme");
        const next = current === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", next);
        const accent = CardStorage.getAccent(next);
        if (accent)
          Settings.applyAccent(next, accent);
        else {
          [
            "--accent-300",
            "--accent-400",
            "--accent-500",
            "--accent-600",
            "--accent-700",
            "--accent-glow",
            "--accent-glow-strong",
            "--accent-text"
          ].forEach((name) => document.documentElement.style.removeProperty(name));
          document.documentElement.removeAttribute("data-accent-custom");
        }
        localStorage.setItem(CardStorage.PREFIX + "theme", next);
        Settings.applyAppearance();
        Anims.iconSpin(themeToggle.querySelector("i"));
        themeToggle.innerHTML = next === "light" ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-fill"></i>';
      });
    }
    const brandIcon = $(".brand-icon");
    if (brandIcon)
      brandIcon.classList.add("brand-float");
    document.addEventListener("mousedown", (e) => {
      const btn = e.target.closest(".btn");
      if (btn && !Anims._disabled())
        Anims.scaleClick(btn);
    });
    setupPanelResizers();
    setupPanelCollapse();
  }
  function setupPanelCollapse() {
    const app = document.querySelector("#appContainer");
    const storageKey = (side) => CardStorage.PREFIX + "panel" + (side === "left" ? "Left" : "Right") + "Collapsed";
    const setCollapsed = (side, collapsed) => {
      const cls = side === "left" ? "side-left-collapsed" : "side-right-collapsed";
      app.classList.toggle(cls, collapsed);
      localStorage.setItem(storageKey(side), collapsed ? "1" : "0");
      const btn = document.querySelector(side === "left" ? "#btnCollapseLeft" : "#btnCollapseRight");
      if (btn) {
        btn.classList.toggle("active", collapsed);
        const icon = btn.querySelector("i");
        if (icon) {
          const left = side === "left";
          icon.className = (left ? collapsed : !collapsed) ? "bi bi-chevron-double-right" : "bi bi-chevron-double-left";
        }
      }
    };
    const isCollapsed = (side) => app.classList.contains(side === "left" ? "side-left-collapsed" : "side-right-collapsed");
    const toggle = (side) => setCollapsed(side, !isCollapsed(side));
    setCollapsed("left", (localStorage.getItem(storageKey("left")) || "0") === "1");
    setCollapsed("right", (localStorage.getItem(storageKey("right")) || "0") === "1");
    const q = (sel) => document.querySelector(sel);
    const collapseLeft = q("#btnCollapseLeft");
    const collapseRight = q("#btnCollapseRight");
    const expandLeft = q("#edgeExpandLeft");
    const expandRight = q("#edgeExpandRight");
    const focusBtn = q("#btnFocusMode");
    if (collapseLeft)
      collapseLeft.addEventListener("click", () => toggle("left"));
    if (collapseRight)
      collapseRight.addEventListener("click", () => toggle("right"));
    if (expandLeft)
      expandLeft.addEventListener("click", () => setCollapsed("left", false));
    if (expandRight)
      expandRight.addEventListener("click", () => setCollapsed("right", false));
    if (focusBtn) {
      focusBtn.addEventListener("click", () => {
        const enterFocus = !(isCollapsed("left") && isCollapsed("right"));
        setCollapsed("left", enterFocus);
        setCollapsed("right", enterFocus);
        Anims.pulseIcon(focusBtn.querySelector("i"));
      });
    }
    Ui2.togglePanelCollapse = (side) => toggle(side);
    Ui2.setFocusMode = (on) => {
      setCollapsed("left", on);
      setCollapsed("right", on);
    };
  }
  function setupPanelResizers() {
    const CENTER_MIN = 320;
    const LEFT_MIN = 220;
    const LEFT_MAX = 480;
    const RIGHT_MIN = 280;
    const RIGHT_MAX = 560;
    const root = document.documentElement;
    const app = document.querySelector("#appContainer");
    function readSavedWidth(key, fallback) {
      const raw = localStorage.getItem(CardStorage.PREFIX + key);
      const n = raw ? parseFloat(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
    }
    function applyClampedWidths(persist) {
      const containerWidth = app.getBoundingClientRect().width || window.innerWidth || 0;
      let left = readSavedWidth("panelLeft", 300);
      let right = readSavedWidth("panelRight", 360);
      left = Math.max(LEFT_MIN, Math.min(LEFT_MAX, left));
      right = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, right));
      const budget = Math.max(0, containerWidth - CENTER_MIN);
      if (left + right > budget) {
        const overflow = left + right - budget;
        const headroom = left - LEFT_MIN + (right - RIGHT_MIN);
        if (headroom > 0) {
          const leftCut = Math.min(left - LEFT_MIN, Math.round(overflow * ((left - LEFT_MIN) / headroom)));
          const rightCut = Math.min(right - RIGHT_MIN, Math.round(overflow * ((right - RIGHT_MIN) / headroom)));
          left = Math.max(LEFT_MIN, left - leftCut);
          right = Math.max(RIGHT_MIN, right - rightCut);
          if (left + right > budget) {
            if (left > LEFT_MIN)
              left = Math.max(LEFT_MIN, left - (left + right - budget));
            else
              right = Math.max(RIGHT_MIN, right - (left + right - budget));
          }
        }
      }
      root.style.setProperty("--panel-left-width", left + "px");
      root.style.setProperty("--panel-right-width", right + "px");
      if (persist) {
        localStorage.setItem(CardStorage.PREFIX + "panelLeft", String(left));
        localStorage.setItem(CardStorage.PREFIX + "panelRight", String(right));
      }
    }
    applyClampedWidths(true);
    window.addEventListener("resize", () => {
      requestAnimationFrame(() => applyClampedWidths(false));
    });
    const startDrag = (which) => (e) => {
      e.preventDefault();
      document.body.classList.add("resizing");
      const rect = app.getBoundingClientRect();
      const move = (ev) => {
        const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
        if (which === "left") {
          let w = Math.round(x - rect.left);
          w = Math.max(LEFT_MIN, Math.min(LEFT_MAX, w));
          const rightW = parseFloat(root.style.getPropertyValue("--panel-right-width")) || 360;
          w = Math.min(w, Math.max(LEFT_MIN, rect.width - rightW - CENTER_MIN));
          root.style.setProperty("--panel-left-width", w + "px");
        } else {
          let w = Math.round(rect.right - x);
          w = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, w));
          const leftW = parseFloat(root.style.getPropertyValue("--panel-left-width")) || 300;
          w = Math.min(w, Math.max(RIGHT_MIN, rect.width - leftW - CENTER_MIN));
          root.style.setProperty("--panel-right-width", w + "px");
        }
      };
      let safetyTimer = null;
      const up = () => {
        document.body.classList.remove("resizing");
        const finalLeft = Math.round(parseFloat(root.style.getPropertyValue("--panel-left-width"))) || 300;
        const finalRight = Math.round(parseFloat(root.style.getPropertyValue("--panel-right-width"))) || 360;
        localStorage.setItem(CardStorage.PREFIX + "panelLeft", String(finalLeft));
        localStorage.setItem(CardStorage.PREFIX + "panelRight", String(finalRight));
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("touchmove", move);
        window.removeEventListener("touchend", up);
        window.removeEventListener("blur", up);
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = null;
        }
      };
      safetyTimer = setTimeout(up, 5000);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("touchend", up);
      window.addEventListener("blur", up);
    };
    const rl = document.querySelector("#resizerLeft");
    const rr = document.querySelector("#resizerRight");
    if (rl) {
      rl.addEventListener("mousedown", startDrag("left"));
      rl.addEventListener("touchstart", startDrag("left"), { passive: false });
    }
    if (rr) {
      rr.addEventListener("mousedown", startDrag("right"));
      rr.addEventListener("touchstart", startDrag("right"), { passive: false });
    }
  }
  function handleKeyboardShortcuts(e) {
    const inField = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable;
    if (inField) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        CardManager.saveCurrentCard();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      Editor.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || e.key.toLowerCase() === "z" && e.shiftKey)) {
      e.preventDefault();
      Editor.redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      CardManager.saveCurrentCard();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "n") {
      e.preventDefault();
      CardManager.createNewCard();
    }
    if (e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      const app = document.querySelector("#appContainer");
      const focused = app && app.classList.contains("side-left-collapsed") && app.classList.contains("side-right-collapsed");
      if (Ui2.setFocusMode)
        Ui2.setFocusMode(!focused);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
      e.preventDefault();
      if (Ui2.togglePanelCollapse)
        Ui2.togglePanelCollapse("right");
      return;
    }
    if (e.key === "?") {
      Ui2._shortcutsModal = Ui2._shortcutsModal || new bootstrap.Modal("#shortcutsModal");
      Ui2._shortcutsModal.show();
    }
  }
  async function handleStorageChange(e) {
    if (!e.key || !e.key.startsWith(CardStorage.PREFIX))
      return;
    const rel = e.key.slice(CardStorage.PREFIX.length);
    const isCardData = rel === CardStorage._keys.cardIndex || rel === CardStorage._keys.activeCardId || rel.startsWith("card_") || rel.startsWith(CardStorage._keys.aiChatHistory + "_") || rel.startsWith("chatSessions_") || rel.startsWith("sessionMsgs_");
    if (!isCardData)
      return;
    window.AppState.cards = CardStorage.getCards();
    CardManager.renderCardList();
    if (window.AppState.activeCard) {
      const active = document.activeElement;
      if (window.AppState._dirty) {
        if (Ui2._pendingRemoteReload)
          return;
        Ui2._pendingRemoteReload = true;
        Ui2._pendingRemoteCardId = window.AppState.activeCard._id;
        Ui2._pendingRemoteTouched = new Set;
        CardStorage.getCard(window.AppState.activeCard._id).then((c) => {
          if (c && Ui2._pendingRemoteCardId === window.AppState.activeCard._id)
            Ui2._pendingRemoteSnapshot = c;
        }).catch((err) => console.error("Failed to snapshot remote card:", err));
        return;
      }
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable))
        return;
      Ui2._reloadActiveCard(window.AppState.activeCard._id);
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
