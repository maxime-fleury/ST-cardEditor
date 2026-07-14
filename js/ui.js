/* ============================================================
   ui.js — Main Controller: Utilities, Init, Event Binding
   ============================================================ */

// ─── Shared State ───────────────────────────────────────
window.AppState = { cards: [], activeCard: null, models: [], chatHistory: [], isAiLoading: false };

// ─── Utilities ──────────────────────────────────────────
window.Ui = {
  $(sel) { return document.querySelector(sel); },
  $$(sel) { return document.querySelectorAll(sel); },

  showToast(msg, type) {
    type = type || 'info';
    const icons = { success: 'bi-check-circle-fill text-success', danger: 'bi-exclamation-triangle-fill text-danger', warning: 'bi-exclamation-circle-fill text-warning', info: 'bi-info-circle-fill text-info' };
    const container = document.querySelector('#toastContainer');
    while (container.children.length >= 3) container.firstChild.remove();
    const el = document.createElement('div');
    el.className = 'toast align-items-center border-0';
    el.setAttribute('role', 'alert');
    el.innerHTML = '<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2"><i class="bi ' + (icons[type] || icons.info) + '"></i>' + this.escapeHtml(msg) + '</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>';
    document.querySelector('#toastContainer').appendChild(el);
    const toast = new bootstrap.Toast(el, { delay: 3000 });
    toast.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  },

  downloadFile(filename, content, mimeType) {
    this.downloadBlob(new Blob([content], { type: mimeType }), filename);
  },

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div'); div.textContent = str; return div.innerHTML;
  },

  escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  debounce(fn, delay) {
    let timer;
    return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
  },

  updateUIState() {
    const h = !!window.AppState.activeCard;
    document.querySelector('#btnSaveCard').disabled = !h;
    document.querySelector('#btnExportJson').disabled = !h;
    document.querySelector('#btnExportPng').disabled = !h;
    document.querySelector('#btnDeleteCard').disabled = !h;
  },
};

// ─── Constants ──────────────────────────────────────────
const DEBOUNCE_INPUT_MS = 800;
const DEBOUNCE_SEARCH_MS = 300;

// ─── INIT ───────────────────────────────────────────────
async function init() {
  const $ = Ui.$;

  await CardStorage._checkMigration();
  await CardStorage.migrateCardsToIndexedDB();
  await CardManager.migrateImagesToIndexedDB();

  window.AppState.cards = CardStorage.getCards();
  window.AppState.chatHistory = [];
  const apiKey = CardStorage.getApiKey();
  const defaultModel = CardStorage.getDefaultModel();

  if (apiKey) {
    AIService.setApiKey(apiKey);
    $('#apiKeyInput').value = apiKey;
  }
  if (defaultModel) {
    $('#navModelSelect').value = defaultModel;
    $('#defaultModelSelect').value = defaultModel;
  }

  const maxTokens = CardStorage.getMaxTokens();
  if (maxTokens > 0) $('#maxTokensInput').value = maxTokens;
  $('#injectCopyrightToggle').checked = CardStorage.getInjectCopyright();

  const settingsModal = new bootstrap.Modal('#settingsModal');

  CardManager.renderCardList();
  AiChat.renderChatHistory();

  const activeId = CardStorage.getActiveCardId();
  if (activeId) {
    const card = await CardStorage.getCard(activeId);
    if (card) await CardManager.selectCard(card);
  }

  if (apiKey) Settings.refreshCredits();
  if (apiKey) Settings.refreshModelsList();
  Ui.updateUIState();
  bindEvents(settingsModal);
  window.addEventListener('beforeunload', () => {
    if (window.AppState.activeCard) {
      Editor.syncGreetings(window.AppState.activeCard);
      Editor.syncLorebook(window.AppState.activeCard);
      Editor.syncEditorToCard();
    }
  });
  window.addEventListener('storage', handleStorageChange);
}

// ─── EVENT BINDINGS ────────────────────────────────────

