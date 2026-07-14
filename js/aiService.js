/* ============================================================
   aiService.js — OpenRouter API Integration
   ============================================================ */

const AIService = {
  BASE_URL: 'https://openrouter.ai/api/v1',

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
    const models = (data.data || []).map(m => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description || '',
      context_length: m.context_length || 0,
      pricing: {
        prompt: m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1_000_000 : null,
        completion: m.pricing?.completion ? parseFloat(m.pricing.completion) * 1_000_000 : null,
      },
      is_free: !m.pricing?.prompt && !m.pricing?.completion,
      provider: (m.id || '').split('/')[0],
    })).sort((a, b) => {
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
    
    const useModel = model || 'google/gemini-flash-1.5';
    
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
