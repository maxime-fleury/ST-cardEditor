/* ============================================================
   settings.js — Settings Modal, Model List, Credits
   ============================================================ */

const Settings = {
  // Canonical order of editable AI prompts. Drives auto-building the Settings
  // → Prompts tab fields, the save/open loops, and reset. Each maps to storage
  // key `prompt<Name>` in CardStorage._keys.
  PROMPTS: [
    'assistant', 'fullCard', 'wizard',
    'fullCardInstr', 'fieldsEdit', 'greetingsSystem',
    'enhance', 'personality', 'firstmes', 'scenario',
    'shorten', 'tone', 'grammar', 'greetings',
    'systemprompt', 'translate', 'tags', 'tagsSystem',
  ],

  // Built-in prompt defaults. `{tone}` / `{lang}` / `{card}` are placeholders
  // substituted at send time (tone/language are asked at runtime, card JSON is
  // attached then). Field-editing prompts get the live card field appended as
  // a "Current:" block by aiChat.handleQuickAction.
  DEFAULT_PROMPTS: {
    assistant: 'You are an AI assistant helping edit SillyTavern character cards.\nSillyTavern is an AI roleplay frontend. Cards define character personalities.',
    fullCard: 'You are an AI assistant helping edit SillyTavern character cards.\nSillyTavern is an AI roleplay frontend. Cards define character personalities.',
    wizard: 'Create a complete SillyTavern character card as valid JSON (chara_card_v2 spec).',
    enhance: 'Enhance the character description to be more detailed and vivid. Add sensory details and specific traits.',
    personality: 'Expand the personality to be more nuanced. Add quirks, habits, fears, and motivations.',
    firstmes: 'Improve the first message to be more engaging and in-character.',
    scenario: 'Expand the scenario to be more detailed, immersive, and vivid. Add sensory atmosphere and narrative depth.',
    shorten: 'Shorten and tighten the description while preserving the core meaning and character voice. Remove redundancies.',
    tone: 'Rewrite the following description with a "{tone}" tone while preserving the character\'s core personality and key information.',
    grammar: 'Fix all grammar, spelling, and punctuation errors in the description. Improve clarity without changing the meaning or voice.',
    greetings: 'Generate alternate greetings for this character.',
    systemprompt: 'Enhance this system prompt to be more effective and comprehensive. Improve the instructions for the AI roleplay assistant.',
    translate: 'Translate this character card to {lang}. Output the COMPLETE card as valid JSON with all fields translated. Keep the exact same JSON structure. Translate ALL text fields.\n\nHere is the card JSON:\n{card}',
    tags: 'Analyze this character card and suggest relevant, short tags for organizing it in a card library. Consider the name, description, personality, scenario, and first message. Respond with ONLY a JSON array of 8-15 short lowercase tag strings, like: ["fantasy", "warrior", "elf"].',
    tagsSystem: 'Respond with ONLY a JSON array of short tag strings. No explanations, no markdown, no code fences.\nExample: ["fantasy", "warrior", "elf"]',
    // Non-quick-action chat/system instructions used by buildSystemPrompt and
    // _sendFullCard. Placeholders are substituted at send time.
    fullCardInstr: 'The user wants you to edit or generate the FULL card as JSON.\nRespond with ONLY the updated JSON card. Keep the exact JSON structure.',
    fieldsEdit: 'The user wants you to edit the "{field}" field of this card.\n\nBelow is the current content of that field:\n[{field}]\n{current}\n\nRespond with ONLY the new content for this field. Do not include explanations, JSON wrapping, or markdown fences unless the original content uses them.',
    greetingsSystem: 'The user wants you to generate ALTERNATE GREETINGS for this character.\nCurrent greetings: {current}\nGenerate exactly {count} new alternate greeting(s).\nRespond with ONLY a valid JSON array of greeting strings. No explanations, no markdown.\nExample response format: ["Greeting one...", "Greeting two...", "Greeting three..."]\nEach greeting should be an in-character opening message that could start a conversation with {{user}}.',
  },

  async saveSettings(modal) {
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
      // Always persist (also when blanked) so the key can be cleared from the UI.
      await CardStorage.setApiKey(apiKey);
      AIService.setProvider('openrouter', apiKey);
      CardStorage.setDefaultModel(defaultModel);
      $('#aiModelSelect').value = defaultModel;
    } else {
      const isCustom = provider === 'custom';
      const info = AIService.getProviderInfo(provider);
      // Only the Custom provider owns the custom base URL + key slot. Named
      // providers must NOT overwrite them (that would destroy a user-configured
      // LM Studio/Ollama endpoint just by saving while DeepSeek was selected).
      if (isCustom) {
        CardStorage.setCustomApiUrl(customApiUrl);
        await CardStorage.setCustomApiKey(customApiKey);
      } else {
        // Per-provider key slot: each named provider keeps its own key so
        // switching between them never cross-sends a previous provider's key.
        await CardStorage.setProviderKey(provider, customApiKey);
      }
      CardStorage.setCustomModelId(customModelId);
      AIService.setProvider(provider, customApiKey);
      // Always persist the model id, even when blank: otherwise a cleared
      // "Model ID" leaves the previous provider's default in place and the
      // request goes out with a stale model (#85).
      CardStorage.setDefaultModel(customModelId);
      $('#aiModelSelect').value = customModelId;
    }

    CardStorage.setMaxTokens(maxTokens);
    CardStorage.setInjectCopyright($('#injectCopyrightToggle').checked);
    // Appearance prefs (read the live controls so saving persists what the
    // user actually picked, then apply so the theme updates immediately).
    const densitySel = $('#glassDensitySelect');
    if (densitySel) CardStorage.setGlassDensity(densitySel.value);
    const radiusSel = $('#cardRadiusSelect');
    if (radiusSel) CardStorage.setCardRadius(radiusSel.value);
    const vignetteToggle = $('#vignetteToggle');
    if (vignetteToggle) CardStorage.setVignette(vignetteToggle.checked);
    this.applyAppearance();
    this.PROMPTS.forEach(name => {
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
    AIService.setProvider(provider, isOpenRouter ? CardStorage.getApiKey() : (isCustom ? CardStorage.getCustomApiKey() : CardStorage.getProviderKey(provider)));

    $('#openrouterSettings').classList.toggle('d-none', !isOpenRouter);
    $('#customSettings').classList.toggle('d-none', !isCustom);
    $('#namedProviderSettings').classList.toggle('d-none', !isNamed);
    $('#modelIdSection').classList.toggle('d-none', isOpenRouter);
    // Max Tokens, Copyright toggle and the model browser apply to every
    // provider (AIService.fetchModels() dispatches per-provider already);
    // only the OpenRouter credit/usage card is OpenRouter-specific.
    $('#openrouterExtras').classList.remove('d-none');
    $('#creditsSection').classList.toggle('d-none', !isOpenRouter);
    // All providers store keys in localStorage (encrypted), so the storage
    // warning applies to every keyed provider — not just OpenRouter.
    $('#securityWarning').classList.remove('d-none');

    if (isNamed) {
      const info = AIService.getProviderInfo(provider);
      $('#namedApiUrlInput').value = info.baseUrl;
      $('#namedApiKeyInput').value = CardStorage.getProviderKey(provider);
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
    return this.DEFAULT_PROMPTS[name] || '';
  },

  resetPrompts() {
    // Clear stored overrides so the built-in defaults apply again; the fields
    // below then display the default prompts for viewing/editing.
    this.PROMPTS.forEach(name => CardStorage.setPrompt(name, ''));
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

  // Curated one-click accent themes. Each applies its color as the custom
  // accent without wiping a user's stored color for the other theme.
  APPEARANCE_PRESETS: [
    { id: 'slate',   name: 'Slate',        color: '#64748b' },
    { id: 'purple',  name: 'Cosmic Purple',color: '#8b5cf6' },
    { id: 'magenta', name: 'Magenta',      color: '#ec4899' },
    { id: 'emerald', name: 'Emerald',      color: '#10b981' },
    { id: 'solar',   name: 'Solar',        color: '#f59e0b' },
    { id: 'ocean',   name: 'Ocean',        color: '#3b82f6' },
  ],

  // Translate stored appearance prefs into concrete CSS custom properties so
  // the theme reacts live to glass density, corner radius, and the vignette.
  applyAppearance() {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme') || 'dark';
    const GLASS = {
      subtle:  { dark: 'rgba(17,15,30,0.92)', light: 'rgba(255,255,255,0.94)', blur: 'blur(8px)' },
      default: { dark: 'rgba(17,15,30,0.72)', light: 'rgba(255,255,255,0.78)', blur: 'blur(12px)' },
      bold:    { dark: 'rgba(17,15,30,0.58)', light: 'rgba(255,255,255,0.60)', blur: 'blur(22px)' },
    };
    const g = GLASS[CardStorage.getGlassDensity()] || GLASS.default;
    root.style.setProperty('--glass-bg', g[theme]);
    root.style.setProperty('--glass-blur', g.blur);

    const RADII = {
      compact: { sm: '6px',  md: '10px', lg: '14px' },
      rounded: { sm: '10px', md: '14px', lg: '18px' },
      pill:    { sm: '14px', md: '18px', lg: '24px' },
    };
    const r = RADII[CardStorage.getCardRadius()] || RADII.compact;
    root.style.setProperty('--radius-sm', r.sm);
    root.style.setProperty('--radius-md', r.md);
    root.style.setProperty('--radius-lg', r.lg);

    root.style.setProperty('--vignette-opacity', CardStorage.getVignette() ? '1' : '0');
  },

  // Mirror the stored appearance prefs into the settings form controls. This
  // is separate from applyAppearance() so opening settings never overwrites
  // the live CSS with stale dialog state.
  syncAppearanceControls() {
    const $ = (sel) => document.querySelector(sel);
    const density = $('#glassDensitySelect');
    if (density) density.value = CardStorage.getGlassDensity();
    const radius = $('#cardRadiusSelect');
    if (radius) radius.value = CardStorage.getCardRadius();
    const vignette = $('#vignetteToggle');
    if (vignette) vignette.checked = CardStorage.getVignette();
  },

  async openSettings() {
    const $ = (sel) => document.querySelector(sel);
    await CardStorage._unlockKeys();
    const provider = CardStorage.getProvider() || 'openrouter';
    $('#providerSelect').value = provider;
    $('#apiKeyInput').value = CardStorage.getApiKey();
    $('#namedApiKeyInput').value = provider === 'custom' ? '' : CardStorage.getProviderKey(provider);
    $('#customApiKeyInput').value = CardStorage.getCustomApiKey();
    $('#customApiUrlInput').value = CardStorage.getCustomApiUrl();
    $('#customModelInput').value = CardStorage.getCustomModelId();
    $('#maxTokensInput').value = CardStorage.getMaxTokens() || '';
    $('#injectCopyrightToggle').checked = CardStorage.getInjectCopyright();
    this.toggleProvider();
    this.syncAccentControls();
    this.syncAppearanceControls();
    this.PROMPTS.forEach(name => {
      const input = $('#prompt' + name[0].toUpperCase() + name.slice(1) + 'Input');
      if (input) input.value = CardStorage.getPrompt(name) || this.getDefaultPrompt(name);
    });
  },

  async refreshCredits() {
    const $ = (sel) => document.querySelector(sel);
    // /key is an OpenRouter-only endpoint; named providers 404 on it.
    if (CardStorage.getProvider() !== 'openrouter') { this.updateStorageUsage(); return; }
    if (!AIService.hasApiKey()) { this.updateStorageUsage(); return; }
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
    // Prefer the dropdown selection when the settings modal is open (Refresh
    // Models button); otherwise (page load, workspace import) fall back to the
    // saved provider so a stale unopened dropdown never hijacks the fetch.
    const modalEl = $('#settingsModal');
    const modalOpen = modalEl && modalEl.classList.contains('show');
    const provider = modalOpen ? $('#providerSelect').value : CardStorage.getProvider();
    const isCustom = provider === 'custom';
    // When the modal is open, use the provider and key as currently typed in
    // the form (possibly unsaved), so first-time setup works: paste key ->
    // Refresh Models. Otherwise pass an empty key so the stored credentials
    // are used.
    let formKey = '';
    if (modalOpen) {
      const keyField = provider === 'openrouter' ? $('#apiKeyInput') : (isCustom ? $('#customApiKeyInput') : $('#namedApiKeyInput'));
      formKey = keyField ? keyField.value.trim() : '';
    }
    AIService.setProvider(provider, formKey);
    if (isCustom && modalOpen) {
      // Mirror the typed base URL into AIService so a first-time setup
      // (paste URL -> Refresh Models, before saving) resolves the endpoint
      // instead of failing with "Custom API base URL is not set".
      const urlInput = $('#customApiUrlInput');
      AIService._customApiUrl = urlInput ? urlInput.value.trim() : '';
    }
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
      // Keep the selects usable: surface the saved default model even when
      // the fetch failed.
      this.populateModelSelects();
      Ui.showToast(I18n.t('toast.modelsFailed', { error: err.message }), 'danger');
    }
  },

  populateModelSelects() {
    const $ = (sel) => document.querySelector(sel);
    const d = CardStorage.getDefaultModel();
    // Alphabetical for the plain <select>s (the settings browser keeps its
    // own price/context ordering); hundreds of OpenRouter models are much
    // easier to scan sorted by name.
    const sorted = [...window.AppState.models].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: 'base' }));
    let h = sorted.map(m => '<option value="' + Ui.escapeAttr(m.id) + '"' + (m.id === d ? ' selected' : '') + '>' + Ui.escapeHtml(m.name) + (m.is_free ? ' [' + I18n.t('gen.free') + ']' : '') + '</option>').join('');
    // Always surface the saved default model, even when the fetch failed or
    // the list hasn't loaded yet, so the navbar dropdown stays usable.
    if (d && !window.AppState.models.some(m => m.id === d)) {
      h += '<option value="' + Ui.escapeAttr(d) + '" selected>' + Ui.escapeHtml(d) + '</option>';
    }
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
    const filtered = window.AppState.models.filter(m => {
      // A compatible third-party endpoint may omit name/id/provider; normalize
      // before .toLowerCase() so one blank field can't blank the whole browser (#86).
      const name = (m.name || m.id || ''); const id = (m.id || ''); const prov = (m.provider || ''); const desc = (m.description || '');
      return !filter || name.toLowerCase().includes(filter) || id.toLowerCase().includes(filter) || prov.toLowerCase().includes(filter) || desc.toLowerCase().includes(filter);
    });
    if (!filtered.length) { container.innerHTML = '<div class="text-center text-muted py-4">' + I18n.t('settings.noModels') + '</div>'; return; }
    const d = CardStorage.getDefaultModel();
    const end = this._modelPage * this._modelPageSize;
    const shown = filtered.slice(0, end);
    const hasMore = end < filtered.length;
    container.innerHTML = shown.map(m =>
      '<div class="model-item' + (m.id === d ? ' selected' : '') + '" data-model-id="' + Ui.escapeAttr(m.id || '') + '">'
      + '<div class="model-item-info"><div class="model-item-name">' + Ui.escapeHtml(m.name || m.id || '?') + '</div>'
      + '<div class="model-item-provider">' + Ui.escapeHtml(m.provider || '') + ' · ' + (m.context_length ? Math.floor(m.context_length/1000) + 'k ctx' : '?')
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
    // Count only this app's own data. navigator.storage.estimate() reports the
    // ENTIRE origin including SW caches and other apps' storage, which would
    // mislabel unrelated usage as "card data" (#39).
    const bytes = await CardStorage.getUsageEstimate();
    const kb = (bytes / 1024).toFixed(1);
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    const gb = (bytes / (1024 * 1024 * 1024)).toFixed(2);
    $('#storageUsage').textContent = parseFloat(gb) >= 1 ? gb + ' GB' : (parseFloat(kb) > 1000 ? mb + ' MB' : kb + ' KB');
  },

  async confirmClearStorage() {
    const $ = (sel) => document.querySelector(sel);
    if (!await Ui.confirm({
      title: I18n.t ? I18n.t('settings.clearTitle') : 'Clear all data?',
      message: I18n.t ? I18n.t('settings.clearConfirm') : 'Delete ALL cards, settings, and chat history? This cannot be undone.',
      buttonLabel: I18n.t ? I18n.t('settings.clearAll') : 'Clear All Data',
    })) return;
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
      reader.onload = async () => {
        try {
          const settings = JSON.parse(reader.result);
          if (settings.provider) { CardStorage.setProvider(settings.provider); $('#providerSelect').value = settings.provider; this.toggleProvider(); }
          if (settings.defaultModel) { CardStorage.setDefaultModel(settings.defaultModel); $('#defaultModelSelect').value = settings.defaultModel; $('#aiModelSelect').value = settings.defaultModel; }
          if (settings.maxTokens !== undefined) { CardStorage.setMaxTokens(settings.maxTokens); $('#maxTokensInput').value = settings.maxTokens || ''; }
          if (settings.injectCopyright !== undefined) { CardStorage.setInjectCopyright(settings.injectCopyright); $('#injectCopyrightToggle').checked = settings.injectCopyright; }
          if (settings.customApiUrl) { CardStorage.setCustomApiUrl(settings.customApiUrl); $('#customApiUrlInput').value = settings.customApiUrl; }
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

  exportPrompts() {
    // Export the EFFECTIVE prompts (stored override || built-in default), so a
    // shared file is complete and unambiguous. Importing stores each value as
    // an override only when it differs from the built-in default.
    const prompts = {};
    this.PROMPTS.forEach(name => {
      prompts[name] = CardStorage.getPrompt(name) || this.getDefaultPrompt(name);
    });
    Ui.downloadFile('st-card-editor-prompts.json', JSON.stringify({ version: 1, prompts }, null, 2), 'application/json');
    Ui.showToast(I18n.t ? I18n.t('settings.promptsExported') : 'Prompts exported', 'success');
  },

  importPrompts() {
    const $ = (sel) => document.querySelector(sel);
    const input = document.querySelector('#promptFileInput');
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = JSON.parse(reader.result);
          const map = (data && data.prompts) || {};
          if (typeof map !== 'object' || Array.isArray(map)) throw new Error('bad');
          let count = 0;
          this.PROMPTS.forEach(name => {
            if (!(name in map)) return;
            const value = typeof map[name] === 'string' ? map[name] : '';
            // Store '' when it equals the built-in default so the app keeps
            // using (and tracking) the hidden default, and future default
            // updates are picked up. Only real customizations become overrides.
            CardStorage.setPrompt(name, value === this.getDefaultPrompt(name) ? '' : value);
            count++;
          });
          if (!count) throw new Error('none');
          // Re-populate the visible prompt fields with the imported values.
          this.PROMPTS.forEach(name => {
            const field = $('#prompt' + name[0].toUpperCase() + name.slice(1) + 'Input');
            if (field) field.value = CardStorage.getPrompt(name) || this.getDefaultPrompt(name);
          });
          Ui.showToast(I18n.t ? I18n.t('settings.promptsImported', { count }) : ('Imported ' + count + ' prompts'), 'success');
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
        glassDensity: CardStorage.getGlassDensity(),
        cardRadius: CardStorage.getCardRadius(),
        vignette: CardStorage.getVignette(),
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
          // Dedupe like processFiles: re-importing a workspace mints a fresh _id
          // for every card, so without this the library silently doubles (#38).
          const trimmedName = (normalized.name || '').trim();
          if (trimmedName) {
            const existing = CardStorage.getCards().find(c => (c.name || '').trim().toLowerCase() === trimmedName.toLowerCase());
            if (existing) {
              let existingFull = null;
              try { existingFull = await CardStorage.getCard(existing._id); } catch (_) {}
              if (existingFull && CardManager._cardSignature(normalized) === CardManager._cardSignature(existingFull)) {
                const base = trimmedName;
                let n = 2;
                const used = new Set(CardStorage.getCards().map(c => (c.name || '').toLowerCase()));
                let candidate = base + ' (' + n + ')';
                while (used.has(candidate.toLowerCase())) { n++; candidate = base + ' (' + n + ')'; }
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
        // Restore settings if present
        if (workspace.settings) {
          if (workspace.settings.provider) {
            CardStorage.setProvider(workspace.settings.provider);
            // Keep the runtime in sync so the imported provider actually takes
            // effect instead of waiting for a reload (#80).
            const isCustom = workspace.settings.provider === 'custom';
            const isOR = workspace.settings.provider === 'openrouter';
            const providerKey = isOR ? CardStorage.getApiKey() : (isCustom ? CardStorage.getCustomApiKey() : CardStorage.getProviderKey(workspace.settings.provider));
            AIService.setProvider(workspace.settings.provider, providerKey);
            const sel = document.querySelector('#providerSelect');
            if (sel) sel.value = workspace.settings.provider;
          }
          if (workspace.settings.defaultModel) {
            CardStorage.setDefaultModel(workspace.settings.defaultModel);
          }
          if (workspace.settings.maxTokens !== undefined) CardStorage.setMaxTokens(workspace.settings.maxTokens);
          if (workspace.settings.injectCopyright !== undefined) CardStorage.setInjectCopyright(workspace.settings.injectCopyright);
          // Appearance prefs are optional for backward compatibility.
          if (workspace.settings.glassDensity !== undefined) CardStorage.setGlassDensity(workspace.settings.glassDensity);
          if (workspace.settings.cardRadius !== undefined) CardStorage.setCardRadius(workspace.settings.cardRadius);
          if (workspace.settings.vignette !== undefined) CardStorage.setVignette(workspace.settings.vignette);
        }
        window.AppState.cards = CardStorage.getCards();
        CardManager.renderCardList();
        Settings.applyAppearance();
        Settings.refreshModelsList();
        const modelSel = document.querySelector('#aiModelSelect');
        if (modelSel) modelSel.value = CardStorage.getDefaultModel() || '';
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

export { Settings };
if (typeof window !== 'undefined') window.Settings = Settings;
