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

  renderCardList() {
    const $ = (sel) => document.querySelector(sel);
    const { cards, activeCard } = window.AppState;
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
        + (card._thumbnail || card._imageBase64 ? '<img src="' + Ui.escapeAttr(card._thumbnail || card._imageBase64) + '" alt="">' : '<i class="bi bi-person-fill"></i>')
        + '</div>'
        + '<div class="card-list-info">'
        + '<div class="card-list-name">' + Ui.escapeHtml(card.name || 'Unnamed') + '</div>'
        + '<div class="card-list-meta">'
        + (card.creator ? Ui.escapeHtml(card.creator) : '')
        + (card.creator && tags.length ? ' · ' : '')
        + tags.map(t => Ui.escapeHtml(t)).join(', ')
        + '</div></div>'
        + (card.spec_version ? '<span class="card-list-badge bg-purple">v' + Ui.escapeHtml(card.spec_version) + '</span>' : '')
        + '</div>';
    }).join('');

    const self = this;
    container.querySelectorAll('.card-list-item').forEach(item => {
      item.addEventListener('click', () => {
        const card = cards.find(c => c._id === item.dataset.cardId);
        if (card) self.selectCard(card);
      });
    });
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

  async deleteActiveCard() {
    const { activeCard, cards } = window.AppState;
    if (!activeCard) return;
    if (!confirm('Delete "' + activeCard.name + '"? This cannot be undone.')) return;
    await CardStorage.deleteCard(activeCard._id);
    window.AppState.cards = CardStorage.getCards();
    window.AppState.activeCard = null;
    Editor.hideEditor();
    this.renderCardList();
    if (window.AppState.cards.length > 0) await this.selectCard(window.AppState.cards[0]);
    Ui.showToast('Card deleted', 'warning');
  },
};

window.CardManager = CardManager;
