/* ============================================================
   editor.js — Editor Population, Sync, Greetings, Lorebook
   ============================================================ */

const Editor = {
  _undoStack: [],
  _redoStack: [],
  _maxUndo: 50,

  _snapshot(field) {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    this._undoStack.push({ field, oldValue: activeCard[field] || '', newValue: document.querySelector('#edit' + field.charAt(0).toUpperCase() + field.slice(1))?.value || '' });
    if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
    this._redoStack = [];
  },

  undo() {
    if (!this._undoStack.length) return;
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const entry = this._undoStack.pop();
    this._redoStack.push({ ...entry, oldValue: activeCard[entry.field] || '', newValue: entry.oldValue });
    activeCard[entry.field] = entry.oldValue;
    const el = document.querySelector('#edit' + entry.field.charAt(0).toUpperCase() + entry.field.slice(1));
    if (el) el.value = entry.oldValue;
    Editor.syncEditorToCard();
    Ui.showToast('Undid change to ' + entry.field, 'info');
  },

  redo() {
    if (!this._redoStack.length) return;
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const entry = this._redoStack.pop();
    this._undoStack.push({ ...entry, oldValue: activeCard[entry.field] || '', newValue: entry.newValue });
    activeCard[entry.field] = entry.newValue;
    const el = document.querySelector('#edit' + entry.field.charAt(0).toUpperCase() + entry.field.slice(1));
    if (el) el.value = entry.newValue;
    Editor.syncEditorToCard();
    Ui.showToast('Redid change to ' + entry.field, 'info');
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

    this.renderGreetings(card);

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
  },

  showEditor() {
    const $ = (sel) => document.querySelector(sel);
    $('#noCardSelected').classList.add('d-none');
    $('#editorContainer').classList.remove('d-none');
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
      ta.style.height = Math.min(ta.scrollHeight, 400) + 'px';
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
          Ui.showToast('First message updated!', 'success');
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

  renderLorebook(card) {
    const $ = (sel) => document.querySelector(sel);
    const container = $('#lorebookEntries');
    const entries = card.character_book?.entries || [];
    if (entries.length === 0) {
      container.innerHTML = '<div class="text-muted text-center py-4" id="lorebookEmpty"><i class="bi bi-journal-text d-block mb-2" style="font-size: 2rem;"></i>No lorebook entries yet. Add one to get started.</div>';
      return;
    }
    container.innerHTML = entries.map((entry, idx) =>
      '<div class="lorebook-entry" data-entry-idx="' + idx + '">'
      + '<div class="lorebook-entry-header">'
      + '<input type="text" class="form-control lorebook-entry-key" value="' + Ui.escapeAttr(entry.key || '') + '" placeholder="Trigger keyword(s)" data-lore-key-idx="' + idx + '">'
      + '<button class="btn btn-outline-danger btn-sm lorebook-delete-btn" data-idx="' + idx + '"><i class="bi bi-trash"></i></button>'
      + '</div>'
      + '<textarea class="form-control editor-textarea font-mono" rows="3" placeholder="Entry content..." data-lore-idx="' + idx + '">' + Ui.escapeHtml(entry.content || '') + '</textarea>'
      + '</div>'
    ).join('');

    const self = this;
    container.querySelectorAll('.lorebook-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
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
  },

  addLorebookEntry() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    if (!activeCard.character_book) activeCard.character_book = { entries: [] };
    if (!activeCard.character_book.entries) activeCard.character_book.entries = [];
    activeCard.character_book.entries.push({ key: 'New Entry', content: '' });
    this.renderLorebook(activeCard);
    this.syncEditorToCard();
  },
};

window.Editor = Editor;
