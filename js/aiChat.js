/* ============================================================
   aiChat.js — AI Chat UI, Multi-Field Parallel Requests
   ============================================================ */

const AiChat = {
  _abortControllers: [],      // per-field controllers for parallel requests
  _historyRendered: false,
  _selectedFields: new Set(), // fields selected for editing
  _greetingCount: 3,

  FIELD_DEFS: [
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
    const $ = (sel) => document.querySelector(sel);
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
    if (this._selectedFields.size === 0) {
      return ['description'];
    }
    return [...this._selectedFields];
  },

  send(retryPrompt) {
    const $ = (sel) => document.querySelector(sel);
    const input = $('#aiInput');
    const prompt = retryPrompt || input.value.trim();
    const { activeCard } = window.AppState;
    if (!prompt || window.AppState.isAiLoading) return;

    if (!activeCard) { Ui.showToast(I18n.t('toast.selectCard'), 'warning'); return; }

    const selectedFields = this.getSelectedFields();
    if (selectedFields.length === 0) {
      Ui.showToast(I18n.t('toast.selectField'), 'info');
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
    }
    window.AppState.isAiLoading = true;
    this.updateSendButton();

    if (!retryPrompt) {
      this.addChatMessage('user', prompt);
      window.AppState.chatHistory.push({ role: 'user', content: prompt });
    }
    CardStorage.saveChatHistory(window.AppState.chatHistory, window.AppState.activeCard?._id);

    const groupedCard = this._createGroupedCard(selectedFields);
    this._abortAll();

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

      AIService.chatStream(prompt, this.buildSystemPrompt(field, capturedGreetingCount), modelId,
        (fullText) => {
          contentEl.textContent = fullText;
          const container = document.querySelector('#aiChatMessages');
          container.scrollTop = container.scrollHeight;
        },
        controller.signal
      )
        .then(result => {
          this._finalizeFieldSection(section, field, result.content);
          completedCount++;
          combinedContent += '\n\n[' + fieldLabel(field) + ']\n' + result.content;

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
          section.classList.add('error');
          section.classList.remove('streaming');
          const label = section.querySelector('.multi-field-label');
          if (label) label.innerHTML = label.innerHTML.replace(I18n.t ? I18n.t('ai.streaming') : 'streaming...', I18n.t ? I18n.t('ai.failed') : 'failed');
          contentEl.textContent = err.name === 'AbortError' ? (I18n.t ? I18n.t('ai.cancelled') : 'Cancelled.') : 'Error: ' + err.message;

          completedCount++;
          if (completedCount === selectedFields.length) {
            this._finalizeGroupedCard(groupedCard, selectedFields.length);
            window.AppState.isAiLoading = false;
            this.updateSendButton();
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
      'You are an AI assistant helping edit SillyTavern character cards.',
      'SillyTavern is an AI roleplay frontend. Cards define character personalities.',
      '',
      'Here is the FULL character card for context:',
      '```json',
      CardEngine.toJSON(cardForPrompt),
      '```',
      '',
    ];

    if (targetField === 'alternate_greetings') {
      const existing = (activeCard && activeCard.alternate_greetings) || [];
      parts.push('The user wants you to generate ALTERNATE GREETINGS for this character.');
      parts.push('Current greetings: ' + (existing.length ? JSON.stringify(existing) : '(none)'));
      parts.push('Generate exactly ' + greetingCount + ' new greeting' + (greetingCount > 1 ? 's' : '') + '.');
      parts.push('Respond with ONLY a valid JSON array of greeting strings. No explanations, no markdown.');
      parts.push('Example response format: ["Greeting one...", "Greeting two...", "Greeting three..."]');
      parts.push('Each greeting should be an in-character opening message that could start a conversation with {{user}}.');
    } else {
      parts.push('The user wants you to edit the "' + fieldLabel + '" field of this card.');
      parts.push('Below is the current content of that field:');
      parts.push('[' + fieldLabel + ']');
      parts.push(activeCard && activeCard[targetField] !== undefined ? (activeCard[targetField] || '(empty)') : '(empty)');
      parts.push('');
      parts.push('Respond with ONLY the new content for this field. Do not include explanations, JSON wrapping, or markdown fences unless the original content uses them.');
    }
    return parts.join('\n');
  },

  // ─── GROUPED MULTI-FIELD CARD ───────────────────────

  _createGroupedCard(fields) {
    const $ = (sel) => document.querySelector(sel);
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

    // Truncate long content — collapse to compact preview with modal expand
    const contentEl = section.querySelector('.multi-field-content');
    if (contentEl && content.length > 300) {
      contentEl.classList.add('collapsed');
      // Click on collapsed content toggles expand inline
      contentEl.addEventListener('click', function onClickExpand() {
        this.classList.toggle('collapsed');
        // Update the expand button icon/text to reflect state
        const viewBtn = section.querySelector('.multi-field-expand-btn');
        if (viewBtn) {
          const isCollapsed = this.classList.contains('collapsed');
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
      if (content.length > 300) {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'multi-field-expand-btn';
        viewBtn.type = 'button';
        viewBtn.innerHTML = '<i class="bi bi-arrows-expand"></i> ' + (I18n.t ? I18n.t('ai.viewFullResult') : 'View full result');
        viewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          self._showResultModal(field, content);
        });
        actions.appendChild(viewBtn);
      }

      // "Review & Apply" button — opens diff modal
      const btn = document.createElement('button');
      btn.className = 'btn btn-outline-accent btn-sm';
      btn.innerHTML = '<i class="bi bi-eye me-1"></i> ' + (I18n.t ? I18n.t('ai.reviewApply') : 'Review & Apply');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        self.tryApplyAIResponse(content, field);
      });
      actions.appendChild(btn);
    }
  },

  // ─── SHOW FULL RESULT IN MODAL ──────────────────────

  _showResultModal(field, content) {
    const $ = (sel) => document.querySelector(sel);
    const fieldLabel = I18n.t
      ? I18n.t(this.FIELD_DEFS.find(d => d.id === field)?.labelKey || field)
      : field;

    const modalEl = $('#aiResultModal');
    if (!modalEl) return;

    const titleEl = modalEl.querySelector('.modal-title');
    const bodyEl = modalEl.querySelector('.modal-body');
    if (titleEl) titleEl.innerHTML = '<i class="bi bi-file-text me-2 text-accent"></i>' + Ui.escapeHtml(fieldLabel);
    if (bodyEl) bodyEl.textContent = content;

    const modal = new bootstrap.Modal(modalEl);

    // Wire up copy button
    const copyBtn = modalEl.querySelector('#btnCopyResult');
    if (copyBtn) {
      // Reset button text on every open
      const copyLabel = () => '<i class="bi bi-clipboard me-1"></i>' + (I18n.t ? I18n.t('ai.copy') : 'Copy');
      copyBtn.innerHTML = copyLabel();
      let copyTimeout = null;
      const cleanupCopy = () => {
        copyBtn.removeEventListener('click', copyHandler);
        if (copyTimeout) { clearTimeout(copyTimeout); copyTimeout = null; }
      };
      const copyHandler = () => {
        navigator.clipboard.writeText(content).then(() => {
          copyBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>' + (I18n.t ? I18n.t('ai.copied') : 'Copied!');
          copyTimeout = setTimeout(() => {
            copyBtn.innerHTML = copyLabel();
          }, 2000);
        }).catch(() => {
          copyBtn.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>' + (I18n.t ? I18n.t('ai.copyFailed') : 'Failed');
        });
      };
      copyBtn.addEventListener('click', copyHandler);
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
      header.textContent = msg;
    }
  },

  _abortAll() {
    this._abortControllers.forEach(c => c.abort());
    this._abortControllers = [];
  },

  // ─── SINGLE FULL-CARD REQUEST (translate, wizard) ────

  _sendFullCard(prompt) {
    const $ = (sel) => document.querySelector(sel);
    const { activeCard } = window.AppState;
    const modelSelect = $('#aiModelSelect');
    const input = $('#aiInput');
    if (!modelSelect || !input) { Ui.showToast(I18n.t('toast.selectModel'), 'warning'); return; }
    const modelId = modelSelect.value;
    if (!modelId) { Ui.showToast(I18n.t('toast.selectModel'), 'warning'); return; }

    input.value = '';
    window.AppState.isAiLoading = true;
    this.updateSendButton();

    this.addChatMessage('user', prompt);
    window.AppState.chatHistory.push({ role: 'user', content: prompt });
    CardStorage.saveChatHistory(window.AppState.chatHistory, activeCard?._id);

    const streamingEl = this.createStreamingMessage();

    const systemPrompt = [
      'You are an AI assistant helping edit SillyTavern character cards.',
      'SillyTavern is an AI roleplay frontend. Cards define character personalities.',
      'The user wants you to edit or generate the FULL card as JSON.',
      'Respond with ONLY the updated JSON card. Keep the exact JSON structure.',
    ].join('\n');

    const controller = new AbortController();
    this._abortControllers.push(controller);

    AIService.chatStream(prompt, systemPrompt, modelId,
      (fullText) => {
        streamingEl.querySelector('.ai-message-content').innerHTML = Ui.escapeHtml(fullText)
          .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '<pre>$1</pre>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/\n/g, '<br>');
        const container = document.querySelector('#aiChatMessages');
        container.scrollTop = container.scrollHeight;
      },
      controller.signal
    )
      .then(result => {
        streamingEl.remove();
        this.addChatMessage('assistant', result.content, result.usage);
        window.AppState.chatHistory.push({ role: 'assistant', content: result.content });
        CardStorage.saveChatHistory(window.AppState.chatHistory, activeCard?._id);
        this._updateSession();
        this.tryApplyAIResponse(result.content, 'full');
        Settings.refreshCredits();
      })
      .catch(err => {
        streamingEl.remove();
        if (err && err.name === 'AbortError') {
          this.addChatMessage('system', I18n.t('toast.genStopped'));
        } else {
          this.addChatMessage('system', 'Error: ' + err.message);
          Ui.showToast(I18n.t('toast.aiError', { error: err.message }), 'danger');
        }
      })
      .finally(() => { window.AppState.isAiLoading = false; this.updateSendButton(); });
  },

  // ─── SIDE-BY-SIDE DIFF ──────────────────────────────

  _renderDiff(oldText, newText) {
    const oldEl = document.querySelector('#aiDiffOld');
    const newEl = document.querySelector('#aiDiffNew');
    if (!oldEl || !newEl) return;

    if (typeof Diff === 'undefined') {
      oldEl.textContent = oldText || '(empty)';
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

    oldEl.innerHTML = oldHtml || '<span class="diff-empty">(empty)</span>';
    newEl.innerHTML = newHtml || '<span class="diff-empty">(empty)</span>';
  },

  tryApplyAIResponse(content, targetField) {
    const { activeCard } = window.AppState;
    if (!activeCard || !content) return;

    const showPreview = (oldVal, newVal, applyFn) => {
      const modal = new bootstrap.Modal('#aiPreviewModal');

      this._renderDiff(oldVal || '', newVal);

      const acceptBtn = document.querySelector('#btnAcceptAI');
      const modalEl = document.querySelector('#aiPreviewModal');
      let applied = false;
      const handler = () => { applied = true; applyFn(); modal.hide(); };
      const cleanup = () => { acceptBtn.removeEventListener('click', handler); modalEl.removeEventListener('hidden.bs.modal', cleanup); };
      acceptBtn.addEventListener('click', handler);
      modalEl.addEventListener('hidden.bs.modal', cleanup);
      modal.show();
    };

    if (targetField === 'full') {
      const jsonStr = this._extractJSON(content);
      if (jsonStr) {
        try {
          const parsed = CardEngine.parseJSON(jsonStr, activeCard._filename);
          showPreview(CardEngine.toJSON(activeCard), CardEngine.toJSON(parsed), () => {
            const internal = { _id: activeCard._id, _filename: activeCard._filename, _hasImage: activeCard._hasImage, _imageBase64: activeCard._imageBase64, _thumbnail: activeCard._thumbnail };
            Object.assign(activeCard, parsed);
            Object.assign(activeCard, internal);
            Editor.populateEditor(activeCard);
            Editor.syncEditorToCard();
            Ui.showToast(I18n.t('toast.cardUpdatedAI'), 'success');
          });
        } catch (e) {
          console.error('Failed to parse AI JSON response', e);
          Ui.showToast(I18n.t('toast.jsonParseFailed'), 'warning');
        }
      } else {
        Ui.showToast(I18n.t('toast.jsonInvalid'), 'info');
      }
    } else if (targetField === 'alternate_greetings') {
      // Parse JSON array of greetings
      const greetings = this._extractJSONArray(content);
      if (greetings && greetings.length > 0) {
        const oldVal = JSON.stringify((activeCard.alternate_greetings || []), null, 2);
        const newVal = JSON.stringify(greetings, null, 2);
        showPreview(oldVal, newVal, () => {
          // Replace greetings (not append)
          activeCard.alternate_greetings = greetings;
          Editor.renderGreetings(activeCard);
          Editor.syncEditorToCard();
          Ui.showToast(I18n.t('toast.greetingsUpdated', { count: greetings.length }), 'success');
        });
      } else {
        Ui.showToast(I18n.t('toast.greetingsParseFailed'), 'warning');
      }
    } else if (activeCard[targetField] !== undefined
      || ['description', 'personality', 'first_mes', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes'].includes(targetField)) {
      let clean = content.replace(/```[\s\S]*?```/g, '').replace(/^\[.*?\]\s*/gm, '').trim();
      if (clean) {
        showPreview(activeCard[targetField] || '', clean, () => {
          activeCard[targetField] = clean;
          Editor.populateEditor(activeCard);
          Editor.syncEditorToCard();
          CardManager.renderCardList();
          Ui.showToast(I18n.t('toast.fieldUpdated', { field: targetField }), 'success');
        });
      }
    }
  },

  _extractJSONArray(text) {
    if (!text) return null;
    // Use bracket-depth counting for robust [ ] matching
    const start = text.indexOf('[');
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
      else if (c === '[') depth++;
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
          // Continue scanning for another array
          depth = 0;
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

  handleQuickAction(action) {
    const $ = (sel) => document.querySelector(sel);
    const { activeCard } = window.AppState;
    if (action === 'newcard') {
      Wizard.show();
      return;
    }
    if (!AIService.hasApiKey()) { Ui.showToast(I18n.t('toast.apiKey'), 'warning'); return; }
    if (!activeCard) { Ui.showToast(I18n.t('toast.selectCard'), 'warning'); return; }

    const prompts = {
      translate: null,
      enhance: 'Enhance the character description to be more detailed and vivid. Add sensory details and specific traits.\n\nCurrent:\n' + (activeCard.description || '(empty)'),
      personality: 'Expand the personality to be more nuanced. Add quirks, habits, fears, and motivations.\n\nCurrent:\n' + (activeCard.personality || '(empty)'),
      firstmes: 'Improve the first message to be more engaging and in-character.\n\nCurrent:\n' + (activeCard.first_mes || '(empty)'),
      shorten: 'Shorten and tighten the following text while preserving the core meaning and character voice. Remove redundancies.\n\nCurrent:\n' + (activeCard.description || activeCard.personality || activeCard.first_mes || '(empty)'),
      tone: null,
      grammar: 'Fix all grammar, spelling, and punctuation errors in the following text. Improve clarity without changing the meaning or voice.\n\nCurrent:\n' + (activeCard.description || activeCard.personality || activeCard.first_mes || '(empty)'),
    };

    if (action === 'translate') {
      const lang = window.prompt('Translate to which language?', 'French');
      if (!lang) return;
      prompts.translate = 'Translate this character card to ' + lang + '. Output the COMPLETE card as valid JSON with all fields translated. Keep the exact same JSON structure. Translate ALL text fields.\n\nHere is the card JSON:\n' + CardEngine.toJSON(activeCard);
    }

    if (action === 'tone') {
      const tone = window.prompt('Which tone? (e.g., formal, casual, dark, humorous, poetic)', 'formal');
      if (!tone) return;
      prompts.tone = 'Rewrite the following text with a "' + tone + '" tone while preserving the character\'s core personality and key information.\n\nCurrent:\n' + (activeCard.description || activeCard.personality || activeCard.first_mes || '(empty)');
    }

    const aiPrompt = action === 'translate' ? prompts.translate : prompts[action];
    if (!aiPrompt) return;

    this._selectedFields.clear();
    const fieldMap = {
      translate: null,
      personality: 'personality',
      firstmes: 'first_mes',
      enhance: 'description',
      shorten: 'description',
      tone: 'description',
      grammar: 'description',
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

  addChatMessage(role, content, usage) {
    const $ = (sel) => document.querySelector(sel);
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
    el.innerHTML = formatted + '<div class="text-muted mt-1" style="font-size:0.6rem;">' + time + '</div>' + usageInfo;

    if (role === 'assistant') {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'ai-message-retry';
      retryBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> ' + (I18n.t ? I18n.t('ai.retry') : 'Retry');
      retryBtn.title = I18n.t ? I18n.t('ai.retryTitle') : 'Regenerate this response';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.retryLastMessage();
      });
      el.appendChild(retryBtn);
    }

    container.appendChild(el);
    Anims.staggerFadeIn(el, { duration: 200, from: 10 });
    container.scrollTop = container.scrollHeight;
  },

  retryLastMessage() {
    const { chatHistory } = window.AppState;
    let lastUserIdx = -1;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;

    const lastUserPrompt = chatHistory[lastUserIdx].content;
    chatHistory.splice(lastUserIdx);
    window.AppState.isAiLoading = false;

    const $ = (sel) => document.querySelector(sel);
    const container = $('#aiChatMessages');
    const allMsgs = container.querySelectorAll('.ai-message');
    let removed = 0;
    for (let i = allMsgs.length - 1; i >= 0 && removed < 2; i--) {
      const msg = allMsgs[i];
      if (msg.classList.contains('system')) continue;
      msg.remove();
      removed++;
    }

    CardStorage.saveChatHistory(chatHistory, window.AppState.activeCard?._id);
    this.send(lastUserPrompt);
  },

  createStreamingMessage() {
    const $ = (sel) => document.querySelector(sel);
    const container = $('#aiChatMessages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();
    const el = document.createElement('div');
    el.className = 'ai-message assistant';
    el.innerHTML = '<div class="ai-message-content"></div>';
    container.appendChild(el);
    Anims.staggerFadeIn(el, { duration: 200, from: 10 });
    container.scrollTop = container.scrollHeight;
    return el;
  },

  renderChatHistory() {
    if (this._historyRendered) return;
    const { chatHistory } = window.AppState;
    const $ = (sel) => document.querySelector(sel);
    const container = $('#aiChatMessages');
    if (chatHistory.length === 0) return;
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();
    chatHistory.forEach(msg => this.addChatMessage(msg.role, msg.content));
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
      : 'Chat session';

    const now = Date.now();
    const SESSION_TIMEOUT = 30 * 60 * 1000;

    let currentSession = sessions.length > 0 ? sessions[0] : null;

    if (currentSession && (now - (currentSession.lastUpdated || currentSession.created)) < SESSION_TIMEOUT) {
      currentSession.lastUpdated = now;
      currentSession.preview = preview;
      currentSession.messageCount = chatHistory.length;
      CardStorage.saveChatSession(cardId, currentSession);
    } else {
      const session = {
        id: 'ses_' + now + '_' + Math.random().toString(36).slice(2, 7),
        created: now,
        lastUpdated: now,
        preview: preview,
        messageCount: chatHistory.length,
      };
      CardStorage.saveChatSession(cardId, session);
    }
  },

  _renderHistoryList() {
    const $ = (sel) => document.querySelector(sel);
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
        + '<span class="ai-history-item-count">' + (s.messageCount || '?') + ' msgs</span>'
        + '</div></div>';
    }).join('');

    list.querySelectorAll('.ai-history-item').forEach(item => {
      item.addEventListener('click', () => {
        this._loadSession(item.dataset.sessionId);
      });
    });
  },

  _loadSession(sessionId) {
    const cardId = window.AppState.activeCard?._id || 'global';
    const sessions = CardStorage.getChatSessions(cardId);
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    this._historyRendered = false;
    this.toggleHistory(false);
    this.renderChatHistory();

    this._renderHistoryList();
    const $ = (sel) => document.querySelector(sel);
    const item = $('#aiHistoryList')?.querySelector('[data-session-id="' + sessionId + '"]');
    if (item) item.classList.add('active');
  },

  toggleHistory(forceState) {
    const $ = (sel) => document.querySelector(sel);
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
    this._historyRendered = false;
    this._selectedFields.clear();
    this._renderFieldChips();
    window.AppState.chatHistory = [];
    CardStorage.clearChatHistory(window.AppState.activeCard?._id);
    const $ = (sel) => document.querySelector(sel);
    $('#aiChatMessages').innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>' + I18n.t('ai.welcomeTitle') + '</h6><p>' + I18n.t('ai.welcomeText') + '</p><div class="quick-actions">'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="newcard"><i class="bi bi-magic me-1"></i> ' + I18n.t('ai.actionNewCard') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="translate"><i class="bi bi-translate me-1"></i> ' + I18n.t('ai.actionTranslate') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="enhance"><i class="bi bi-stars me-1"></i> ' + I18n.t('ai.actionEnhance') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="shorten"><i class="bi bi-arrows-angle-contract me-1"></i> ' + I18n.t('ai.actionShorten') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="tone"><i class="bi bi-palette me-1"></i> ' + I18n.t('ai.actionTone') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="grammar"><i class="bi bi-check2-all me-1"></i> ' + I18n.t('ai.actionGrammar') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="personality"><i class="bi bi-emoji-smile me-1"></i> ' + I18n.t('ai.actionPersonality') + '</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="firstmes"><i class="bi bi-chat-dots me-1"></i> ' + I18n.t('ai.actionFirstMes') + '</button>'
      + '</div></div>';
    const self = this;
    $('#aiChatMessages').querySelectorAll('.quick-action').forEach(btn => {
      btn.addEventListener('click', () => self.handleQuickAction(btn.dataset.action));
    });
    Anims.staggerFadeIn($('#aiChatMessages').querySelectorAll('.quick-action'), { stagger: 40, duration: 180 });
    Ui.showToast(I18n.t('toast.chatCleared'), 'info');
  },

  updateSendButton() {
    const $ = (sel) => document.querySelector(sel);
    const btn = $('#btnAiSend');
    const stop = $('#btnAiStop');
    if (!btn) return;
    btn.disabled = window.AppState.isAiLoading;
    btn.innerHTML = window.AppState.isAiLoading ? '<span class="spinner-border spinner-border-sm"></span>' : '<i class="bi bi-send-fill"></i>';
    if (stop) stop.classList.toggle('d-none', !window.AppState.isAiLoading);
  },

  async updateContextBar() {
    const $ = (sel) => document.querySelector(sel);
    const bar = $('#contextBarFill');
    const label = $('#contextBarLabel');
    if (!bar || !label) return;

    const modelSelect = $('#aiModelSelect');
    const input = $('#aiInput');
    if (!modelSelect || !input) return;

    const modelId = modelSelect.value;
    const prompt = input.value || '';
    const { activeCard } = window.AppState;

    if (!modelId) {
      bar.style.width = '0%';
      bar.classList.remove('warn', 'danger');
      label.textContent = I18n.t('ai.selectModel');
      return;
    }

    const ctx = AIService.getContextLength(modelId);
    const inputText = CardEngine.getTextContent(activeCard);

    const inputTokens = await Tokenizer.count(inputText + '\n' + prompt);

    // Get the model's actual max output limit from the model data
    const modelData = (window.AppState.models || []).find(m => m.id === modelId);
    const modelMaxOut = (modelData && modelData.max_output_tokens > 0)
      ? modelData.max_output_tokens
      : AIService.DEFAULT_MAX_TOKENS;

    // Get the API-safe max for this request (accounts for context space)
    const resolvedMax = await AIService.resolveMaxTokens(modelId, [{ role: 'system', content: inputText }, { role: 'user', content: prompt }]);
    // The actual usable output is the smaller of model limit and available context
    const actualMaxOut = Math.min(modelMaxOut, resolvedMax);

    // Show the meaningful ratio: input + expected output vs context
    const total = inputTokens + actualMaxOut;
    const ratio = ctx > 0 ? total / ctx : 0;
    const pct = Math.min(100, Math.round(ratio * 100));

    bar.style.width = pct + '%';
    bar.classList.toggle('warn', ratio >= 0.9 && ratio < 1);
    bar.classList.toggle('danger', ratio >= 1);

    let labelText = this._fmt(inputTokens) + ' in · ' + this._fmt(actualMaxOut) + ' out · ' + this._fmt(ctx) + ' ctx';
    if (ratio >= 1) {
      labelText += ' ⚠ Exceeds limit!';
    } else if (ratio >= 0.9) {
      labelText += ' ⚠ Approaching limit';
    }
    label.textContent = labelText;
  },

  _fmt(n) {
    n = n || 0;
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return '' + n;
  },
};

window.AiChat = AiChat;
