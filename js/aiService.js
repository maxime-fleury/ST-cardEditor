/* ============================================================
   aiService.js — OpenRouter API Integration
   ============================================================ */

const AIService = {
  BASE_URL: 'https://openrouter.ai/api/v1',
  DEFAULT_TEMPERATURE: 0.7,
  DEFAULT_MAX_TOKENS: 65536,

  /**
   * Known free model IDs on OpenRouter (for quick identification).
   */
  FREE_MODEL_PATTERNS: [
    ':free',
    'openrouter/free',
  ],

  /**
   * Set the API key for all requests.
   */
  setApiKey(key) {
    this._apiKey = key;
  },

  /**
   * Get current API key.
   */
  getApiKey() {
    return this._apiKey || '';
  },

  /**
   * Check if API key is set.
   */
  hasApiKey() {
    return !!this._apiKey;
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
    if (!this._apiKey) throw new Error('API key not set');
    
    const resp = await fetch(`${this.BASE_URL}/models`, {
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
      },
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
   * Fetch API key info (credits, limits, usage).
   */
  async fetchKeyInfo() {
    if (!this._apiKey) throw new Error('API key not set');
    
    const resp = await fetch(`${this.BASE_URL}/key`, {
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
      },
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
    if (!this._apiKey) throw new Error('API key not set');
    
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    
    // Require an explicit model selection
    if (!model) {
      throw new Error('No model selected. Please choose a model from the navbar or settings.');
    }
    const useModel = model;

    const maxTokens = this.resolveMaxTokens(model, messages);
    
    const resp = await fetch(`${this.BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/st-card-editor',
        'X-Title': 'ST Card Editor',
      },
      body: JSON.stringify({
        model: useModel,
        messages: messages,
        temperature: this.DEFAULT_TEMPERATURE,
        max_tokens: maxTokens,
        stream: false,
      }),
    });
    
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (resp.status === 402) {
        throw new Error('Insufficient credits. Please top up your OpenRouter account.');
      }
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

  async chatStream(prompt, systemPrompt = '', model = '', onChunk) {
    if (!this._apiKey) throw new Error('API key not set');
    if (!model) throw new Error('No model selected.');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const maxTokens = this.resolveMaxTokens(model, messages);

    const resp = await fetch(`${this.BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/st-card-editor',
        'X-Title': 'ST Card Editor',
      },
      body: JSON.stringify({ model, messages, temperature: this.DEFAULT_TEMPERATURE, max_tokens: maxTokens, stream: true }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (resp.status === 402) throw new Error('Insufficient credits.');
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) { full += delta; onChunk(full, delta); }
          if (parsed.usage) usage = parsed.usage;
        } catch (_) {}
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
      model,
    };
  },

  /**
   * Resolve max_tokens: user setting > model limit > default.
   * Caps output so that input + max_tokens <= context_length,
   * reserving 20 % of context for input (safe for all languages).
   */
  resolveMaxTokens(modelId, messages = []) {
    const ctxLength = this._getContextLength(modelId);
    const available = Math.max(1024, Math.floor(ctxLength * 0.8));

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
