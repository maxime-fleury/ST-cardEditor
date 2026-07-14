/* ============================================================
   ui.js — Main UI Controller
   ============================================================ */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────
  let cards = [];
  let activeCard = null;
  let models = [];
  let chatHistory = [];
  let isAiLoading = false;

  // ─── DOM refs ─────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ─── INIT ─────────────────────────────────────────────
  async function init() {
    cards = Storage.getCards();
    chatHistory = Storage.getChatHistory();
    const apiKey = Storage.getApiKey();
    const defaultModel = Storage.getDefaultModel();

    if (apiKey) {
      AIService.setApiKey(apiKey);
      $('#apiKeyInput').value = apiKey;
    }
    if (defaultModel) {
      $('#navModelSelect').value = defaultModel;
      $('#defaultModelSelect').value = defaultModel;
    }

    const settingsModal = new bootstrap.Modal('#settingsModal');

    // Migrate any large images still stored in localStorage to IndexedDB
    await migrateImagesToIndexedDB();

    renderCardList();
    renderChatHistory();

    const activeId = Storage.getActiveCardId();
    if (activeId) {
      const card = Storage.getCard(activeId);
      if (card) await selectCard(card);
    }

    if (apiKey) refreshCredits();
    if (apiKey) refreshModelsList();
    updateUIState();
    bindEvents(settingsModal);
    window.addEventListener('beforeunload', () => { if (activeCard) syncEditorToCard(); });
    window.addEventListener('storage', handleStorageChange);
  }

  async function migrateImagesToIndexedDB() {
    const all = Storage.getCards();
    for (const meta of all) {
      const full = Storage.getCard(meta._id);
      if (!full || !full._imageBase64) continue;
      try {
        await Storage.saveImage(full._id, full._imageBase64);
        full._thumbnail = full._thumbnail || await CardEngine._createThumbnail(full._imageBase64);
        delete full._imageBase64;
        Storage.upsertCard(full);
      } catch (e) {
        console.error('Image migration failed for', full._id, e);
      }
    }
    cards = Storage.getCards();
  }

  // ─── EVENT BINDINGS ──────────────────────────────────

  function bindEvents(settingsModal) {
    const dropZone = $('#dropZone');

    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', (e) => { e.stopPropagation(); dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      dropZone.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (files?.length) processFiles(files);
    });
    dropZone.addEventListener('click', () => $('#fileInput').click());

    $('#btnBrowse').addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', handleFileSelect);

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dropZone.contains(e.target)) dropZone.classList.add('drag-over');
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || e.relatedTarget === document.documentElement)
        dropZone.classList.remove('drag-over');
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (!dropZone.contains(e.target)) {
        const files = e.dataTransfer?.files;
        if (files?.length) processFiles(files);
      }
    });

    $('#btnNewCard').addEventListener('click', createNewCard);
    $('#btnNewCardCenter').addEventListener('click', createNewCard);
    $('#btnSaveCard').addEventListener('click', saveCurrentCard);
    $('#btnSettings').addEventListener('click', () => settingsModal.show());
    $('#btnToggleApiKey').addEventListener('click', toggleApiKeyVisibility);
    $('#btnSaveSettings').addEventListener('click', () => saveSettings(settingsModal));
    $('#btnRefreshModels').addEventListener('click', refreshModelsList);
    $('#btnClearStorage').addEventListener('click', confirmClearStorage);
    $('#navModelSelect').addEventListener('change', onNavModelChange);
    $('#btnExportJson').addEventListener('click', exportAsJSON);
    $('#btnExportPng').addEventListener('click', exportAsPNG);
    $('#btnDeleteCard').addEventListener('click', deleteActiveCard);

    // Listeners for editor textareas
    ['editName','editDescription','editPersonality','editScenario','editFirstMes',
     'editMesExample','editCreatorNotes','editSystemPrompt','editPostHistory',
     'editCreator','editVersion','editTags'].forEach(id => {
      const el = $('#' + id);
      if (el) el.addEventListener('input', debounce(syncEditorToCard, 800));
    });

    $('#btnAiSend').addEventListener('click', sendAiMessage);
    $('#aiInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMessage(); }
    });
    $('#btnClearChat').addEventListener('click', clearChat);

    $$('.quick-action').forEach(btn => {
      btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
    });

    $('#modelSearch').addEventListener('input', debounce(filterModels, 300));
    $('#btnAddLoreEntry').addEventListener('click', addLorebookEntry);
    $('#btnAddGreeting').addEventListener('click', addGreeting);

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
  }

  // ─── KEYBOARD SHORTCUTS ─────────────────────────────

  function handleKeyboardShortcuts(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      // In an input field, allow Ctrl+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentCard();
        return;
      }
      return; // Don't intercept other shortcuts while typing
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCurrentCard();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      createNewCard();
    }
  }

  async function handleStorageChange(e) {
    if (!e.key || !e.key.startsWith(Storage.PREFIX)) return;
    cards = Storage.getCards();
    renderCardList();
    if (activeCard) {
      const updated = Storage.getCard(activeCard._id);
      if (updated) {
        activeCard = updated;
        try {
          const b64 = await Storage.getImage(updated._id);
          if (b64) activeCard._imageBase64 = b64;
        } catch (err) {
          console.error('Failed to load image from IndexedDB:', err);
        }
        populateEditor(activeCard);
      }
    }
  }

  function handleFileSelect(e) {
    if (e.target.files?.length) processFiles(e.target.files);
    e.target.value = '';
  }

  async function processFiles(fileList) {
    const validExts = ['png', 'json'];
    let loaded = 0, errors = 0;

    for (const file of fileList) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!validExts.includes(ext)) { errors++; continue; }
      try {
        const card = await CardEngine.parseFile(file);
        if (card._imageBase64) {
          await Storage.saveImage(card._id, card._imageBase64);
        }
        Storage.upsertCard(card);
        loaded++;
      } catch (err) {
        console.error('Parse error:', file.name, err);
        errors++;
        showToast('Failed: ' + file.name + ' — ' + err.message, 'danger');
      }
    }

    if (loaded > 0) {
      cards = Storage.getCards();
      renderCardList();
      if (loaded === 1 && cards.length > 0) await selectCard(cards[0]);
      showToast('Loaded ' + loaded + ' card' + (loaded !== 1 ? 's' : ''), 'success');
    }
    if (errors > 0 && loaded === 0)
      showToast('No valid cards found. Drop PNG or JSON files.', 'warning');
  }

  // ─── CARD LIST ───────────────────────────────────────

  function renderCardList() {
    const container = $('#cardList');
    const emptyState = $('#emptyState');
    $('#cardCount').textContent = cards.length + ' card' + (cards.length !== 1 ? 's' : '');

    if (cards.length === 0) { container.innerHTML = ''; emptyState.style.display = 'flex'; return; }
    emptyState.style.display = 'none';

    container.innerHTML = cards.map(card => {
      const isActive = activeCard && activeCard._id === card._id;
      const tags = (card.tags || []).slice(0, 2);
      return '<div class="card-list-item' + (isActive ? ' active' : '') + '" data-card-id="' + card._id + '">'
        + '<div class="card-list-avatar">'
        + (card._thumbnail || card._imageBase64 ? '<img src="' + escapeAttr(card._thumbnail || card._imageBase64) + '" alt="">' : '<i class="bi bi-person-fill"></i>')
        + '</div>'
        + '<div class="card-list-info">'
        + '<div class="card-list-name">' + escapeHtml(card.name || 'Unnamed') + '</div>'
        + '<div class="card-list-meta">'
        + (card.creator ? escapeHtml(card.creator) : '')
        + (card.creator && tags.length ? ' · ' : '')
        + tags.map(t => escapeHtml(t)).join(', ')
        + '</div></div>'
        + (card.spec_version ? '<span class="card-list-badge bg-purple">v' + escapeHtml(card.spec_version) + '</span>' : '')
        + '</div>';
    }).join('');

    container.querySelectorAll('.card-list-item').forEach(item => {
      item.addEventListener('click', () => {
        const card = cards.find(c => c._id === item.dataset.cardId);
        if (card) selectCard(card);
      });
    });
  }

  // ─── CARD SELECTION ──────────────────────────────────

  async function selectCard(cardMeta) {
    if (!cardMeta || !cardMeta._id) return;
    if (activeCard && activeCard._id !== cardMeta._id) syncEditorToCard();
    const fullCard = Storage.getCard(cardMeta._id);
    if (!fullCard) return;
    activeCard = fullCard;
    Storage.setActiveCardId(fullCard._id);

    // Load the full image from IndexedDB if available
    try {
      const b64 = await Storage.getImage(fullCard._id);
      if (b64) activeCard._imageBase64 = b64;
    } catch (e) {
      console.error('Failed to load image from IndexedDB:', e);
    }

    populateEditor(fullCard);
    renderCardList();
    updateUIState();
  }

  function safeStyle(id, displayVal) {
    const el = $(id);
    if (el) el.style.display = displayVal;
  }

  function populateEditor(card) {
    $('#editName').value = card.name || '';
    $('#editDescription').value = card.description || '';
    $('#editPersonality').value = card.personality || '';
    $('#editScenario').value = card.scenario || '';
    $('#editFirstMes').value = card.first_mes || '';
    $('#editMesExample').value = card.mes_example || '';
    $('#editCreatorNotes').value = card.creator_notes || '';
    $('#editSystemPrompt').value = card.system_prompt || '';
    $('#editPostHistory').value = card.post_history_instructions || '';
    $('#editCreator').value = card.creator || '';
    $('#editVersion').value = card.character_version || '';
    $('#editTags').value = (card.tags || []).join(', ');

    // Render greetings list
    renderGreetings(card);

    const metaCreator = $('#metaCreator');
    if (metaCreator) { metaCreator.textContent = card.creator ? 'By ' + card.creator : ''; safeStyle('#metaCreator', card.creator ? '' : 'none'); }
    safeStyle('#metaVersion', card.character_version ? '' : 'none');
    const metaVersion = $('#metaVersion');
    if (metaVersion) { metaVersion.textContent = card.character_version ? 'v' + card.character_version : ''; }
    safeStyle('#metaTags', card.tags?.length ? '' : 'none');
    const metaTags = $('#metaTags');
    if (metaTags) { metaTags.textContent = (card.tags || []).slice(0, 3).join(', '); }

    if (card._imageBase64) {
      const img = $('#charAvatarImg');
      if (img) { img.src = card._imageBase64; img.hidden = false; }
      safeStyle('#avatarPlaceholder', 'none');
    } else {
      safeStyle('#avatarPlaceholder', '');
      const img = $('#charAvatarImg');
      if (img) img.hidden = true;
    }

    renderLorebook(card);
    showEditor();
    updateUIState();
  }

  function syncEditorToCard() {
    if (!activeCard) return;
    activeCard.name = $('#editName').value.trim();
    activeCard.description = $('#editDescription').value;
    activeCard.personality = $('#editPersonality').value;
    activeCard.scenario = $('#editScenario').value;
    activeCard.first_mes = $('#editFirstMes').value;
    activeCard.mes_example = $('#editMesExample').value;
    activeCard.creator_notes = $('#editCreatorNotes').value;
    activeCard.system_prompt = $('#editSystemPrompt').value;
    activeCard.post_history_instructions = $('#editPostHistory').value;
    syncGreetings();
    activeCard.creator = $('#editCreator').value.trim();
    activeCard.character_version = $('#editVersion').value.trim();
    activeCard.tags = $('#editTags').value.split(',').map(s => s.trim()).filter(Boolean);
    Storage.upsertCard(activeCard);
    cards = Storage.getCards();
  }

  function showEditor() {
    $('#noCardSelected').classList.add('d-none');
    $('#editorContainer').classList.remove('d-none');
  }
  function hideEditor() {
    $('#noCardSelected').classList.remove('d-none');
    $('#editorContainer').classList.add('d-none');
  }

  // ─── CARD ACTIONS ────────────────────────────────────

  async function createNewCard() {
    if (activeCard) syncEditorToCard();
    const card = CardEngine.createEmptyCard();
    Storage.upsertCard(card);
    cards = Storage.getCards();
    renderCardList();
    await selectCard(card);
    $('#editName').focus();
    showToast('New blank card created', 'success');
  }

  function saveCurrentCard() {
    if (!activeCard) { showToast('No card to save', 'warning'); return; }
    syncEditorToCard();
    renderCardList();
    showToast('Card saved!', 'success');
  }

  async function deleteActiveCard() {
    if (!activeCard) return;
    if (!confirm('Delete "' + activeCard.name + '"? This cannot be undone.')) return;
    Storage.deleteCard(activeCard._id);
    cards = Storage.getCards();
    activeCard = null;
    hideEditor();
    renderCardList();
    if (cards.length > 0) await selectCard(cards[0]);
    showToast('Card deleted', 'warning');
  }

  function exportAsJSON() {
    if (!activeCard) return;
    syncEditorToCard();
    downloadFile((activeCard.name || 'character') + '.json', CardEngine.toJSON(activeCard), 'application/json');
    showToast('Exported as JSON!', 'success');
  }

  async function exportAsPNG() {
    if (!activeCard) return;
    syncEditorToCard();
    const json = CardEngine.toJSON(activeCard);
    try {
      if (activeCard._imageBase64) {
        const blob = await embedJSONInPNG(activeCard._imageBase64, json);
        if (blob) { downloadBlob(blob, (activeCard.name || 'character') + '.png'); showToast('Exported as PNG with card data!', 'success'); return; }
      }
      const blob = await createMinimalPNG(json);
      downloadBlob(blob, (activeCard.name || 'character') + '.png');
      showToast('Exported as PNG with card data!', 'success');
    } catch (err) {
      console.error('PNG export failed:', err);
      showToast('PNG export failed. Falling back to JSON.', 'warning');
      exportAsJSON();
    }
  }

  // ─── PNG EXPORT HELPERS ──────────────────────────────

  async function embedJSONInPNG(imageBase64, jsonStr) {
    try {
      const bytes = base64DataUrlToBytes(imageBase64);
      if (!bytes) return null;
      return new Blob([embedCharaChunk(bytes, jsonStr)], { type: 'image/png' });
    } catch (err) {
      console.error('Failed to embed PNG chunk:', err);
      return null;
    }
  }

  function base64DataUrlToBytes(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    const base64 = dataUrl.split(',')[1];
    if (!base64) return null;
    const binStr = atob(base64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return bytes;
  }

  async function createMinimalPNG(jsonStr) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 64, 64);
    g.addColorStop(0, '#772ce8'); g.addColorStop(1, '#ec4899');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('ST Card', 32, 36);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Blob([embedCharaChunk(new Uint8Array(reader.result), jsonStr)], { type: 'image/png' }));
        reader.readAsArrayBuffer(blob);
      }, 'image/png');
    });
  }

  function embedCharaChunk(pngBytes, jsonStr) {
    const bytes = new Uint8Array(pngBytes);
    let offset = 8, iendPos = -1;
    while (offset + 12 <= bytes.length) {
      const length = CardEngine._readUint32(bytes, offset);
      const type = String.fromCharCode(bytes[offset+4], bytes[offset+5], bytes[offset+6], bytes[offset+7]);
      if (type === 'IEND') { iendPos = offset; break; }
      offset += 12 + length;
    }
    if (iendPos < 0) return bytes;

    const keyword = 'chara';
    const textData = new TextEncoder().encode(keyword + '\0' + jsonStr);
    const typeBytes = new TextEncoder().encode('tEXt');
    const crcData = new Uint8Array(4 + textData.length);
    crcData.set(typeBytes, 0); crcData.set(textData, 4);
    const crc = crc32(crcData);

    const chunk = new Uint8Array(12 + textData.length);
    new DataView(chunk.buffer).setUint32(0, textData.length, false);
    chunk.set(typeBytes, 4); chunk.set(textData, 8);
    new DataView(chunk.buffer).setUint32(8 + textData.length, crc, false);

    const result = new Uint8Array(bytes.length + chunk.length);
    result.set(bytes.slice(0, iendPos), 0);
    result.set(chunk, iendPos);
    result.set(bytes.slice(iendPos), iendPos + chunk.length);
    return result;
  }

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ─── GREETINGS ──────────────────────────────────────

  function renderGreetings(card) {
    const container = $('#greetingsList');
    const count = $('#greetingCount');
    const greetings = card.alternate_greetings || [];

    count.textContent = greetings.length ? '(' + greetings.length + ')' : '';

    if (!greetings.length) {
      container.innerHTML = '<div class="text-muted" style="font-size:0.8rem;padding:0.5rem 0;">No alternate greetings yet.</div>';
      return;
    }

    container.innerHTML = greetings.map((g, idx) => {
      const isDefault = g === card.first_mes;
      return '<div class="greeting-item' + (isDefault ? ' default-greeting' : '') + '" data-greeting-idx="' + idx + '">'
        + '<div class="greeting-item-actions">'
        + '<button class="btn btn-outline-secondary btn-sm greeting-up" data-idx="' + idx + '" title="Move up"><i class="bi bi-chevron-up"></i></button>'
        + (isDefault
            ? '<span class="greeting-item-badge bg-purple" title="This is the current first message"><i class="bi bi-star-fill"></i></span>'
            : '<button class="btn btn-outline-accent btn-sm greeting-set-default" data-idx="' + idx + '" title="Set as first message"><i class="bi bi-star"></i></button>')
        + '<button class="btn btn-outline-danger btn-sm greeting-delete" data-idx="' + idx + '" title="Remove"><i class="bi bi-x-lg"></i></button>'
        + '</div>'
        + '<textarea class="form-control greeting-textarea" rows="2" placeholder="Greeting ' + (idx + 1) + '..." data-greeting-idx="' + idx + '">' + escapeHtml(g) + '</textarea>'
        + '</div>';
    }).join('');

    // Bind handlers
    container.querySelectorAll('.greeting-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCard.alternate_greetings.splice(parseInt(btn.dataset.idx), 1);
        renderGreetings(activeCard);
        syncEditorToCard();
      });
    });

    container.querySelectorAll('.greeting-set-default').forEach(btn => {
      btn.addEventListener('click', () => {
        const g = activeCard.alternate_greetings[parseInt(btn.dataset.idx)];
        if (g) {
          activeCard.first_mes = g;
          $('#editFirstMes').value = g;
          renderGreetings(activeCard);
          syncEditorToCard();
          showToast('First message updated!', 'success');
        }
      });
    });

    container.querySelectorAll('.greeting-up').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        if (idx > 0) {
          const arr = activeCard.alternate_greetings;
          [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
          renderGreetings(activeCard);
          syncEditorToCard();
        }
      });
    });

    container.querySelectorAll('.greeting-textarea').forEach(ta => {
      ta.addEventListener('input', debounce(() => {
        const idx = parseInt(ta.dataset.greetingIdx);
        if (activeCard.alternate_greetings[idx] !== undefined) {
          activeCard.alternate_greetings[idx] = ta.value;
        }
        syncEditorToCard();
      }, 500));
    });
  }

  function syncGreetings() {
    // Greetings are synced in real-time via the textarea listeners.
    // This ensures the array order and content match what's in the DOM.
    const greetings = [];
    $('#greetingsList').querySelectorAll('.greeting-textarea').forEach(ta => {
      const val = ta.value.trim();
      if (val) greetings.push(val);
    });
    activeCard.alternate_greetings = greetings;
  }

  function addGreeting() {
    if (!activeCard) return;
    if (!activeCard.alternate_greetings) activeCard.alternate_greetings = [];
    activeCard.alternate_greetings.push('');
    renderGreetings(activeCard);
    syncEditorToCard();
    // Focus the new textarea
    const last = $('#greetingsList').querySelector('.greeting-textarea:last-of-type');
    if (last) last.focus();
  }

  function renderLorebook(card) {
    const container = $('#lorebookEntries');
    const empty = $('#lorebookEmpty');
    const entries = card.character_book?.entries || [];
    if (entries.length === 0) { container.innerHTML = ''; empty.style.display = ''; return; }
    empty.style.display = 'none';
    container.innerHTML = entries.map((entry, idx) =>
      '<div class="lorebook-entry" data-entry-idx="' + idx + '">'
      + '<div class="lorebook-entry-header">'
      + '<input type="text" class="form-control lorebook-entry-key" value="' + escapeAttr(entry.key || '') + '" placeholder="Trigger keyword(s)" data-lore-key-idx="' + idx + '">'
      + '<button class="btn btn-outline-danger btn-sm lorebook-delete-btn" data-idx="' + idx + '"><i class="bi bi-trash"></i></button>'
      + '</div>'
      + '<textarea class="form-control editor-textarea font-mono" rows="3" placeholder="Entry content..." data-lore-idx="' + idx + '">' + escapeHtml(entry.content || '') + '</textarea>'
      + '</div>'
    ).join('');

    container.querySelectorAll('.lorebook-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCard.character_book.entries.splice(parseInt(btn.dataset.idx), 1);
        renderLorebook(activeCard); syncEditorToCard();
      });
    });
    container.querySelectorAll('textarea[data-lore-idx]').forEach(ta => {
      ta.addEventListener('input', debounce(() => {
        const idx = parseInt(ta.dataset.loreIdx);
        if (activeCard.character_book.entries[idx]) {
          activeCard.character_book.entries[idx].content = ta.value;
          syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-key-idx]').forEach(input => {
      input.addEventListener('input', debounce(() => {
        const idx = parseInt(input.dataset.loreKeyIdx);
        if (activeCard.character_book.entries[idx]) {
          activeCard.character_book.entries[idx].key = input.value.trim();
          syncEditorToCard();
        }
      }, 600));
    });
  }

  function addLorebookEntry() {
    if (!activeCard) return;
    if (!activeCard.character_book) activeCard.character_book = { entries: [] };
    if (!activeCard.character_book.entries) activeCard.character_book.entries = [];
    activeCard.character_book.entries.push({ key: 'New Entry', content: '' });
    renderLorebook(activeCard); syncEditorToCard();
  }

  // ─── AI ASSISTANT ────────────────────────────────────

  function sendAiMessage() {
    const input = $('#aiInput');
    const prompt = input.value.trim();
    if (!prompt || isAiLoading) return;
    if (!AIService.hasApiKey()) { showToast('Set your OpenRouter API key first', 'warning'); return; }

    input.value = '';
    isAiLoading = true;
    updateAiSendButton();

    addChatMessage('user', prompt);
    chatHistory.push({ role: 'user', content: prompt });
    Storage.saveChatHistory(chatHistory);

    const targetField = $('#aiTargetSelect').value;
    const modelId = $('#aiModelSelect').value || $('#navModelSelect').value;
    if (!modelId) {
      showToast('Please select a model from the navbar or settings first.', 'warning');
      isAiLoading = false;
      updateAiSendButton();
      return;
    }
    const typingEl = showTypingIndicator();

    AIService.chat(prompt, buildSystemPrompt(targetField), modelId)
      .then(result => {
        typingEl.remove();
        addChatMessage('assistant', result.content, result.usage);
        chatHistory.push({ role: 'assistant', content: result.content });
        Storage.saveChatHistory(chatHistory);

        if (targetField === 'full' || targetField === 'description' || targetField === 'personality'
            || targetField === 'first_mes' || targetField === 'scenario' || targetField === 'mes_example'
            || targetField === 'system_prompt') {
          tryApplyAIResponse(result.content, targetField);
        }
        refreshCredits();
      })
      .catch(err => {
        typingEl.remove();
        addChatMessage('system', 'Error: ' + err.message);
        showToast('AI Error: ' + err.message, 'danger');
      })
      .finally(() => { isAiLoading = false; updateAiSendButton(); });
  }

  function buildSystemPrompt(targetField) {
    let parts = [
      'You are an AI assistant helping edit SillyTavern character cards.',
      'SillyTavern is an AI roleplay frontend. Cards define character personalities.',
    ];

    if (targetField === 'full') {
      parts.push('The user will ask you to modify the entire card. Here is the current card content:');
      parts.push('```json');
      parts.push(CardEngine.toJSON(activeCard || CardEngine.createEmptyCard()));
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
  }

  function tryApplyAIResponse(content, targetField) {
    if (!activeCard || !content) return;
    if (targetField === 'full') {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        try {
          const parsed = CardEngine.parseJSON(jsonMatch[1].trim(), activeCard._filename);
          const internal = { _id: activeCard._id, _filename: activeCard._filename, _hasImage: activeCard._hasImage, _imageBase64: activeCard._imageBase64, _thumbnail: activeCard._thumbnail };
          Object.assign(activeCard, parsed);
          Object.assign(activeCard, internal);
          populateEditor(activeCard); syncEditorToCard();
          showToast('Card updated from AI response!', 'success');
        } catch (e) {
          console.error('Failed to parse AI JSON response', e);
          showToast('Could not parse AI response as JSON. Check the chat.', 'warning');
        }
      } else {
        showToast('AI didn\'t return valid JSON. The response is in the chat — you can copy it manually.', 'info');
      }
    } else if (activeCard[targetField] !== undefined) {
      let clean = content.replace(/```[\s\S]*?```/g, '').replace(/^\[.*?\]\s*/gm, '').trim();
      if (clean) {
        activeCard[targetField] = clean;
        populateEditor(activeCard); syncEditorToCard(); renderCardList();
        showToast('"' + targetField + '" updated!', 'success');
      }
    }
  }

  function handleQuickAction(action) {
    if (!AIService.hasApiKey()) { showToast('Set your OpenRouter API key first', 'warning'); return; }
    if (!activeCard) { showToast('Select a card first', 'warning'); return; }

    const prompts = {
      translate: 'Translate this character card to French. Output the COMPLETE card as valid JSON with all fields translated. Keep the exact same JSON structure. Translate ALL text fields.\n\nHere is the card JSON:\n' + CardEngine.toJSON(activeCard),
      enhance: 'Enhance the character description to be more detailed and vivid. Add sensory details and specific traits.\n\nCurrent:\n' + (activeCard.description || '(empty)'),
      personality: 'Expand the personality to be more nuanced. Add quirks, habits, fears, and motivations.\n\nCurrent:\n' + (activeCard.personality || '(empty)'),
      firstmes: 'Improve the first message to be more engaging and in-character.\n\nCurrent:\n' + (activeCard.first_mes || '(empty)'),
    };

    const prompt = prompts[action];
    if (!prompt) return;

    if (action === 'translate') $('#aiTargetSelect').value = 'full';
    else if (action === 'personality') $('#aiTargetSelect').value = 'personality';
    else if (action === 'firstmes') $('#aiTargetSelect').value = 'first_mes';
    else if (action === 'enhance') $('#aiTargetSelect').value = 'description';
    else $('#aiTargetSelect').value = 'full';

    $('#aiInput').value = prompt;
    sendAiMessage();
  }

  function addChatMessage(role, content, usage) {
    const container = $('#aiChatMessages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    // Escape HTML first, then convert markdown-like code fences/blocks to markup.
    // This order is intentional and security-critical: never swap it.
    let formatted = escapeHtml(content)
      .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '<pre>$1</pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');

    const usageInfo = usage
      ? '<div class="text-muted mt-1" style="font-size:0.65rem;">' + (usage.total_tokens || '?') + ' tokens · $' + (usage.cost || 0).toFixed(5) + '</div>'
      : '';

    const el = document.createElement('div');
    el.className = 'ai-message ' + role;
    el.innerHTML = formatted + usageInfo;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function showTypingIndicator() {
    const container = $('#aiChatMessages');
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function renderChatHistory() {
    const container = $('#aiChatMessages');
    if (chatHistory.length === 0) return;
    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();
    if (container.querySelector('.ai-message')) return;
    chatHistory.forEach(msg => addChatMessage(msg.role, msg.content));
  }

  function clearChat() {
    chatHistory = [];
    Storage.clearChatHistory();
    $('#aiChatMessages').innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>AI Card Assistant</h6><p>Ask the AI to edit, translate, or enhance your character card.</p><div class="quick-actions">'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="translate"><i class="bi bi-translate me-1"></i> Translate to French</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="enhance"><i class="bi bi-stars me-1"></i> Enhance Description</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="personality"><i class="bi bi-emoji-smile me-1"></i> Expand Personality</button>'
      + '<button class="btn btn-outline-accent btn-sm quick-action" data-action="firstmes"><i class="bi bi-chat-dots me-1"></i> Improve First Message</button>'
      + '</div></div>';
    $('#aiChatMessages').querySelectorAll('.quick-action').forEach(btn => {
      btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
    });
    showToast('Chat cleared', 'info');
  }

  function updateAiSendButton() {
    const btn = $('#btnAiSend');
    btn.disabled = isAiLoading;
    btn.innerHTML = isAiLoading ? '<span class="spinner-border spinner-border-sm"></span>' : '<i class="bi bi-send-fill"></i>';
  }

  // ─── SETTINGS ────────────────────────────────────────

  function saveSettings(modal) {
    const apiKey = $('#apiKeyInput').value.trim();
    const defaultModel = $('#defaultModelSelect').value;
    if (apiKey) { Storage.setApiKey(apiKey); AIService.setApiKey(apiKey); }
    Storage.setDefaultModel(defaultModel);
    $('#navModelSelect').value = defaultModel;
    modal.hide();
    showToast('Settings saved!', 'success');
    if (apiKey) { refreshCredits(); refreshModelsList(); }
  }

  function toggleApiKeyVisibility() {
    const input = $('#apiKeyInput');
    const icon = $('#btnToggleApiKey i');
    if (input.type === 'password') { input.type = 'text'; icon.className = 'bi bi-eye-slash-fill'; }
    else { input.type = 'password'; icon.className = 'bi bi-eye-fill'; }
  }

  async function refreshCredits() {
    if (!AIService.hasApiKey()) { updateStorageUsage(); return; }
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
    updateStorageUsage();
  }

  async function refreshModelsList() {
    if (!AIService.hasApiKey()) return;
    try {
      models = await AIService.fetchModels();
      populateModelSelects();
      renderModelList();
    } catch (err) {
      console.error('Failed to fetch models:', err);
      showToast('Failed to load models: ' + err.message, 'danger');
    }
  }

  function populateModelSelects() {
    const d = Storage.getDefaultModel();
    const h = models.map(m => '<option value="' + escapeHtml(m.id) + '"' + (m.id === d ? ' selected' : '') + '>' + escapeHtml(m.name) + (m.is_free ? ' [FREE]' : '') + '</option>').join('');
    $('#navModelSelect').innerHTML = '<option value="">Auto</option>' + h;
    $('#defaultModelSelect').innerHTML = '<option value="">Auto</option>' + h;
    $('#aiModelSelect').innerHTML = '<option value="">Auto (use nav model)</option>' + h;
  }

  function renderModelList(filter) {
    filter = (filter || '').toLowerCase();
    const container = $('#modelList');
    const filtered = models.filter(m => !filter || m.name.toLowerCase().includes(filter) || m.id.toLowerCase().includes(filter) || m.provider.toLowerCase().includes(filter));
    if (!filtered.length) { container.innerHTML = '<div class="text-center text-muted py-4">No models found</div>'; return; }
    const d = Storage.getDefaultModel();
    container.innerHTML = filtered.slice(0, 100).map(m =>
      '<div class="model-item' + (m.id === d ? ' selected' : '') + '" data-model-id="' + escapeHtml(m.id) + '">'
      + '<div class="model-item-info"><div class="model-item-name">' + escapeHtml(m.name) + '</div>'
      + '<div class="model-item-provider">' + escapeHtml(m.provider) + ' · ' + (m.context_length ? Math.floor(m.context_length/1000) + 'k ctx' : '?')
      + (m.is_free ? ' · <span class="text-success">FREE</span>' : '') + '</div></div>'
      + '<div class="model-item-pricing">' + (m.is_free ? '<span class="price-highlight">FREE</span>'
        : '<div>in: ' + AIService.formatPrice(m.pricing.prompt) + '</div><div>out: ' + AIService.formatPrice(m.pricing.completion) + '</div>') + '</div></div>'
    ).join('');
    container.querySelectorAll('.model-item').forEach(item => {
      item.addEventListener('click', () => {
        $('#defaultModelSelect').value = item.dataset.modelId;
        $('#navModelSelect').value = item.dataset.modelId;
        Storage.setDefaultModel(item.dataset.modelId);
        renderModelList(filter);
        showToast('Model set: ' + item.dataset.modelId, 'info');
      });
    });
  }

  function filterModels() { renderModelList($('#modelSearch').value); }
  function onNavModelChange() { Storage.setDefaultModel($('#navModelSelect').value); }

  function updateStorageUsage() {
    const bytes = Storage.getUsageEstimate();
    const kb = (bytes / 1024).toFixed(1);
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    $('#storageUsage').textContent = parseFloat(kb) > 1000 ? mb + ' MB' : kb + ' KB';
  }

  function confirmClearStorage() {
    if (!confirm('Delete ALL cards, settings, and chat history? This cannot be undone.')) return;
    Storage.clearAll();
    cards = []; activeCard = null; chatHistory = []; models = [];
    AIService.setApiKey('');
    $('#apiKeyInput').value = '';
    $('#navModelSelect').innerHTML = '<option value="">Select model...</option>';
    $('#defaultModelSelect').innerHTML = '<option value="">Browse models below...</option>';
    hideEditor(); renderCardList(); renderModelList();
    $('#creditsBadge').classList.add('d-none');
    $('#aiChatMessages').innerHTML = '<div class="ai-welcome"><div class="ai-welcome-icon"><i class="bi bi-magic"></i></div><h6>AI Card Assistant</h6><p>Ask the AI to edit, translate, or enhance your character card.</p></div>';
    showToast('All data cleared', 'warning');
  }

  // ─── UI STATE ────────────────────────────────────────

  function updateUIState() {
    const h = !!activeCard;
    $('#btnSaveCard').disabled = !h;
    $('#btnExportJson').disabled = !h;
    $('#btnExportPng').disabled = !h;
    $('#btnDeleteCard').disabled = !h;
  }

  // ─── UTILITIES ───────────────────────────────────────

  function showToast(msg, type) {
    type = type || 'info';
    const icons = { success: 'bi-check-circle-fill text-success', danger: 'bi-exclamation-triangle-fill text-danger', warning: 'bi-exclamation-circle-fill text-warning', info: 'bi-info-circle-fill text-info' };
    const el = document.createElement('div');
    el.className = 'toast align-items-center border-0';
    el.setAttribute('role', 'alert');
    el.innerHTML = '<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2"><i class="bi ' + (icons[type] || icons.info) + '"></i>' + escapeHtml(msg) + '</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>';
    $('#toastContainer').appendChild(el);
    const toast = new bootstrap.Toast(el, { delay: 3000 });
    toast.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  }

  function downloadFile(filename, content, mimeType) { downloadBlob(new Blob([content], { type: mimeType }), filename); }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div'); div.textContent = str; return div.innerHTML;
  }
  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function debounce(fn, delay) {
    let timer;
    return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
  }

  // ─── BOOT ────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
