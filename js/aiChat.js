// @ts-check
/* ============================================================
   aiChat.js — AI Chat UI, Multi-Field Parallel Requests
   ============================================================ */

const AiChat = {
  _abortControllers: [],      // per-field controllers for parallel requests
  _historyRendered: false,
  _selectedFields: new Set(), // fields selected for editing
  _greetingCount: 3,
  _applyStore: new Map(),     // msgId → { content, field } for re-apply
  _applyQueue: [],            // every pending apply-able response { el, field, content, applied }
  _applyElMap: new WeakMap(), // element → apply item (dup-free registration)
  _applyIndex: 0,             // active item index in _applyQueue
  _currentSessionId: null,    // active session ID for per-session storage
  _gen: 0,                    // generation token: bumped on every send/clear so
                              // stale aborted callbacks bail out instead of
                              // clobbering the new run's state
  _contextBarGen: 0,          // generation token for updateContextBar: each new
                              // call supersedes in-flight ones so the bar can
                              // never show a stale estimate after a newer call
  MAX_PARALLEL_FIELDS: 20,    // cap parallel API requests

  FIELD_DEFS: [
    { id: 'name', labelKey: 'ai.target.name', icon: 'bi-person-badge' },
    { id: 'description', labelKey: 'ai.target.description', icon: 'bi-card-text' },
    { id: 'personality', labelKey: 'ai.target.personality', icon: 'bi-brain' },
    { id: 'first_mes', labelKey: 'ai.target.first_mes', icon: 'bi-chat-dots' },
    { id: 'scenario', labelKey: 'ai.target.scenario', icon: 'bi-geo-alt' },
    { id: 'mes_example', labelKey: 'ai.target.mes_example', icon: 'bi-chat-square-text' },
    { id: 'alternate_greetings', labelKey: 'ai.target.alternate_greetings', icon: 'bi-list-ol', hasCount: true },
    { id: 'system_prompt', labelKey: 'ai.target.system_prompt', icon: 'bi-terminal' },
    { id: 'post_history_instructions', labelKey: 'ai.target.post_history_instructions', icon: 'bi-arrow-repeat' },
    { id: 'creator_notes', labelKey: 'ai.target.creator_notes', icon: 'bi-pencil' },
  ],

  _renderFieldChips() {
    const $ = Ui.$;
    const container = $('#aiFieldChips');
    if (!container) return;

    const chipHtml = this.FIELD_DEFS.map(f => {
      const isActive = this._selectedFields.has(f.id);
      const label = I18n.t ? I18n.t(f.labelKey) : f.id;
      return '<span class="ai-field-chip' + (isActive ? ' active' : '') + '" data-field="' + f.id + '">'
        + '<i class="bi ' + f.icon + '"></i>' + Ui.escapeHtml(label)
        + '</span>';
    }).join('');

    const allActive = this._selectedFields.size >= this.FIELD_DEFS.length;
    const allChip = '<span class="ai-field-chip all-fields' + (allActive ? ' active' : '') + '" data-field="__all__">'
      + '<i class="bi bi-stars"></i>' + (I18n.t ? I18n.t('ai.target.full') : 'All Fields')
      + '</span>';

    container.innerHTML = allChip + chipHtml;

    const self = this;
    container.querySelectorAll('.ai-field-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const field = chip.dataset.field;
        self._toggleFieldChip(field);
        self._renderFieldChips();
        self.updateContextBar();
      });
    });

    // Show/hide greeting count input
    const countWrap = document.querySelector('#aiGreetingCount');
    if (countWrap) {
      countWrap.style.display = this._selectedFields.has('alternate_greetings') ? 'flex' : 'none';
    }

    // Sync greeting count from DOM
    const countInput = document.querySelector('#aiGreetingCountInput');
    if (countInput) {
      this._greetingCount = parseInt(countInput.value) || 3;
    }
  },

  _toggleFieldChip(field) {
    if (field === '__all__') {
      const allSelected = this._selectedFields.size >= this.FIELD_DEFS.length;
      if (allSelected) {
        this._selectedFields.clear();
      } else {
        this.FIELD_DEFS.forEach(f => this._selectedFields.add(f.id));
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
    // Return the empty set as-is: the callers (send) check selectedFields.length
    // === 0 to warn, so this guard must be reachable.
    return [...this._selectedFields];
  },

  send(retryPrompt) {
    const $ = Ui.$;
    const input = $('#aiInput');
    const rawPrompt = retryPrompt || input.value.trim();
    // Normalize SillyTavern macros in the instruction: {user}/{User}/{{User}}
    // all become {{user}} (same for {char}), so references to the player or
    // character always reach the model in the form the card actually needs.
    const prompt = this._normalizePlaceholders(rawPrompt);
    const { activeCard } = window.AppState;
    if (!prompt || window.AppState.isAiLoading) return;

    if (!activeCard) { Ui.showToast(I18n.t('toast.selectCard'), 'warning'); return; }

    let selectedFields = this.getSelectedFields();
    if (selectedFields.length === 0) {
      // Natural-language intent: no chips were picked — infer the fields the
      // request is about and select them automatically.
      const inferred = this._inferFields(prompt);
      if (inferred.length > 0) {
        this._selectedFields = new Set(inferred);
        this._renderFieldChips();
        selectedFields = inferred;
        const labels = inferred.map(f => {
          const def = this.FIELD_DEFS.find(d => d.id === f);
          return def ? (I18n.t ? I18n.t(def.labelKey) : def.labelKey) : f;
        });
        Ui.showToast(I18n.t('toast.fieldsDetected', { fields: labels.join(', ') }), 'info');
      } else {
        Ui.showToast(I18n.t('toast.selectField'), 'info');
        return;
      }
    }
    if (selectedFields.length > this.MAX_PARALLEL_FIELDS) {
      Ui.showToast(I18n.t ? I18n.t('toast.tooManyFields', { max: this.MAX_PARALLEL_FIELDS }) : 'Too many fields selected. Max ' + this.MAX_PARALLEL_FIELDS + ' at once.', 'warning');
      return;
    }

    const histPanel = $('#aiHistoryPanel');
    if (histPanel && histPanel.classList.contains('open')) {
      this.toggleHistory(false);
    }
    if (!AIService.hasApiKey()) { Ui.showToast(I18n.t('toast.apiKey'), 'warning'); return; }

    const modelId = $('#aiModelSelect').value;
    if (!modelId) {
      Ui.showToast(I18n.t('toast.selectModel'), 'warning');
      return;
    }

    if (!retryPrompt) {
      input.value = '';
      // Keep the input hot so the next instruction can be typed while the
      // model streams (multi-round editing without a mouse trip).
      input.focus();
      const userIdx = window.AppState.chatHistory.length;
      this.addChatMessage('user', prompt, null, null, userIdx);
    }
    window.AppState.isAiLoading = true;
    this.updateSendButton();

    window.AppState.chatHistory.push({ role: 'user', content: prompt });
    CardStorage.saveChatHistory(window.AppState.chatHistory, window.AppState.activeCard?._id);
    // Create a new session if none exists
    const cardId = window.AppState.activeCard?._id || 'global';
    if (!this._currentSessionId) {
      const now = Date.now();
      const session = {
        id: 'ses_' + now + '_' + Math.random().toString(36).slice(2, 7),
        created: now,
        lastUpdated: now,
        preview: prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt,
        messageCount: 1,
      };
      this._currentSessionId = session.id;
      CardStorage.saveChatSession(cardId, session);
    }
    CardStorage.saveSessionMessages(cardId, this._currentSessionId, window.AppState.chatHistory);

    const groupedCard = this._createGroupedCard(selectedFields);
    this._abortAll();
    const gen = ++this._gen; // generation token — stale callbacks bail below

    // Capture greeting count now to prevent TOCTOU
    const capturedGreetingCount = this._greetingCount;

    const fieldLabel = (f) => I18n.t ? I18n.t(this.FIELD_DEFS.find(d => d.id === f)?.labelKey || '') : f;
    let completedCount = 0;
    let combinedContent = '';

    selectedFields.forEach(field => {
      const controller = new AbortController();
      this._abortControllers.push(controller);

      const section = this._addFieldSection(groupedCard, field, fieldLabel(field));
      const contentEl = section.querySelector('.multi-field-content');

      const history = this._getRecentHistory(10);
      AIService.chatStream(prompt, this.buildSystemPrompt(field, capturedGreetingCount), modelId,
        (fullText) => {
          contentEl.innerHTML = this._formatFieldText(fullText);
          const container = document.querySelector('#aiChatMessages');
          container.scrollTop = container.scrollHeight;
        },
        controller.signal,
        false,
        history
      )
        .then(result => {
          if (gen !== this._gen) return; // stale run aborted by retry/clear
          this._releaseController(controller);
          try {
            this._finalizeFieldSection(section, field, result.content);
          } catch (e) { console.error('aiChat: failed to finalize field section:', e); }
          completedCount++;
          combinedContent += '\n\n[' + field + ']\n' + this._fieldDisplayContent(field, result.content);

          if (completedCount === selectedFields.length) {
            this._finalizeGroupedCard(groupedCard, selectedFields.length);
            window.AppState.chatHistory.push({ role: 'assistant', content: combinedContent });
            CardStorage.saveChatHistory(window.AppState.chatHistory, window.AppState.activeCard?._id);
            this._updateSession();
            window.AppState.isAiLoading = false;
            this.updateSendButton();
            Settings.refreshCredits();
          }
        })
        .catch(err => {
          if (gen !== this._gen) return; // stale run aborted by retry/clear
          this._releaseController(controller);
          try {
            section.classList.add('error');
            section.classList.remove('streaming');
            const label = section.querySelector('.multi-field-label');
            if (label) label.innerHTML = label.innerHTML.replace(I18n.t ? I18n.t('ai.streaming') : 'streaming...', I18n.t ? I18n.t('ai.failed') : 'failed');
            contentEl.textContent = err.name === 'AbortError' ? (I18n.t ? I18n.t('ai.cancelled') : 'Cancelled.') : (I18n.t ? I18n.t('ai.errorPrefix') : 'Error: ') + err.message;
          } catch (_) {}

          completedCount++;
          if (completedCount === selectedFields.length) {
            try { this._finalizeGroupedCard(groupedCard, selectedFields.length); } catch (e) { console.error('aiChat: failed to finalize grouped card:', e); }
            if (combinedContent.trim()) {
              window.AppState.chatHistory.push({ role: 'assistant', content: combinedContent.trim() });
              CardStorage.saveChatHistory(window.AppState.chatHistory, window.AppState.activeCard?._id);
            }
            // _updateSession() must run for partial AND complete failure alike:
            // if any field produced content the history already changed; if none
            // did, the pushed user message still needs the session's
            // preview/count/lastUpdated to catch up, or it goes stale and the
            // next message forks a fresh session.
            this._updateSession();
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
    const fieldLabel = I18n.t
      ? I18n.t(this.FIELD_DEFS.find(d => d.id === targetField)?.labelKey || targetField)
      : targetField;

    const cardForPrompt = activeCard ? { ...activeCard } : CardEngine.createEmptyCard();
    delete cardForPrompt._id; delete cardForPrompt._filename; delete cardForPrompt._hasImage;
    delete cardForPrompt._imageBase64; delete cardForPrompt._thumbnail;
    delete cardForPrompt._createdAt; delete cardForPrompt._fileSize;

    const parts = [
      CardStorage.getPrompt('assistant') || 'You are an AI assistant helping edit SillyTavern character cards.\nSillyTavern is an AI roleplay frontend. Cards define character personalities.',
      '',
      'Here is the FULL character card for context:',
      '```json',
      this._normalizePlaceholders(CardEngine.toJSON(cardForPrompt)),
      '```',
      '',
    ];

    if (targetField === 'alternate_greetings') {
      const existing = (activeCard && activeCard.alternate_greetings) || [];
      const greetInstr = (CardStorage.getPrompt('greetingsSystem') || Settings.getDefaultPrompt('greetingsSystem'))
        .split('{count}').join(String(greetingCount))
        .split('{current}').join(existing.length ? JSON.stringify(existing) : '(none)');
      parts.push(greetInstr);
    } else {
      let current = '(empty)';
      if (activeCard && typeof activeCard[targetField] === 'string' && activeCard[targetField]) {
        current = this._normalizePlaceholders(activeCard[targetField]);
      }
      const fieldInstr = (CardStorage.getPrompt('fieldsEdit') || Settings.getDefaultPrompt('fieldsEdit'))
        .split('{field}').join(fieldLabel)
        .split('{current}').join(current);
      parts.push(fieldInstr);
    }
    return parts.join('\n');
  },

  // ─── GROUPED MULTI-FIELD CARD ───────────────────────

  _createGroupedCard(fields) {
    const $ = Ui.$;
    const container = $('#aiChatMessages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    const el = document.createElement('div');
    el.className = 'ai-message assistant multi-field';
    el.innerHTML = '<div class="multi-field-header">'
      + '<i class="bi bi-robot"></i> ' + (I18n.t ? I18n.t('ai.editing', { count: fields.length }) : 'Editing ' + fields.length + ' field' + (fields.length > 1 ? 's' : '') + '...')
      + '</div>';
    container.appendChild(el);
    Anims.staggerFadeIn(el, { duration: 200, from: 10 });
    container.scrollTop = container.scrollHeight;
    return el;
  },

  _addFieldSection(groupedCard, field, label) {
    const section = document.createElement('div');
    section.className = 'multi-field-section streaming';
    section.setAttribute('data-field', field);
    section.innerHTML = '<div class="multi-field-label">'
      + '<i class="bi bi-hourglass-split"></i> ' + Ui.escapeHtml(label)
      + '<span class="multi-field-status"><span class="spinner-border spinner-border-sm text-accent"></span> ' + (I18n.t ? I18n.t('ai.streaming') : 'streaming...') + '</span>'
      + '</div>'
      + '<div class="multi-field-content"></div>'
      + '<div class="multi-field-actions" style="display:none;"></div>';
    groupedCard.appendChild(section);
    return section;
  },

  _finalizeFieldSection(section, field, content) {
    section.classList.remove('streaming');
    section.classList.add('done');
    const label = section.querySelector('.multi-field-label');
    if (label) {
      const icon = label.querySelector('.bi');
      if (icon) { icon.className = 'bi bi-check-circle-fill'; }
      const status = label.querySelector('.multi-field-status');
      if (status) status.remove();
    }

    // Models sometimes ignore the per-field instruction and answer with the
    // WHOLE card as JSON (very common for "rename the card…" prompts). Show
    // only this field's value in that case — the full JSON blob belongs to
    // the diff/apply step, not the chat bubble.
    const display = this._fieldDisplayContent(field, content);
    const contentEl = section.querySelector('.multi-field-content');
    if (contentEl && display !== content) {
      contentEl.innerHTML = this._formatFieldText(display);
    }

    // Truncate long content — collapse to compact preview with modal expand
    if (contentEl && display.length > 300) {
      contentEl.classList.add('collapsed');
      // Click on collapsed content toggles expand inline
      contentEl.addEventListener('click', () => {
        contentEl.classList.toggle('collapsed');
        // Update the expand button icon/text to reflect state
        const viewBtn = section.querySelector('.multi-field-expand-btn');
        if (viewBtn) {
          const isCollapsed = contentEl.classList.contains('collapsed');
          viewBtn.innerHTML = isCollapsed
            ? '<i class="bi bi-arrows-expand"></i> ' + (I18n.t ? I18n.t('ai.viewFullResult') : 'View full result')
            : '<i class="bi bi-arrows-collapse"></i> ' + (I18n.t ? I18n.t('ai.showLess') : 'Show less');
        }
      });
    }

    const actions = section.querySelector('.multi-field-actions');
    if (actions) {
      actions.style.display = 'flex';
      const self = this;

      // "View full result" button — opens modal
      if (display.length > 300) {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'multi-field-expand-btn';
        viewBtn.type = 'button';
        viewBtn.innerHTML = '<i class="bi bi-arrows-expand"></i> ' + (I18n.t ? I18n.t('ai.viewFullResult') : 'View full result');
        viewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          self._showResultModal(field, display);
        });
        actions.appendChild(viewBtn);
      }

      // "Review & Apply" button — opens diff modal. The RAW content is
      // registered so _prepareApply can re-detect a full-card JSON and pull
      // the right field out of it (including the card name for renames).
      this._registerApply(section, field, content);
      const btn = document.createElement('button');
      btn.className = 'btn btn-outline-accent btn-sm';
      btn.innerHTML = '<i class="bi bi-eye me-1"></i> ' + (I18n.t ? I18n.t('ai.reviewApply') : 'Review & Apply');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        self.tryApplyAIResponse(content, field, section);
      });
      actions.appendChild(btn);
    }
  },

  // ─── SHOW FULL RESULT IN MODAL ──────────────────────

  _showResultModal(field, content) {
    const $ = Ui.$;
    const fieldLabel = I18n.t
      ? I18n.t(this.FIELD_DEFS.find(d => d.id === field)?.labelKey || field)
      : field;

    const modalEl = $('#aiResultModal');
    if (!modalEl) return;

    const titleEl = modalEl.querySelector('.modal-title');
    const bodyEl = modalEl.querySelector('.modal-body');
    if (titleEl) titleEl.innerHTML = '<i class="bi bi-file-text me-2 text-accent"></i>' + Ui.escapeHtml(fieldLabel);
    if (bodyEl) bodyEl.textContent = content;

    // Reuse a single Modal instance: constructing one per open re-runs
    // _addEventListeners() and leaks backdrop/Escape handlers (#14).
    this._resultModal = this._resultModal || new bootstrap.Modal(modalEl);
    const modal = this._resultModal;

    // Wire up copy button
    const copyBtn = modalEl.querySelector('#btnCopyResult');
    if (copyBtn) {
      // Reset button text on every open
      const copyLabel = () => '<i class="bi bi-clipboard me-1"></i>' + (I18n.t ? I18n.t('ai.copy') : 'Copy');
      copyBtn.innerHTML = copyLabel();
      // Clean up previous listener if any
      if (this._copyAbort) this._copyAbort.abort();
      this._copyAbort = new AbortController();
      let copyTimeout = null;
      const cleanupCopy = () => {
        if (copyTimeout) { clearTimeout(copyTimeout); copyTimeout = null; }
      };
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(content).then(() => {
          copyBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>' + (I18n.t ? I18n.t('ai.copied') : 'Copied!');
          copyTimeout = setTimeout(() => {
            copyBtn.innerHTML = copyLabel();
          }, 2000);
        }).catch(() => {
          copyBtn.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>' + (I18n.t ? I18n.t('ai.copyFailed') : 'Failed');
        });
      }, { signal: this._copyAbort.signal });
      modalEl.addEventListener('hidden.bs.modal', cleanupCopy, { once: true });
    }

    modal.show();
  },

  _finalizeGroupedCard(groupedCard, total) {
    const header = groupedCard.querySelector('.multi-field-header');
    if (header) {
      const done = groupedCard.querySelectorAll('.multi-field-section.done').length;
      const errs = groupedCard.querySelectorAll('.multi-field-section.error').length;
      let msg;
      if (I18n.t) {
        msg = I18n.t('ai.doneSummary', { done: done, total: total, errs: errs });
      } else {
        msg = done + '/' + total + ' field' + (total > 1 ? 's' : '') + ' done';
        if (errs > 0) msg += ' · ' + errs + ' failed';
      }
      header.innerHTML = '<i class="bi bi-robot"></i> ' + Ui.escapeHtml(msg);
    }

    // Sticky action bar: every completed section is a ready change — apply all
    // in one click, or open the review modal (Enter/A/←/→ shortcuts inside).
    const readySections = [...groupedCard.querySelectorAll('.multi-field-section.done')]
      .filter(s => this._applyElMap.get(s));
    if (readySections.length > 0) {
      const footer = document.createElement('div');
      footer.className = 'multi-field-footer';
      footer.innerHTML = '<span class="multi-field-footer-count">'
        + (I18n.t ? I18n.t('ai.changesReady', { count: readySections.length }) : readySections.length + ' changes ready')
        + '</span>';
      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'btn btn-outline-accent btn-sm';
      viewBtn.innerHTML = '<i class="bi bi-eye me-1"></i> ' + (I18n.t ? I18n.t('ai.reviewApply') : 'Review & Apply');
      viewBtn.addEventListener('click', () => {
        const idx = this._firstUnappliedIndex();
        if (idx >= 0) this._openApplyAt(idx);
      });
      footer.appendChild(viewBtn);
      const applyAllBtn = document.createElement('button');
      applyAllBtn.type = 'button';
      applyAllBtn.className = 'btn btn-accent btn-sm';
      applyAllBtn.innerHTML = '<i class="bi bi-check2-all me-1"></i> ' + (I18n.t ? I18n.t('diff.applyAll') : 'Apply all');
      applyAllBtn.addEventListener('click', () => this._applyAllPending(null));
      footer.appendChild(applyAllBtn);
      groupedCard.appendChild(footer);
    }
  },

  // Index of the first not-yet-applied change in the queue (-1 when all done).
  _firstUnappliedIndex() {
    for (let i = 0; i < this._applyQueue.length; i++) {
      if (!this._applyQueue[i].applied) return i;
    }
    return -1;
  },

  // Once nothing is pending anywhere, retire every ready-bar so its buttons
  // can't be clicked a second time (they stay visible as a summary).
  _maybeRetireReadyBars() {
    if (typeof document === 'undefined') return;
    if (this._applyQueue.every(it => it.applied)) {
      document.querySelectorAll('.multi-field-footer button').forEach(b => {
        b.disabled = true;
        b.classList.add('disabled');
      });
    }
  },

  _abortAll() {
    this._abortControllers.forEach(c => c.abort());
    this._abortControllers = [];
  },

  // Drop all pending apply-able responses (queue, index, DOM-element map and
  // re-apply store). Called when switching cards so a response generated for
  // one card can never be applied to another via Prev/Next or a stale entry.
  _resetApplyQueue() {
    this._applyQueue = [];
    this._applyIndex = 0;
    this._applyElMap = new WeakMap();
    this._applyStore.clear();
  },

  _releaseController(controller) {
    const idx = this._abortControllers.indexOf(controller);
    if (idx >= 0) this._abortControllers.splice(idx, 1);
  },

  /**
   * Get recent chat history for AI context (last N message pairs).
   * By default excludes the last entry (the current user message just pushed).
   * Pass includeLast=true when nothing has been pushed yet (e.g. the context
   * bar runs before any message is appended, so the last real message must be
   * kept in the estimate).
   */
  _getRecentHistory(maxMessages = 10, includeLast = false) {
    const { chatHistory } = window.AppState;
    if (!chatHistory || chatHistory.length <= 1) return [];
    return chatHistory.slice(0, includeLast ? chatHistory.length : -1).slice(-maxMessages);
  },

  // ─── SINGLE FULL-CARD REQUEST (translate, wizard) ────

  _sendFullCard(prompt, opts) {
    opts = opts || {};
    const $ = Ui.$;
    const { activeCard } = window.AppState;
    if (window.AppState.isAiLoading) return;
    if (!AIService.hasApiKey()) { Ui.showToast(I18n.t('toast.apiKey'), 'warning'); return; }
    if (!activeCard) { Ui.showToast(I18n.t('toast.selectCard'), 'warning'); return; }
    const modelSelect = $('#aiModelSelect');
    const input = $('#aiInput');
    if (!modelSelect || !input) { Ui.showToast(I18n.t('toast.selectModel'), 'warning'); return; }
    const modelId = modelSelect.value;
    if (!modelId) { Ui.showToast(I18n.t('toast.selectModel'), 'warning'); return; }

    input.value = '';
    this._abortAll();
    const gen = ++this._gen; // generation token for stale-callback bailout
    window.AppState.isAiLoading = true;
    this.updateSendButton();

    this.addChatMessage('user', prompt, null, null, window.AppState.chatHistory.length);
    window.AppState.chatHistory.push({ role: 'user', content: prompt });
    CardStorage.saveChatHistory(window.AppState.chatHistory, activeCard?._id);
    // Create a new session if none exists
    const cardId = activeCard?._id || 'global';
    if (!this._currentSessionId) {
      const now = Date.now();
      const session = {
        id: 'ses_' + now + '_' + Math.random().toString(36).slice(2, 7),
        created: now,
        lastUpdated: now,
        preview: prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt,
        messageCount: 1,
      };
      this._currentSessionId = session.id;
      CardStorage.saveChatSession(cardId, session);
    }
    CardStorage.saveSessionMessages(cardId, this._currentSessionId, window.AppState.chatHistory);

    const streamingEl = this.createStreamingMessage();
    let shimmerGone = false;

    // Live “thinking…” presence: elapsed-time + (once tokens arrive) a live
    // token count, so long generations never look hung. Uses the shared
    // estimator (real BPE once the CDN lib loads, heuristic before) so this
    // display agrees with the context bar and the editor counters.
    const startedAt = Date.now();
    let lastOut = '';
    const statusEl = streamingEl.querySelector('.ai-stream-status');
    const liveTimer = setInterval(() => {
      // The stream message can be detached without the promise settling (e.g. a
      // card switch mid-generation, or a clear that wipes the transcript before
      // the fetch resolves). Stop the timer when its element is gone so we never
      // leak an interval updating a detached node forever.
      if (!streamingEl.isConnected) { clearInterval(liveTimer); return; }
      const secs = Math.floor((Date.now() - startedAt) / 1000) + 's';
      let liveCount = 0;
      if (lastOut) {
        try {
          // syncCount degrades to the heuristic internally — no guard needed.
          liveCount = Tokenizer.syncCount(lastOut);
        } catch (_) { liveCount = Math.ceil(lastOut.length / 3); }
      }
      statusEl.textContent = lastOut
        ? (I18n.t ? I18n.t('ai.streamLive', { tokens: liveCount, secs }) : liveCount + ' tokens · ' + secs)
        : (I18n.t ? I18n.t('ai.thinkingLive', { secs }) : 'Thinking… ' + secs);
    }, 500);

    const cardJson = activeCard ? CardEngine.toJSON(activeCard) : '';
    const systemPrompt = [
      CardStorage.getPrompt('fullCard') || 'You are an AI assistant helping edit SillyTavern character cards.\nSillyTavern is an AI roleplay frontend. Cards define character personalities.',
      '',
      'Here is the FULL character card for context:',
      '```json',
      cardJson,
      '```',
      '',
      opts.systemPromptInstruction || (CardStorage.getPrompt('fullCardInstr') || Settings.getDefaultPrompt('fullCardInstr')),
    ].join('\n');

    const controller = new AbortController();
    this._abortControllers.push(controller);

    AIService.chatStream(prompt, systemPrompt, modelId,
      (fullText) => {
        lastOut = fullText; // for the live token counter
        // Replace the shimmer skeleton with live content on the first real
        // token, so users get a clear "model is thinking" cue while waiting.
        if (!shimmerGone && fullText) {
          shimmerGone = true;
          const sk = streamingEl.querySelector('.ai-shimmer');
          if (sk) sk.remove();
        }
        streamingEl.querySelector('.ai-message-content').innerHTML = Ui.escapeHtml(fullText)
          .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '<pre>$1</pre>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/\n/g, '<br>');
        const container = document.querySelector('#aiChatMessages');
        container.scrollTop = container.scrollHeight;
      },
      controller.signal,
      true,
      this._getRecentHistory(10)
    )
      .then(result => {
        clearInterval(liveTimer);
        if (gen !== this._gen) { streamingEl.remove(); return; }
        streamingEl.remove();
        const asstIdx = window.AppState.chatHistory.length;
        const applyTarget = opts.applyTarget || 'full';
        this.addChatMessage('assistant', result.content, result.usage, { content: result.content, field: applyTarget }, asstIdx);
        window.AppState.chatHistory.push({ role: 'assistant', content: result.content });
        CardStorage.saveChatHistory(window.AppState.chatHistory, activeCard?._id);
        this._updateSession();
        this.tryApplyAIResponse(result.content, applyTarget);
        Settings.refreshCredits();
      })
      .catch(err => {
        clearInterval(liveTimer);
        if (gen !== this._gen) { streamingEl.remove(); return; }
        streamingEl.remove();
        if (err && err.name === 'AbortError') {
          this.addChatMessage('system', I18n.t ? I18n.t('toast.genStopped') : 'Generation stopped.');
        } else {
          this.addChatMessage('system', (I18n.t ? I18n.t('ai.errorPrefix') : 'Error: ') + err.message);
          Ui.showToast(I18n.t('toast.aiError', { error: err.message }), 'danger');
        }
      })
      .finally(() => {
        this._releaseController(controller);
        if (gen !== this._gen) return;
        window.AppState.isAiLoading = false; this.updateSendButton();
      });
  },

  // ─── SIDE-BY-SIDE DIFF ──────────────────────────────

  _renderDiff(oldText, newText) {
    const oldEl = document.querySelector('#aiDiffOld');
    const newEl = document.querySelector('#aiDiffNew');
    if (!oldEl || !newEl) return;

    if (typeof Diff === 'undefined') {
      oldEl.textContent = oldText || (I18n.t ? I18n.t('gen.empty') : '(empty)');
      newEl.textContent = newText;
      return;
    }

    const changes = Diff.diffWords(oldText || '', newText || '');

    let oldHtml = '';
    let newHtml = '';

    changes.forEach(part => {
      const escaped = Ui.escapeHtml(part.value);
      if (part.removed) {
        oldHtml += '<span class="diff-del">' + escaped + '</span>';
      } else if (part.added) {
        newHtml += '<span class="diff-add">' + escaped + '</span>';
      } else {
        oldHtml += escaped;
        newHtml += escaped;
      }
    });

    oldEl.innerHTML = oldHtml || '<span class="diff-empty">' + (I18n.t ? I18n.t('gen.empty') : '(empty)') + '</span>';
    newEl.innerHTML = newHtml || '<span class="diff-empty">' + (I18n.t ? I18n.t('gen.empty') : '(empty)') + '</span>';
  },

  // Register an apply-able response so Prev/Next can move between every
  // pending change in the transcript. Duplicate registration for the same DOM
  // element just updates content/field (retries regenerate the response).
  _registerApply(el, field, content) {
    if (!el) return null;
    let item = this._applyElMap.get(el);
    if (item) { item.field = field; item.content = content; return item; }
    item = { el, field, content, applied: false };
    this._applyElMap.set(el, item);
    this._applyQueue.push(item);
    return item;
  },

  // Build { oldVal, newVal, applyFn } for a pending apply from the CURRENT
  // card state. Recomputes on every modal open so navigating back later picks
  // up whatever has already been applied to the card.
  _prepareApply(field, content, opts) {
    opts = opts || {};
    // silent: suppress the per-item success toast (used by "Apply all", which
    // shows a single summary toast instead of stacking N field toasts).
    const silent = !!opts.silent;
    const { activeCard } = window.AppState;
    if (!activeCard || !content) return null;

    // The model may answer a per-field request with a whole card JSON (see
    // _extractCard) — every branch below then pulls the requested field's
    // value out of the card instead of treating the JSON blob as the field.
    const card = this._extractCard(content);

    if (field === 'full') {
      const jsonStr = this._extractJSON(content);
      if (!jsonStr) return null;
      try {
        const parsed = CardEngine.parseJSON(jsonStr, activeCard._filename);
        // Echoed "{user}"/"{char}" must never land in the card: normalize every
        // text field of the regenerated card to the {{...}} macro form.
        this._normalizeCardPlaceholders(parsed);
        return {
          oldVal: CardEngine.toJSON(activeCard),
          newVal: CardEngine.toJSON(parsed),
          applyFn: () => {
            // normalize() mints a fresh _id/_createdAt/_fileSize; restore every
            // internal field so applying an AI full-card edit can't bump the
            // card to the top of the Newest sort or rewrite its metadata.
            const internal = {
              _id: activeCard._id,
              _filename: activeCard._filename,
              _hasImage: activeCard._hasImage,
              _imageBase64: activeCard._imageBase64,
              _thumbnail: activeCard._thumbnail,
              _createdAt: activeCard._createdAt,
              _fileSize: activeCard._fileSize,
            };
            Object.assign(activeCard, parsed);
            Object.assign(activeCard, internal);
            Editor.populateEditor(activeCard);
            Editor.syncEditorToCard();
            if (!silent) Ui.showToast(I18n.t('toast.cardUpdatedAI'), 'success');
          },
        };
      } catch (e) {
        console.error('Failed to parse AI JSON response', e);
        Ui.showToast(I18n.t('toast.jsonParseFailed'), 'warning');
        return null;
      }
    }

    if (field === 'tags') {
      // Parse a JSON array of tag strings and MERGE into the existing tags
      // (dedupe, case-insensitive) — never replace what the user curated.
      // Prefer the card's own tags when the model answered with a whole card.
      const cardValue = this._cardFieldValue(card, 'tags');
      const tags = (Array.isArray(cardValue) && cardValue.length > 0 && cardValue.every(t => typeof t === 'string'))
        ? cardValue
        : this._extractJSONArray(content);
      if (!tags || tags.length === 0) {
        Ui.showToast(I18n.t ? I18n.t('toast.jsonInvalid') : 'Could not parse tags from the response.', 'warning');
        return null;
      }
      const existing = (activeCard.tags || []).map(t => String(t).trim()).filter(Boolean);
      const merged = [...existing];
      let added = 0;
      tags.forEach(t => {
        const s = String(t).trim();
        if (s && !merged.some(m => m.toLowerCase() === s.toLowerCase())) { merged.push(s); added++; }
      });
      return {
        oldVal: JSON.stringify(existing, null, 2),
        newVal: JSON.stringify(merged, null, 2),
        applyFn: () => {
          activeCard.tags = merged;
          Editor.populateEditor(activeCard);
          Editor.syncEditorToCard();
          CardManager.renderCardList();
          if (!silent) Ui.showToast(I18n.t('toast.tagsUpdated', { count: added }), 'success');
        },
      };
    }

    if (field === 'alternate_greetings') {
      // Parse JSON array of greetings — from the card's own field when the
      // model answered with a whole card, else from a bare JSON array.
      const cardValue = this._cardFieldValue(card, 'alternate_greetings');
      let greetings = Array.isArray(cardValue) ? cardValue : this._extractJSONArray(content);
      if (greetings) greetings = greetings.map(g => this._normalizePlaceholders(g));
      if (!greetings || greetings.length === 0) {
        Ui.showToast(I18n.t('toast.greetingsParseFailed'), 'warning');
        return null;
      }
      const renamedTo = this._pendingRename(card, activeCard);
      return {
        oldVal: JSON.stringify((activeCard.alternate_greetings || []), null, 2),
        newVal: JSON.stringify(greetings, null, 2),
        applyFn: () => {
          // Replace greetings (not append)
          activeCard.alternate_greetings = greetings;
          if (renamedTo) activeCard.name = renamedTo;
          Editor.renderGreetings(activeCard);
          Editor.syncEditorToCard();
          if (renamedTo) CardManager.renderCardList();
          if (!silent) Ui.showToast(renamedTo ? I18n.t('toast.cardRenamed', { name: renamedTo }) : I18n.t('toast.greetingsUpdated', { count: greetings.length }), 'success');
        },
      };
    }

    if (activeCard[field] !== undefined
      || ['description', 'personality', 'first_mes', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes'].includes(field)) {
      // When the model answered with a whole card JSON, apply ONLY this
      // field's value — never dump the entire JSON into a single field.
      const cardValue = this._cardFieldValue(card, field);
      let clean = cardValue !== undefined ? String(cardValue) : content;
      // Unwrap markdown fences instead of deleting them: models commonly wrap
      // the whole field in ``` which would otherwise make clean === '' and
      // silently abort the apply (no modal, no toast).
      const fence = clean.match(/```(?:json|text|markdown)?\s*\n?([\s\S]*?)```/);
      if (fence) clean = fence[1];
      // Strip only a lone "[Field Label]" echo header the prompt asks for.
      // Do NOT strip every bracket-prefixed line — that mangles W++ content
      // like "[Name: Yeon-ju] likes cats".
      const fieldLabel = this._applyFieldLabel(field);
      const headerRe = new RegExp('^\\[' + fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\s*\\n?');
      clean = this._normalizePlaceholders(clean.replace(headerRe, '')).trim();
      if (!clean) {
        Ui.showToast(I18n.t ? I18n.t('toast.emptyResponse') : 'AI returned empty content — nothing to apply.', 'warning');
        return null;
      }
      // The model named the card in its JSON (e.g. "rename the card to X"):
      // honor it as part of the same apply instead of silently dropping it.
      const renamedTo = this._pendingRename(card, activeCard);
      return {
        oldVal: activeCard[field] || '',
        newVal: clean,
        applyFn: () => {
          activeCard[field] = clean;
          if (renamedTo) activeCard.name = renamedTo;
          Editor.populateEditor(activeCard);
          Editor.syncEditorToCard();
          CardManager.renderCardList();
          if (!silent) Ui.showToast(renamedTo ? I18n.t('toast.cardRenamed', { name: renamedTo }) : I18n.t('toast.fieldUpdated', { field }), 'success');
        },
      };
    }
    return null;
  },

  _applyFieldLabel(field) {
    if (field === 'full') return I18n.t ? I18n.t('ai.target.full') : 'Full Card';
    if (field === 'tags') return I18n.t ? I18n.t('ai.target.tags') : 'Tags';
    return I18n.t ? I18n.t(this.FIELD_DEFS.find(d => d.id === field)?.labelKey || field) : field;
  },

  // ─── FULL-CARD JSON UNWRAPPING ───────────────────────

  // Fields that identify a real character card, so _extractCard never mistakes
  // arbitrary JSON (e.g. a description written as JSON) for a whole card.
  CARD_FIELDS: ['description', 'personality', 'first_mes', 'scenario', 'mes_example',
    'alternate_greetings', 'system_prompt', 'post_history_instructions', 'creator_notes', 'tags'],

  // Detect a full character card (chara_card_v2 JSON) embedded in a response.
  // Models sometimes ignore the per-field instruction and return the whole
  // card — especially for "rename the card…" prompts. Handles the
  // spec/data wrapper, a bare data wrapper, and flat name/description JSON.
  _extractCard(text) {
    if (!text || typeof text !== 'string') return null;
    const json = this._extractJSON(text);
    if (!json) return null;
    let parsed;
    try { parsed = JSON.parse(json); } catch (_) { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : null;
    if (parsed.spec === 'chara_card_v2' && data) return parsed;
    if (data && typeof data.name === 'string' && this.CARD_FIELDS.some(k => data[k] !== undefined)) return parsed;
    if (!data && typeof parsed.name === 'string' && this.CARD_FIELDS.some(k => parsed[k] !== undefined)) return parsed;
    return null;
  },

  // Pull one field's value out of a detected card (spec/data wrapper or flat).
  _cardFieldValue(card, field) {
    if (!card) return undefined;
    const data = card.data && typeof card.data === 'object' ? card.data : card;
    return data[field];
  },

  // The name the detected card proposes ('' when absent/empty).
  _cardName(card) {
    if (!card) return '';
    const data = card.data && typeof card.data === 'object' ? card.data : card;
    return typeof data.name === 'string' ? data.name.trim() : '';
  },

  // The name to apply when the detected card proposes a different name than
  // the current card ('' when no rename is warranted). Honours the model's
  // "rename the card to X" intent carried inside its JSON response.
  _pendingRename(card, activeCard) {
    if (!card || !activeCard) return '';
    const name = this._cardName(card);
    if (!name || name === (activeCard.name || '').trim()) return '';
    return name;
  },

  // Display value for a per-field response: when the model answered with a
  // whole card JSON, show ONLY this field's value instead of the JSON blob.
  _fieldDisplayContent(field, content) {
    const card = this._extractCard(content);
    if (!card) return content;
    let value = this._cardFieldValue(card, field);
    if (value === undefined) return content;
    if (field === 'alternate_greetings') {
      if (!Array.isArray(value)) return content;
      const norm = value.map(g => this._normalizePlaceholders(g));
      return norm.length ? JSON.stringify(norm, null, 2) : '';
    }
    return String(this._normalizePlaceholders(value));
  },

  // Inline formatting shared by live streaming and the finalize re-render so
  // both produce identical markup (no flicker when a section swaps a full-card
  // JSON for the extracted field value).
  _formatFieldText(text) {
    return Ui.escapeHtml(text)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  },

  // ─── NATURAL-LANGUAGE INTENT & MACRO NORMALIZATION ───

  // Normalize player/character references to the SillyTavern macro form:
  //   {user}, {User}, {{User}}  →  {{user}}
  //   {char}, {Char}, {{CHAR}}  →  {{char}}
  // Other single-brace tokens ({field}, {count}, …) are left untouched.
  _normalizePlaceholders(text) {
    if (!text || typeof text !== 'string') return text;
    // First, canonicalize the case of already-double-braced macros.
    let out = text.replace(/\{\{(user|char)\}\}/gi, (m, name) => '{{' + name.toLowerCase() + '}}');
    // Then lift single-braced forms — but never touch a brace that is part of
    // {{...}}: the lookbehind/lookahead keep {user} → {{user}} while leaving
    // {{user}} (and {random}/{field}) exactly as they are.
    out = out.replace(/(?<!\{)\{([^{}\n]{1,40})\}(?!\})/g, (m, name) => {
      const key = name.trim().toLowerCase();
      if (key === 'user' || key === 'char') return '{{' + key + '}}';
      return m;
    });
    return out;
  },

  // Normalize every text field of a parsed card (used by the full-card apply).
  _normalizeCardPlaceholders(card) {
    if (!card || typeof card !== 'object') return card;
    ['name', 'description', 'personality', 'first_mes', 'scenario', 'mes_example',
      'system_prompt', 'post_history_instructions', 'creator_notes'].forEach(f => {
      if (typeof card[f] === 'string') card[f] = this._normalizePlaceholders(card[f]);
    });
    if (Array.isArray(card.alternate_greetings)) {
      card.alternate_greetings = card.alternate_greetings.map(g => this._normalizePlaceholders(g));
    }
    return card;
  },

  // Infer which card fields a natural-language request is about. Used when the
  // user sends a message without picking field chips: "Renomme la carte en X,
  // elle est … elle dit « … »" → name + description + first_mes + scenario.
  _inferFields(prompt) {
    if (!prompt || typeof prompt !== 'string') return [];
    const p = prompt.toLowerCase();
    const has = (re) => re.test(p);
    const fields = new Set();
    if (has(/(renomme|rename|s'appelle|s’appelle|nom de la carte|card name)/)) fields.add('name');
    if (has(/(dit\s*[«"“'‘]|premier message|first message|first_mes|salue\s|greet)/)) fields.add('first_mes');
    if (has(/(personnalit|personality|caract[èe]re)/)) fields.add('personality');
    if (has(/(sc[ée]nario|scenario|arrive chez|se rend chez|situation|contexte)/)) fields.add('scenario');
    if (has(/(salutation|greeting|alternatif)/)) fields.add('alternate_greetings');
    if (has(/(exemple|example)/)) fields.add('mes_example');
    if (has(/(system prompt|prompt syst[èe]me|instructions? pour l'?ia)/)) fields.add('system_prompt');
    if (has(/(cr[ée]ateur|creator)/)) fields.add('creator_notes');
    if (has(/(étudiant|etudiant|fauch|femme de m[ée]nage|housekeeper|est une|est un|est [a-zà-ÿ]+ et|traits|character)/)) fields.add('description');
    // Description is the catch-all: long character prose almost always rewrites
    // it, even when no explicit trait keyword appears.
    if (fields.size > 0 && !fields.has('description') && p.length > 40) fields.add('description');
    return [...fields];
  },

  // Decide which item a request corresponds to and show the modal on it.
  tryApplyAIResponse(content, targetField, sourceEl) {
    const { activeCard } = window.AppState;
    if (!activeCard || !content) return;
    let item = null;
    if (sourceEl) {
      item = this._applyElMap.get(sourceEl);
      if (item) { item.field = targetField; item.content = content; }
    } else {
      item = this._applyQueue.find(it => it.content === content && it.field === targetField) || null;
    }
    // Fallback: register an item so the response is still navigable.
    if (!item) { item = this._registerApply(sourceEl || null, targetField, content); }
    if (!item) return;
    this._applyIndex = this._applyQueue.indexOf(item);
    this._openApplyAt(this._applyIndex);
  },

  // Open the diff modal at a queue index with Prev/Next navigation.
  _openApplyAt(index) {
    const queue = this._applyQueue;
    if (!queue.length) return;
    const n = queue.length;
    const i = ((index % n) + n) % n;
    const item = queue[i];
    this._applyIndex = i;

    const modalEl = document.querySelector('#aiPreviewModal');
    if (!modalEl) return;
    const prep = this._prepareApply(item.field, item.content);
    if (!prep) return; // parse failure already toasted

    // Reuse a single Modal instance to avoid stacking listeners (#32/#104).
    this._previewModal = this._previewModal || new bootstrap.Modal(modalEl);
    const modal = this._previewModal;

    this._renderDiff(prep.oldVal, prep.newVal);
    const titleEl = modalEl.querySelector('.modal-title');
    if (titleEl) titleEl.innerHTML = '<i class="bi bi-split-cells me-2 text-accent"></i>' + Ui.escapeHtml(this._applyFieldLabel(item.field));

    // Prev / Next / counter — only meaningful when there is more than one change.
    const showNav = n > 1;
    const navGroup = document.querySelector('#applyNavGroup');
    const counterEl = document.querySelector('#applyNavCounter');
    const prevBtn = document.querySelector('#btnApplyPrev');
    const nextBtn = document.querySelector('#btnApplyNext');
    if (navGroup) navGroup.style.display = showNav ? 'flex' : 'none';
    if (counterEl) counterEl.textContent = showNav ? (I18n.t ? I18n.t('ai.changesNav', { current: i + 1, total: n }) : ((i + 1) + ' / ' + n)) : '';
    if (prevBtn) prevBtn.disabled = !showNav;
    if (nextBtn) nextBtn.disabled = !showNav;

    const acceptBtn = document.querySelector('#btnAcceptAI');
    const applyAllBtn = document.querySelector('#btnApplyAll');
    if (this._previewCleanup) this._previewCleanup();

    // Apply the current change, then advance to the next unapplied one so a
    // long multi-field run can be reviewed + applied in a single pass. Closes
    // once nothing is left (the per-section "Applied" badges stay visible).
    const handler = () => {
      if (item.applied) { modal.hide(); return; }
      this._markApplied(item);
      if (prep.applyFn) prep.applyFn();
      this._maybeRetireReadyBars();
      const nextIdx = this._nextUnappliedIndex();
      if (nextIdx >= 0) this._openApplyAt(nextIdx);
      else modal.hide();
    };
    // Apply every remaining change in the queue in one click.
    const applyAllHandler = () => {
      this._applyAllPending(modal);
    };
    // Keyboard-first review: Enter applies & advances, A applies everything,
    // ←/→ move between changes. Bound to the modal element so typing in the
    // page underneath is never intercepted.
    const keyHandler = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handler(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this._applyNav(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this._applyNav(1); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); applyAllHandler(); }
    };
    const cleanup = () => {
      acceptBtn.removeEventListener('click', handler);
      if (applyAllBtn) applyAllBtn.removeEventListener('click', applyAllHandler);
      modalEl.removeEventListener('keydown', keyHandler);
      modalEl.removeEventListener('hidden.bs.modal', cleanup);
      if (this._previewCleanup === cleanup) this._previewCleanup = null;
    };
    this._previewCleanup = cleanup;
    acceptBtn.addEventListener('click', handler);
    if (applyAllBtn) applyAllBtn.addEventListener('click', applyAllHandler);
    modalEl.addEventListener('keydown', keyHandler);
    modalEl.addEventListener('hidden.bs.modal', cleanup);
    modal.show();
    // Land focus on Apply so Enter works immediately (the keydown handler
    // preventDefaults, so the focused button never double-fires).
    if (acceptBtn) acceptBtn.focus();
  },

  _applyNav(delta) {
    const queue = this._applyQueue;
    if (queue.length < 2) return;
    this._openApplyAt((this._applyIndex + delta + queue.length) % queue.length);
  },

  // Index of the next not-yet-applied change after the current one (-1 when
  // the queue is exhausted). Applied items stay in the queue (still viewable
  // via Prev/Next) but are skipped by the apply-and-advance flow.
  _nextUnappliedIndex() {
    for (let i = this._applyIndex + 1; i < this._applyQueue.length; i++) {
      if (!this._applyQueue[i].applied) return i;
    }
    return -1;
  },

  // Apply every remaining pending change in one pass. Per-item success toasts
  // are suppressed (silent) in favour of a single summary toast, so applying
  // 9 fields doesn't stack 9 toasts. Items whose response cannot be prepared
  // already warned at modal-open time — they are skipped, not fatal.
  _applyAllPending(modal) {
    const queue = this._applyQueue;
    let applied = 0;
    let failed = 0;
    for (const item of queue) {
      if (item.applied) continue;
      const prep = this._prepareApply(item.field, item.content, { silent: true });
      if (!prep) { failed++; continue; }
      try {
        this._markApplied(item);
        prep.applyFn();
        applied++;
      } catch (e) {
        console.error('aiChat: failed to apply change:', e);
        failed++;
      }
    }
    if (modal && typeof modal.hide === 'function') modal.hide();
    this._maybeRetireReadyBars();
    if (applied > 0) {
      Ui.showToast(I18n.t('toast.changesApplied', { count: applied }), 'success');
    }
  },

  // Drop queue items whose source message left the DOM (chat cleared, or
  // removed by retry) so the Prev/Next nav never lists stale changes.
  _pruneApplyQueue() {
    this._applyQueue = this._applyQueue.filter(it => it.el && it.el.isConnected);
    if (this._applyIndex >= this._applyQueue.length) this._applyIndex = Math.max(0, this._applyQueue.length - 1);
  },

  // Mark an item applied: badge on the chat message + disable its apply buttons.
  _markApplied(item) {
    item.applied = true;
    const el = item.el;
    if (!el) return;
    el.dataset.applied = '1';
    const actions = el.matches('.multi-field-section')
      ? el.querySelector('.multi-field-actions')
      : (el.querySelector('.ai-message-actions') || el);
    const badge = document.createElement('span');
    badge.className = 'ai-applied-badge';
    badge.innerHTML = '<i class="bi bi-check2-circle"></i> ' + (I18n.t ? I18n.t('ai.applied') : 'Applied');
    actions.appendChild(badge);
    // Disable/relabel apply buttons inside the element (Retry stays active).
    [...el.querySelectorAll('button')].forEach(b => {
      if (/apply/i.test(b.textContent) || b.classList.contains('ai-message-reapply')) { b.disabled = true; b.classList.add('disabled'); }
    });
  },


  _extractJSONArray(text) {
    if (!text) return null;
    // Use bracket-depth counting for robust [ ] matching
    const textStart = text.indexOf('[');
    if (textStart < 0) return null;
    let start = textStart;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') {
        if (depth === 0) start = i; // each top-level [ starts a candidate
        depth++;
      }
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
              return parsed;
            }
          } catch (_) { /* keep looking for another array */ }
        }
      }
    }
    // Fallback: try parsing full text
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        return parsed;
      }
    } catch (_) {}
    return null;
  },

  _extractJSON(text) {
    if (!text) return null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1].trim() : text.trim();
    const balanced = this._balancedBraces(candidate);
    if (balanced) return balanced;
    return this._balancedBraces(text);
  },

  _balancedBraces(text) {
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  },

  // ─── QUICK ACTIONS ──────────────────────────────────

  async handleQuickAction(action) {
    const $ = Ui.$;
    const { activeCard } = window.AppState;
    if (action === 'newcard') {
      Wizard.show();
      return;
    }
    if (!AIService.hasApiKey()) { Ui.showToast(I18n.t('toast.apiKey'), 'warning'); return; }
    if (!activeCard) { Ui.showToast(I18n.t('toast.selectCard'), 'warning'); return; }

    // Prompts come from the Settings registry (stored override || built-in
    // default), so users can edit every AI prompt under Settings → Prompts tab.
    const promptFor = (name) => CardStorage.getPrompt(name) || Settings.getDefaultPrompt(name);
    const currentOf = {
      shorten: activeCard.description, enhance: activeCard.description,
      tone: activeCard.description, grammar: activeCard.description,
      personality: activeCard.personality, firstmes: activeCard.first_mes,
      scenario: activeCard.scenario, systemprompt: activeCard.system_prompt,
    };
    const withCurrent = (name, field) => promptFor(name) + '\n\nCurrent:\n' + (currentOf[field] || '(empty)');

    const prompts = {
      // shorten/tone/grammar all write back to 'description' (fieldMap below),
      // so they must read 'description' — not a fallback chain that would feed
      // personality text in and paste it into the wrong field (#8).
      enhance: withCurrent('enhance', 'enhance'),
      personality: withCurrent('personality', 'personality'),
      firstmes: withCurrent('firstmes', 'firstmes'),
      scenario: withCurrent('scenario', 'scenario'),
      shorten: withCurrent('shorten', 'shorten'),
      tone: promptFor('tone'),
      grammar: withCurrent('grammar', 'grammar'),
      greetings: promptFor('greetings'),
      systemprompt: withCurrent('systemprompt', 'systemprompt'),
      translate: promptFor('translate'),
      tags: promptFor('tags'),
    };

    if (action === 'translate') {
      // Offer the app's 27 supported languages as a dropdown instead of a
      // free-text prompt (native dialogs can be blocked in iframes/PWAs).
      const LANG_CODES = ['en', 'fr', 'es', 'de', 'pt', 'ja', 'zh', 'ko', 'el', 'ru', 'it', 'pl', 'tr', 'nl', 'uk', 'vi', 'id', 'hi', 'ar', 'he', 'fa', 'ro', 'cs', 'sv', 'th', 'pt-pt', 'tl'];
      const options = LANG_CODES.map((code) => {
        const label = (I18n.t && I18n.t('wizard.language.' + code) !== 'wizard.language.' + code) ? I18n.t('wizard.language.' + code) : code;
        return { value: label, label };
      });
      const lang = await Ui.prompt({
        title: I18n.t ? I18n.t('ai.translateTitle') : 'Translate card',
        message: I18n.t ? I18n.t('ai.translateMessage') : 'Which language should the card be translated to?',
        select: options,
        value: (I18n.t ? (I18n.t('wizard.language.fr') !== 'wizard.language.fr' ? I18n.t('wizard.language.fr') : 'French') : 'French'),
        buttonLabel: I18n.t ? I18n.t('dialog.ok') : 'OK',
      });
      if (!lang) return;
      prompts.translate = prompts.translate.split('{lang}').join(lang).split('{card}').join(CardEngine.toJSON(activeCard));
    }

    if (action === 'tone') {
      const tone = await Ui.prompt({
        title: I18n.t ? I18n.t('ai.toneTitle') : 'Change tone',
        message: I18n.t ? I18n.t('ai.toneMessage') : 'Which tone should the description be rewritten in?',
        text: '',
        value: I18n.t ? (I18n.t('ai.toneDefault') !== 'ai.toneDefault' ? I18n.t('ai.toneDefault') : 'formal') : 'formal',
        placeholder: I18n.t ? I18n.t('ai.toneMessage') : 'formal, casual, dark, humorous, poetic…',
        buttonLabel: I18n.t ? I18n.t('dialog.ok') : 'OK',
      });
      if (!tone) return;
      prompts.tone = prompts.tone.split('{tone}').join(tone) + '\n\nCurrent:\n' + (currentOf.tone || '(empty)');
    }

    // Suggest tags: dedicated path that asks for a JSON array (like translate),
    // so it does not pollute the field-chip selector.
    if (action === 'tags') {
      this._sendFullCard(prompts.tags, {
        applyTarget: 'tags',
        systemPromptInstruction: promptFor('tagsSystem'),
      });
      return;
    }

    const aiPrompt = action === 'translate' ? prompts.translate : prompts[action];
    if (!aiPrompt) return;

    this._selectedFields.clear();
    const fieldMap = {
      translate: null,
      personality: 'personality',
      firstmes: 'first_mes',
      scenario: 'scenario',
      enhance: 'description',
      shorten: 'description',
      tone: 'description',
      grammar: 'description',
      greetings: 'alternate_greetings',
      systemprompt: 'system_prompt',
    };

    if (action === 'translate') {
      this._renderFieldChips();
      const inp = $('#aiInput');
      if (inp) inp.value = aiPrompt;
      this._sendFullCard(aiPrompt);
      return;
    } else if (fieldMap[action]) {
      this._selectedFields.add(fieldMap[action]);
    }

    this._renderFieldChips();
    const inp = $('#aiInput');
    if (inp) inp.value = aiPrompt;
    this.send();
  },

  // ─── CHAT MESSAGES ──────────────────────────────────

  addChatMessage(role, content, usage, applyData, historyIndex) {
    const $ = Ui.$;
    const container = $('#aiChatMessages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    let formatted;
    if (typeof Ui !== 'undefined' && Ui.renderMarkdown) {
      formatted = Ui.renderMarkdown(content);
    } else {
      formatted = Ui.escapeHtml(content)
        .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '<pre>$1</pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
        .replace(/\n/g, '<br>');
    }

    const usageInfo = usage
      ? '<div class="text-muted mt-1" style="font-size:0.65rem;">' + (usage.total_tokens || '?') + ' tokens · $' + (usage.cost || 0).toFixed(5) + '</div>'
      : '';

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const el = document.createElement('div');
    el.className = 'ai-message ' + role;
    if (typeof historyIndex === 'number') el.dataset.historyIndex = String(historyIndex);
    el.innerHTML = formatted + '<div class="text-muted mt-1" style="font-size:0.6rem;">' + time + '</div>' + usageInfo;

    if (role === 'assistant') {
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'ai-message-actions';

      // Re-apply button — appears when there is pending apply data for this message
      const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      if (applyData && applyData.content) {
        this._applyStore.set(msgId, applyData);
        // Evict oldest entries if store exceeds limit
        if (this._applyStore.size > 50) {
          const oldest = this._applyStore.keys().next().value;
          this._applyStore.delete(oldest);
        }
        el.setAttribute('data-apply-id', msgId);
        this._registerApply(el, applyData.field, applyData.content);
        const reapplyBtn = document.createElement('button');
        reapplyBtn.className = 'ai-message-reapply';
        reapplyBtn.innerHTML = '<i class="bi bi-check2-circle"></i> ' + (I18n.t ? I18n.t('ai.apply') : 'Apply');
        reapplyBtn.title = I18n.t ? I18n.t('ai.applyTitle') : 'Apply these changes to the card';
        reapplyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const stored = this._applyStore.get(msgId);
          if (stored) {
            this.tryApplyAIResponse(stored.content, stored.field, el);
          }
        });
        actionsWrap.appendChild(reapplyBtn);
      }

      const retryBtn = document.createElement('button');
      retryBtn.className = 'ai-message-retry';
      retryBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> ' + (I18n.t ? I18n.t('ai.retry') : 'Retry');
      retryBtn.title = I18n.t ? I18n.t('ai.retryTitle') : 'Regenerate this response';
      retryBtn.addEventListener('click', (e) => {
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
    // Determine the user message that prompted the response being retried.
    // historyIndex is the chatHistory index of the assistant message the user
    // clicked "Retry" on; we regenerate its own prompt, not the last one.
    let targetUserIdx = -1;
    if (typeof historyIndex === 'number') {
      for (let i = historyIndex; i >= 0; i--) {
        if (chatHistory[i] && chatHistory[i].role === 'user') { targetUserIdx = i; break; }
      }
    }
    if (targetUserIdx < 0) {
      // Fallback: last user message (legacy behaviour for unannotated nodes).
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'user') { targetUserIdx = i; break; }
      }
    }
    if (targetUserIdx < 0) return;

    const lastUserPrompt = chatHistory[targetUserIdx].content;
    // Abort any in-flight generation so stale callbacks don't mutate the UI.
    this._abortAll();
    this._gen++; // also invalidate the aborted run's .then/.catch
    // Remove the user message being retried and everything after it.
    chatHistory.splice(targetUserIdx);
    window.AppState.isAiLoading = false;
    this.updateSendButton();
    CardStorage.saveChatHistory(chatHistory, window.AppState.activeCard?._id);
    if (this._currentSessionId) {
      const cardId = window.AppState.activeCard?._id || 'global';
      CardStorage.saveSessionMessages(cardId, this._currentSessionId, chatHistory);
    }

    // Clean up DOM: remove the retried user bubble and EVERYTHING after it.
    // DOM order mirrors history order, and multi-field grouped cards carry no
    // historyIndex, so removing by index alone would orphan them — remove from
    // the target user bubble's DOM position onward instead (v2 fix).
    const $ = Ui.$;
    const container = $('#aiChatMessages');
    const allMsgs = container.querySelectorAll('.ai-message');
    let removedDom = 0;
    const targetEl = [...allMsgs].find(el => parseInt(el.dataset.historyIndex, 10) === targetUserIdx);
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
      // Fallback: remove the last user + assistant pair from the DOM.
      for (let i = allMsgs.length - 1; i >= 0 && removedDom < 2; i--) {
        const msg = allMsgs[i];
        if (msg.classList.contains('system')) continue;
        msg.remove();
        removedDom++;
      }
    }

    // Drop apply-queue items for messages that were just removed from the DOM.
    this._pruneApplyQueue();

    // Re-add the user bubble so the retried prompt stays visible (#5).
    this.addChatMessage('user', lastUserPrompt, null, null, targetUserIdx);
    this.send(lastUserPrompt);
  },

  createStreamingMessage() {
    const $ = Ui.$;
    const container = $('#aiChatMessages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();
    const el = document.createElement('div');
    el.className = 'ai-message assistant';
    el.innerHTML = '<div class="ai-message-content"></div>'
      + '<div class="ai-stream-status" aria-live="polite" aria-atomic="true"></div>'
      + '<div class="ai-shimmer" aria-hidden="true"><div class="shimmer-line"></div><div class="shimmer-line"></div><div class="shimmer-line short"></div></div>';
    container.appendChild(el);
    Anims.staggerFadeIn(el, { duration: 200, from: 10 });
    container.scrollTop = container.scrollHeight;
    return el;
  },

  renderChatHistory() {
    if (this._historyRendered) return;
    const { chatHistory } = window.AppState;
    const $ = Ui.$;
    const container = $('#aiChatMessages');
    if (chatHistory.length === 0) {
      // Card has no chat: never leave a previous card's messages on screen,
      // and still latch the flag so re-selecting a card with history cannot
      // append duplicates on top of the still-visible DOM.
      this._historyRendered = true;
      this._showWelcome();
      return;
    }
    // Switching cards must not stack histories: rebuild the transcript from
    // scratch instead of appending below a previous card's messages.
    container.innerHTML = '';
    chatHistory.forEach((msg, i) => this.addChatMessage(msg.role, msg.content, null, null, i));
    this._historyRendered = true;
  },

  _updateSession() {
    const { chatHistory, activeCard } = window.AppState;
    if (!chatHistory || chatHistory.length < 2) return;
    const cardId = activeCard?._id || 'global';
    const sessions = CardStorage.getChatSessions(cardId);

    const firstUser = chatHistory.find(m => m.role === 'user');
    const preview = firstUser
      ? (firstUser.content.length > 80 ? firstUser.content.slice(0, 80) + '...' : firstUser.content)
      : (I18n.t ? I18n.t('ai.chatSession') : 'Chat session');

    const now = Date.now();
    const SESSION_TIMEOUT = 30 * 60 * 1000;

    let currentSession = this._currentSessionId
      ? sessions.find(s => s.id === this._currentSessionId)
      : (sessions.length > 0 ? sessions[0] : null);

    if (currentSession && (now - (currentSession.lastUpdated || currentSession.created)) < SESSION_TIMEOUT) {
      currentSession.lastUpdated = now;
      currentSession.preview = preview;
      currentSession.messageCount = chatHistory.length;
      this._currentSessionId = currentSession.id;
      CardStorage.saveChatSession(cardId, currentSession);
      CardStorage.saveSessionMessages(cardId, currentSession.id, chatHistory);
    } else {
      // Stale session: start a new one. Do NOT also refresh the old session's
      // timestamp/messages here — that would defeat the timeout (the old
      // session would look current again) and fork two identical conversations
      // into storage (v3 #1).
      const session = {
        id: 'ses_' + now + '_' + Math.random().toString(36).slice(2, 7),
        created: now,
        lastUpdated: now,
        preview: preview,
        messageCount: chatHistory.length,
      };
      this._currentSessionId = session.id;
      CardStorage.saveChatSession(cardId, session);
      CardStorage.saveSessionMessages(cardId, session.id, chatHistory);
    }
  },

  _renderHistoryList() {
    const $ = Ui.$;
    const list = $('#aiHistoryList');
    if (!list) return;
    const cardId = window.AppState.activeCard?._id || 'global';
    const sessions = CardStorage.getChatSessions(cardId);

    if (sessions.length === 0) {
      list.innerHTML = '<div class="ai-history-empty">' + (I18n.t ? I18n.t('ai.historyEmpty') : 'No conversations yet') + '</div>';
      return;
    }

    list.innerHTML = sessions.map(s => {
      const date = new Date(s.created);
      const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<div class="ai-history-item" data-session-id="' + Ui.escapeAttr(s.id) + '">'
        + '<div class="ai-history-item-preview">' + Ui.escapeHtml(s.preview) + '</div>'
        + '<div class="ai-history-item-meta">'
        + '<span class="ai-history-item-time">' + dateStr + ' ' + timeStr + '</span>'
        + '<span class="ai-history-item-count">' + (I18n.t ? I18n.t('ai.msgs', { count: s.messageCount || '?' }) : (s.messageCount || '?') + ' msgs') + '</span>'
        + '</div></div>';
    }).join('');

    list.querySelectorAll('.ai-history-item').forEach(item => {
      item.addEventListener('click', () => {
        this._loadSession(item.dataset.sessionId);
      });
    });
  },

  _showWelcome() {
    const $ = Ui.$;
    const container = $('#aiChatMessages');
    if (!container) return;
    container.innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>' + I18n.t('ai.welcomeTitle') + '</h6><p>' + I18n.t('ai.welcomeText') + '</p><div class="quick-actions">'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="newcard"><i class="bi bi-magic me-1"></i> ' + I18n.t('ai.actionNewCard') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="translate"><i class="bi bi-translate me-1"></i> ' + I18n.t('ai.actionTranslate') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="enhance"><i class="bi bi-stars me-1"></i> ' + I18n.t('ai.actionEnhance') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="shorten"><i class="bi bi-arrows-angle-contract me-1"></i> ' + I18n.t('ai.actionShorten') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="tone"><i class="bi bi-palette me-1"></i> ' + I18n.t('ai.actionTone') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="grammar"><i class="bi bi-check2-all me-1"></i> ' + I18n.t('ai.actionGrammar') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="personality"><i class="bi bi-emoji-smile me-1"></i> ' + I18n.t('ai.actionPersonality') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="firstmes"><i class="bi bi-chat-dots me-1"></i> ' + I18n.t('ai.actionFirstMes') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="scenario"><i class="bi bi-geo-alt me-1"></i> ' + I18n.t('ai.actionScenario') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="greetings"><i class="bi bi-list-ol me-1"></i> ' + I18n.t('ai.actionGreetings') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="systemprompt"><i class="bi bi-terminal me-1"></i> ' + I18n.t('ai.actionSystemprompt') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="tags"><i class="bi bi-tags me-1"></i> ' + I18n.t('ai.actionTags') + '</button>'
      + '</div></div>';
    const self = this;
    container.querySelectorAll('.quick-action').forEach(btn => {
      btn.addEventListener('click', () => self.handleQuickAction(btn.dataset.action));
    });
    Anims.staggerFadeIn(container.querySelectorAll('.quick-action'), { stagger: 40, duration: 180 });
  },

  _loadSession(sessionId) {
    const cardId = window.AppState.activeCard?._id || 'global';
    const sessions = CardStorage.getChatSessions(cardId);
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    // Load this session's messages into chatHistory
    const sessionMessages = CardStorage.getSessionMessages(cardId, sessionId);
    window.AppState.chatHistory = sessionMessages;
    this._currentSessionId = sessionId;
    this._historyRendered = false;
    // Pending AI responses belong to the conversation that generated them:
    // loading a different session must drop the previous transcript's apply
    // queue exactly like switching cards does (clearChat resets it too —
    // _loadSession used to miss it, leaving stale Prev/Next entries).
    this._resetApplyQueue();

    // Clear the DOM and re-render
    const $ = Ui.$;
    const container = $('#aiChatMessages');
    if (container) container.innerHTML = '';

    this.toggleHistory(false);
    if (!sessionMessages || sessionMessages.length === 0) {
      // Empty session (e.g. failed persistence): show the welcome panel with
      // quick actions instead of leaving a completely blank screen (#40).
      this._showWelcome();
    } else {
      this.renderChatHistory();
    }

    this._renderHistoryList();
    const item = $('#aiHistoryList')?.querySelector('[data-session-id="' + sessionId + '"]');
    if (item) item.classList.add('active');
  },

  toggleHistory(forceState) {
    const $ = Ui.$;
    const panel = $('#aiHistoryPanel');
    const messages = $('#aiChatMessages');
    const inputArea = $('.ai-input-area');
    if (!panel) return;

    const isOpen = forceState !== undefined ? forceState : !panel.classList.contains('open');
    panel.classList.toggle('open', isOpen);
    if (messages) messages.style.display = isOpen ? 'none' : '';
    if (inputArea) inputArea.style.display = isOpen ? 'none' : '';

    if (isOpen) {
      this._renderHistoryList();
    }
  },

  clearChat() {
    // Abort any in-flight generation first so its .then/.catch can't push an
    // orphan message into the freshly-emptied history (#25).
    this._abortAll();
    this._gen++; // invalidate stale run callbacks
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
    Ui.showToast(I18n.t('toast.chatCleared'), 'info');
  },

  updateSendButton() {
    const $ = Ui.$;
    const btn = $('#btnAiSend');
    const stop = $('#btnAiStop');
    if (!btn) return;
    btn.disabled = window.AppState.isAiLoading;
    btn.innerHTML = window.AppState.isAiLoading ? '<span class="spinner-border spinner-border-sm"></span>' : '<i class="bi bi-send-fill"></i>';
    if (stop) stop.classList.toggle('d-none', !window.AppState.isAiLoading);
  },

  async updateContextBar() {
    const $ = Ui.$;
    const bar = $('#contextBarFill');
    const label = $('#contextBarLabel');
    if (!bar || !label) return;

    const modelSelect = $('#aiModelSelect');
    const input = $('#aiInput');
    if (!modelSelect || !input) return;

    const modelId = modelSelect.value;
    const prompt = input.value || '';
    const { activeCard } = window.AppState;

    // Capture AFTER the element guards so only real invocations supersede
    // in-flight ones; a stale call that finishes later must not overwrite the
    // bar with older text (async Tokenizer.count / resolveMaxTokens).
    const gen = ++this._contextBarGen;

    if (!modelId) {
      bar.style.width = '0%';
      bar.classList.remove('warn', 'danger');
      label.textContent = I18n.t('ai.selectModel');
      return;
    }

    const ctx = AIService.getContextLength(modelId);
    const cardJson = activeCard ? CardEngine.toJSON(activeCard) : '';
    // Mirror the default send path (buildSystemPrompt uses getPrompt('assistant')
    // plus the full card JSON), not the full-card translate prompt.
    const systemPromptBase = [
      CardStorage.getPrompt('assistant') || 'You are an AI assistant helping edit SillyTavern character cards.\nSillyTavern is an AI roleplay frontend. Cards define character personalities.',
    ].join('\n');
    const inputText = systemPromptBase + '\n\n' + cardJson;

    // Include chat history tokens for accurate estimate. Nothing has been
    // pushed to history yet at context-bar time, so keep the last real message.
    const history = this._getRecentHistory(10, true);
    let historyText = '';
    for (const msg of history) {
      historyText += (msg.content || '') + '\n';
    }
    let inputTokens = 0;
    try {
      if (window.Tokenizer && typeof window.Tokenizer.count === 'function') {
        inputTokens = await window.Tokenizer.count(inputText + '\n' + historyText + '\n' + prompt);
      }
    } catch (_) {
      inputTokens = 0;
    }
    if (gen !== this._contextBarGen) return; // superseded by a newer call
    if (!inputTokens) {
      // Shared estimator: real BPE once the CDN lib is loaded (even when the
      // async count above failed), heuristic before — always the same number
      // the editor counters and the live streaming display compute.
      inputTokens = Tokenizer.syncCount(inputText + '\n' + historyText + '\n' + prompt);
    }

    // Get the model's actual max output limit from the model data
    const modelData = (window.AppState.models || []).find(m => m.id === modelId);
    const modelMaxOut = (modelData && modelData.max_output_tokens > 0)
      ? modelData.max_output_tokens
      : AIService.DEFAULT_MAX_TOKENS;

    // The effective output cap for THIS request is the user's Max Tokens
    // setting when set (that's what actually goes on the wire, aiService.js
    // _buildRequestBody), falling back to the model's limit.
    const userMaxTokens = CardStorage.getMaxTokens();
    const outputCap = userMaxTokens > 0 ? Math.min(userMaxTokens, modelMaxOut) : modelMaxOut;

    // Get the API-safe max for this request (accounts for context space)
    // Build messages array including history for accurate max token resolution
    const historyMsgs = history.map(m => ({ role: m.role, content: m.content || '' }));
    const allMessages = [{ role: 'system', content: inputText }, ...historyMsgs, { role: 'user', content: prompt }];
    const resolvedMax = await AIService.resolveMaxTokens(modelId, allMessages);
    if (gen !== this._contextBarGen) return; // superseded by a newer call
    // The actual usable output is the smaller of the request cap and available context
    const actualMaxOut = Math.min(outputCap, resolvedMax);

    // Show the meaningful ratio: input + expected output vs context
    const total = inputTokens + actualMaxOut;
    const ratio = ctx > 0 ? total / ctx : 0;
    const pct = Math.min(100, Math.round(ratio * 100));

    bar.style.width = pct + '%';
    bar.classList.toggle('warn', ratio >= 0.9 && ratio < 1);
    bar.classList.toggle('danger', ratio >= 1);

    let labelText = this._fmt(inputTokens) + (I18n.t ? I18n.t('ai.tokensIn') : ' in · ') + this._fmt(actualMaxOut) + (I18n.t ? I18n.t('ai.tokensOut') : ' out · ') + this._fmt(ctx) + (I18n.t ? I18n.t('ai.tokensCtx') : ' ctx');
    if (ratio >= 1) {
      labelText += I18n.t ? I18n.t('ai.exceedsLimit') : ' ⚠ Exceeds limit!';
    } else if (ratio >= 0.9) {
      labelText += I18n.t ? I18n.t('ai.approachingLimit') : ' ⚠ Approaching limit';
    }
    label.textContent = labelText;
  },

  _fmt(n) {
    n = n || 0;
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return '' + n;
  },
};

export { AiChat };
if (typeof window !== 'undefined') window.AiChat = AiChat;