function bindEvents(settingsModal) {
  const $ = Ui.$;
  const $$ = Ui.$$;
  const dropZone = $('#dropZone');

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', (e) => { e.stopPropagation(); dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (files?.length) CardManager.processFiles(files);
  });
  dropZone.addEventListener('click', () => $('#fileInput').click());

  $('#btnBrowse').addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', (e) => CardManager.handleFileSelect(e));

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
      if (files?.length) CardManager.processFiles(files);
    }
  });

  $('#btnNewCard').addEventListener('click', () => CardManager.createNewCard());
  $('#btnNewCardCenter').addEventListener('click', () => CardManager.createNewCard());
  $('#btnSaveCard').addEventListener('click', () => CardManager.saveCurrentCard());
  $('#btnSettings').addEventListener('click', () => settingsModal.show());
  $('#btnToggleApiKey').addEventListener('click', () => Settings.toggleApiKeyVisibility());
  $('#btnSaveSettings').addEventListener('click', () => Settings.saveSettings(settingsModal));
  $('#btnRefreshModels').addEventListener('click', () => Settings.refreshModelsList());
  $('#btnClearStorage').addEventListener('click', () => Settings.confirmClearStorage());
  $('#btnExportSettings').addEventListener('click', () => Settings.exportSettings());
  $('#btnImportSettings').addEventListener('click', () => Settings.importSettings());
  $('#navModelSelect').addEventListener('change', () => Settings.onNavModelChange());
  $('#btnExportJson').addEventListener('click', () => ExportUtils.exportAsJSON());
  $('#btnExportPng').addEventListener('click', () => ExportUtils.exportAsPNG());
  $('#btnDeleteCard').addEventListener('click', () => CardManager.deleteActiveCard());
  $('#btnDuplicateCard').addEventListener('click', () => CardManager.duplicateCard());

  ['editName','editDescription','editPersonality','editScenario','editFirstMes',
   'editMesExample','editCreatorNotes','editSystemPrompt','editPostHistory',
   'editCreator','editVersion','editTags'].forEach(id => {
    const el = $('#' + id);
    if (el) {
      const field = id.replace('edit', '');
      const camelField = field.charAt(0).toLowerCase() + field.slice(1);
      el.addEventListener('focus', () => Editor._snapshot(camelField));
      el.addEventListener('input', Ui.debounce(() => { Editor.syncEditorToCard(); Editor.updateCharCounts(); Editor.autoResizeTextareas(); }, DEBOUNCE_INPUT_MS));
    }
  });

  $('#btnAiSend').addEventListener('click', () => AiChat.send());
  $('#aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); AiChat.send(); }
  });
  $('#btnClearChat').addEventListener('click', () => AiChat.clearChat());

  $$('.quick-action').forEach(btn => {
    btn.addEventListener('click', () => AiChat.handleQuickAction(btn.dataset.action));
  });

  $('#modelSearch').addEventListener('input', Ui.debounce(() => Settings.filterModels(), DEBOUNCE_SEARCH_MS));
  $('#btnAddLoreEntry').addEventListener('click', () => Editor.addLorebookEntry());
  $('#btnAddGreeting').addEventListener('click', () => Editor.addGreeting());

  document.addEventListener('keydown', handleKeyboardShortcuts);

  const toggleAI = $('#btnToggleAI');
  if (toggleAI) {
    toggleAI.addEventListener('click', () => {
      document.querySelector('#panelRight').classList.toggle('mobile-open');
    });
  }

  const themeToggle = $('#btnThemeToggle');
  const savedTheme = localStorage.getItem('stce_theme') || 'dark';
  if (savedTheme === 'light') { document.documentElement.setAttribute('data-theme', 'light'); themeToggle.innerHTML = '<i class="bi bi-sun-fill"></i>'; }
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('stce_theme', next);
      themeToggle.innerHTML = next === 'light' ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-fill"></i>';
    });
  }
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────

function handleKeyboardShortcuts(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault(); Editor.undo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault(); Editor.redo(); return;
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      CardManager.saveCurrentCard();
      return;
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    CardManager.saveCurrentCard();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    CardManager.createNewCard();
  }
  if (e.key === '?' && !e.target.matches('input,textarea,[contenteditable]')) {
    const modal = new bootstrap.Modal('#shortcutsModal');
    modal.show();
  }
}

async function handleStorageChange(e) {
  if (!e.key || !e.key.startsWith(CardStorage.PREFIX)) return;
  window.AppState.cards = CardStorage.getCards();
  CardManager.renderCardList();
  if (window.AppState.activeCard) {
    const updated = await CardStorage.getCard(window.AppState.activeCard._id);
    if (updated) {
      window.AppState.activeCard = updated;
      try {
        const b64 = await CardStorage.getImage(updated._id);
        if (b64) window.AppState.activeCard._imageBase64 = b64;
      } catch (err) {
        console.error('Failed to load image from IndexedDB:', err);
      }
      Editor.populateEditor(window.AppState.activeCard);
    }
  }
}

// ─── BOOT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
