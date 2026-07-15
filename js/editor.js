/* ============================================================
   editor.js — Editor Population, Sync, Greetings, Lorebook
   ============================================================ */

const Editor = {
  _undoStack: [],
  _redoStack: [],
  _maxUndo: 50,

  _FIELD_MAP: {
    firstMes: 'first_mes',
    mesExample: 'mes_example',
    creatorNotes: 'creator_notes',
    systemPrompt: 'system_prompt',
    postHistory: 'post_history_instructions',
    version: 'character_version',
  },

  _toCardProp(field) { return this._FIELD_MAP[field] || field; },
  _toDomId(cardProp) {
    for (const [k, v] of Object.entries(this._FIELD_MAP)) { if (v === cardProp) return k; }
    return cardProp;
  },
  _fieldToDomId(field) {
    const map = {
      name: 'editName', description: 'editDescription', personality: 'editPersonality',
      scenario: 'editScenario', firstMes: 'editFirstMes', mesExample: 'editMesExample',
      creatorNotes: 'editCreatorNotes', systemPrompt: 'editSystemPrompt',
      postHistory: 'editPostHistory', creator: 'editCreator', version: 'editVersion', tags: 'editTags',
    };
    return map[field] || 'edit' + field.charAt(0).toUpperCase() + field.slice(1);
  },

  _snapshot(field) {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const prop = this._toCardProp(field);
    this._undoStack.push({ field, prop, oldValue: activeCard[prop] || '' });
    if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
    this._redoStack = [];
  },

  undo() {
    if (!this._undoStack.length) return;
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const entry = this._undoStack.pop();
    this._redoStack.push({ ...entry, oldValue: activeCard[entry.prop] || '', newValue: entry.oldValue });
    activeCard[entry.prop] = entry.oldValue;
    const el = document.querySelector('#' + this._fieldToDomId(entry.field));
    if (el) el.value = entry.oldValue;
    Editor.syncEditorToCard();
    Ui.showToast(I18n.t('toast.undo') + ' ' + entry.prop, 'info');
  },

  redo() {
    if (!this._redoStack.length) return;
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const entry = this._redoStack.pop();
    this._undoStack.push({ ...entry, oldValue: activeCard[entry.prop] || '', newValue: entry.newValue });
    activeCard[entry.prop] = entry.newValue;
    const el = document.querySelector('#' + this._fieldToDomId(entry.field));
    if (el) el.value = entry.newValue;
    Editor.syncEditorToCard();
    Ui.showToast('Redid change to ' + entry.prop, 'info');
  },
  populateEditor(card) {
    const $ = (sel) => document.querySelector(sel);
    function safeStyle(id, displayVal) { const el = $(id); if (el) el.style.display = displayVal; }

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

    const allTags = new Set();
    (window.AppState.cards || []).forEach(c => (c.tags || []).forEach(t => allTags.add(t)));
    const datalist = document.querySelector('#tagSuggestions');
    if (datalist) datalist.innerHTML = [...allTags].map(t => '<option value="' + Ui.escapeAttr(t) + '">').join('');

    // Reset any preview states when loading a new card
    document.querySelectorAll('.field-toggle-group').forEach(group => {
      const targetId = group.dataset.target;
      group.querySelectorAll('.field-toggle-btn').forEach(b => b.classList.remove('active'));
      const editBtn = group.querySelector('[data-mode="edit"]');
      if (editBtn) editBtn.classList.add('active');
      const textarea = document.getElementById(targetId);
      const previewId = 'preview' + targetId.replace('edit', '');
      const preview = document.getElementById(previewId);
      if (textarea) textarea.style.display = '';
      if (preview) { preview.classList.remove('visible'); preview.innerHTML = ''; }
    });

    this.renderGreetings(card);

    const metaCreator = $('#metaCreator');
    if (metaCreator) { metaCreator.textContent = card.creator ? I18n.t('gen.byCreator', { name: card.creator }) : ''; safeStyle('#metaCreator', card.creator ? '' : 'none'); }
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

    this.renderLorebook(card);
    this.showEditor();
    this.updateCharCounts();
    this.autoResizeTextareas();
    window.Ui.updateUIState();
  },

  async syncEditorToCard() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const $ = (sel) => document.querySelector(sel);
    activeCard.name = $('#editName').value.trim();
    activeCard.description = $('#editDescription').value;
    activeCard.personality = $('#editPersonality').value;
    activeCard.scenario = $('#editScenario').value;
    activeCard.first_mes = $('#editFirstMes').value;
    activeCard.mes_example = $('#editMesExample').value;
    activeCard.creator_notes = $('#editCreatorNotes').value;
    activeCard.system_prompt = $('#editSystemPrompt').value;
    activeCard.post_history_instructions = $('#editPostHistory').value;
    this.syncGreetings();
    activeCard.creator = $('#editCreator').value.trim();
    activeCard.character_version = $('#editVersion').value.trim();
    activeCard.tags = $('#editTags').value.split(',').map(s => s.trim()).filter(Boolean);
    await CardStorage.upsertCard(activeCard);
    window.AppState.cards = CardStorage.getCards();
    window.AppState._dirty = true;
    Ui.setDirty(true);
  },

  showEditor() {
    const $ = (sel) => document.querySelector(sel);
    $('#noCardSelected').classList.add('d-none');
    $('#editorContainer').classList.remove('d-none');
  },

  async setAvatar(file) {
    const { activeCard } = window.AppState;
    if (!activeCard) { Ui.showToast(I18n.t('toast.selectCard'), 'warning'); return; }
    try {
      const b64 = await CardEngine._blobToBase64(file);
      activeCard._imageBase64 = b64;
      activeCard._hasImage = true;
      activeCard._thumbnail = await CardEngine._createThumbnail(b64);
      const img = $('#charAvatarImg');
      if (img) { img.src = b64; img.hidden = false; }
      const ph = $('#avatarPlaceholder');
      if (ph) ph.style.display = 'none';
      await CardStorage.saveImage(activeCard._id, b64);
      await this.syncEditorToCard();
      Ui.showToast(I18n.t('toast.avatarUpdated'), 'success');
    } catch (e) {
      console.error('Avatar load failed', e);
      Ui.showToast(I18n.t('toast.imgFailed'), 'danger');
    }
  },

  hideEditor() {
    const $ = (sel) => document.querySelector(sel);
    $('#noCardSelected').classList.remove('d-none');
    $('#editorContainer').classList.add('d-none');
  },

  _fieldIds: ['editName','editDescription','editPersonality','editScenario','editFirstMes',
    'editMesExample','editCreatorNotes','editSystemPrompt','editPostHistory',
    'editCreator','editVersion','editTags'],

  autoResizeTextareas() {
    document.querySelectorAll('.editor-textarea').forEach(ta => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 800) + 'px';
    });
  },

  updateCharCounts() {
    for (const id of this._fieldIds) {
      const el = document.querySelector('#' + id);
      if (!el) continue;
      const countEl = el.parentElement.querySelector('.char-count');
      if (!countEl) continue;
      const len = (el.value || '').length;
      const tokens = Math.ceil(len / 4);
      countEl.textContent = len + ' chars ~' + tokens + ' tokens';
    }
  },

  renderGreetings(card) {
    const $ = (sel) => document.querySelector(sel);
    const container = $('#greetingsList');
    const count = $('#greetingCount');
    const greetings = card.alternate_greetings || [];

    count.textContent = greetings.length ? '(' + greetings.length + ')' : '';

    if (!greetings.length) {
      container.innerHTML = '<div class="text-muted" style="font-size:0.8rem;padding:0.5rem 0;">' + I18n.t('editor.greetings') + '</div>';
      return;
    }

    container.innerHTML = greetings.map((g, idx) => {
      const isDefault = g === card.first_mes;
      return '<div class="greeting-item' + (isDefault ? ' default-greeting' : '') + '" data-greeting-idx="' + idx + '">'
        + '<div class="greeting-item-actions">'
        + '<button class="btn btn-outline-secondary btn-sm greeting-up" data-idx="' + idx + '" title="Move up"><i class="bi bi-chevron-up"></i></button>'
        + '<button class="btn btn-outline-secondary btn-sm greeting-down" data-idx="' + idx + '" title="Move down"><i class="bi bi-chevron-down"></i></button>'
        + (isDefault
            ? '<span class="greeting-item-badge bg-purple" title="This is the current first message"><i class="bi bi-star-fill"></i></span>'
            : '<button class="btn btn-outline-accent btn-sm greeting-set-default" data-idx="' + idx + '" title="Set as first message"><i class="bi bi-star"></i></button>')
        + '<button class="btn btn-outline-danger btn-sm greeting-delete" data-idx="' + idx + '" title="Remove"><i class="bi bi-x-lg"></i></button>'
        + '</div>'
        + '<textarea class="form-control greeting-textarea" rows="2" placeholder="Greeting ' + (idx + 1) + '..." data-greeting-idx="' + idx + '">' + Ui.escapeHtml(g) + '</textarea>'
        + '</div>';
    }).join('');

    const self = this;
    container.querySelectorAll('.greeting-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        window.AppState.activeCard.alternate_greetings.splice(parseInt(btn.dataset.idx), 1);
        self.renderGreetings(window.AppState.activeCard);
        self.syncEditorToCard();
      });
    });

    container.querySelectorAll('.greeting-set-default').forEach(btn => {
      btn.addEventListener('click', () => {
        const g = window.AppState.activeCard.alternate_greetings[parseInt(btn.dataset.idx)];
        if (g) {
          window.AppState.activeCard.first_mes = g;
          $('#editFirstMes').value = g;
          self.renderGreetings(window.AppState.activeCard);
          self.syncEditorToCard();
          Ui.showToast(I18n.t('toast.firstMesUpdated'), 'success');
        }
      });
    });

    container.querySelectorAll('.greeting-up').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        if (idx > 0) {
          const arr = window.AppState.activeCard.alternate_greetings;
          [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
          self.renderGreetings(window.AppState.activeCard);
          self.syncEditorToCard();
        }
      });
    });

    container.querySelectorAll('.greeting-down').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const arr = window.AppState.activeCard.alternate_greetings;
        if (idx < arr.length - 1) {
          [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
          self.renderGreetings(window.AppState.activeCard);
          self.syncEditorToCard();
        }
      });
    });

    container.querySelectorAll('.greeting-textarea').forEach(ta => {
      ta.addEventListener('input', Ui.debounce(() => {
        const idx = parseInt(ta.dataset.greetingIdx);
        if (window.AppState.activeCard.alternate_greetings[idx] !== undefined) {
          window.AppState.activeCard.alternate_greetings[idx] = ta.value;
        }
        self.syncEditorToCard();
      }, 500));
    });
  },

  syncGreetings() {
    const { activeCard } = window.AppState;
    const $ = (sel) => document.querySelector(sel);
    const greetings = [];
    $('#greetingsList').querySelectorAll('.greeting-textarea').forEach(ta => {
      greetings.push(ta.value);
    });
    activeCard.alternate_greetings = greetings;
  },

  addGreeting() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const $ = (sel) => document.querySelector(sel);
    if (!activeCard.alternate_greetings) activeCard.alternate_greetings = [];
    activeCard.alternate_greetings.push('');
    this.renderGreetings(activeCard);
    this.syncEditorToCard();
    const last = $('#greetingsList').querySelector('.greeting-textarea:last-of-type');
    if (last) last.focus();
  },

  // ─── LOREBOOK — Accordion with Search ──────────────
  renderLorebook(card) {
    const $ = (sel) => document.querySelector(sel);
    const container = $('#lorebookEntries');
    const entries = card.character_book?.entries || [];

    // Get search filter
    const searchInput = $('#lorebookSearchInput');
    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';

    if (entries.length === 0) {
      container.innerHTML = '<div class="text-muted text-center py-4" id="lorebookEmpty"><i class="bi bi-journal-text d-block mb-2" style="font-size: 2rem;"></i>' + I18n.t('editor.lorebookEmpty') + '</div>';
      return;
    }

    // Filter entries by search
    let filteredEntries = entries.map((entry, idx) => ({ entry, idx }));
    if (searchQuery) {
      filteredEntries = filteredEntries.filter(({ entry }) => {
        const keyStr = (entry.key || '').toLowerCase();
        const secStr = (entry.keysecondary || []).join(' ').toLowerCase();
        const contentStr = (entry.content || '').toLowerCase();
        const commentStr = (entry.comment || '').toLowerCase();
        return keyStr.includes(searchQuery) || secStr.includes(searchQuery)
          || contentStr.includes(searchQuery) || commentStr.includes(searchQuery);
      });
    }

    if (filteredEntries.length === 0) {
      container.innerHTML = '<div class="text-muted text-center py-3">No entries match "' + Ui.escapeHtml(searchQuery) + '"</div>';
      return;
    }

    container.innerHTML = '<div class="lorebook-accordion">'
      + filteredEntries.map(({ entry, idx }) => {
        const keys = (entry.key || '').split(',').map(s => s.trim()).filter(Boolean);
        const secondary = (entry.keysecondary || []);
        const label = entry.comment || entry.key || 'Entry ' + (idx + 1);

        const keyTagsHtml = keys.slice(0, 3).map(k =>
          '<span class="lorebook-key-tag primary">' + Ui.escapeHtml(k) + '</span>'
        ).join('') + secondary.slice(0, 2).map(k =>
          '<span class="lorebook-key-tag secondary">' + Ui.escapeHtml(k) + '</span>'
        ).join('');

        return '<div class="lorebook-accordion-item" data-entry-idx="' + idx + '">'
          + '<div class="lorebook-accordion-header" data-lore-toggle="' + idx + '">'
          + '<i class="bi bi-chevron-right lorebook-chevron"></i>'
          + '<span class="lorebook-entry-label">' + Ui.escapeHtml(label) + '</span>'
          + '<div class="lorebook-key-tags">' + keyTagsHtml + '</div>'
          + '<button class="btn btn-outline-danger btn-sm lorebook-delete-btn" data-idx="' + idx + '" title="Delete entry"><i class="bi bi-trash"></i></button>'
          + '</div>'
          + '<div class="lorebook-accordion-body">'
          + '<div class="row g-2 mb-2" style="font-size:0.8rem;">'
          + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">Primary Keywords</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr(entry.key || '') + '" placeholder="Primary keywords — comma separated" data-lore-key-idx="' + idx + '"></div>'
          + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">Secondary Keywords</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr((entry.keysecondary || []).join(', ')) + '" placeholder="Secondary keywords" data-lore-secondary-idx="' + idx + '"></div>'
          + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">Comment</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr(entry.comment || '') + '" placeholder="Comment" data-lore-comment-idx="' + idx + '"></div>'
          + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">Order</label><input type="number" class="form-control form-control-sm" value="' + (entry.order || 100) + '" placeholder="Order" data-lore-order-idx="' + idx + '"></div>'
          + '</div>'
          + '<div class="d-flex gap-3 mb-2" style="font-size:0.8rem;">'
          + '<div class="form-check"><input class="form-check-input" type="checkbox"' + (entry.constant ? ' checked' : '') + ' data-lore-constant-idx="' + idx + '"><label class="form-check-label">Constant</label></div>'
          + '<div class="form-check"><input class="form-check-input" type="checkbox"' + (entry.selective ? ' checked' : '') + ' data-lore-selective-idx="' + idx + '"><label class="form-check-label">Selective</label></div>'
          + '<select class="form-select form-select-sm" style="width:auto;" data-lore-position-idx="' + idx + '">'
          + '<option value="before_char"' + (entry.position === 'before_char' ? ' selected' : '') + '>Before char</option>'
          + '<option value="after_char"' + (entry.position !== 'before_char' ? ' selected' : '') + '>After char</option></select>'
          + '</div>'
          + '<label class="form-label" style="font-size:0.72rem;">Content</label>'
          + '<textarea class="form-control editor-textarea font-mono" rows="3" placeholder="Entry content..." data-lore-idx="' + idx + '">' + Ui.escapeHtml(entry.content || '') + '</textarea>'
          + '</div>'
          + '</div>';
      }).join('')
      + '</div>';

    // Accordion toggle handlers
    container.querySelectorAll('[data-lore-toggle]').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.lorebook-delete-btn')) return;
        const item = header.closest('.lorebook-accordion-item');
        if (item) item.classList.toggle('open');
      });
    });

    const self = this;
    container.querySelectorAll('.lorebook-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.AppState.activeCard.character_book.entries.splice(parseInt(btn.dataset.idx), 1);
        self.renderLorebook(window.AppState.activeCard);
        self.syncEditorToCard();
      });
    });
    container.querySelectorAll('textarea[data-lore-idx]').forEach(ta => {
      ta.addEventListener('input', Ui.debounce(() => {
        const idx = parseInt(ta.dataset.loreIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].content = ta.value;
          self.syncEditorToCard();
          self.autoResizeTextareas();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-key-idx]').forEach(input => {
      input.addEventListener('input', Ui.debounce(() => {
        const idx = parseInt(input.dataset.loreKeyIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].key = input.value.trim();
          self.syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-secondary-idx]').forEach(input => {
      input.addEventListener('input', Ui.debounce(() => {
        const idx = parseInt(input.dataset.loreSecondaryIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].keysecondary = input.value.split(',').map(s => s.trim()).filter(Boolean);
          self.syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-comment-idx]').forEach(input => {
      input.addEventListener('input', Ui.debounce(() => {
        const idx = parseInt(input.dataset.loreCommentIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].comment = input.value;
          self.syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-order-idx]').forEach(input => {
      input.addEventListener('input', Ui.debounce(() => {
        const idx = parseInt(input.dataset.loreOrderIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].order = parseInt(input.value) || 100;
          self.syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-constant-idx]').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.dataset.loreConstantIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].constant = cb.checked;
          self.syncEditorToCard();
        }
      });
    });
    container.querySelectorAll('input[data-lore-selective-idx]').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.dataset.loreSelectiveIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].selective = cb.checked;
          self.syncEditorToCard();
        }
      });
    });
    container.querySelectorAll('select[data-lore-position-idx]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.lorePositionIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].position = sel.value;
          self.syncEditorToCard();
        }
      });
    });
  },

  addLorebookEntry() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    if (!activeCard.character_book) activeCard.character_book = { entries: [] };
    if (!activeCard.character_book.entries) activeCard.character_book.entries = [];
    activeCard.character_book.entries.push({ key: 'New Entry', content: '', keysecondary: [], constant: false, selective: false, position: 'after_char', order: 100, comment: '' });
    this.renderLorebook(activeCard);
    this.syncEditorToCard();
  },
};

window.Editor = Editor;
