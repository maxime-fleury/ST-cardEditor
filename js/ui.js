/* ============================================================
   ui.js — Main Controller: Utilities, Init, Event Binding
   ============================================================ */

// ─── Shared State ───────────────────────────────────────
window.AppState = { cards: [], activeCard: null, models: [], chatHistory: [], isAiLoading: false, _dirty: false };

// ─── Utilities ──────────────────────────────────────────
window.Ui = {
  $(sel) { return document.querySelector(sel); },
  $$(sel) { return document.querySelectorAll(sel); },

  showToast(msg, type) {
    type = type || 'info';
    const icons = { success: 'bi-check-circle-fill text-success', danger: 'bi-exclamation-triangle-fill text-danger', warning: 'bi-exclamation-circle-fill text-warning', info: 'bi-info-circle-fill text-info' };
    const container = document.querySelector('#toastContainer');
    if (!container) return;
    while (container.children.length >= 3) container.firstChild.remove();
    const el = document.createElement('div');
    el.className = 'toast align-items-center border-0';
    el.setAttribute('role', 'alert');
    const DURATION = 10000;
    const initialSecs = Math.ceil(DURATION / 1000);
    const toastLabel = (I18n && I18n.t) ? I18n.t('gen.toastAutoHide', { s: initialSecs }) : 'Auto-hides in ' + initialSecs + 's';
    el.innerHTML = '<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2 w-100"><div class="flex-grow-1 d-flex align-items-center gap-2"><i class="bi ' + (icons[type] || icons.info) + '"></i>' + this.escapeHtml(msg) + '</div><div class="toast-timer" style="font-size:0.62rem;white-space:nowrap;font-family:var(--font-mono);min-width:3.2em;text-align:right;">' + toastLabel + '</div><button type="button" class="btn-close btn-close-white ms-2" data-bs-dismiss="toast"></button></div></div>';
    document.querySelector('#toastContainer').appendChild(el);
    const toast = new bootstrap.Toast(el, { delay: DURATION });
    toast.show();
    // Live countdown timer
    const timerEl = el.querySelector('.toast-timer');
    if (timerEl) {
      const interval = 200;
      let remaining = DURATION;
      const tick = () => {
        remaining -= interval;
        if (remaining <= 0) { timerEl.textContent = ''; return; }
        const secs = Math.ceil(remaining / 1000);
        timerEl.textContent = (I18n && I18n.t)
          ? I18n.t('gen.toastAutoHide', { s: secs })
          : 'Auto-hides in ' + secs + 's';
      };
      const timer = setInterval(tick, interval);
      el.addEventListener('hidden.bs.toast', () => {
        clearInterval(timer);
        el.remove();
      });
    } else {
      el.addEventListener('hidden.bs.toast', () => el.remove());
    }
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
    this.setDirty(window.AppState._dirty);
  },

  setDirty(dirty) {
    window.AppState._dirty = dirty;
    const btn = document.querySelector('#btnSaveCard');
    if (!btn) return;
    btn.classList.toggle('is-dirty', !!dirty);
    let dot = btn.querySelector('.dirty-dot');
    if (dirty && !dot) {
      dot = document.createElement('span');
      dot.className = 'dirty-dot';
      btn.appendChild(dot);
    } else if (!dirty && dot) {
      dot.remove();
    }
  },

  // ─── Markdown Renderer (lazy-loads marked + DOMPurify) ───
  _markdownReady: false,
  _markdownLoading: null,

  _ensureMarkdownLibs() {
    if (this._markdownReady) return;
    if (this._markdownLoading) return;
    this._markdownLoading = true;
    let pending = 2;
    const checkReady = () => { pending--; if (pending <= 0) { this._markdownReady = true; this._markdownLoading = null; } };
    if (typeof marked === 'undefined') {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
      s.onload = checkReady;
      s.onerror = checkReady;
      document.head.appendChild(s);
    } else {
      checkReady();
    }
    if (typeof DOMPurify === 'undefined') {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js';
      s.onload = checkReady;
      s.onerror = checkReady;
      document.head.appendChild(s);
    } else {
      checkReady();
    }
  },

  renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      this._ensureMarkdownLibs();
      // Fall back to escaped text while libraries load
      return this.escapeHtml(text).replace(/\n/g, '<br>');
    }

    // Configure marked
    if (marked.setOptions) {
      marked.setOptions({ breaks: true, gfm: true });
    }

    let html = typeof marked.parse === 'function' ? marked.parse(text) : marked(text);

    // Sanitize first, then add our own controlled dialogue highlights.
    html = DOMPurify.sanitize(html, { ADD_TAGS: ['span', 'strong', 'em'] });

    // Color dialogue lines: {{char}}: and {{user}}:
    html = html.replace(/({{char}})\s*:/g,
      '<span class="dlg-char-name">$1</span><span class="dlg-char">:</span>');
    html = html.replace(/({{user}})\s*:/g,
      '<span class="dlg-user-name">$1</span><span class="dlg-user">:</span>');

    return html;
  },

  // ─── Format File Size ──────────────────────────────────
  formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  },

  // ─── Saved Indicator ──────────────────────────────────
  _savedTimer: null,
  flashSaved() {
    const btn = document.querySelector('#btnSaveCard');
    if (!btn) return;
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<i class="bi bi-check2-all me-1"></i> Saved';
    btn.classList.add('btn-saved-flash');
    if (this._savedTimer) clearTimeout(this._savedTimer);
    this._savedTimer = setTimeout(() => {
      btn.innerHTML = origHTML;
      btn.classList.remove('btn-saved-flash');
      this._savedTimer = null;
    }, 1500);
  },
};

