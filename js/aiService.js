/* ============================================================
   aiService.js — OpenRouter API Integration
   ============================================================ */

const AIService = {
  DEFAULT_TEMPERATURE: 0.7,
  DEFAULT_MAX_TOKENS: 8192,

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
  },

  /**
   * Get the effective base URL for the current provider.
   */
  _getBaseUrl() {
    const info = this.getProviderInfo(this._provider);
    if (this._provider === 'custom') {
      return (CardStorage.getCustomApiUrl() || '').replace(/\/+$/, '');
    }
    return info.baseUrl;
  },

  /**
   * Get the API key for the current provider.
   * OpenRouter uses CardStorage.getApiKey(), others use CardStorage.getCustomApiKey().
   */
  _getApiKeyForProvider() {
    if (this._provider === 'openrouter') return CardStorage.getApiKey();
    return CardStorage.getCustomApiKey() || '';
  },

  _resolveModel(model) {
    if (this._provider === 'custom') {
      return CardStorage.getCustomModelId() || model || '';
    }
    if (this._provider !== 'openrouter') {
      return CardStorage.getCustomModelId() || model || '';
    }
    return model;
  },

  setApiKey(key) { this._apiKey = key; },
  getApiKey() { return this._apiKey || ''; },

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
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = this._getApiKeyForProvider();
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

    const resp = await fetch(baseUrl + '/models', { headers });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Failed to fetch models (HTTP ' + resp.status + ')');
    }

    const data = await resp.json();
    const customModelId = CardStorage.getCustomModelId();

    // If the provider returns a model list, use it
    if (data.data && data.data.length) {
      return data.data.map(m => ({
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
      return [{ id: customModelId, name: customModelId, description: 'Custom model', context_length: 0, max_output_tokens: 0, pricing: { prompt: null, completion: null }, is_free: true, provider: 'custom' }];
    }

    return [];
  },

  /**
   * Fetch API key info (credits, limits, usage).
   */
  async fetchKeyInfo() {
    if (!this._getApiKeyForProvider()) throw new Error(I18n.t('error.apiKeyNotSet'));
    
    const resp = await fetch(`${this._getBaseUrl()}/key`, {
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
    const key = data.data || {};
    return {
      label: key.label || 'Unknown',
      limit: key.limit || 0,
      limit_remaining: key.limit_remaining ?? 0,
      usage: key.usage || 0,
      is_free_tier: key.is_free_tier || false,
    };
  },

  /**
   * Send a chat completion request.
   * @param {string} prompt - User prompt
   * @param {string} systemPrompt - System instructions
   * @param {string} model - Model ID
   * @returns {Promise<object>} { content, usage, model }
   */
  async chat(prompt, systemPrompt = '', model = '') {
    const apiKey = this._getApiKeyForProvider();
    const info = this.getProviderInfo(this._provider);
    if (!apiKey && info.requiresKey) throw new Error(I18n.t('error.apiKeyNotSet'));
    
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    
    const useModel = this._resolveModel(model);
    if (!useModel) {
      throw new Error(I18n.t('error.noModel'));
    }

    const maxTokens = await this.resolveMaxTokens(useModel, messages);
    const baseUrl = this._getBaseUrl();

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    if (this._provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/st-card-editor';
      headers['X-Title'] = 'ST Card Editor';
    }

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: useModel,
        messages: messages,
        temperature: this.DEFAULT_TEMPERATURE,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (resp.status === 402) throw new Error(I18n.t('error.insufficientCredits'));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    
    const data = await resp.json();
    const choice = data.choices?.[0];
    
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
    if (perMillion === 0) return 'Free';
    return `$${perMillion.toFixed(3)}/M`;
  },

  async chatStream(prompt, systemPrompt = '', model = '', onChunk, signal) {
    const apiKey = this._getApiKeyForProvider();
    const info = this.getProviderInfo(this._provider);
    if (!apiKey && info.requiresKey) throw new Error(I18n.t('error.apiKeyNotSet'));

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const useModel = this._resolveModel(model);
    if (!useModel) throw new Error(I18n.t('error.noModelSimple'));

    const maxTokens = await this.resolveMaxTokens(useModel, messages);
    const baseUrl = this._getBaseUrl();

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    if (this._provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/st-card-editor';
      headers['X-Title'] = 'ST Card Editor';
    }

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: useModel, messages, temperature: this.DEFAULT_TEMPERATURE, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
      signal,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (resp.status === 402) throw new Error(I18n.t('error.insufficientCredits'));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }

    if (!resp.body) throw new Error('Empty response from API (no body)');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let usage = null;
    let eventType = '';

    let bufferStr = '';
    while (true) {
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
        if (data === '[DONE]') { eventType = ''; break; }
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
          if (e instanceof Error) throw e;
          console.warn('aiService: dropped unparseable SSE chunk:', data);
        }
      }
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
   * Resolve max_tokens: user setting > model limit > default.
   * Caps output so that input + max_tokens <= context_length,
   * reserving 20 % of context for input (safe for all languages).
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
      inputTokens = (messages || []).reduce((sum, m) => sum + Math.ceil((m.content || '').length / 4), 0);
    }

    const safetyMargin = Math.max(512, Math.floor(ctxLength * 0.05));
    const available = Math.max(512, ctxLength - inputTokens - safetyMargin);

    const userMax = CardStorage.getMaxTokens();
    if (userMax > 0) return Math.min(userMax, available);

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

window.AIService = AIService;
