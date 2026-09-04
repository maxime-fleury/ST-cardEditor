/* ============================================================
   aiService.js — OpenRouter API Integration
   ============================================================ */

const AIService = {
  DEFAULT_TEMPERATURE: 0.7,
  DEFAULT_MAX_TOKENS: 16384,

  PROVIDERS: {
    openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true },
    nanogpt:    { name: 'NanoGPT',    baseUrl: 'https://api.nano-gpt.com/api/v1', requiresKey: true },
    xai:        { name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', requiresKey: true },
    zai:        { name: 'Z.AI (GLM)', baseUrl: 'https://api.z.ai/api/paas/v4', requiresKey: true },
    chutes:     { name: 'Chutes',     baseUrl: 'https://llm.chutes.ai/v1', requiresKey: true },
    deepseek:   { name: 'DeepSeek',   baseUrl: 'https://api.deepseek.com/v1', requiresKey: true },
    custom:     { name: 'Custom',     baseUrl: '', requiresKey: false },
  },

  FREE_MODEL_PATTERNS: [ ':free', 'openrouter/free' ],
  _provider: 'openrouter',
  _apiKey: '',
  _customApiUrl: '',

  /**
   * Get the provider registry entry.
   */
  getProviderInfo(id) {
    return this.PROVIDERS[id] || this.PROVIDERS.custom;
  },

  /**
   * Set the active provider.
   */
  setProvider(provider, customKey) {
    this._provider = provider || 'openrouter';
    this._apiKey = customKey || '';
    this._customApiUrl = '';
  },

  /**
   * Get the effective base URL for the current provider.
   */
  _getBaseUrl() {
    const info = this.getProviderInfo(this._provider);
    if (this._provider === 'custom') {
      // Prefer the in-memory URL (mirrors what is currently typed in the
      // settings form) so typed-but-unsaved endpoints work on first setup;
      // fall back to the persisted one.
      return (this._customApiUrl || CardStorage.getCustomApiUrl() || '').replace(/\/+$/, '');
    }
    return info.baseUrl;
  },

  /**
   * Get the API key for the current provider.
   * The in-memory key (set via setProvider/setApiKey, mirroring the latest
   * saved or typed credential) takes precedence; fall back to storage.
   */
  _getApiKeyForProvider() {
    if (this._apiKey) return this._apiKey;
    if (this._provider === 'openrouter') return CardStorage.getApiKey();
    if (this._provider === 'custom') return CardStorage.getCustomApiKey();
    return CardStorage.getProviderKey(this._provider);
  },

  _resolveModel(model) {
    // Prefer the navbar dropdown selection; fall back to a manually
    // configured "Model ID" (Settings) for providers without a model list.
    return model || CardStorage.getCustomModelId() || '';
  },

  async setApiKey(key) {
    this._apiKey = key;
    // Persist to the slot that actually belongs to the active provider:
    // named providers each have their own slot, so writing them into the
    // custom slot would cross-send credentials later (v2 #7).
    if (this._provider === 'openrouter') await CardStorage.setApiKey(key);
    else if (this._provider === 'custom') await CardStorage.setCustomApiKey(key);
    else await CardStorage.setProviderKey(this._provider, key);
  },
  getApiKey() { return this._getApiKeyForProvider(); },

  hasApiKey() {
    const info = this.getProviderInfo(this._provider);
    if (!info.requiresKey) return true;
    return !!this._getApiKeyForProvider();
  },

  /**
   * Check if a model ID indicates a free model.
   */
  _isFreeModelId(modelId, pricing) {
    // Check by pricing (0 cost)
    const pPrompt = pricing?.prompt;
    const pCompletion = pricing?.completion;
    if (parseFloat(pPrompt) === 0 && parseFloat(pCompletion) === 0) return true;
    // Check by ID pattern
    if (modelId && this.FREE_MODEL_PATTERNS.some(p => modelId.includes(p))) return true;
    return false;
  },

  /**
   * Parse a pricing value from OpenRouter (can be string or number).
   * Returns number or null.
   */
  _parsePrice(val) {
    if (val === null || val === undefined) return null;
    const num = typeof val === 'string' ? parseFloat(val) : val;
    if (isNaN(num)) return null;
    return num * 1_000_000; // Convert to per-million rate
  },

  /**
   * Fetch available models with pricing.
   */
  async fetchModels() {
    if (this._provider === 'custom') {
      return this._fetchCustomModels();
    }
    if (!this._getApiKeyForProvider()) throw new Error(I18n.t('error.apiKeyNotSet'));

    const resp = await fetch(`${this._getBaseUrl()}/models`, {
      headers: {
        'Authorization': `Bearer ${this._getApiKeyForProvider()}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
    
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    
    const data = await resp.json();
    
    // Sort: free first, then by pricing
    const models = (data.data || []).map(m => {
      const pricing = m.pricing || {};
      const promptPrice = this._parsePrice(pricing.prompt);
      const completionPrice = this._parsePrice(pricing.completion);
      return {
        id: m.id,
        name: m.name || m.id,
        description: m.description || '',
        context_length: m.context_length || 0,
        max_output_tokens: m.top_provider?.max_completion_tokens || m.max_completion_tokens || 0,
        pricing: {
          prompt: promptPrice,
          completion: completionPrice,
        },
        is_free: this._isFreeModelId(m.id, pricing),
        provider: (m.id || '').split('/')[0],
      };
    }).sort((a, b) => {
      if (a.is_free !== b.is_free) return a.is_free ? -1 : 1;
      const aPrice = (a.pricing.prompt || 0) + (a.pricing.completion || 0);
      const bPrice = (b.pricing.prompt || 0) + (b.pricing.completion || 0);
      return aPrice - bPrice;
    });
    
    return models;
  },

  /**
   * Fetch models from a custom (OpenAI-compatible) provider.
   */
  async _fetchCustomModels() {
    const baseUrl = this._getBaseUrl();
    if (!baseUrl) throw new Error(I18n.t ? I18n.t('error.customUrlNotSet') : 'Custom API base URL is not set');
    const apiBaseUrl = this._v1BaseUrl(baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = this._getApiKeyForProvider();
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

    let resp;
    try {
      resp = await fetch(apiBaseUrl + '/models', {
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      // Network/CSP failure: guide the user instead of a bare "Failed to fetch".
      throw new Error(I18n.t ? I18n.t('error.customUnreachable', { url: apiBaseUrl }) : 'Cannot reach ' + apiBaseUrl + '. Check the URL and that the server is running.');
    }
    // A few local servers expose /v1/models only when the user entered the
    // host root, while others expose /models from an already versioned URL.
    // Try the alternate form once when the first path is not available.
    if (resp.status === 404) {
      const alternateUrl = apiBaseUrl.slice(0, -3) + '/models';
      try {
        resp = await fetch(alternateUrl, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
      } catch (err) {
        throw new Error(I18n.t ? I18n.t('error.customUnreachable', { url: alternateUrl }) : 'Cannot reach ' + alternateUrl + '.');
      }
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (err.error?.message) throw new Error(err.error.message);
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(I18n.t ? I18n.t('error.customAuthFailed', { status: resp.status }) : 'Authentication failed (HTTP ' + resp.status + '). Check the API key for this endpoint.');
      }
      if (resp.status === 404) {
        throw new Error(I18n.t ? I18n.t('error.customPathNotFound') : 'Endpoint not found (HTTP 404). Check that the API Base URL includes /v1.');
      }
      throw new Error(I18n.t ? I18n.t('error.fetchModelsFailed', { status: resp.status }) : 'Failed to fetch models (HTTP ' + resp.status + ')');
    }

    const data = await resp.json().catch(() => ({}));
    // Some compatible servers answer 200 with an { error } body for unknown
    // paths (e.g. custom router backends). Surface it instead of a silent empty list.
    if (data.error) {
      const msg = (typeof data.error === 'string' ? data.error : data.error.message) || '';
      throw new Error(I18n.t ? I18n.t('error.customServerError', { detail: msg }) : 'The server returned an error: ' + msg);
    }
    const customModelId = CardStorage.getCustomModelId();
    const returnedModels = Array.isArray(data.data) ? data.data : [];

    // If the provider returns a model list, use it. Some compatible servers
    // return an empty/omitted data array; in that case retain the configured
    // model as a usable fallback.
    if (returnedModels.length) {
      return returnedModels.map(m => ({
        id: m.id,
        name: m.name || m.id,
        description: m.description || '',
        context_length: m.context_length || m.max_context_length || 0,
        max_output_tokens: m.max_output_tokens || m.max_tokens || 0,
        pricing: { prompt: null, completion: null },
        is_free: true,
        provider: 'custom',
      }));
    }

    // Fallback: if no list but we have a custom model ID, return it
    if (customModelId) {
      return [{ id: customModelId, name: customModelId, description: (I18n.t ? I18n.t('settings.customModelDesc') : 'Custom model'), context_length: 0, max_output_tokens: 0, pricing: { prompt: null, completion: null }, is_free: true, provider: 'custom' }];
    }

    return [];
  },

  /**
   * Fetch API key info (credits, limits, usage).
   * Only OpenRouter exposes /key; other providers return 404, so the callers
   * only use this for OpenRouter.
   */
  async fetchKeyInfo() {
    if (this._provider !== 'openrouter') throw new Error(I18n.t ? I18n.t('gen.notAvailable') : 'N/A');
    if (!this._getApiKeyForProvider()) throw new Error(I18n.t('error.apiKeyNotSet'));
    
    const resp = await fetch(`${this._getBaseUrl()}/key`, {
      headers: {
        'Authorization': `Bearer ${this._getApiKeyForProvider()}`,
        'Content-Type': 'application/json',
      },
      signal: this._withTimeout(null),
    });
    
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    
    const data = await resp.json();
    const key = data.data || {};
    return {
      label: key.label || 'Unknown',
      // Preserve null ("unlimited") instead of collapsing it to 0 — settings.js
      // distinguishes "unlimited" (null) from "$0.00" (spent up).
      limit: key.limit ?? null,
      limit_remaining: key.limit_remaining ?? null,
      usage: key.usage || 0,
      is_free_tier: key.is_free_tier || false,
    };
  },

  /**
   * Build request body for chat completion.
   */
  _buildRequestBody(model, messages, { jsonMode = false, stream = false } = {}) {
    const body = {
      model,
      messages,
      temperature: this.DEFAULT_TEMPERATURE,
      stream,
    };
    const userMax = CardStorage.getMaxTokens();
    if (userMax > 0) body.max_tokens = userMax;
    if (jsonMode) body.response_format = { type: 'json_object' };
    if (stream) body.stream_options = { include_usage: true };
    return body;
  },

  /**
   * Extract the provider's error message from a non-OK response body.
   * Servers differ: some return `{ error: { message } }`, others (llama.cpp
   * and friends) return `{ error: "plain string" }`. A bare HTTP status is
   * the last resort so callers never see an unhelpful "HTTP 400" that hides
   * the actionable detail (and defeats the jsonMode retry guard).
   */
  _extractApiError(err, status) {
    if (err && typeof err === 'object') {
      const e = err.error;
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && e.message) return e.message;
    }
    return `HTTP ${status}`;
  },

  /**
   * Check if an error is caused by unsupported response_format.
   */
  _isUnsupportedFormatError(errMsg) {
    if (!errMsg) return false;
    const lower = errMsg.toLowerCase();
    if (!lower.includes('response_format')) return false;
    // Only retry without response_format when the error is *specifically*
    // about the jsonMode we sent — not any unrelated "unsupported" wording.
    // llama.cpp and similar OpenAI-compatible servers only accept
    // json_schema/text and reject json_object with e.g. "'response_format.type'
    // must be 'json_schema' or 'text'" — match that wording too (live-model
    // finding) so the tags/translate flows fall back to plain text.
    return lower.includes('unsupported') || lower.includes('not support') ||
      lower.includes('invalid') || lower.includes('not allowed') ||
      lower.includes('does not support') || lower.includes('must be') ||
      lower.includes('only supports');
  },

  /**
   * Build messages array with system prompt, history, and user prompt.
   */
  _buildMessages(systemPrompt, prompt, history = []) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const msg of history) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content: msg.content || '' });
      }
    }
    messages.push({ role: 'user', content: prompt });
    return messages;
  },

  /**
   * Send a chat completion request.
   * @param {string} prompt - User prompt
   * @param {string} systemPrompt - System instructions
   * @param {string} model - Model ID
   * @param {object} opts - { jsonMode, signal, history }
   * @returns {Promise<object>} { content, usage, model }
   */
  _v1BaseUrl(baseUrl) {
    return baseUrl.endsWith('/v1') ? baseUrl : baseUrl + '/v1';
  },

  /**
   * Combine an external controller signal with the 120 s idle timeout.
   */
  _withTimeout(signal) {
    const timeout = AbortSignal.timeout(120000);
    if (!signal) return timeout;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
    return signal; // Older browsers: rely on the caller's controller alone.
  },

  /**
   * Chat-completions base URL for the active provider.
   * Named providers ship a versioned API root (Z.AI is .../api/paas/v4,
   * not /v1), so _v1BaseUrl is only applied to user-typed Custom endpoints.
   */
  _getChatBaseUrl() {
    const baseUrl = this._getBaseUrl();
    if (this._provider === 'custom') return this._v1BaseUrl(baseUrl);
    return baseUrl;
  },

  async chat(prompt, systemPrompt = '', model = '', opts = {}) {
    const safeOpts = (typeof opts === 'object' && opts !== null) ? opts : {};
    const { jsonMode = false, signal, history = [] } = safeOpts;
    const apiKey = this._getApiKeyForProvider();
    const info = this.getProviderInfo(this._provider);
    if (!apiKey && info.requiresKey) throw new Error(I18n.t('error.apiKeyNotSet'));
    
    const messages = this._buildMessages(systemPrompt, prompt, history);
    
    const useModel = this._resolveModel(model);
    if (!useModel) throw new Error(I18n.t('error.noModel'));

    const baseUrl = this._getBaseUrl();
    if (!baseUrl) throw new Error(I18n.t ? I18n.t('error.customUrlNotSet') : 'Custom API base URL is not set');
    const apiBaseUrl = this._getChatBaseUrl();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    if (this._provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/st-card-editor';
      headers['X-Title'] = 'ST Card Editor';
    }

    const fetchChat = async (useJsonMode) => {
      const resp = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(this._buildRequestBody(useModel, messages, { jsonMode: useJsonMode, stream: false })),
        signal: this._withTimeout(signal),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (resp.status === 402) throw new Error(I18n.t('error.insufficientCredits'));
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
    if (!choice) throw new Error((I18n.t ? I18n.t('error.noChoices') : 'API returned no response choices'));
    return {
      content: choice?.message?.content || '',
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens || 0,
        completion_tokens: data.usage.completion_tokens || 0,
        total_tokens: data.usage.total_tokens || 0,
        cost: data.usage.cost || 0,
      } : null,
      model: data.model || useModel,
    };
  },

  /**
   * Format price for display.
   */
  formatPrice(perMillion) {
    if (perMillion === null || perMillion === undefined) return '—';
    const n = Number(perMillion);
    if (!isFinite(n)) return '—';
    if (n === 0) return I18n.t ? I18n.t('gen.free') : 'Free';
    if (n < 0.001) return `$${n.toFixed(6)}/M`;
    return `$${n.toFixed(3)}/M`;
  },

  async chatStream(prompt, systemPrompt = '', model = '', onChunk, signal, jsonMode = false, history = []) {
    const apiKey = this._getApiKeyForProvider();
    const info = this.getProviderInfo(this._provider);
    if (!apiKey && info.requiresKey) throw new Error(I18n.t('error.apiKeyNotSet'));

    const messages = this._buildMessages(systemPrompt, prompt, history);

    const useModel = this._resolveModel(model);
    if (!useModel) throw new Error(I18n.t('error.noModelSimple'));

    const baseUrl = this._getBaseUrl();
    if (!baseUrl) throw new Error(I18n.t ? I18n.t('error.customUrlNotSet') : 'Custom API base URL is not set');
    const apiBaseUrl = this._getChatBaseUrl();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    if (this._provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/st-card-editor';
      headers['X-Title'] = 'ST Card Editor';
    }

    const doStream = async (useJsonMode) => {
      const resp = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(this._buildRequestBody(useModel, messages, { jsonMode: useJsonMode, stream: true })),
        signal: this._withTimeout(signal),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (resp.status === 402) throw new Error(I18n.t('error.insufficientCredits'));
        throw new Error(this._extractApiError(err, resp.status));
      }
      return resp;
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

    if (!resp.body) throw new Error((I18n.t ? I18n.t('error.emptyResponse') : 'Empty response from API (no body)'));

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let usage = null;
    let eventType = '';
    let streamDone = false;

    try {
      let bufferStr = '';
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        bufferStr += decoder.decode(value, { stream: true });
        const lines = bufferStr.split('\n');
        bufferStr = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('event: ')) { eventType = trimmed.slice(7).trim(); continue; }
          if (trimmed.startsWith(':')) continue; // SSE comment (e.g. : ping)
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') { eventType = ''; streamDone = true; break; }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) { full += delta; onChunk(full, delta); }
            if (parsed.usage) usage = parsed.usage;
            if (eventType === 'error') {
              const msg = parsed.error?.message || parsed.detail || data;
              throw new Error(msg);
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              console.warn('aiService: dropped unparseable SSE chunk:', data);
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
        cost: usage.cost || 0,
      } : null,
      model: useModel,
    };
  },

  /**
   * Estimate max output tokens for UI display (context bar).
   * Returns the model's reported max_output_tokens or DEFAULT_MAX_TOKENS,
   * capped by available context space.
   */
  async resolveMaxTokens(modelId, messages = []) {
    const ctxLength = this._getContextLength(modelId);

    let inputTokens = 0;
    try {
      if (window.Tokenizer && typeof window.Tokenizer.count === 'function') {
        const counts = await Promise.all((messages || []).map(m => window.Tokenizer.count(m.content || '')));
        inputTokens = counts.reduce((sum, n) => sum + (n || 0), 0);
      }
    } catch (_) { inputTokens = 0; }
    if (!inputTokens && messages?.length) {
      inputTokens = (messages || []).reduce((sum, m) => {
        const quick = window.Tokenizer && typeof window.Tokenizer.quickCount === 'function'
          ? window.Tokenizer.quickCount(m.content || '')
          : Math.ceil((m.content || '').length / 3);
        return sum + quick;
      }, 0);
    }

    const safetyMargin = Math.max(512, Math.floor(ctxLength * 0.05));
    const available = Math.max(512, ctxLength - inputTokens - safetyMargin);

    let maxTokens = this.DEFAULT_MAX_TOKENS;
    if (modelId && window.AppState.models) {
      const m = window.AppState.models.find(x => x.id === modelId);
      if (m && m.max_output_tokens > 0) maxTokens = m.max_output_tokens;
    }

    return Math.min(maxTokens, available);
  },

  /**
   * Public: get context length for a model (fallback 128k).
   */
  getContextLength(modelId) {
    return this._getContextLength(modelId);
  },

  /**
   * Get context length for a model.
   */
  _getContextLength(modelId) {
    if (modelId && window.AppState.models) {
      const m = window.AppState.models.find(x => x.id === modelId);
      if (m && m.context_length > 0) return m.context_length;
    }
    return 128000; // safe fallback
  },


};

export { AIService };
if (typeof window !== 'undefined') window.AIService = AIService;