// ─── Constants ──────────────────────────────────────────
const DEBOUNCE_INPUT_MS = 800;
const DEBOUNCE_SEARCH_MS = 300;

// ─── FLOATING LABELS ──────────────────────────────────────
function initFloatingLabels() {
  function syncFloatLabels() {
    document.querySelectorAll('.floating-label').forEach(group => {
      const label = group.querySelector('label');
      const input = group.querySelector('input, textarea');
      if (!label || !input) return;
      const hasVal = input.value && input.value.trim().length > 0;
      label.classList.toggle('floated', hasVal || document.activeElement === input);
    });
  }
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('.floating-label input, .floating-label textarea')) {
      const label = e.target.closest('.floating-label')?.querySelector('label');
      if (label) label.classList.add('floated');
    }
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.matches('.floating-label input, .floating-label textarea')) {
      const label = e.target.closest('.floating-label')?.querySelector('label');
      if (label && !(e.target.value && e.target.value.trim().length > 0)) {
        label.classList.remove('floated');
      }
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.matches('.floating-label input, .floating-label textarea')) {
      const label = e.target.closest('.floating-label')?.querySelector('label');
      if (label) {
        const hasVal = e.target.value && e.target.value.trim().length > 0;
        label.classList.toggle('floated', hasVal || document.activeElement === e.target);
      }
    }
  });
  window.syncFloatingLabels = syncFloatLabels;
  syncFloatLabels();
}

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
    $('#aiModelSelect').value = defaultModel;
    $('#defaultModelSelect').value = defaultModel;
  }

  // Restore provider
  const provider = CardStorage.getProvider();
  if (provider && provider !== 'openrouter') {
    const customUrl = CardStorage.getCustomApiUrl();
    const customKey = CardStorage.getCustomApiKey();
    AIService.setProvider(provider, customKey);
    if (provider === 'custom') {
      const customModel = CardStorage.getCustomModelId();
      if (customModel) {
        CardStorage.setDefaultModel(customModel);
        $('#aiModelSelect').value = customModel;
      }
    }
  }

  const maxTokens = CardStorage.getMaxTokens();
  if (maxTokens > 0) $('#maxTokensInput').value = maxTokens;
  $('#injectCopyrightToggle').checked = CardStorage.getInjectCopyright();

  // ─── I18n ────────────────────────────────────────────
  I18n.init();

  const settingsModal = new bootstrap.Modal('#settingsModal');

  // Focus-trap all modals for keyboard accessibility
  setupModalFocusTraps();

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
  AiChat.updateContextBar();
  Wizard.init();
  AiChat._renderFieldChips();
  initFloatingLabels();
  window.addEventListener('beforeunload', (e) => {
    if (window.AppState.activeCard && window.AppState._dirty) {
      Editor.syncGreetings();
      Editor.syncEditorToCardSync();
      e.preventDefault();
      e.returnValue = '';
      return e.returnValue;
    }
  });
  window.addEventListener('storage', handleStorageChange);

  // Register service worker for offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // ─── Global error boundary ─────────────────────────
  setupErrorBoundary();
}

