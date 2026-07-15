/* ============================================================
   settings.js — Settings Modal, Model List, Credits
   ============================================================ */

const Settings = {
  saveSettings(modal) {
    const $ = (sel) => document.querySelector(sel);
    const provider = $('#providerSelect').value;
    const apiKey = $('#apiKeyInput').value.trim();
    const defaultModel = $('#defaultModelSelect').value;
    const maxTokens = parseInt($('#maxTokensInput').value, 10) || 0;
    const customApiUrl = $('#customApiUrlInput').value.trim();
    const keyInput = provider === 'custom' ? $('#customApiKeyInput') : $('#namedApiKeyInput');
    const customApiKey = keyInput.value.trim();
    const customModelId = $('#customModelInput').value.trim();

    CardStorage.setProvider(provider);

    if (provider === 'openrouter') {
      CardStorage.setApiKey(apiKey);
      AIService.setProvider('openrouter');
      CardStorage.setDefaultModel(defaultModel);
      $('#aiModelSelect').value = defaultModel;
    } else {
      const info = AIService.getProviderInfo(provider);
      const url = provider === 'custom' ? customApiUrl : info.baseUrl;
      CardStorage.setCustomApiUrl(url);
      CardStorage.setCustomApiKey(customApiKey);
      CardStorage.setCustomModelId(customModelId);
      AIService.setProvider(provider, customApiKey);
      if (customModelId) {
        CardStorage.setDefaultModel(customModelId);
        $('#aiModelSelect').value = customModelId;
      }
    }

    CardStorage.setMaxTokens(maxTokens);
    CardStorage.setInjectCopyright($('#injectCopyrightToggle').checked);

    // Avoid leaving a stale key for the provider we're not using.
    if (provider === 'openrouter') CardStorage.setCustomApiKey('');
    else CardStorage.setApiKey('');

    modal.hide();
    Ui.showToast(I18n.t('toast.settingsSaved'), 'success');
    if (provider === 'openrouter' && apiKey) { this.refreshCredits(); this.refreshModelsList(); }
  },

  toggleApiKeyVisibility() {
    const $ = (sel) => document.querySelector(sel);
    const input = $('#apiKeyInput');
    const icon = $('#btnToggleApiKey i');
    if (input.type === 'password') { input.type = 'text'; icon.className = 'bi bi-eye-slash-fill'; }
    else { input.type = 'password'; icon.className = 'bi bi-eye-fill'; }
  },

  toggleNamedApiKeyVisibility() {
    const $ = (sel) => document.querySelector(sel);
    const input = $('#namedApiKeyInput');
    const icon = $('#btnToggleNamedApiKey i');
    if (input.type === 'password') { input.type = 'text'; icon.className = 'bi bi-eye-slash-fill'; }
    else { input.type = 'password'; icon.className = 'bi bi-eye-fill'; }
  },

  toggleProvider() {
    const $ = (sel) => document.querySelector(sel);
    const provider = $('#providerSelect').value;
    const isOpenRouter = provider === 'openrouter';
    const isCustom = provider === 'custom';
    const isNamed = !isOpenRouter && !isCustom;

    $('#openrouterSettings').classList.toggle('d-none', !isOpenRouter);
    $('#customSettings').classList.toggle('d-none', !isCustom);
    $('#namedProviderSettings').classList.toggle('d-none', !isNamed);
    $('#modelIdSection').classList.toggle('d-none', isOpenRouter);
    $('#openrouterExtras').classList.toggle('d-none', !isOpenRouter);
    $('#securityWarning').classList.toggle('d-none', !isOpenRouter);

    if (isNamed) {
      const info = AIService.getProviderInfo(provider);
      $('#namedApiUrlInput').value = info.baseUrl;
      const linkMap = {
        nanogpt: 'https://nano-gpt.com',
        xai: 'https://console.x.ai',
        zai: 'https://z.ai',
        chutes: 'https://chutes.ai',
        deepseek: 'https://platform.deepseek.com',
      };
      $('#namedProviderLink').innerHTML = '<a href="' + (linkMap[provider] || '#') + '" target="_blank" class="text-accent">Get API key from ' + info.name + ' <i class="bi bi-box-arrow-up-right ms-1"></i></a>';
    }

    if (isCustom) {
      $('#customModelInput').placeholder = 'e.g. llama-3.2-8b-instruct';
      $('#modelIdHint').textContent = I18n.t('settings.modelIdHint');
    } else if (isNamed) {
      $('#customModelInput').placeholder = 'e.g. ' + provider + '-latest';
      $('#modelIdHint').textContent = I18n.t('settings.modelIdHintNamed');
    }
  },

  openSettings() {
    const $ = (sel) => document.querySelector(sel);
    const provider = CardStorage.getProvider() || 'openrouter';
    $('#providerSelect').value = provider;
    $('#apiKeyInput').value = CardStorage.getApiKey();
    $('#namedApiKeyInput').value = CardStorage.getCustomApiKey();
    $('#customApiKeyInput').value = CardStorage.getCustomApiKey();
    $('#customApiUrlInput').value = CardStorage.getCustomApiUrl();
    $('#customModelInput').value = CardStorage.getCustomModelId();
    $('#maxTokensInput').value = CardStorage.getMaxTokens() || '';
    $('#injectCopyrightToggle').checked = CardStorage.getInjectCopyright();
    this.toggleProvider();
  },

  async refreshCredits() {
    const $ = (sel) => document.querySelector(sel);
    if (!AIService.hasApiKey() || CardStorage.getProvider() === 'custom') { this.updateStorageUsage(); return; }
    try {
      const info = await AIService.fetchKeyInfo();
      $('#creditsBadge').classList.remove('d-none');
      $('#creditsAmount').textContent = info.limit_remaining !== null ? '$' + Number(info.limit_remaining).toFixed(2) : 'N/A';
      $('#creditLimit').textContent = info.limit > 0 ? '$' + Number(info.limit).toFixed(2) : 'Unlimited';
      $('#creditRemaining').textContent = info.limit_remaining !== null ? '$' + Number(info.limit_remaining).toFixed(2) : 'N/A';
      $('#creditUsage').textContent = info.usage > 0 ? '$' + Number(info.usage).toFixed(2) : '$0.00';
    } catch (err) {
      console.error('Failed to fetch credits:', err);
      $('#creditsBadge').classList.add('d-none');
    }
    this.updateStorageUsage();
  },

  async refreshModelsList() {
    if (!AIService.hasApiKey()) return;
    const container = document.querySelector('#modelList');
    if (container) container.innerHTML = '<div class="p-3"><div class="skeleton skeleton-line" style="width:80%"></div><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>';
    try {
      window.AppState.models = await AIService.fetchModels();
      this.populateModelSelects();
      this.renderModelList();
    } catch (err) {
      console.error('Failed to fetch models:', err);
      Ui.showToast(I18n.t('toast.modelsFailed', { error: err.message }), 'danger');
    }
  },

  populateModelSelects() {
    const $ = (sel) => document.querySelector(sel);
    const d = CardStorage.getDefaultModel();
    const h = window.AppState.models.map(m => '<option value="' + Ui.escapeHtml(m.id) + '"' + (m.id === d ? ' selected' : '') + '>' + Ui.escapeHtml(m.name) + (m.is_free ? ' [' + I18n.t('gen.free') + ']' : '') + '</option>').join('');
    $('#defaultModelSelect').innerHTML = '<option value="">Auto</option>' + h;
    $('#aiModelSelect').innerHTML = '<option value="">Select model...</option>' + h;
  },

  _modelPageSize: 50,
  _modelPage: 1,

  renderModelList(filter, resetPage) {
    const $ = (sel) => document.querySelector(sel);
    filter = (filter || '').toLowerCase();
    if (resetPage) this._modelPage = 1;
    const container = $('#modelList');
    const filtered = window.AppState.models.filter(m => !filter || m.name.toLowerCase().includes(filter) || m.id.toLowerCase().includes(filter) || m.provider.toLowerCase().includes(filter) || (m.description || '').toLowerCase().includes(filter));
    if (!filtered.length) { container.innerHTML = '<div class="text-center text-muted py-4">' + I18n.t('settings.noModels') + '</div>'; return; }
    const d = CardStorage.getDefaultModel();
    const end = this._modelPage * this._modelPageSize;
    const shown = filtered.slice(0, end);
    const hasMore = end < filtered.length;
    container.innerHTML = shown.map(m =>
      '<div class="model-item' + (m.id === d ? ' selected' : '') + '" data-model-id="' + Ui.escapeHtml(m.id) + '">'
      + '<div class="model-item-info"><div class="model-item-name">' + Ui.escapeHtml(m.name) + '</div>'
      + '<div class="model-item-provider">' + Ui.escapeHtml(m.provider) + ' · ' + (m.context_length ? Math.floor(m.context_length/1000) + 'k ctx' : '?')
      + (m.max_output_tokens ? ' · ' + Math.floor(m.max_output_tokens/1000) + 'k out' : '')
      + (m.is_free ? ' · <span class="text-success">' + I18n.t('gen.free') + '</span>' : '') + '</div></div>'
      + '<div class="model-item-pricing">' + (m.is_free ? '<span class="price-highlight">' + I18n.t('gen.free') + '</span>'
        : '<div>in: ' + AIService.formatPrice(m.pricing ? m.pricing.prompt : null) + '</div><div>out: ' + AIService.formatPrice(m.pricing ? m.pricing.completion : null) + '</div>') + '</div></div>'
    ).join('')
    + (hasMore ? '<div class="text-center py-2"><button class="btn btn-outline-accent btn-sm" id="btnLoadMoreModels">' + I18n.t('settings.loadMore', { count: (filtered.length - end) }) + '</button></div>' : '')
    + '<div class="text-center text-muted" style="font-size:0.7rem;">' + I18n.t('settings.showingModels', { shown: Math.min(end, filtered.length), total: filtered.length }) + '</div>';

    Anims.staggerFadeIn(container.querySelectorAll('.model-item'), { stagger: 15, duration: 150 });

    const self = this;
    container.querySelectorAll('.model-item').forEach(item => {
      item.addEventListener('click', () => {
        $('#defaultModelSelect').value = item.dataset.modelId;
        $('#aiModelSelect').value = item.dataset.modelId;
        CardStorage.setDefaultModel(item.dataset.modelId);
        self.renderModelList(filter);
        Ui.showToast(I18n.t('toast.modelSet', { model: item.dataset.modelId }), 'info');
      });
    });
    const loadMore = container.querySelector('#btnLoadMoreModels');
    if (loadMore) loadMore.addEventListener('click', () => { self._modelPage++; self.renderModelList(filter); });
  },

  filterModels() {
    const $ = (sel) => document.querySelector(sel);
    this.renderModelList($('#modelSearch').value, true);
  },



  async updateStorageUsage() {
    const $ = (sel) => document.querySelector(sel);
    let bytes = CardStorage.getUsageEstimate();
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (est.usage) bytes = est.usage;
      } catch (_) { /* keep localStorage sum */ }
    }
    const kb = (bytes / 1024).toFixed(1);
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    const gb = (bytes / (1024 * 1024 * 1024)).toFixed(2);
    $('#storageUsage').textContent = parseFloat(gb) >= 1 ? gb + ' GB' : (parseFloat(kb) > 1000 ? mb + ' MB' : kb + ' KB');
  },

  confirmClearStorage() {
    const $ = (sel) => document.querySelector(sel);
    if (!confirm(I18n.t('settings.clearConfirm'))) return;
    CardStorage.clearAll();
    window.AppState.cards = [];
    window.AppState.activeCard = null;
    window.AppState.chatHistory = [];
    window.AppState.models = [];
    AIService.setProvider('openrouter');
    $('#apiKeyInput').value = '';
    $('#providerSelect').value = 'openrouter';
    $('#customApiUrlInput').value = '';
    $('#namedApiKeyInput').value = '';
    $('#customApiKeyInput').value = '';
    $('#customModelInput').value = '';
    this.toggleProvider();
    $('#defaultModelSelect').innerHTML = '<option value="">Browse models below...</option>';
    $('#aiModelSelect').innerHTML = '<option value="">Select model...</option>';
    Editor.hideEditor();
    CardManager.renderCardList();
    this.renderModelList();
    $('#creditsBadge').classList.add('d-none');
    $('#aiChatMessages').innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>AI Card Assistant</h6><p>Ask the AI to edit, translate, or enhance your character card.</p></div>';
    Ui.showToast(I18n.t('toast.dataCleared'), 'warning');
  },

  exportSettings() {
    const settings = {
      provider: CardStorage.getProvider(),
      defaultModel: CardStorage.getDefaultModel(),
      maxTokens: CardStorage.getMaxTokens(),
      injectCopyright: CardStorage.getInjectCopyright(),
      customApiUrl: CardStorage.getCustomApiUrl(),
      customApiKey: CardStorage.getCustomApiKey(),
      customModelId: CardStorage.getCustomModelId(),
    };
    Ui.downloadFile('st-card-editor-settings.json', JSON.stringify(settings, null, 2), 'application/json');
    Ui.showToast(I18n.t('toast.settingsExported'), 'success');
  },

  importSettings() {
    const input = document.querySelector('#settingsFileInput');
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const settings = JSON.parse(reader.result);
          if (settings.provider) { CardStorage.setProvider(settings.provider); $('#providerSelect').value = settings.provider; this.toggleProvider(); }
          if (settings.defaultModel) { CardStorage.setDefaultModel(settings.defaultModel); $('#defaultModelSelect').value = settings.defaultModel; $('#aiModelSelect').value = settings.defaultModel; }
          if (settings.maxTokens !== undefined) { CardStorage.setMaxTokens(settings.maxTokens); $('#maxTokensInput').value = settings.maxTokens || ''; }
          if (settings.injectCopyright !== undefined) { CardStorage.setInjectCopyright(settings.injectCopyright); $('#injectCopyrightToggle').checked = settings.injectCopyright; }
          if (settings.customApiUrl) { CardStorage.setCustomApiUrl(settings.customApiUrl); $('#customApiUrlInput').value = settings.customApiUrl; }
          if (settings.customApiKey) { CardStorage.setCustomApiKey(settings.customApiKey); $('#namedApiKeyInput').value = settings.customApiKey; $('#customApiKeyInput').value = settings.customApiKey; }
          if (settings.customModelId) { CardStorage.setCustomModelId(settings.customModelId); $('#customModelInput').value = settings.customModelId; }
          Ui.showToast(I18n.t('toast.settingsImported'), 'success');
        } catch (err) {
          Ui.showToast(I18n.t('toast.invalidFile'), 'danger');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    };
    input.click();
  },
};

window.Settings = Settings;
