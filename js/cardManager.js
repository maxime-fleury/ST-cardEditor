/* ============================================================
   cardManager.js — Card List Rendering, Selection, CRUD
   ============================================================ */

const CardManager = {
  async migrateImagesToIndexedDB() {
    const all = CardStorage.getCards();
    for (const meta of all) {
      const full = await CardStorage.getCard(meta._id);
      if (!full || !full._imageBase64) continue;
        try {
          await CardStorage.saveImage(full._id, full._imageBase64);
          full._thumbnail = full._thumbnail || await CardEngine._createThumbnail(full._imageBase64);
          full._hasImage = true;
          delete full._imageBase64;
          await CardStorage.upsertCard(full);
        } catch (e) {
        console.error('Image migration failed for', full._id, e);
      }
    }
    window.AppState.cards = CardStorage.getCards();
  },

  handleFileSelect(e) {
    if (e.target.files?.length) this.processFiles(e.target.files);
    e.target.value = '';
  },

  async processFiles(fileList) {
    const validExts = ['png', 'webp', 'json'];
    let loaded = 0, errors = 0, lastCardId = null;

    for (const file of fileList) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!validExts.includes(ext)) { errors++; continue; }
      try {
        const card = await CardEngine.parseFile(file);
        if (card._imageBase64) {
          await CardStorage.saveImage(card._id, card._imageBase64);
        }
        await CardStorage.upsertCard(card);
        lastCardId = card._id;
        loaded++;
      } catch (err) {
        console.error('Parse error:', file.name, err);
        errors++;
        Ui.showToast(I18n.t('toast.loadFailed', { name: file.name + ' — ' + err.message }), 'danger');
      }
    }

    if (loaded > 0) {
      window.AppState.cards = CardStorage.getCards();
      this.renderCardList();
      if (loaded === 1 && lastCardId) {
        const meta = window.AppState.cards.find(c => c._id === lastCardId);
        if (meta) await this.selectCard(meta);
      }
      Ui.showToast(I18n.t('toast.loaded', { count: loaded }), 'success');
    }
    if (errors > 0 && loaded === 0)
      Ui.showToast(I18n.t('toast.noValid'), 'warning');
  },

  _cardListBound: false,
  _searchQuery: '',
  _selectedIds: new Set(),
  _sortMode: 'name-asc',
  _activeTagFilters: new Set(),

  _toggleBatchSelect(cardId) {
    if (this._selectedIds.has(cardId)) this._selectedIds.delete(cardId);
    else this._selectedIds.add(cardId);
    this._updateBatchToolbar();
  },

  _updateBatchToolbar() {
    const toolbar = document.querySelector('#batchToolbar');
    const count = document.querySelector('#batchCount');
    const compareBtn = document.querySelector('#btnBatchCompare');
    if (!toolbar) return;
    if (this._selectedIds.size >= 2) {
      toolbar.classList.remove('d-none');
      count.textContent = I18n.t('left.selected', { count: this._selectedIds.size });
      // Show compare button only when exactly 2 cards are selected
      if (compareBtn) compareBtn.classList.toggle('d-none', this._selectedIds.size !== 2);
    } else {
      toolbar.classList.add('d-none');
    }
  },

  async batchDelete() {
    if (this._selectedIds.size === 0) { Ui.showToast(I18n.t('toast.noSelected'), 'info'); return; }
    if (!confirm(I18n.t('batch.deleteConfirm', { count: this._selectedIds.size }))) return;
    for (const id of this._selectedIds) await CardStorage.deleteCard(id);
    this._selectedIds.clear();
    this._updateBatchToolbar();
    window.AppState.cards = CardStorage.getCards();
    if (window.AppState.activeCard && !window.AppState.cards.find(c => c._id === window.AppState.activeCard._id)) {
      window.AppState.activeCard = null;
      Editor.hideEditor();
    }
    this.renderCardList();
    Ui.showToast(I18n.t('toast.cardsDeleted'), 'warning');
  },

  async batchCompare() {
    if (this._selectedIds.size !== 2) { Ui.showToast('Select exactly 2 cards to compare', 'info'); return; }
    const [idA, idB] = [...this._selectedIds];
    const cardA = await CardStorage.getCard(idA);
    const cardB = await CardStorage.getCard(idB);
    if (!cardA || !cardB) { Ui.showToast('Failed to load cards for comparison', 'danger'); return; }

    const jsonA = CardEngine.toJSON(cardA);
    const jsonB = CardEngine.toJSON(cardB);

    const oldEl = document.querySelector('#aiDiffOld');
    const newEl = document.querySelector('#aiDiffNew');
    const titleEl = document.querySelector('#aiPreviewModal .modal-title');
    if (!oldEl || !newEl) return;

    if (titleEl) titleEl.innerHTML = '<i class="bi bi-layout-sidebar-inset me-2 text-accent"></i>Compare: ' + Ui.escapeHtml(cardA.name || 'Card A') + ' vs ' + Ui.escapeHtml(cardB.name || 'Card B');

    // Reuse the existing diff renderer
    AiChat._renderDiff(jsonA, jsonB);

    // Hide accept/discard buttons (comparison is read-only)
    const acceptBtn = document.querySelector('#btnAcceptAI');
    const discardBtn = document.querySelector('#btnDiscardAI');
    if (acceptBtn) acceptBtn.classList.add('d-none');
    if (discardBtn) discardBtn.classList.add('d-none');

    const modal = new bootstrap.Modal('#aiPreviewModal');
    // Restore button visibility on close
    const modalEl = document.querySelector('#aiPreviewModal');
    const restoreButtons = () => {
      if (acceptBtn) acceptBtn.classList.remove('d-none');
      if (discardBtn) discardBtn.classList.remove('d-none');
      modalEl.removeEventListener('hidden.bs.modal', restoreButtons);
    };
    modalEl.addEventListener('hidden.bs.modal', restoreButtons);
    modal.show();
  },

  async batchExportJSON() {
    if (this._selectedIds.size === 0) { Ui.showToast(I18n.t('toast.noSelected'), 'info'); return; }
    const cards = [];
    for (const id of this._selectedIds) {
      const card = await CardStorage.getCard(id);
      if (card) {
        const clone = JSON.parse(JSON.stringify(card));
        if (CardStorage.getInjectCopyright()) ExportUtils.injectCopyright(clone);
        cards.push(clone);
      }
    }
    if (cards.length === 1) {
      Ui.downloadFile((cards[0].name || 'character') + '.json', CardEngine.toJSON(cards[0]), 'application/json');
    } else {
      Ui.downloadFile('cards_export.json', JSON.stringify(cards, null, 2), 'application/json');
    }
    Ui.showToast(I18n.t('toast.exported', { count: cards.length }), 'success');
  },

  // ─── SORTING ──────────────────────────────────────────
  _sortCards(cards) {
    const mode = this._sortMode;
    const sorted = [...cards];
    switch (mode) {
      case 'name-asc':
        sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        break;
      case 'name-desc':
        sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        break;
      case 'newest':
        sorted.sort((a, b) => (b._createdAt || b._id || '').localeCompare(a._createdAt || a._id || ''));
        break;
      case 'oldest':
        sorted.sort((a, b) => (a._createdAt || a._id || '').localeCompare(b._createdAt || b._id || ''));
        break;
      case 'largest':
        sorted.sort((a, b) => (b._fileSize || 0) - (a._fileSize || 0));
        break;
      case 'smallest':
        sorted.sort((a, b) => (a._fileSize || 0) - (b._fileSize || 0));
        break;
    }
    return sorted;
  },

  // ─── TAG CLOUD ────────────────────────────────────────
  _renderTagCloud() {
    const tagCloudEl = document.querySelector('#tagCloud');
    if (!tagCloudEl) return;

    const tagCounts = {};
    (window.AppState.cards || []).forEach(c => {
      (c.tags || []).forEach(t => {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      });
    });

    const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

    if (sortedTags.length === 0) {
      tagCloudEl.innerHTML = '<span style="font-size:0.68rem;color:var(--text-muted);">' + I18n.t('gen.untagged') + '</span>';
      return;
    }

    tagCloudEl.innerHTML = sortedTags.map(([tag, count]) => {
      const isActive = this._activeTagFilters.has(tag);
      return '<span class="tag-chip' + (isActive ? ' active' : '') + '" data-tag="' + Ui.escapeAttr(tag) + '">'
        + Ui.escapeHtml(tag)
        + ' <span class="tag-count">' + count + '</span>'
        + '</span>';
    }).join('');

    tagCloudEl.querySelectorAll('.tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (this._activeTagFilters.has(tag)) {
          this._activeTagFilters.delete(tag);
        } else {
          this._activeTagFilters.add(tag);
        }
        this.renderCardList();
      });
    });
  },

  renderCardList() {
    const $ = (sel) => document.querySelector(sel);
    const { cards, activeCard } = window.AppState;
    const container = $('#cardList');
    const emptyState = $('#emptyState');
    const searchWrap = $('#cardSearchWrap');
    const controlsWrap = $('#libraryControls');
    $('#cardCount').textContent = I18n.t('left.cards', { count: cards.length });

    if (searchWrap) searchWrap.style.display = cards.length > 3 ? '' : 'none';
    if (controlsWrap) controlsWrap.style.display = cards.length > 3 ? '' : 'none';

    this._renderTagCloud();

    let filtered = cards;

    // Text search
    if (this._searchQuery) {
      const q = this._searchQuery.toLowerCase();
      filtered = cards.filter(c => (c.name || '').toLowerCase().includes(q)
        || (c.creator || '').toLowerCase().includes(q)
        || (c.tags || []).some(t => t.toLowerCase().includes(q)));
    }

    // Tag filter
    if (this._activeTagFilters.size > 0) {
      filtered = filtered.filter(c => {
        const cardTags = new Set((c.tags || []).map(t => t.toLowerCase()));
        for (const filter of this._activeTagFilters) {
          if (!cardTags.has(filter.toLowerCase())) return false;
        }
        return true;
      });
    }

    // Sort
    filtered = this._sortCards(filtered);

    if (filtered.length === 0 && (this._searchQuery || this._activeTagFilters.size > 0)) {
      container.innerHTML = '<div class="text-center text-muted py-4">' + I18n.t('gen.noMatch') + '</div>';
      emptyState.style.display = 'none';
      return;
    }
    if (filtered.length === 0) { container.innerHTML = ''; emptyState.style.display = 'flex'; return; }
    emptyState.style.display = 'none';

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    container.innerHTML = filtered.map(card => {
      const isActive = activeCard && activeCard._id === card._id;
      const isBatch = this._selectedIds.has(card._id);
      const tags = (card.tags || []).slice(0, 2);
      const thumb = card._thumbnail || card._imageBase64;
      const desc = (card.description || '').slice(0, 300);
      const fileSize = card._fileSize ? Ui.formatFileSize(card._fileSize) : '';

      return '<div class="card-list-item' + (isActive ? ' active' : '') + (isBatch ? ' batch-selected' : '') + '" data-card-id="' + card._id + '" role="option" aria-selected="' + isActive + '">'
        + '<div class="card-list-avatar">'
        + (thumb ? '<img src="' + Ui.escapeAttr(thumb) + '" alt="">' : '<i class="bi bi-person-fill"></i>')
        + '</div>'
        + '<div class="card-list-info">'
        + '<div class="card-list-name">' + Ui.escapeHtml(card.name || I18n.t('gen.unnamed')) + '</div>'
        + '<div class="card-list-meta">'
        + (card.creator ? Ui.escapeHtml(card.creator) : '')
        + (card.creator && tags.length ? ' · ' : '')
        + tags.map(t => Ui.escapeHtml(t)).join(', ')
        + (fileSize ? ' <span class="meta-filesize">' + fileSize + '</span>' : '')
        + '</div></div>'
        + '<input type="checkbox" class="card-batch-check" data-card-id="' + card._id + '"' + (isBatch ? ' checked' : '') + '>'
        + '<span class="card-drag-handle" draggable="true" data-card-id="' + card._id + '"><i class="bi bi-grip-vertical"></i></span>'
        + (card.spec_version ? '<span class="card-list-badge bg-purple">v' + Ui.escapeHtml(card.spec_version) + '</span>' : '')
        + '<div class="card-preview-tooltip">'
        + (thumb ? '<img class="preview-avatar" src="' + Ui.escapeAttr(thumb) + '" alt="">' : '')
        + '<div class="fw-semibold">' + Ui.escapeHtml(card.name || I18n.t('gen.unnamed')) + '</div>'
        + (card.creator ? '<div class="text-muted" style="font-size:0.7rem;">' + I18n.t('gen.byCreator', { name: Ui.escapeHtml(card.creator) }) + '</div>' : '')
        + (desc ? '<div class="preview-desc">' + Ui.escapeHtml(desc) + '</div>' : '')
        + '</div></div>';
    }).join('');

    Anims.staggerFadeIn(container.querySelectorAll('.card-list-item'), { stagger: 25, duration: 200 });

    // ─── 3D Tilt Effect ──────────────────────────────────
    if (!reducedMotion) {
      container.querySelectorAll('.card-list-item').forEach(item => {
        item.addEventListener('mousemove', (e) => {
          const rect = item.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const centerX = rect.width / 2;
          const centerY = rect.height / 2;
          const rotateX = ((y - centerY) / centerY) * -4;
          const rotateY = ((x - centerX) / centerX) * 4;
          item.style.transform = 'perspective(400px) rotateX(' + rotateX + 'deg) rotateY(' + rotateY + 'deg) scale(1.01)';
          item.style.setProperty('--mouse-x', ((x / rect.width) * 100) + '%');
          item.style.setProperty('--mouse-y', ((y / rect.height) * 100) + '%');
        });
        item.addEventListener('mouseleave', () => {
          item.style.transform = '';
        });
      });
    }

    if (!this._cardListBound) {
      this._cardListBound = true;
      container.addEventListener('click', (e) => {
        const checkbox = e.target.closest('.card-batch-check');
        if (checkbox) {
          e.stopPropagation();
          CardManager._toggleBatchSelect(checkbox.dataset.cardId);
          return;
        }
        const item = e.target.closest('.card-list-item');
        if (!item) return;
        const card = window.AppState.cards.find(c => c._id === item.dataset.cardId);
        if (card) CardManager.selectCard(card);
      });
      const searchInput = $('#cardSearchInput');
      if (searchInput) {
        searchInput.addEventListener('input', Ui.debounce(() => {
          this._searchQuery = searchInput.value.trim();
          this.renderCardList();
        }, DEBOUNCE_SEARCH_MS));
      }

      let dragId = null;
      container.addEventListener('dragstart', (e) => {
        const handle = e.target.closest('.card-drag-handle');
        if (!handle) return;
        dragId = handle.dataset.cardId;
        e.dataTransfer.effectAllowed = 'move';
        const dragItem = handle.closest('.card-list-item');
        if (dragItem && !Anims._disabled()) {
          dragItem.style.transition = 'transform 150ms ease, opacity 150ms ease';
          dragItem.style.transform = 'scale(0.97)';
          dragItem.style.opacity = '0.7';
        }
      });
      container.addEventListener('dragover', (e) => {
        e.preventDefault();
        const item = e.target.closest('.card-list-item');
        if (item) item.classList.add('drag-over');
      });
      container.addEventListener('dragleave', (e) => {
        const item = e.target.closest('.card-list-item');
        if (item) item.classList.remove('drag-over');
      });
      container.addEventListener('drop', (e) => {
        e.preventDefault();
        const item = e.target.closest('.card-list-item');
        if (item) item.classList.remove('drag-over');
        if (!dragId || !item) return;
        // Reordering by DOM position corrupts order when a filter/search is active,
        // so only allow it on the full, unfiltered list.
        if (this._searchQuery || this._activeTagFilters.size > 0) {
          Ui.showToast(I18n.t('toast.reorderFiltered'), 'info');
          dragId = null;
          return;
        }
        const dropId = item.dataset.cardId;
        if (dragId === dropId) return;
        const cards = window.AppState.cards;
        const fromIdx = cards.findIndex(c => c._id === dragId);
        const toIdx = cards.findIndex(c => c._id === dropId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = cards.splice(fromIdx, 1);
        const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
        cards.splice(adjustedTo, 0, moved);
        CardStorage.saveCardIndex(cards);
        this.renderCardList();
        dragId = null;
      });
      container.addEventListener('dragend', () => {
        const dragItem = container.querySelector('.card-list-item[style*="scale"]');
        if (dragItem) { dragItem.style.transform = ''; dragItem.style.opacity = ''; }
        dragId = null;
      });
    }
  },

  _switchPromise: Promise.resolve(),

  async selectCard(cardMeta) {
    if (!cardMeta || !cardMeta._id) return;
    const run = () => this._doSelect(cardMeta);
    const next = this._switchPromise.then(run, run);
    this._switchPromise = next.catch(() => {});
    return next;
  },

  async _doSelect(cardMeta) {
    const { activeCard, isAiLoading } = window.AppState;
    // Abort any ongoing AI generation when switching cards
    if (isAiLoading) {
      AiChat._abortAll();
      window.AppState.isAiLoading = false;
      AiChat.updateSendButton();
    }
    if (activeCard && activeCard._id !== cardMeta._id) await Editor.syncEditorToCard();
    const fullCard = await CardStorage.getCard(cardMeta._id);
    if (!fullCard) return;
    window.AppState.activeCard = fullCard;
    CardStorage.setActiveCardId(fullCard._id);

    try {
      const b64 = await CardStorage.getImage(fullCard._id);
      if (b64) window.AppState.activeCard._imageBase64 = b64;
    } catch (e) {
      console.error('Failed to load image from IndexedDB:', e);
    }

    window.AppState.chatHistory = CardStorage.getChatHistory(fullCard._id);
    AiChat._historyRendered = false;
    AiChat.renderChatHistory();
    Editor.populateEditor(fullCard);
    this.renderCardList();
    window.AppState._dirty = false;
    Ui.updateUIState();
    AiChat.updateContextBar();
    // Autofocus the AI input for quick editing workflow
    setTimeout(() => {
      const aiInput = document.querySelector('#aiInput');
      if (aiInput) aiInput.focus();
    }, 100);
  },

  async createNewCard() {
    const { activeCard } = window.AppState;
    if (activeCard) await Editor.syncEditorToCard();
    const card = CardEngine.createEmptyCard();
    await CardStorage.upsertCard(card);
    window.AppState.cards = CardStorage.getCards();
    this.renderCardList();
    await this.selectCard(card);
    document.querySelector('#editName').focus();
    Ui.showToast(I18n.t('toast.newBlank'), 'success');
  },

  async saveCurrentCard() {
    const { activeCard } = window.AppState;
    if (!activeCard) { Ui.showToast(I18n.t('toast.noCardSave'), 'warning'); return; }
    await Editor.syncEditorToCard();
    window.AppState._dirty = false;
    Ui.setDirty(false);
    Ui.flashSaved();
    this.renderCardList();
    Ui.showToast(I18n.t('toast.cardSaved'), 'success');
  },

  async duplicateCard() {
    const { activeCard } = window.AppState;
    if (!activeCard) { Ui.showToast(I18n.t('toast.noCardDup'), 'warning'); return; }
    await Editor.syncEditorToCard();
    const clone = JSON.parse(JSON.stringify(activeCard));
    clone._id = 'card_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    clone.name = (clone.name || (I18n.t ? I18n.t('gen.unnamed') : 'Unnamed')) + (I18n.t ? I18n.t('gen.copySuffix') : ' (Copy)');
    await CardStorage.upsertCard(clone);
    if (clone._imageBase64) await CardStorage.saveImage(clone._id, clone._imageBase64);
    window.AppState.cards = CardStorage.getCards();
    this.renderCardList();
    await this.selectCard(clone);
    Ui.showToast(I18n.t('toast.cardDup'), 'success');
  },

  async deleteActiveCard() {
    const { activeCard, cards } = window.AppState;
    if (!activeCard) return;
    await Editor.syncEditorToCard();
    const snapshot = { ...activeCard };
    const snapshotIndex = cards.findIndex(c => c._id === activeCard._id);

    await CardStorage.deleteCard(activeCard._id);
    window.AppState.cards = CardStorage.getCards();
    window.AppState.activeCard = null;
    Editor.hideEditor();
    this.renderCardList();
    if (window.AppState.cards.length > 0) await this.selectCard(window.AppState.cards[0]);

    let undone = false;
    const DURATION = 8000;
    const toastLabel = (I18n && I18n.t) ? I18n.t('gen.toastAutoHide', { s: Math.ceil(DURATION / 1000) }) : 'Auto-hides in 8s';
    const toastEl = document.createElement('div');
    toastEl.className = 'toast align-items-center border-0';
    toastEl.setAttribute('role', 'alert');
    toastEl.innerHTML = '<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2 w-100"><div class="flex-grow-1 d-flex align-items-center gap-2">'
      + '<i class="bi bi-trash-fill text-danger"></i>' + I18n.t('toast.cardDeleted', { name: Ui.escapeHtml(snapshot.name || I18n.t('gen.unnamed')) })
      + '<button class="btn btn-sm btn-outline-accent ms-2" id="undoDeleteBtn">' + I18n.t('toast.undo') + '</button>'
      + '</div><div class="toast-timer" style="font-size:0.62rem;white-space:nowrap;font-family:var(--font-mono);min-width:3.2em;text-align:right;">' + toastLabel + '</div><button type="button" class="btn-close btn-close-white ms-2" data-bs-dismiss="toast"></button></div></div>';
    document.querySelector('#toastContainer').appendChild(toastEl);
    const toast = new bootstrap.Toast(toastEl, { delay: DURATION });
    toast.show();
    // Live countdown timer
    const timerEl = toastEl.querySelector('.toast-timer');
    if (timerEl) {
      const interval = 200;
      let remaining = DURATION;
      const tick = () => {
        remaining -= interval;
        if (remaining <= 0 || undone) { timerEl.textContent = ''; return; }
        const secs = Math.ceil(remaining / 1000);
        timerEl.textContent = (I18n && I18n.t)
          ? I18n.t('gen.toastAutoHide', { s: secs })
          : 'Auto-hides in ' + secs + 's';
      };
      const timer = setInterval(tick, interval);
      toastEl.addEventListener('hidden.bs.toast', () => {
        clearInterval(timer);
        toastEl.remove();
        if (!undone) return;
      });
    } else {
      toastEl.addEventListener('hidden.bs.toast', () => {
        toastEl.remove();
        if (!undone) return;
      });
    }
    const undoBtn = toastEl.querySelector('#undoDeleteBtn');
    undoBtn.addEventListener('click', async () => {
      undone = true;
      toast.hide();
      await CardStorage.upsertCard(snapshot);
      if (snapshot._imageBase64) {
        await CardStorage.saveImage(snapshot._id, snapshot._imageBase64);
        snapshot._hasImage = true;
      }
      window.AppState.cards = CardStorage.getCards();
      this.renderCardList();
      await this.selectCard(snapshot);
      Ui.showToast(I18n.t('toast.cardRestored'), 'success');
    });
  },
};

window.CardManager = CardManager;