// ─── MODAL FOCUS TRAP ────────────────────────────────
function setupModalFocusTraps() {
  document.querySelectorAll('.modal').forEach(modalEl => {
    modalEl.addEventListener('shown.bs.modal', () => {
      const firstFocusable = modalEl.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (firstFocusable) firstFocusable.focus();
    });
    modalEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return; // let Bootstrap handle Escape
      if (e.key !== 'Tab') return;
      const focusable = modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  });
}

// ─── GLOBAL ERROR BOUNDARY ────────────────────────────
function setupErrorBoundary() {
  window.addEventListener('error', (e) => {
    const msg = e.error?.message || e.message || 'Unknown error';
    console.error('Global error:', e.error || e);
    // Avoid flooding toasts for cascading errors
    if (!window._errorThrottled) {
      window._errorThrottled = true;
      Ui.showToast('Unexpected error: ' + msg, 'danger');
      setTimeout(() => { window._errorThrottled = false; }, 5000);
    }
    // Reset AI loading state on error to prevent UI lockup
    if (window.AppState.isAiLoading) {
      window.AppState.isAiLoading = false;
      AiChat.updateSendButton();
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason?.message || String(e.reason);
    console.error('Unhandled rejection:', e.reason);
    if (!window._errorThrottled) {
      window._errorThrottled = true;
      Ui.showToast('Request failed: ' + msg, 'danger');
      setTimeout(() => { window._errorThrottled = false; }, 5000);
    }
    if (window.AppState.isAiLoading) {
      window.AppState.isAiLoading = false;
      AiChat.updateSendButton();
    }
  });
}

// ─── EVENT BINDINGS ────────────────────────────────────

function bindEvents(settingsModal) {
  const $ = Ui.$;
  const $$ = Ui.$$;
  const dropZone = $('#dropZone');
  if (!dropZone) return;

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
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      if (!dropZone.contains(e.target)) dropZone.classList.add('drag-over');
    }
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

  $('#btnNewCardCenter').addEventListener('click', () => CardManager.createNewCard());
  $('#btnSaveCard').addEventListener('click', () => CardManager.saveCurrentCard());
  $('#btnSettings').addEventListener('click', () => settingsModal.show());
  $('#btnHelp').addEventListener('click', () => { const m = new bootstrap.Modal('#shortcutsModal'); m.show(); });
  $('#btnToggleApiKey').addEventListener('click', () => Settings.toggleApiKeyVisibility());
  $('#btnToggleNamedApiKey').addEventListener('click', () => Settings.toggleNamedApiKeyVisibility());
  $('#btnSaveSettings').addEventListener('click', () => Settings.saveSettings(settingsModal));
  $('#btnRefreshModels').addEventListener('click', () => Settings.refreshModelsList());
  $('#btnClearStorage').addEventListener('click', () => Settings.confirmClearStorage());
  $('#btnExportSettings').addEventListener('click', () => Settings.exportSettings());
  $('#btnImportSettings').addEventListener('click', () => Settings.importSettings());
  $('#btnExportWorkspace').addEventListener('click', () => Settings.exportWorkspace());
  $('#btnImportWorkspace').addEventListener('click', () => Settings.importWorkspace());
  $('#providerSelect').addEventListener('change', () => Settings.toggleProvider());
  $('#languageSelect').addEventListener('change', (e) => {
    I18n.setLanguage(e.target.value);
    I18n.translateDOM();
    Ui.showToast(I18n.t('settings.languageChanged'), 'success');
  });
  settingsModal._element.addEventListener('shown.bs.modal', () => Settings.openSettings());
  $('#aiModelSelect').addEventListener('change', () => {
    const val = $('#aiModelSelect').value;
    if (val) {
      $('#defaultModelSelect').value = val;
      CardStorage.setDefaultModel(val);
    }
  });
  $('#btnExportJson').addEventListener('click', () => ExportUtils.exportAsJSON());
  $('#btnExportPng').addEventListener('click', () => ExportUtils.exportAsPNG());
  $('#btnDeleteCard').addEventListener('click', () => {
    if (confirm(I18n.t ? I18n.t('batch.deleteConfirm', { count: 1 }) : 'Delete this card? This cannot be undone.')) {
      CardManager.deleteActiveCard();
    }
  });
  $('#btnDuplicateCard').addEventListener('click', () => CardManager.duplicateCard());
  $('#btnBatchDelete').addEventListener('click', () => CardManager.batchDelete());
  $('#btnBatchExport').addEventListener('click', () => CardManager.batchExportJSON());
  $('#btnBatchCompare').addEventListener('click', () => CardManager.batchCompare());

  // Avatar upload (click + drag/drop)
  const avatar = $('#charAvatar');
  const avatarInput = $('#avatarInput');
  if (avatar) {
    avatar.addEventListener('click', () => avatarInput.click());
    avatar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); avatarInput.click(); }
    });
    avatar.addEventListener('dragover', (e) => { e.preventDefault(); avatar.classList.add('drag-over'); });
    avatar.addEventListener('dragleave', () => avatar.classList.remove('drag-over'));
    avatar.addEventListener('drop', (e) => {
      e.preventDefault(); avatar.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (f && f.type.startsWith('image/')) Editor.setAvatar(f);
    });
  }
  if (avatarInput) avatarInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) Editor.setAvatar(f);
    e.target.value = '';
  });

  // Editor field input bindings
  ['editName','editDescription','editPersonality','editScenario','editFirstMes',
   'editMesExample','editCreatorNotes','editSystemPrompt','editPostHistory',
   'editCreator','editVersion','editTags'].forEach(id => {
    const el = $('#' + id);
    if (el) {
      const field = id.replace('edit', '');
      const camelField = field.charAt(0).toLowerCase() + field.slice(1);
      el.addEventListener('focus', () => Editor._snapshot(camelField));
      el.addEventListener('input', Ui.debounce(() => { Editor.syncEditorToCard(); Editor.updateCharCounts(); Editor.autoResizeTextareas(); AiChat.updateContextBar(); }, DEBOUNCE_INPUT_MS));
    }
  });

  // Edit / Preview toggle for textareas
  document.querySelectorAll('.field-toggle-group').forEach(group => {
    const targetId = group.dataset.target;
    group.querySelectorAll('.field-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        group.querySelectorAll('.field-toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const textarea = document.getElementById(targetId);
        const previewId = 'preview' + targetId.replace('edit', '');
        const preview = document.getElementById(previewId);

        if (!textarea || !preview) return;

        if (mode === 'preview') {
          textarea.style.display = 'none';
          preview.innerHTML = Ui.renderMarkdown(textarea.value);
          preview.classList.add('visible');
        } else {
          textarea.style.display = '';
          preview.classList.remove('visible');
          preview.innerHTML = '';
        }
      });
    });
  });

  // AI chat
  $('#btnAiSend').addEventListener('click', () => AiChat.send());
  $('#aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); AiChat.send(); }
  });
  $('#btnClearChat').addEventListener('click', () => AiChat.clearChat());
  $('#btnChatHistory').addEventListener('click', () => AiChat.toggleHistory());
  $('#aiInput').addEventListener('input', Ui.debounce(() => AiChat.updateContextBar(), 400));

  $('#aiModelSelect').addEventListener('change', () => AiChat.updateContextBar());
  const stopBtn = $('#btnAiStop');
  if (stopBtn) stopBtn.addEventListener('click', () => {
    AiChat._abortAll();
    window.AppState.isAiLoading = false;
    AiChat.updateSendButton();
  });

  // Greeting count input
  const greetingCountInput = $('#aiGreetingCountInput');
  if (greetingCountInput) {
    greetingCountInput.addEventListener('change', () => {
      AiChat._greetingCount = parseInt(greetingCountInput.value) || 3;
    });
  }

  $$('.quick-action').forEach(btn => {
    btn.addEventListener('click', () => AiChat.handleQuickAction(btn.dataset.action));
  });

  $('#modelSearch').addEventListener('input', Ui.debounce(() => Settings.filterModels(), DEBOUNCE_SEARCH_MS));
  $('#btnAddLoreEntry').addEventListener('click', () => Editor.addLorebookEntry());
  $('#btnAddGreeting').addEventListener('click', () => Editor.addGreeting());

  // Library sort control
  const sortSelect = $('#cardSortSelect');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      CardManager._sortMode = sortSelect.value;
      CardManager.renderCardList();
    });
  }

  // Tag cloud toggle
  const tagToggle = $('#btnToggleTagCloud');
  if (tagToggle) {
    tagToggle.addEventListener('click', () => {
      const wrap = $('#tagCloudWrap');
      if (wrap) wrap.classList.toggle('open');
    });
  }

  // Lorebook search
  const loreSearch = $('#lorebookSearchInput');
  if (loreSearch) {
    loreSearch.addEventListener('input', Ui.debounce(() => {
      if (window.AppState.activeCard) Editor.renderLorebook(window.AppState.activeCard);
    }, DEBOUNCE_SEARCH_MS));
  }

  document.addEventListener('keydown', handleKeyboardShortcuts);

  const toggleAI = $('#btnToggleAI');
  if (toggleAI) {
    toggleAI.addEventListener('click', () => {
      document.querySelector('#panelRight').classList.toggle('mobile-open');
    });
  }

  const themeToggle = $('#btnThemeToggle');
  const savedTheme = localStorage.getItem(CardStorage.PREFIX + 'theme') || 'dark';
  if (savedTheme === 'light') { document.documentElement.setAttribute('data-theme', 'light'); }
  if (themeToggle) {
    themeToggle.innerHTML = savedTheme === 'light' ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-fill"></i>';
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(CardStorage.PREFIX + 'theme', next);
      Anims.iconSpin(themeToggle.querySelector('i'));
      themeToggle.innerHTML = next === 'light' ? '<i class="bi bi-sun-fill"></i>' : '<i class="bi bi-moon-fill"></i>';
    });
  }

  // Brand icon float
  const brandIcon = $('.brand-icon');
  if (brandIcon) brandIcon.classList.add('brand-float');

  // Global button click feedback
  document.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('.btn');
    if (btn && !Anims._disabled()) Anims.scaleClick(btn);
  });

    setupPanelResizers();
  }

  // ─── PANEL RESIZERS ───────────────────────────────
  function setupPanelResizers() {
    const root = document.documentElement;
    const app = document.querySelector('#appContainer');
    const savedL = localStorage.getItem(CardStorage.PREFIX + 'panelLeft');
    const savedR = localStorage.getItem(CardStorage.PREFIX + 'panelRight');
    if (savedL) root.style.setProperty('--panel-left-width', savedL + 'px');
    if (savedR) root.style.setProperty('--panel-right-width', savedR + 'px');

    const startDrag = (which) => (e) => {
      e.preventDefault();
      document.body.classList.add('resizing');
      const rect = app.getBoundingClientRect();
      const move = (ev) => {
        const x = (ev.touches ? ev.touches[0].clientX : ev.clientX);
        if (which === 'left') {
          let w = Math.round(x - rect.left);
          w = Math.max(220, Math.min(480, w));
          root.style.setProperty('--panel-left-width', w + 'px');
        } else {
          let w = Math.round(rect.right - x);
          w = Math.max(280, Math.min(560, w));
          root.style.setProperty('--panel-right-width', w + 'px');
        }
      };
      const up = () => {
        document.body.classList.remove('resizing');
        localStorage.setItem(CardStorage.PREFIX + 'panelLeft', root.style.getPropertyValue('--panel-left-width'));
        localStorage.setItem(CardStorage.PREFIX + 'panelRight', root.style.getPropertyValue('--panel-right-width'));
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', up);
    };
    const rl = document.querySelector('#resizerLeft');
    const rr = document.querySelector('#resizerRight');
    if (rl) { rl.addEventListener('mousedown', startDrag('left')); rl.addEventListener('touchstart', startDrag('left'), { passive: false }); }
    if (rr) { rr.addEventListener('mousedown', startDrag('right')); rr.addEventListener('touchstart', startDrag('right'), { passive: false }); }
  }

// ─── KEYBOARD SHORTCUTS ───────────────────────────────

function handleKeyboardShortcuts(e) {
  const inField = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;

  // Inside a text field: only intercept Save; let native undo/redo work.
  if (inField) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      CardManager.saveCurrentCard();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault(); Editor.undo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault(); Editor.redo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    CardManager.saveCurrentCard();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    CardManager.createNewCard();
  }
  if (e.key === '?') {
    const modal = new bootstrap.Modal('#shortcutsModal');
    modal.show();
  }
}

async function handleStorageChange(e) {
  if (!e.key || !e.key.startsWith(CardStorage.PREFIX)) return;
  window.AppState.cards = CardStorage.getCards();
  CardManager.renderCardList();
  if (window.AppState.activeCard) {
    const active = document.activeElement;
    if (window.AppState._dirty) return;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    try {
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
    } catch (err) {
      console.error('Failed to handle storage change:', err);
    }
  }
}

// ─── BOOT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
