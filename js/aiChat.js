/* ============================================================
   aiChat.js — AI Chat UI, Quick Actions, Message Rendering
   ============================================================ */

const AiChat = {
  send(retryPrompt) {
    const $ = (sel) => document.querySelector(sel);
    const input = $('#aiInput');
    const prompt = retryPrompt || input.value.trim();
    const { activeCard } = window.AppState;
    if (!prompt || window.AppState.isAiLoading) return;

    // Close history panel if open
    const histPanel = $('#aiHistoryPanel');
    if (histPanel && histPanel.classList.contains('open')) {
      this.toggleHistory(false);
    }
    if (!AIService.hasApiKey()) { Ui.showToast(I18n.t('toast.apiKey'), 'warning'); return; }

    const targetField = $('#aiTargetSelect').value;
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

    const streamingEl = this.createStreamingMessage();
    this._abortController = new AbortController();

    AIService.chatStream(prompt, this.buildSystemPrompt(targetField), modelId, (fullText) => {
      streamingEl.querySelector('.ai-message-content').innerHTML = Ui.escapeHtml(fullText)
        .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '<pre>$1</pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br>');
      const container = document.querySelector('#aiChatMessages');
      container.scrollTop = container.scrollHeight;
    }, this._abortController.signal)
      .then(result => {
        streamingEl.remove();
        this.addChatMessage('assistant', result.content, result.usage);
        window.AppState.chatHistory.push({ role: 'assistant', content: result.content });
        CardStorage.saveChatHistory(window.AppState.chatHistory, window.AppState.activeCard?._id);
        this._updateSession();

        if (['full','description','personality','first_mes','scenario','mes_example','system_prompt','post_history_instructions','creator_notes'].includes(targetField)) {
          this.tryApplyAIResponse(result.content, targetField);
        }
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

  buildSystemPrompt(targetField) {
    const { activeCard } = window.AppState;
    let parts = [
      'You are an AI assistant helping edit SillyTavern character cards.',
      'SillyTavern is an AI roleplay frontend. Cards define character personalities.',
    ];

    if (targetField === 'full') {
      parts.push('The user will ask you to modify the entire card. Here is the current card content:');
      parts.push('```json');
      const cardForPrompt = activeCard ? { ...activeCard } : CardEngine.createEmptyCard();
      delete cardForPrompt._id; delete cardForPrompt._filename; delete cardForPrompt._hasImage;
      delete cardForPrompt._imageBase64; delete cardForPrompt._thumbnail;
      parts.push(CardEngine.toJSON(cardForPrompt));
      parts.push('```');
      parts.push('When the user asks for changes, respond with the FULL updated JSON card. Keep all the structure intact.');
    } else if (activeCard) {
      parts.push('The user wants you to edit the card\'s "' + targetField + '" field.');
      parts.push('Here is the current content:');
      parts.push('[' + targetField + ']');
      parts.push(activeCard[targetField] || '(empty)');
      parts.push('');
      parts.push('Respond with ONLY the new content for this field. Do not include explanations or JSON wrapping unless asked.');
    } else {
      parts.push('No card is currently selected. Help the user with their request about character cards.');
    }
    return parts.join('\n');
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

      // Render side-by-side diff
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

  // ─── QUICK ACTIONS (Expanded) ───────────────────────
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

    if (action === 'translate') $('#aiTargetSelect').value = 'full';
    else if (action === 'personality') $('#aiTargetSelect').value = 'personality';
    else if (action === 'firstmes') $('#aiTargetSelect').value = 'first_mes';
    else if (action === 'enhance') $('#aiTargetSelect').value = 'description';
    else if (action === 'shorten') $('#aiTargetSelect').value = 'description';
    else if (action === 'tone') $('#aiTargetSelect').value = 'description';
    else if (action === 'grammar') $('#aiTargetSelect').value = 'description';
    else $('#aiTargetSelect').value = 'full';

    $('#aiInput').value = aiPrompt;
    this.send();
  },

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

    // Add retry button on assistant messages
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
    // Find the last user message (skip system messages)
    let lastUserIdx = -1;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;

    const lastUserPrompt = chatHistory[lastUserIdx].content;
    // Remove the last user message and any messages after it
    chatHistory.splice(lastUserIdx);
    window.AppState.isAiLoading = false;

    // Remove the last user+assistant pair from the DOM
    const $ = (sel) => document.querySelector(sel);
    const container = $('#aiChatMessages');
    const allMsgs = container.querySelectorAll('.ai-message');
    // Walk backwards through the DOM messages (only user/assistant, skip system)
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

  // ─── Chat Sessions ───────────────────────────────────

  _updateSession() {
    const { chatHistory, activeCard } = window.AppState;
    if (!chatHistory || chatHistory.length < 2) return; // at least one exchange
    const cardId = activeCard?._id || 'global';
    const sessions = CardStorage.getChatSessions(cardId);

    // Find the first user message for the preview
    const firstUser = chatHistory.find(m => m.role === 'user');
    const preview = firstUser
      ? (firstUser.content.length > 80 ? firstUser.content.slice(0, 80) + '...' : firstUser.content)
      : 'Chat session';

    const now = Date.now();
    const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

    // Check if we should update the last session or create a new one
    let currentSession = sessions.length > 0 ? sessions[0] : null;

    if (currentSession && (now - (currentSession.lastUpdated || currentSession.created)) < SESSION_TIMEOUT) {
      // Update existing session
      currentSession.lastUpdated = now;
      currentSession.preview = preview;
      currentSession.messageCount = chatHistory.length;
      CardStorage.saveChatSession(cardId, currentSession);
    } else {
      // Create a new session
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

    // Load the chat history and scroll to the session point
    // Since we store flat history, we'll just show the full history
    this._historyRendered = false;
    this.toggleHistory(false);
    this.renderChatHistory();

    // Highlight the active session
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
    btn.disabled = window.AppState.isAiLoading;
    btn.innerHTML = window.AppState.isAiLoading ? '<span class="spinner-border spinner-border-sm"></span>' : '<i class="bi bi-send-fill"></i>';
    if (stop) stop.classList.toggle('d-none', !window.AppState.isAiLoading);
  },

  async updateContextBar() {
    const $ = (sel) => document.querySelector(sel);
    const bar = $('#contextBarFill');
    const label = $('#contextBarLabel');
    if (!bar || !label) return;

    const modelId = $('#aiModelSelect').value;
    const targetField = $('#aiTargetSelect').value;
    const prompt = $('#aiInput').value || '';
    const { activeCard } = window.AppState;

    if (!modelId) {
      bar.style.width = '0%';
      bar.classList.remove('warn', 'danger');
      label.textContent = I18n.t('ai.selectModel');
      return;
    }

    const ctx = AIService.getContextLength(modelId);
    let inputText = '';
    if (targetField === 'full') inputText = CardEngine.getTextContent(activeCard);
    else if (activeCard && activeCard[targetField] !== undefined) inputText = activeCard[targetField] || '';
    if (!inputText && !activeCard) inputText = '(no card selected)';

    const inputTokens = await Tokenizer.count(inputText + '\n' + prompt);
    const maxOut = await AIService.resolveMaxTokens(modelId, [{ role: 'system', content: inputText }, { role: 'user', content: prompt }]);
    const total = inputTokens + maxOut;
    const ratio = ctx > 0 ? total / ctx : 0;
    const pct = Math.min(100, Math.round(ratio * 100));

    bar.style.width = pct + '%';
    bar.classList.toggle('warn', ratio >= 0.9 && ratio < 1);
    bar.classList.toggle('danger', ratio >= 1);
    label.textContent = this._fmt(inputTokens) + ' in · ' + this._fmt(maxOut) + ' out · ' + this._fmt(ctx) + ' ctx';
  },

  _fmt(n) {
    n = n || 0;
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return '' + n;
  },
};

window.AiChat = AiChat;
