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
    let loaded = 0, errors = 0;

    for (const file of fileList) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!validExts.includes(ext)) { errors++; continue; }
      try {
        const card = await CardEngine.parseFile(file);
        if (card._imageBase64) {
          await CardStorage.saveImage(card._id, card._imageBase64);
        }
        await CardStorage.upsertCard(card);
        loaded++;
      } catch (err) {
        console.error('Parse error:', file.name, err);
        errors++;
        Ui.showToast('Failed: ' + file.name + ' — ' + err.message, 'danger');
      }
    }

    if (loaded > 0) {
      window.AppState.cards = CardStorage.getCards();
      this.renderCardList();
      if (loaded === 1 && window.AppState.cards.length > 0) await this.selectCard(window.AppState.cards[0]);
      Ui.showToast('Loaded ' + loaded + ' card' + (loaded !== 1 ? 's' : ''), 'success');
    }
    if (errors > 0 && loaded === 0)
      Ui.showToast('No valid cards found. Drop PNG or JSON files.', 'warning');
  },

  _cardListBound: false,
  _searchQuery: '',
  _selectedIds: new Set(),

  _toggleBatchSelect(cardId) {
    if (this._selectedIds.has(cardId)) this._selectedIds.delete(cardId);
    else this._selectedIds.add(cardId);
    this._updateBatchToolbar();
  },

  _updateBatchToolbar() {
    const toolbar = document.querySelector('#batchToolbar');
    const count = document.querySelector('#batchCount');
    if (!toolbar) return;
    if (this._selectedIds.size >= 2) {
      toolbar.classList.remove('d-none');
      count.textContent = this._selectedIds.size + ' selected';
    } else {
      toolbar.classList.add('d-none');
    }
  },

  async batchDelete() {
    if (!confirm('Delete ' + this._selectedIds.size + ' cards? This cannot be undone.')) return;
    for (const id of this._selectedIds) await CardStorage.deleteCard(id);
    this._selectedIds.clear();
    this._updateBatchToolbar();
    window.AppState.cards = CardStorage.getCards();
    if (window.AppState.activeCard && !window.AppState.cards.find(c => c._id === window.AppState.activeCard._id)) {
      window.AppState.activeCard = null;
      Editor.hideEditor();
    }
    this.renderCardList();
    Ui.showToast('Cards deleted', 'warning');
  },

  async batchExportJSON() {
    for (const id of this._selectedIds) {
      const card = await CardStorage.getCard(id);
      if (card) {
        const clone = JSON.parse(JSON.stringify(card));
        if (CardStorage.getInjectCopyright()) ExportUtils.injectCopyright(clone);
        Ui.downloadFile((card.name || 'character') + '.json', CardEngine.toJSON(clone), 'application/json');
      }
    }
    Ui.showToast('Exported ' + this._selectedIds.size + ' cards', 'success');
  },

  renderCardList() {
    const $ = (sel) => document.querySelector(sel);
    const { cards, activeCard } = window.AppState;
    const container = $('#cardList');
    const emptyState = $('#emptyState');
    const searchWrap = $('#cardSearchWrap');
    $('#cardCount').textContent = cards.length + ' card' + (cards.length !== 1 ? 's' : '');

    if (searchWrap) searchWrap.style.display = cards.length > 3 ? '' : 'none';

    let filtered = cards;
    if (this._searchQuery) {
      const q = this._searchQuery.toLowerCase();
      filtered = cards.filter(c => (c.name || '').toLowerCase().includes(q)
        || (c.creator || '').toLowerCase().includes(q)
        || (c.tags || []).some(t => t.toLowerCase().includes(q)));
    }

    if (filtered.length === 0) { container.innerHTML = ''; emptyState.style.display = 'flex'; return; }
    emptyState.style.display = 'none';

    container.innerHTML = filtered.map(card => {
      const isActive = activeCard && activeCard._id === card._id;
      const isBatch = this._selectedIds.has(card._id);
      const tags = (card.tags || []).slice(0, 2);
      const thumb = card._thumbnail || card._imageBase64;
      const desc = (card.description || '').slice(0, 300);
      return '<div class="card-list-item' + (isActive ? ' active' : '') + (isBatch ? ' batch-selected' : '') + '" data-card-id="' + card._id + '" role="option" aria-selected="' + isActive + '">'
        + '<div class="card-list-avatar">'
        + (thumb ? '<img src="' + Ui.escapeAttr(thumb) + '" alt="">' : '<i class="bi bi-person-fill"></i>')
        + '</div>'
        + '<div class="card-list-info">'
        + '<div class="card-list-name">' + Ui.escapeHtml(card.name || 'Unnamed') + '</div>'
        + '<div class="card-list-meta">'
        + (card.creator ? Ui.escapeHtml(card.creator) : '')
        + (card.creator && tags.length ? ' · ' : '')
        + tags.map(t => Ui.escapeHtml(t)).join(', ')
        + '</div></div>'
        + '<input type="checkbox" class="card-batch-check" data-card-id="' + card._id + '"' + (isBatch ? ' checked' : '') + '>'
        + (card.spec_version ? '<span class="card-list-badge bg-purple">v' + Ui.escapeHtml(card.spec_version) + '</span>' : '')
        + '<div class="card-preview-tooltip">'
        + (thumb ? '<img class="preview-avatar" src="' + Ui.escapeAttr(thumb) + '" alt="">' : '')
        + '<div class="fw-semibold">' + Ui.escapeHtml(card.name || 'Unnamed') + '</div>'
        + (card.creator ? '<div class="text-muted" style="font-size:0.7rem;">by ' + Ui.escapeHtml(card.creator) + '</div>' : '')
        + (desc ? '<div class="preview-desc">' + Ui.escapeHtml(desc) + '</div>' : '')
        + '</div></div>';
    }).join('');

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
    }
  },

  async selectCard(cardMeta) {
    if (!cardMeta || !cardMeta._id) return;
    const { activeCard } = window.AppState;
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
    AiChat.renderChatHistory();
    Editor.populateEditor(fullCard);
    this.renderCardList();
    Ui.updateUIState();
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
    Ui.showToast('New blank card created', 'success');
  },

  async saveCurrentCard() {
    const { activeCard } = window.AppState;
    if (!activeCard) { Ui.showToast('No card to save', 'warning'); return; }
    await Editor.syncEditorToCard();
    this.renderCardList();
    Ui.showToast('Card saved!', 'success');
  },

  async duplicateCard() {
    const { activeCard } = window.AppState;
    if (!activeCard) { Ui.showToast('No card to duplicate', 'warning'); return; }
    await Editor.syncEditorToCard();
    const clone = JSON.parse(JSON.stringify(activeCard));
    clone._id = 'card_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    clone.name = (clone.name || 'Unnamed') + ' (Copy)';
    await CardStorage.upsertCard(clone);
    if (clone._imageBase64) await CardStorage.saveImage(clone._id, clone._imageBase64);
    window.AppState.cards = CardStorage.getCards();
    this.renderCardList();
    await this.selectCard(clone);
    Ui.showToast('Card duplicated', 'success');
  },

  async deleteActiveCard() {
    const { activeCard, cards } = window.AppState;
    if (!activeCard) return;
    const snapshot = { ...activeCard };
    const snapshotIndex = cards.findIndex(c => c._id === activeCard._id);

    await CardStorage.deleteCard(activeCard._id);
    window.AppState.cards = CardStorage.getCards();
    window.AppState.activeCard = null;
    Editor.hideEditor();
    this.renderCardList();
    if (window.AppState.cards.length > 0) await this.selectCard(window.AppState.cards[0]);

    let undone = false;
    const toastEl = document.createElement('div');
    toastEl.className = 'toast align-items-center border-0';
    toastEl.setAttribute('role', 'alert');
    toastEl.innerHTML = '<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2">'
      + '<i class="bi bi-trash-fill text-danger"></i>Card "' + Ui.escapeHtml(snapshot.name || 'Unnamed') + '" deleted'
      + '<button class="btn btn-sm btn-outline-accent ms-2" id="undoDeleteBtn">Undo</button>'
      + '</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>';
    document.querySelector('#toastContainer').appendChild(toastEl);
    const toast = new bootstrap.Toast(toastEl, { delay: 8000 });
    toast.show();
    toastEl.addEventListener('hidden.bs.toast', () => {
      toastEl.remove();
      if (!undone) return;
    });
    const undoBtn = toastEl.querySelector('#undoDeleteBtn');
    undoBtn.addEventListener('click', async () => {
      undone = true;
      toast.hide();
      await CardStorage.upsertCard(snapshot);
      window.AppState.cards = CardStorage.getCards();
      this.renderCardList();
      await this.selectCard(snapshot);
      Ui.showToast('Card restored', 'success');
    });
  },
};

window.CardManager = CardManager;
