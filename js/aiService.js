/* ============================================================
   aiService.js — OpenRouter API Integration
   ============================================================ */

const AIService = {
  BASE_URL: 'https://openrouter.ai/api/v1',

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
    return {
      label: data.label || 'Unknown',
      limit: data.limit || 0,
      limit_remaining: data.limit_remaining ?? 0,
      usage: data.usage || 0,
      is_free_tier: data.is_free_tier || false,
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
    
    // Use a free model by default
    const useModel = model || 'meta-llama/llama-3.3-70b-instruct:free';
    
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
        temperature: 0.7,
        max_tokens: 4096,
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


};

window.AIService = AIService;
