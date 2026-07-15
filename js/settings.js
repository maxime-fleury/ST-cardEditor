/* ============================================================
   settings.js — Settings Modal, Model List, Credits
   ============================================================ */

const Settings = {
  saveSettings(modal) {
    const $ = (sel) => document.querySelector(sel);
    const apiKey = $('#apiKeyInput').value.trim();
    const defaultModel = $('#defaultModelSelect').value;
    const maxTokens = parseInt($('#maxTokensInput').value, 10) || 0;
    CardStorage.setApiKey(apiKey);
    AIService.setApiKey(apiKey);
    CardStorage.setDefaultModel(defaultModel);
    CardStorage.setMaxTokens(maxTokens);
    CardStorage.setInjectCopyright($('#injectCopyrightToggle').checked);
    $('#navModelSelect').value = defaultModel;
    $('#aiModelSelect').value = defaultModel;
    modal.hide();
    Ui.showToast('Settings saved!', 'success');
    if (apiKey) { this.refreshCredits(); this.refreshModelsList(); }
  },

  toggleApiKeyVisibility() {
    const $ = (sel) => document.querySelector(sel);
    const input = $('#apiKeyInput');
    const icon = $('#btnToggleApiKey i');
    if (input.type === 'password') { input.type = 'text'; icon.className = 'bi bi-eye-slash-fill'; }
    else { input.type = 'password'; icon.className = 'bi bi-eye-fill'; }
  },

  async refreshCredits() {
    const $ = (sel) => document.querySelector(sel);
    if (!AIService.hasApiKey()) { this.updateStorageUsage(); return; }
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
      Ui.showToast('Failed to load models: ' + err.message, 'danger');
    }
  },

  populateModelSelects() {
    const $ = (sel) => document.querySelector(sel);
    const d = CardStorage.getDefaultModel();
    const h = window.AppState.models.map(m => '<option value="' + Ui.escapeHtml(m.id) + '"' + (m.id === d ? ' selected' : '') + '>' + Ui.escapeHtml(m.name) + (m.is_free ? ' [FREE]' : '') + '</option>').join('');
    $('#navModelSelect').innerHTML = '<option value="">Auto</option>' + h;
    $('#defaultModelSelect').innerHTML = '<option value="">Auto</option>' + h;
    $('#aiModelSelect').innerHTML = '<option value="">Auto (use nav model)</option>' + h;
  },

  _modelPageSize: 50,
  _modelPage: 1,

  renderModelList(filter, resetPage) {
    const $ = (sel) => document.querySelector(sel);
    filter = (filter || '').toLowerCase();
    if (resetPage) this._modelPage = 1;
    const container = $('#modelList');
    const filtered = window.AppState.models.filter(m => !filter || m.name.toLowerCase().includes(filter) || m.id.toLowerCase().includes(filter) || m.provider.toLowerCase().includes(filter) || (m.description || '').toLowerCase().includes(filter));
    if (!filtered.length) { container.innerHTML = '<div class="text-center text-muted py-4">No models found</div>'; return; }
    const d = CardStorage.getDefaultModel();
    const end = this._modelPage * this._modelPageSize;
    const shown = filtered.slice(0, end);
    const hasMore = end < filtered.length;
    container.innerHTML = shown.map(m =>
      '<div class="model-item' + (m.id === d ? ' selected' : '') + '" data-model-id="' + Ui.escapeHtml(m.id) + '">'
      + '<div class="model-item-info"><div class="model-item-name">' + Ui.escapeHtml(m.name) + '</div>'
      + '<div class="model-item-provider">' + Ui.escapeHtml(m.provider) + ' · ' + (m.context_length ? Math.floor(m.context_length/1000) + 'k ctx' : '?')
      + (m.max_output_tokens ? ' · ' + Math.floor(m.max_output_tokens/1000) + 'k out' : '')
      + (m.is_free ? ' · <span class="text-success">FREE</span>' : '') + '</div></div>'
      + '<div class="model-item-pricing">' + (m.is_free ? '<span class="price-highlight">FREE</span>'
        : '<div>in: ' + AIService.formatPrice(m.pricing.prompt) + '</div><div>out: ' + AIService.formatPrice(m.pricing.completion) + '</div>') + '</div></div>'
    ).join('')
    + (hasMore ? '<div class="text-center py-2"><button class="btn btn-outline-accent btn-sm" id="btnLoadMoreModels">Load more (' + (filtered.length - end) + ' remaining)</button></div>' : '')
    + '<div class="text-center text-muted" style="font-size:0.7rem;">Showing ' + Math.min(end, filtered.length) + ' of ' + filtered.length + ' models</div>';
    const self = this;
    container.querySelectorAll('.model-item').forEach(item => {
      item.addEventListener('click', () => {
        $('#defaultModelSelect').value = item.dataset.modelId;
        $('#navModelSelect').value = item.dataset.modelId;
        $('#aiModelSelect').value = item.dataset.modelId;
        CardStorage.setDefaultModel(item.dataset.modelId);
        self.renderModelList(filter);
        Ui.showToast('Model set: ' + item.dataset.modelId, 'info');
      });
    });
    const loadMore = container.querySelector('#btnLoadMoreModels');
    if (loadMore) loadMore.addEventListener('click', () => { self._modelPage++; self.renderModelList(filter); });
  },

  filterModels() {
    const $ = (sel) => document.querySelector(sel);
    this.renderModelList($('#modelSearch').value, true);
  },

  onNavModelChange() {
    const $ = (sel) => document.querySelector(sel);
    const val = $('#navModelSelect').value;
    CardStorage.setDefaultModel(val);
    if (val) $('#aiModelSelect').value = val;
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
    if (!confirm('Delete ALL cards, settings, and chat history? This cannot be undone.')) return;
    CardStorage.clearAll();
    window.AppState.cards = [];
    window.AppState.activeCard = null;
    window.AppState.chatHistory = [];
    window.AppState.models = [];
    AIService.setApiKey('');
    $('#apiKeyInput').value = '';
    $('#navModelSelect').innerHTML = '<option value="">Select model...</option>';
    $('#defaultModelSelect').innerHTML = '<option value="">Browse models below...</option>';
    $('#aiModelSelect').innerHTML = '<option value="">Auto (use nav model)</option>';
    Editor.hideEditor();
    CardManager.renderCardList();
    this.renderModelList();
    $('#creditsBadge').classList.add('d-none');
    $('#aiChatMessages').innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>AI Card Assistant</h6><p>Ask the AI to edit, translate, or enhance your character card.</p></div>';
    Ui.showToast('All data cleared', 'warning');
  },

  exportSettings() {
    const settings = {
      defaultModel: CardStorage.getDefaultModel(),
      maxTokens: CardStorage.getMaxTokens(),
      injectCopyright: CardStorage.getInjectCopyright(),
    };
    Ui.downloadFile('st-card-editor-settings.json', JSON.stringify(settings, null, 2), 'application/json');
    Ui.showToast('Settings exported', 'success');
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
          if (settings.defaultModel) { CardStorage.setDefaultModel(settings.defaultModel); $('#defaultModelSelect').value = settings.defaultModel; $('#navModelSelect').value = settings.defaultModel; $('#aiModelSelect').value = settings.defaultModel; }
          if (settings.maxTokens !== undefined) { CardStorage.setMaxTokens(settings.maxTokens); $('#maxTokensInput').value = settings.maxTokens || ''; }
          if (settings.injectCopyright !== undefined) { CardStorage.setInjectCopyright(settings.injectCopyright); $('#injectCopyrightToggle').checked = settings.injectCopyright; }
          Ui.showToast('Settings imported!', 'success');
        } catch (err) {
          Ui.showToast('Invalid settings file', 'danger');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    };
    input.click();
  },
};

window.Settings = Settings;
