/* ============================================================
   aiChat.js — AI Chat UI, Quick Actions, Message Rendering
   ============================================================ */

const AiChat = {
  send() {
    const $ = (sel) => document.querySelector(sel);
    const input = $('#aiInput');
    const prompt = input.value.trim();
    const { activeCard } = window.AppState;
    if (!prompt || window.AppState.isAiLoading) return;
    if (!AIService.hasApiKey()) { Ui.showToast('Set your OpenRouter API key first', 'warning'); return; }

    const targetField = $('#aiTargetSelect').value;
    const modelId = $('#aiModelSelect').value || $('#navModelSelect').value;
    if (!modelId) {
      Ui.showToast('Please select a model from the navbar or settings first.', 'warning');
      return;
    }

    input.value = '';
    window.AppState.isAiLoading = true;
    this.updateSendButton();

    this.addChatMessage('user', prompt);
    window.AppState.chatHistory.push({ role: 'user', content: prompt });
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

        if (['full','description','personality','first_mes','scenario','mes_example','system_prompt','post_history_instructions','creator_notes'].includes(targetField)) {
          this.tryApplyAIResponse(result.content, targetField);
        }
        Settings.refreshCredits();
      })
      .catch(err => {
        streamingEl.remove();
        if (err && err.name === 'AbortError') {
          this.addChatMessage('system', 'Generation stopped.');
        } else {
          this.addChatMessage('system', 'Error: ' + err.message);
          Ui.showToast('AI Error: ' + err.message, 'danger');
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

  tryApplyAIResponse(content, targetField) {
    const { activeCard } = window.AppState;
    if (!activeCard || !content) return;

    const showPreview = (oldVal, newVal, applyFn) => {
      const modal = new bootstrap.Modal('#aiPreviewModal');
      document.querySelector('.ai-preview-old').textContent = oldVal || '(empty)';
      document.querySelector('.ai-preview-new').textContent = newVal;
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
            Ui.showToast('Card updated from AI response!', 'success');
          });
        } catch (e) {
          console.error('Failed to parse AI JSON response', e);
          Ui.showToast('Could not parse AI response as JSON. Check the chat.', 'warning');
        }
      } else {
        Ui.showToast('AI didn\'t return valid JSON. The response is in the chat — you can copy it manually.', 'info');
      }
    } else if (activeCard[targetField] !== undefined) {
      let clean = content.replace(/```[\s\S]*?```/g, '').replace(/^\[.*?\]\s*/gm, '').trim();
      if (clean) {
        showPreview(activeCard[targetField] || '', clean, () => {
          activeCard[targetField] = clean;
          Editor.populateEditor(activeCard);
          Editor.syncEditorToCard();
          CardManager.renderCardList();
          Ui.showToast('"' + targetField + '" updated!', 'success');
        });
      }
    }
  },

  /**
   * Extract a full JSON object from AI text. Handles ```json fences and finds
   * the outermost balanced-brace span (ignoring braces inside strings), which is
   * far more robust than a greedy regex for messy model output.
   */
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

  handleQuickAction(action) {
    const $ = (sel) => document.querySelector(sel);
    const { activeCard } = window.AppState;
    if (!AIService.hasApiKey()) { Ui.showToast('Set your OpenRouter API key first', 'warning'); return; }
    if (!activeCard) { Ui.showToast('Select a card first', 'warning'); return; }

    const prompts = {
      translate: null,
      enhance: 'Enhance the character description to be more detailed and vivid. Add sensory details and specific traits.\n\nCurrent:\n' + (activeCard.description || '(empty)'),
      personality: 'Expand the personality to be more nuanced. Add quirks, habits, fears, and motivations.\n\nCurrent:\n' + (activeCard.personality || '(empty)'),
      firstmes: 'Improve the first message to be more engaging and in-character.\n\nCurrent:\n' + (activeCard.first_mes || '(empty)'),
    };

    if (action === 'translate') {
      const lang = window.prompt('Translate to which language?', 'French');
      if (!lang) return;
      prompts.translate = 'Translate this character card to ' + lang + '. Output the COMPLETE card as valid JSON with all fields translated. Keep the exact same JSON structure. Translate ALL text fields.\n\nHere is the card JSON:\n' + CardEngine.toJSON(activeCard);
    }

    const aiPrompt = action === 'translate' ? prompts.translate : prompts[action];
    if (!aiPrompt) return;

    if (action === 'translate') $('#aiTargetSelect').value = 'full';
    else if (action === 'personality') $('#aiTargetSelect').value = 'personality';
    else if (action === 'firstmes') $('#aiTargetSelect').value = 'first_mes';
    else if (action === 'enhance') $('#aiTargetSelect').value = 'description';
    else $('#aiTargetSelect').value = 'full';

    $('#aiInput').value = aiPrompt;
    this.send();
  },

  addChatMessage(role, content, usage) {
    const $ = (sel) => document.querySelector(sel);
    const container = $('#aiChatMessages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    let formatted = Ui.escapeHtml(content)
      .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '<pre>$1</pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n/g, '<br>');

    const usageInfo = usage
      ? '<div class="text-muted mt-1" style="font-size:0.65rem;">' + (usage.total_tokens || '?') + ' tokens · $' + (usage.cost || 0).toFixed(5) + '</div>'
      : '';

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const el = document.createElement('div');
    el.className = 'ai-message ' + role;
    el.innerHTML = formatted + '<div class="text-muted mt-1" style="font-size:0.6rem;">' + time + '</div>' + usageInfo;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
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
    container.scrollTop = container.scrollHeight;
    return el;
  },

  renderChatHistory() {
    const { chatHistory } = window.AppState;
    const $ = (sel) => document.querySelector(sel);
    const container = $('#aiChatMessages');
    if (chatHistory.length === 0) return;
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();
    if (container.querySelector('.ai-message')) return;
    chatHistory.forEach(msg => this.addChatMessage(msg.role, msg.content));
  },

  clearChat() {
    window.AppState.chatHistory = [];
    CardStorage.clearChatHistory(window.AppState.activeCard?._id);
    const $ = (sel) => document.querySelector(sel);
    $('#aiChatMessages').innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>AI Card Assistant</h6><p>Ask the AI to edit, translate, or enhance your character card.</p><div class="quick-actions">'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="translate"><i class="bi bi-translate me-1"></i> Translate Card</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="enhance"><i class="bi bi-stars me-1"></i> Enhance Description</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="personality"><i class="bi bi-emoji-smile me-1"></i> Expand Personality</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="firstmes"><i class="bi bi-chat-dots me-1"></i> Improve First Message</button>'
      + '</div></div>';
    const self = this;
    $('#aiChatMessages').querySelectorAll('.quick-action').forEach(btn => {
      btn.addEventListener('click', () => self.handleQuickAction(btn.dataset.action));
    });
    Ui.showToast('Chat cleared', 'info');
  },

  updateSendButton() {
    const $ = (sel) => document.querySelector(sel);
    const btn = $('#btnAiSend');
    const stop = $('#btnAiStop');
    btn.disabled = window.AppState.isAiLoading;
    btn.innerHTML = window.AppState.isAiLoading ? '<span class="spinner-border spinner-border-sm"></span>' : '<i class="bi bi-send-fill"></i>';
    if (stop) stop.classList.toggle('d-none', !window.AppState.isAiLoading);
  },

  /**
   * Update the context-usage bar: estimates input tokens (card target + prompt)
   * plus the capped max output, relative to the model's context length.
   * Uses a real BPE tokenizer when available, with a heuristic fallback.
   */
  async updateContextBar() {
    const $ = (sel) => document.querySelector(sel);
    const bar = $('#contextBarFill');
    const label = $('#contextBarLabel');
    if (!bar || !label) return;

    const modelId = $('#aiModelSelect').value || $('#navModelSelect').value;
    const targetField = $('#aiTargetSelect').value;
    const prompt = $('#aiInput').value || '';
    const { activeCard } = window.AppState;

    if (!modelId) {
      bar.style.width = '0%';
      bar.classList.remove('warn', 'danger');
      label.textContent = 'Select a model';
      return;
    }

    const ctx = AIService.getContextLength(modelId);
    let inputText = '';
    if (targetField === 'full') inputText = CardEngine.getTextContent(activeCard);
    else if (activeCard && activeCard[targetField] !== undefined) inputText = activeCard[targetField] || '';
    if (!inputText && !activeCard) inputText = '(no card selected)';

    const inputTokens = await Tokenizer.count(inputText + '\n' + prompt);
    const maxOut = AIService.resolveMaxTokens(modelId, [{ role: 'system', content: inputText }, { role: 'user', content: prompt }]);
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
