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
      // Keep the OpenRouter key independent from custom-provider credentials.
      // Switching providers must not erase it, especially when the field is
      // temporarily empty while the settings modal is being reopened.
      if (apiKey) CardStorage.setApiKey(apiKey);
      AIService.setProvider('openrouter', apiKey || CardStorage.getApiKey());
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
    ['assistant', 'fullCard', 'wizard'].forEach(name => {
      const input = document.querySelector('#prompt' + name[0].toUpperCase() + name.slice(1) + 'Input');
      const value = input ? input.value : '';
      // Store empty when unchanged from the default so future default updates are picked up.
      CardStorage.setPrompt(name, value === this.getDefaultPrompt(name) ? '' : value);
    });
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const themeColorInput = document.querySelector('#themeColorHex');
    const themeColor = themeColorInput ? themeColorInput.value.trim() : '';
    if (/^#[0-9a-fA-F]{6}$/.test(themeColor)) this.applyAccent(theme, themeColor);

    // Keep provider credentials separate. Do not clear the inactive provider's
    // key: users commonly switch between OpenRouter and a local endpoint.
    // This also allows returning to OpenRouter without re-entering its key.

    modal.hide();
    Ui.showToast(I18n.t('toast.settingsSaved'), 'success');
    if (provider === 'openrouter' && apiKey) this.refreshCredits();
    if (provider === 'custom' || apiKey || customApiKey) this.refreshModelsList();
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

    // Keep AIService in sync with the dropdown selection so "Refresh Models"
    // (and its API-key check) target the provider currently shown in settings,
    // not the previously saved one.
    AIService.setProvider(provider, isOpenRouter ? CardStorage.getApiKey() : CardStorage.getCustomApiKey());

    $('#openrouterSettings').classList.toggle('d-none', !isOpenRouter);
    $('#customSettings').classList.toggle('d-none', !isCustom);
    $('#namedProviderSettings').classList.toggle('d-none', !isNamed);
    $('#modelIdSection').classList.toggle('d-none', isOpenRouter);
    // Max Tokens, Copyright toggle and the model browser apply to every
    // provider (AIService.fetchModels() dispatches per-provider already);
    // only the OpenRouter credit/usage card is OpenRouter-specific.
    $('#openrouterExtras').classList.remove('d-none');
    $('#creditsSection').classList.toggle('d-none', !isOpenRouter);
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
      $('#namedProviderLink').innerHTML = '<a href="' + (linkMap[provider] || '#') + '" target="_blank" class="text-accent">' + (I18n.t ? I18n.t('settings.getApiKeyFrom') : 'Get API key from ') + Ui.escapeHtml(info.name) + ' <i class="bi bi-box-arrow-up-right ms-1"></i></a>';
    }

    if (isCustom) {
      $('#customModelInput').placeholder = I18n.t ? I18n.t('settings.customModelPlaceholder') : 'e.g. llama-3.2-8b-instruct';
      $('#modelIdHint').textContent = I18n.t('settings.modelIdHint');
    } else if (isNamed) {
      $('#customModelInput').placeholder = I18n.t ? I18n.t('settings.namedModelPlaceholder', { provider: provider }) : ('e.g. ' + provider + '-latest');
      $('#modelIdHint').textContent = I18n.t('settings.modelIdHintNamed');
    }
  },

  applyAccent(theme, color) {
    const normalized = String(color || '').trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(normalized)) return false;
    const shades = this._accentShades(normalized, theme);
    CardStorage.setAccent(theme, normalized);
    Object.entries(shades).forEach(([name, value]) => document.documentElement.style.setProperty(name, value));
    document.documentElement.setAttribute('data-accent-custom', 'true');
    return true;
  },

  _accentShades(hex, theme) {
    const rgb = hex.slice(1).match(/.{2}/g).map(v => parseInt(v, 16));
    const mix = (target, amount) => rgb.map((v, i) => Math.round(v * amount + target[i] * (1 - amount)));
    const css = values => '#' + values.map(v => v.toString(16).padStart(2, '0')).join('');
    const white = [255, 255, 255];
    const black = [0, 0, 0];
    return {
      '--accent-300': css(mix(white, 0.42)),
      '--accent-400': css(mix(white, 0.72)),
      '--accent-500': hex,
      '--accent-600': css(mix(black, 0.82)),
      '--accent-700': css(mix(black, 0.62)),
      '--accent-glow': 'rgba(' + rgb.join(', ') + ', 0.25)',
      '--accent-glow-strong': 'rgba(' + rgb.join(', ') + ', 0.45)',
      '--accent-text': theme === 'light' ? css(mix(black, 0.82)) : css(mix(white, 0.78)),
    };
  },

  getDefaultPrompt(name) {
    if (name === 'assistant' || name === 'fullCard') {
      return 'You are an AI assistant helping edit SillyTavern character cards.\nSillyTavern is an AI roleplay frontend. Cards define character personalities.';
    }
    return 'Create a complete SillyTavern character card as valid JSON (chara_card_v2 spec).';
  },

  resetPrompts() {
    // Clear stored overrides so the built-in defaults apply again; the fields
    // below then display the default prompts for viewing/editing.
    ['assistant', 'fullCard', 'wizard'].forEach(name => CardStorage.setPrompt(name, ''));
    this.openSettings();
  },

  resetAccent(theme) {
    this.applyAccent(theme, '#64748b');
    this.syncAccentControls();
  },

  syncAccentControls() {
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const color = CardStorage.getAccent(theme) || '#64748b';
    const picker = document.querySelector('#themeColorPicker');
    const hex = document.querySelector('#themeColorHex');
    if (picker) picker.value = color;
    if (hex) hex.value = color;
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
    this.syncAccentControls();
    $('#promptAssistantInput').value = CardStorage.getPrompt('assistant') || this.getDefaultPrompt('assistant');
    $('#promptFullCardInput').value = CardStorage.getPrompt('fullCard') || this.getDefaultPrompt('fullCard');
    $('#promptWizardInput').value = CardStorage.getPrompt('wizard') || this.getDefaultPrompt('wizard');
  },

  async refreshCredits() {
    const $ = (sel) => document.querySelector(sel);
    if (!AIService.hasApiKey() || CardStorage.getProvider() === 'custom') { this.updateStorageUsage(); return; }
    try {
      const info = await AIService.fetchKeyInfo();
      $('#creditsBadge').classList.remove('d-none');
      $('#creditsAmount').textContent = info.limit_remaining !== null ? '$' + Number(info.limit_remaining).toFixed(2) : (I18n.t ? I18n.t('gen.notAvailable') : 'N/A');
      $('#creditLimit').textContent = info.limit > 0 ? '$' + Number(info.limit).toFixed(2) : (I18n.t ? I18n.t('gen.unlimited') : 'Unlimited');
      $('#creditRemaining').textContent = info.limit_remaining !== null ? '$' + Number(info.limit_remaining).toFixed(2) : (I18n.t ? I18n.t('gen.notAvailable') : 'N/A');
      $('#creditUsage').textContent = info.usage > 0 ? '$' + Number(info.usage).toFixed(2) : '$0.00';
    } catch (err) {
      console.error('Failed to fetch credits:', err);
      $('#creditsBadge').classList.add('d-none');
    }
    this.updateStorageUsage();
  },

  async refreshModelsList() {
    const $ = (sel) => document.querySelector(sel);
    const provider = $('#providerSelect').value;
    const isCustom = provider === 'custom';
    // Use the provider and key as currently typed in the form (possibly
    // unsaved), so first-time setup works: paste key -> Refresh Models.
    const keyField = provider === 'openrouter' ? $('#apiKeyInput') : (isCustom ? $('#customApiKeyInput') : $('#namedApiKeyInput'));
    AIService.setProvider(provider, keyField ? keyField.value.trim() : '');
    // Custom/OpenAI-compatible local endpoints intentionally have no API key.
    // Only keyed providers should be blocked when credentials are missing.
    if (!AIService.hasApiKey() && !isCustom) {
      Ui.showToast(I18n.t('error.apiKeyNotSet'), 'warning');
      return;
    }
    // Guard against overlapping refreshes so a stale (earlier) response can't
    // overwrite the models that a newer request is about to render.
    const myToken = (this._modelReqToken = (this._modelReqToken || 0) + 1);
    const container = document.querySelector('#modelList');
    if (container) container.innerHTML = '<div class="p-3"><div class="skeleton skeleton-line" style="width:80%"></div><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>';
    try {
      const models = await AIService.fetchModels();
      if (myToken !== this._modelReqToken) return; // a newer refresh superseded us
      window.AppState.models = models;
      this.populateModelSelects();
      this.renderModelList();
    } catch (err) {
      if (myToken !== this._modelReqToken) return;
      console.error('Failed to fetch models:', err);
      Ui.showToast(I18n.t('toast.modelsFailed', { error: err.message }), 'danger');
    }
  },

  populateModelSelects() {
    const $ = (sel) => document.querySelector(sel);
    const d = CardStorage.getDefaultModel();
    const h = window.AppState.models.map(m => '<option value="' + Ui.escapeAttr(m.id) + '"' + (m.id === d ? ' selected' : '') + '>' + Ui.escapeHtml(m.name) + (m.is_free ? ' [' + I18n.t('gen.free') + ']' : '') + '</option>').join('');
    $('#defaultModelSelect').innerHTML = '<option value="">' + (I18n.t ? I18n.t('settings.modelAuto') : 'Auto') + '</option>' + h;
    $('#aiModelSelect').innerHTML = '<option value="">' + (I18n.t ? I18n.t('nav.selectModel') : 'Select model...') + '</option>' + h;
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
      '<div class="model-item' + (m.id === d ? ' selected' : '') + '" data-model-id="' + Ui.escapeAttr(m.id) + '">'
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
    let bytes = await CardStorage.getUsageEstimate();
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (est.usage) bytes = est.usage;
      } catch (_) { /* keep the async sum */ }
    }
    const kb = (bytes / 1024).toFixed(1);
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    const gb = (bytes / (1024 * 1024 * 1024)).toFixed(2);
    $('#storageUsage').textContent = parseFloat(gb) >= 1 ? gb + ' GB' : (parseFloat(kb) > 1000 ? mb + ' MB' : kb + ' KB');
  },

  async confirmClearStorage() {
    const $ = (sel) => document.querySelector(sel);
    if (!confirm(I18n.t('settings.clearConfirm'))) return;
    await CardStorage.clearAll();
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
    $('#defaultModelSelect').innerHTML = '<option value="">' + (I18n.t ? I18n.t('settings.modelAuto') : 'Auto') + '</option>';
    $('#aiModelSelect').innerHTML = '<option value="">' + (I18n.t ? I18n.t('nav.selectModel') : 'Select model...') + '</option>';
    Editor.hideEditor();
    CardManager.renderCardList();
    this.renderModelList();
    $('#creditsBadge').classList.add('d-none');
    $('#aiChatMessages').innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>' + (I18n.t ? I18n.t('ai.welcomeTitle') : 'AI Card Assistant') + '</h6><p>' + (I18n.t ? I18n.t('ai.welcomeText') : 'Ask the AI to edit, translate, or enhance your character card.') + '</p></div>';
    Ui.showToast(I18n.t('toast.dataCleared'), 'warning');
  },

  exportSettings() {
    const settings = {
      provider: CardStorage.getProvider(),
      defaultModel: CardStorage.getDefaultModel(),
      maxTokens: CardStorage.getMaxTokens(),
      injectCopyright: CardStorage.getInjectCopyright(),
      customApiUrl: CardStorage.getCustomApiUrl(),
      // NOTE: customApiKey intentionally NOT exported — it is a credential and
      // would leak if the settings file is shared.
      customModelId: CardStorage.getCustomModelId(),
    };
    Ui.downloadFile('st-card-editor-settings.json', JSON.stringify(settings, null, 2), 'application/json');
    Ui.showToast(I18n.t('toast.settingsExported'), 'success');
  },

  importSettings() {
    const $ = (sel) => document.querySelector(sel);
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

  async exportWorkspace() {
    const $ = (sel) => document.querySelector(sel);
    const cards = CardStorage.getCards();
    const fullCards = [];
    for (const meta of cards) {
      const card = await CardStorage.getCard(meta._id);
      if (!card) continue;
      try {
        const b64 = await CardStorage.getImage(card._id);
        if (b64) card._imageBase64 = b64;
      } catch (_) {}
      // Strip internal metadata that won't survive export
      delete card._id;
      delete card._filename;
      delete card._createdAt;
      delete card._fileSize;
      fullCards.push(card);
    }
    const workspace = {
      version: '2.1',
      exportedAt: new Date().toISOString(),
      cards: fullCards,
      settings: {
        provider: CardStorage.getProvider(),
        defaultModel: CardStorage.getDefaultModel(),
        maxTokens: CardStorage.getMaxTokens(),
        injectCopyright: CardStorage.getInjectCopyright(),
      },
    };
    Ui.downloadFile('st-card-editor-workspace-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(workspace, null, 2), 'application/json');
    Ui.showToast((I18n.t ? I18n.t('settings.workspaceExported', { count: fullCards.length }) : 'Workspace exported (' + fullCards.length + ' cards)'), 'success');
  },

  importWorkspace() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
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
      if (!file) { cleanup(); return; }
      try {
        const text = await file.text();
        const workspace = JSON.parse(text);
        if (!workspace.cards || !Array.isArray(workspace.cards)) {
          throw new Error((I18n.t ? I18n.t('settings.invalidWorkspace') : 'Invalid workspace format'));
        }
        let imported = 0;
        for (const card of workspace.cards) {
          if (!card.name && !card.description) continue;
          const normalized = CardEngine.normalize(card, (card.name || 'character') + '.json');
          if (card._imageBase64) {
            await CardStorage.saveImage(normalized._id, card._imageBase64);
            normalized._hasImage = true;
            normalized._thumbnail = normalized._thumbnail || await CardEngine._createThumbnail(card._imageBase64);
          }
          await CardStorage.upsertCard(normalized);
          imported++;
        }
        // Restore settings if present
        if (workspace.settings) {
          if (workspace.settings.provider) CardStorage.setProvider(workspace.settings.provider);
          if (workspace.settings.defaultModel) CardStorage.setDefaultModel(workspace.settings.defaultModel);
          if (workspace.settings.maxTokens !== undefined) CardStorage.setMaxTokens(workspace.settings.maxTokens);
          if (workspace.settings.injectCopyright !== undefined) CardStorage.setInjectCopyright(workspace.settings.injectCopyright);
        }
        window.AppState.cards = CardStorage.getCards();
        CardManager.renderCardList();
        Settings.refreshModelsList();
        Ui.showToast((I18n.t ? I18n.t('settings.workspaceImported', { count: imported }) : 'Workspace imported (' + imported + ' cards)'), 'success');
      } catch (err) {
        console.error('Workspace import failed:', err);
        Ui.showToast((I18n.t ? I18n.t('settings.workspaceImportFailed', { error: err.message }) : 'Failed to import workspace: ' + err.message), 'danger');
      }
      cleanup();
    };
    document.body.appendChild(input);
    input.click();
  },
};

window.Settings = Settings;
