/* ============================================================
   editor.js — Editor Population, Sync, Greetings, Lorebook
   ============================================================ */

const Editor = {
  _undoStack: [],
  _redoStack: [],
  _maxUndo: 50,
  _undoCardId: null,
  // The field of the most recent undo snapshot. Used to coalesce continuous
  // edits to one field into a single undo step (per edit burst), so Ctrl+Z
  // reverts a whole burst instead of one character at a time.
  _lastSnapField: null,

  _FIELD_MAP: {
    firstMes: 'first_mes',
    mesExample: 'mes_example',
    creatorNotes: 'creator_notes',
    systemPrompt: 'system_prompt',
    postHistory: 'post_history_instructions',
    version: 'character_version',
  },

  _toCardProp(field) { return this._FIELD_MAP[field] || field; },
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
    const val = activeCard[prop];
    const oldVal = (Array.isArray(val) || (val && typeof val === 'object'))
      ? JSON.parse(JSON.stringify(val))
      : (val || '');
    this._undoStack.push({ field, prop, oldValue: oldVal });
    if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
    this._redoStack = [];
  },

  // Greetings + lorebook are rendered sub-sections, not top-level #edit* fields,
  // so their undo entries snapshot the whole container value and restore by
  // re-rendering (#37). `kind` is 'greetings' | 'lorebook'.
  _snapshotSub(kind) {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const prop = kind === 'greetings' ? 'alternate_greetings' : 'character_book';
    this._undoStack.push({
      field: kind,
      prop,
      oldValue: JSON.parse(JSON.stringify(activeCard[prop] || (kind === 'greetings' ? [] : { entries: [] }))),
    });
    if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
    this._redoStack = [];
  },

  _applySubEntry(entry, newValue) {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    if (entry.prop === 'alternate_greetings') {
      activeCard.alternate_greetings = newValue;
      this.renderGreetings(activeCard);
    } else if (entry.prop === 'character_book') {
      activeCard.character_book = newValue;
      this.renderLorebook(activeCard);
    }
  },

  async undo() {
    if (!this._undoStack.length) return;
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    this._lastSnapField = null;
    const entry = this._undoStack.pop();
    this._redoStack.push({
      ...entry,
      oldValue: entry.oldValue,
      newValue: JSON.parse(JSON.stringify(activeCard[entry.prop] || (entry.prop === 'alternate_greetings' ? [] : (entry.prop === 'character_book' ? { entries: [] } : '')))),
    });
    if (entry.prop === 'alternate_greetings' || entry.prop === 'character_book') {
      this._applySubEntry(entry, entry.oldValue);
      await this.syncEditorToCard();
      AiChat.updateContextBar();
      Ui.showToast(I18n.t('toast.undo') + ': ' + entry.field, 'info');
      return;
    }
    activeCard[entry.prop] = entry.oldValue;
    const el = document.querySelector('#' + this._fieldToDomId(entry.field));
    if (el) el.value = entry.oldValue;
    await Editor.syncEditorToCard();
    this.updateCharCounts();
    this.autoResizeTextareas();
    AiChat.updateContextBar();
    Ui.showToast(I18n.t('toast.undo') + ': ' + entry.field, 'info');
  },

  async redo() {
    if (!this._redoStack.length) return;
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    this._lastSnapField = null;
    const entry = this._redoStack.pop();
    this._undoStack.push({
      ...entry,
      oldValue: JSON.parse(JSON.stringify(activeCard[entry.prop] || (entry.prop === 'alternate_greetings' ? [] : (entry.prop === 'character_book' ? { entries: [] } : '')))),
      newValue: entry.newValue,
    });
    if (entry.prop === 'alternate_greetings' || entry.prop === 'character_book') {
      this._applySubEntry(entry, entry.newValue);
      await this.syncEditorToCard();
      AiChat.updateContextBar();
      Ui.showToast(I18n.t('toast.redo') + ': ' + entry.field, 'info');
      return;
    }
    activeCard[entry.prop] = entry.newValue;
    const el = document.querySelector('#' + this._fieldToDomId(entry.field));
    if (el) el.value = entry.newValue;
    await Editor.syncEditorToCard();
    this.updateCharCounts();
    this.autoResizeTextareas();
    AiChat.updateContextBar();
    Ui.showToast(I18n.t('toast.redo') + ': ' + entry.field, 'info');
  },
  populateEditor(card) {
    const $ = (sel) => document.querySelector(sel);
    function safeStyle(id, displayVal) { const el = $(id); if (el) el.style.display = displayVal; }

    // Records which card the DOM currently reflects. _doSync uses this to refuse
    // writes when a debounced sync fires after a card switch but before the new
    // card's populateEditor has run — otherwise the old card's DOM values would
    // be written into the new card object (#75).
    this._renderedCardId = card._id;

    // Undo/redo stacks belong to a single card; never let edits to one card
    // bleed into another via Ctrl+Z/Ctrl+Y after switching cards.
    if (card._id !== this._undoCardId) {
      this._undoStack = [];
      this._redoStack = [];
      this._lastSnapField = null;
      this._undoCardId = card._id;
    }

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
    window.syncFloatingLabels?.();
    window.Ui.updateUIState();
  },

  // Shared field-capture logic used by both sync paths so the two stay in
  // sync and cannot drift when fields are added or edited.
  _captureFields(activeCard) {
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
    activeCard.tags = $('#editTags').value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
    // Compute file size using the export format (without internal metadata)
    activeCard._fileSize = JSON.stringify({
      spec: activeCard.spec || 'chara_card_v2',
      spec_version: activeCard.spec_version || '2.0',
      data: {
        name: activeCard.name || '', description: activeCard.description || '',
        personality: activeCard.personality || '', scenario: activeCard.scenario || '',
        first_mes: activeCard.first_mes || '', mes_example: activeCard.mes_example || '',
        creator_notes: activeCard.creator_notes || '',
        system_prompt: activeCard.system_prompt || '',
        post_history_instructions: activeCard.post_history_instructions || '',
        alternate_greetings: activeCard.alternate_greetings || [],
        tags: activeCard.tags || [], creator: activeCard.creator || '',
        character_version: activeCard.character_version || '',
        character_book: activeCard.character_book || { entries: [] },
        extensions: activeCard.extensions || {},
      },
    }).length;
  },

  async syncEditorToCard() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    // Serialize concurrent writes: if a save is already in flight, chain this
    // one after it so IndexedDB writes never interleave and reorder.
    const prev = this._pendingSync || Promise.resolve();
    const run = prev.then(() => this._doSync(activeCard));
    this._pendingSync = run.catch(() => {});
    return run;
  },

  async _doSync(activeCard) {
    // Guard against cross-card writes: if the DOM currently renders a different
    // card than the one this write is destined for (card switch in progress),
    // the debounced capture would persist the wrong card's values (#75).
    if (this._renderedCardId && this._renderedCardId !== activeCard._id) return;
    this._captureFields(activeCard);
    // Warn if card has no name (throttled to once until name is filled)
    if (!activeCard.name && !this._nameWarned) {
      this._nameWarned = true;
      Ui.showToast(I18n.t('toast.noNameWarning'), 'warning');
    } else if (activeCard.name && this._nameWarned) {
      this._nameWarned = false;
    }
    await CardStorage.upsertCard(activeCard);
    window.AppState.cards = CardStorage.getCards();
    window.AppState._dirty = true;
    Ui.setDirty(true);
  },

  syncEditorToCardSync() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    // Same guard as _doSync so a stray debounced flush during a card switch
    // can't write the wrong card's DOM values (#75).
    if (this._renderedCardId && this._renderedCardId !== activeCard._id) return;
    this._captureFields(activeCard);
    // Fire-and-forget IndexedDB write via the shared connection.
    // Reuse the same save path as the async version to avoid divergent
    // write logic and connection leaks. On beforeunload this is a best-effort flush.
    try {
      CardStorage.upsertCard(activeCard).catch(() => {});
    } catch (_) {}
    const index = CardStorage.getCards();
    const idx = index.findIndex(c => c._id === activeCard._id);
    const meta = CardStorage._extractMeta(activeCard);
    if (idx >= 0) { index[idx] = meta; } else { index.unshift(meta); }
    try { localStorage.setItem(CardStorage.PREFIX + CardStorage._keys.cardIndex, JSON.stringify(index)); } catch (_) {}
    window.AppState._dirty = true;
  },

  showEditor() {
    const $ = (sel) => document.querySelector(sel);
    $('#noCardSelected').classList.add('d-none');
    $('#editorContainer').classList.remove('d-none');
  },

  async setAvatar(file) {
    const $ = (sel) => document.querySelector(sel);
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
      // Skip textareas in hidden tab panes: their scrollHeight is 0, so resizing
      // here would clamp them to the CSS min-height and never grow back (#73).
      if (ta.offsetParent === null) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 800) + 'px';
    });
  },

  updateCharCounts() {
    for (const id of this._fieldIds) {
      const el = document.querySelector('#' + id);
      if (!el) continue;
      let countEl = el.parentElement.querySelector('.char-count');
      // Lazily create a counter for fields that don't ship one in the markup;
      // updateCharCounts runs on every editor tab switch, so this keeps all
      // 12 fields consistent without hand-adding markup to each of them (#43).
      if (!countEl) {
        countEl = document.createElement('small');
        countEl.className = 'char-count text-secondary d-block mt-1';
        countEl.style.fontSize = '0.7rem';
        el.insertAdjacentElement('afterend', countEl);
      }
      const len = (el.value || '').length;
      // Use the same estimator as Tokenizer (which the context bar uses) so the
      // char counts and the token context bar never disagree.
      const tokens = typeof Tokenizer !== 'undefined' && Tokenizer.quickCount
        ? Tokenizer.quickCount(el.value || '')
        : Math.ceil(len / 3);
      countEl.textContent = I18n.t ? I18n.t('editor.charCount', { chars: len, tokens: tokens }) : (len + ' chars ~' + tokens + ' tokens');
    }
  },

  renderGreetings(card) {
    const $ = (sel) => document.querySelector(sel);
    const container = $('#greetingsList');
    const count = $('#greetingCount');
    const greetings = card.alternate_greetings || [];

    // Generation token invalidates stale debounced writes after a re-render
    // (add/delete/move) so writebacks can't clobber a reordered entry.
    const gen = (this._greetGen = (this._greetGen || 0) + 1);

    count.textContent = greetings.length ? '(' + greetings.length + ')' : '';

    if (!greetings.length) {
      container.innerHTML = '<div style="font-size:0.82rem;padding:0.5rem 0;color:var(--text-secondary);"><i class="bi bi-info-circle me-1" style="color:var(--purple-400);"></i>' + (I18n.t ? I18n.t('editor.noGreetings') : 'No greetings yet. Click <strong>Add Greeting</strong> or use AI to generate some.') + '</div>';
      return;
    }

    container.innerHTML = greetings.map((g, idx) => {
      // Badge only the *first* greeting whose text equals first_mes; comparing
      // by value alone would star every duplicate greeting (#101).
      const isDefault = idx === greetings.indexOf(card.first_mes);
      return '<div class="greeting-item' + (isDefault ? ' default-greeting' : '') + '" data-greeting-idx="' + idx + '">'
        + '<div class="greeting-item-actions">'
        + '<button class="btn btn-outline-secondary btn-sm greeting-up" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t('editor.greetingMoveUp') : 'Move up') + '"><i class="bi bi-chevron-up"></i></button>'
        + '<button class="btn btn-outline-secondary btn-sm greeting-down" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t('editor.greetingMoveDown') : 'Move down') + '"><i class="bi bi-chevron-down"></i></button>'
        + (isDefault
            ? '<span class="greeting-item-badge bg-purple" title="' + (I18n.t ? I18n.t('editor.greetingIsDefault') : 'This is the current first message') + '"><i class="bi bi-star-fill"></i></span>'
            : '<button class="btn btn-outline-accent btn-sm greeting-set-default" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t('editor.greetingSetDefault') : 'Set as first message') + '"><i class="bi bi-star"></i></button>')
        + '<button class="btn btn-outline-danger btn-sm greeting-delete" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t('editor.greetingRemove') : 'Remove') + '"><i class="bi bi-x-lg"></i></button>'
        + '</div>'
        + '<textarea class="form-control greeting-textarea" rows="4" placeholder="' + (I18n.t ? I18n.t('editor.greetingPlaceholder', { num: idx + 1 }) : 'Greeting ' + (idx + 1) + '...') + '" data-greeting-idx="' + idx + '">' + Ui.escapeHtml(g) + '</textarea>'
        + '</div>';
    }).join('');

    const self = this;
    container.querySelectorAll('.greeting-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        // Flush any in-flight typed text into the array before re-rendering,
        // otherwise the characters typed in the last 500 ms are discarded (#74).
        self.syncGreetings();
        window.AppState.activeCard.alternate_greetings.splice(parseInt(btn.dataset.idx), 1);
        self.renderGreetings(window.AppState.activeCard);
        await self.syncEditorToCard();
      });
    });

    container.querySelectorAll('.greeting-set-default').forEach(btn => {
      btn.addEventListener('click', async () => {
        self.syncGreetings();
        const g = window.AppState.activeCard.alternate_greetings[parseInt(btn.dataset.idx)];
        if (g) {
          window.AppState.activeCard.first_mes = g;
          $('#editFirstMes').value = g;
          self.renderGreetings(window.AppState.activeCard);
          await self.syncEditorToCard();
          Ui.showToast(I18n.t('toast.firstMesUpdated'), 'success');
        }
      });
    });

    container.querySelectorAll('.greeting-up').forEach(btn => {
      btn.addEventListener('click', async () => {
        self.syncGreetings();
        const idx = parseInt(btn.dataset.idx);
        if (idx > 0) {
          const arr = window.AppState.activeCard.alternate_greetings;
          [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
          self.renderGreetings(window.AppState.activeCard);
          await self.syncEditorToCard();
        }
      });
    });

    container.querySelectorAll('.greeting-down').forEach(btn => {
      btn.addEventListener('click', async () => {
        self.syncGreetings();
        const idx = parseInt(btn.dataset.idx);
        const arr = window.AppState.activeCard.alternate_greetings;
        if (idx < arr.length - 1) {
          [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
          self.renderGreetings(window.AppState.activeCard);
          await self.syncEditorToCard();
        }
      });
    });

    container.querySelectorAll('.greeting-textarea').forEach(ta => {
      // Undo support for the greetings section (#37): snapshot before the first
      // edit of each burst, coalesced like the top-level fields.
      ta.addEventListener('focus', () => { self._lastSnapField = null; });
      ta.addEventListener('beforeinput', () => {
        if (self._lastSnapField !== 'greetings') {
          self._snapshotSub('greetings');
          self._lastSnapField = 'greetings';
        }
      });
      ta.addEventListener('input', Ui.debounce(async () => {
        // If a re-render happened since this textarea was created, the DOM
        // entry (and the array) may have been reordered or replaced; fall back
        // to reading the current DOM so we never write stale text to a moved slot.
        if (!ta.isConnected || gen !== self._greetGen) {
          self.syncGreetings();
          await self.syncEditorToCard();
          return;
        }
        const idx = parseInt(ta.dataset.greetingIdx);
        if (window.AppState.activeCard.alternate_greetings[idx] !== undefined) {
          window.AppState.activeCard.alternate_greetings[idx] = ta.value;
        }
        await self.syncEditorToCard();
      }, 500));
    });
  },

  syncGreetings() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const $ = (sel) => document.querySelector(sel);
    const greetings = [];
    const list = $('#greetingsList');
    if (list) {
      list.querySelectorAll('.greeting-textarea').forEach(ta => {
        greetings.push(ta.value);
      });
    }
    activeCard.alternate_greetings = greetings;
  },

  async addGreeting() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    const $ = (sel) => document.querySelector(sel);
    if (!activeCard.alternate_greetings) activeCard.alternate_greetings = [];
    activeCard.alternate_greetings.push('');
    this.renderGreetings(activeCard);
    await this.syncEditorToCard();
    const allTas = $('#greetingsList').querySelectorAll('.greeting-textarea');
    const last = allTas[allTas.length - 1];
    if (last) last.focus();
  },

  // ─── LOREBOOK — Accordion with Search ──────────────
  renderLorebook(card) {
    const $ = (sel) => document.querySelector(sel);
    const container = $('#lorebookEntries');
    // Normalize malformed entries in place (self-healing: the fixed shape is
    // persisted on the next sync). keysecondary is an array per the V2 spec,
    // but legacy/foreign cards may store a comma-joined string — and a string
    // here crashed the whole render (`.slice().map` on a string) (v2 #5).
    // Non-object entries become safe placeholders (NOT dropped) so the index
    // numbers rendered into data-lore-* attributes stay aligned with the card's
    // entries array.
    const entries = (card.character_book?.entries || []).map(e => {
      if (!e || typeof e !== 'object') {
        return { key: '', keysecondary: [], content: '', order: 100, constant: false, selective: false, position: 'after_char', comment: '' };
      }
      if (!Array.isArray(e.keysecondary)) {
        e.keysecondary = e.keysecondary == null
          ? []
          : String(e.keysecondary).split(',').map(s => s.trim()).filter(Boolean);
      }
      if (e.key != null && !Array.isArray(e.key) && typeof e.key !== 'string') {
        e.key = String(e.key);
      }
      return e;
    });

    // Generation token invalidates stale debounced writes after a re-render
    // (delete/reorder), so writebacks can't clobber a shifted entry (#97).
    const gen = (this._loreGen = (this._loreGen || 0) + 1);

    // Get search filter
    const searchInput = $('#lorebookSearchInput');
    const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';

    if (entries.length === 0) {
      container.innerHTML = '<div class="text-center py-4" id="lorebookEmpty" style="color:var(--text-secondary);"><i class="bi bi-journal-text d-block mb-2" style="font-size: 2.5rem;color:var(--purple-400);"></i><span style="font-size:0.85rem;">' + I18n.t('editor.lorebookEmpty') + '</span></div>';
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
      container.innerHTML = '<div class="text-muted text-center py-3">' + (I18n.t ? I18n.t('editor.noEntriesMatch', { query: Ui.escapeHtml(searchQuery) }) : 'No entries match "' + Ui.escapeHtml(searchQuery) + '"') + '</div>';
      return;
    }

    container.innerHTML = '<div class="lorebook-accordion">'
      + filteredEntries.map(({ entry, idx }) => {
        // V2 treats keys as an array; older ST cards use a comma-joined string.
        // Normalize both so spec-conformant cards don't lose their keywords (#99).
        const keys = (Array.isArray(entry.key) ? entry.key : (entry.key || '').split(',')).map(s => String(s).trim()).filter(Boolean);
        const secondary = (entry.keysecondary || []);
        const label = entry.comment || (Array.isArray(entry.key) ? entry.key.join(', ') : entry.key) || (I18n.t ? I18n.t('editor.loreEntry', { num: idx + 1 }) : 'Entry ' + (idx + 1));

        const keyTagsHtml = keys.slice(0, 3).map(k =>
          '<span class="lorebook-key-tag primary">' + Ui.escapeHtml(k) + '</span>'
        ).join('') + secondary.slice(0, 2).map(k =>
          '<span class="lorebook-key-tag secondary">' + Ui.escapeHtml(k) + '</span>'
        ).join('');

        return '<div class="lorebook-accordion-item" data-entry-idx="' + idx + '">'
          + '<div class="lorebook-accordion-header" data-lore-toggle="' + idx + '" role="button" tabindex="0" aria-expanded="false">'
          + '<i class="bi bi-chevron-right lorebook-chevron"></i>'
          + '<span class="lorebook-entry-label">' + Ui.escapeHtml(label) + '</span>'
          + '<div class="lorebook-key-tags">' + keyTagsHtml + '</div>'
          + '<button class="btn btn-outline-danger btn-sm lorebook-delete-btn" data-idx="' + idx + '" title="' + (I18n.t ? I18n.t('editor.loreDeleteEntry') : 'Delete entry') + '"><i class="bi bi-trash"></i></button>'
          + '</div>'
          + '<div class="lorebook-accordion-body">'
          + '<div class="row g-2 mb-2" style="font-size:0.8rem;">'
          + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t('editor.lorePrimaryKeys') : 'Primary Keywords') + '</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr((Array.isArray(entry.key) ? entry.key.join(', ') : entry.key) || '') + '" placeholder="' + (I18n.t ? I18n.t('editor.lorePrimaryKeysPlaceholder') : 'Primary keywords \u2014 comma separated') + '" data-lore-key-idx="' + idx + '"></div>'
          + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t('editor.loreSecondaryKeys') : 'Secondary Keywords') + '</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr((entry.keysecondary || []).join(', ')) + '" placeholder="' + (I18n.t ? I18n.t('editor.loreSecondaryKeysPlaceholder') : 'Secondary keywords') + '" data-lore-secondary-idx="' + idx + '"></div>'
          + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t('editor.loreComment') : 'Comment') + '</label><input type="text" class="form-control form-control-sm" value="' + Ui.escapeAttr(entry.comment || '') + '" placeholder="' + (I18n.t ? I18n.t('editor.loreCommentPlaceholder') : 'Comment') + '" data-lore-comment-idx="' + idx + '"></div>'
          + '<div class="col-6"><label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t('editor.loreOrder') : 'Order') + '</label><input type="number" class="form-control form-control-sm" value="' + Ui.escapeAttr(entry.order ?? 100) + '" placeholder="' + (I18n.t ? I18n.t('editor.loreOrderPlaceholder') : 'Order') + '" data-lore-order-idx="' + idx + '"></div>'
          + '</div>'
          + '<div class="d-flex gap-3 mb-2" style="font-size:0.8rem;">'
          + '<div class="form-check"><input class="form-check-input" type="checkbox"' + (entry.constant ? ' checked' : '') + ' data-lore-constant-idx="' + idx + '"><label class="form-check-label">' + (I18n.t ? I18n.t('editor.loreConstant') : 'Constant') + '</label></div>'
          + '<div class="form-check"><input class="form-check-input" type="checkbox"' + (entry.selective ? ' checked' : '') + ' data-lore-selective-idx="' + idx + '"><label class="form-check-label">' + (I18n.t ? I18n.t('editor.loreSelective') : 'Selective') + '</label></div>'
          + '<select class="form-select form-select-sm" style="width:auto;" data-lore-position-idx="' + idx + '">'
          + '<option value="before_char"' + (entry.position === 'before_char' ? ' selected' : '') + '>' + (I18n.t ? I18n.t('editor.loreBeforeChar') : 'Before char') + '</option>'
          + '<option value="after_char"' + (entry.position === 'after_char' ? ' selected' : '') + '>' + (I18n.t ? I18n.t('editor.loreAfterChar') : 'After char') + '</option></select>'
          + '</div>'
          + '<label class="form-label" style="font-size:0.72rem;">' + (I18n.t ? I18n.t('editor.loreContent') : 'Content') + '</label>'
          + '<textarea class="form-control editor-textarea font-mono" rows="6" placeholder="' + (I18n.t ? I18n.t('editor.loreContentPlaceholder') : 'Entry content...') + '" data-lore-idx="' + idx + '">' + Ui.escapeHtml(entry.content || '') + '</textarea>'
          + '</div>'
          + '</div>';
      }).join('')
      + '</div>';

    // Accordion toggle handlers (mouse + keyboard, #72)
    container.querySelectorAll('[data-lore-toggle]').forEach(header => {
      const toggle = (e) => {
        if (e.target.closest('.lorebook-delete-btn')) return;
        const item = header.closest('.lorebook-accordion-item');
        if (item) {
          item.classList.toggle('open');
          header.setAttribute('aria-expanded', item.classList.contains('open') ? 'true' : 'false');
        }
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
      });
    });

    const self = this;
    container.querySelectorAll('.lorebook-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        window.AppState.activeCard.character_book.entries.splice(parseInt(btn.dataset.idx), 1);
        self.renderLorebook(window.AppState.activeCard);
        await self.syncEditorToCard();
      });
    });
    const loreFields = container.querySelectorAll('textarea[data-lore-idx], input[data-lore-key-idx], input[data-lore-secondary-idx], input[data-lore-comment-idx], input[data-lore-order-idx]');
    loreFields.forEach(fld => {
      fld.addEventListener('focus', () => { self._lastSnapField = null; });
      fld.addEventListener('beforeinput', () => {
        if (self._lastSnapField !== 'lorebook') {
          self._snapshotSub('lorebook');
          self._lastSnapField = 'lorebook';
        }
      });
    });
    container.querySelectorAll('textarea[data-lore-idx]').forEach(ta => {
      ta.addEventListener('input', Ui.debounce(async () => {
        if (!ta.isConnected || gen !== self._loreGen) return; // re-render superseded this write
        const idx = parseInt(ta.dataset.loreIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].content = ta.value;
          await self.syncEditorToCard();
          self.autoResizeTextareas();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-key-idx]').forEach(input => {
      input.addEventListener('input', Ui.debounce(async () => {
        if (!input.isConnected || gen !== self._loreGen) return;
        const idx = parseInt(input.dataset.loreKeyIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].key = input.value.trim();
          await self.syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-secondary-idx]').forEach(input => {
      input.addEventListener('input', Ui.debounce(async () => {
        if (!input.isConnected || gen !== self._loreGen) return;
        const idx = parseInt(input.dataset.loreSecondaryIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].keysecondary = input.value.split(',').map(s => s.trim()).filter(Boolean);
          await self.syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-comment-idx]').forEach(input => {
      input.addEventListener('input', Ui.debounce(async () => {
        if (!input.isConnected || gen !== self._loreGen) return;
        const idx = parseInt(input.dataset.loreCommentIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].comment = input.value;
          await self.syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-order-idx]').forEach(input => {
      input.addEventListener('input', Ui.debounce(async () => {
        if (!input.isConnected || gen !== self._loreGen) return;
        const idx = parseInt(input.dataset.loreOrderIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          const parsed = parseInt(input.value, 10);
          window.AppState.activeCard.character_book.entries[idx].order = Number.isNaN(parsed) ? 100 : parsed;
          await self.syncEditorToCard();
        }
      }, 600));
    });
    container.querySelectorAll('input[data-lore-constant-idx]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const idx = parseInt(cb.dataset.loreConstantIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].constant = cb.checked;
          await self.syncEditorToCard();
        }
      });
    });
    container.querySelectorAll('input[data-lore-selective-idx]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const idx = parseInt(cb.dataset.loreSelectiveIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].selective = cb.checked;
          await self.syncEditorToCard();
        }
      });
    });
    container.querySelectorAll('select[data-lore-position-idx]').forEach(sel => {
      sel.addEventListener('change', async () => {
        const idx = parseInt(sel.dataset.lorePositionIdx);
        if (window.AppState.activeCard.character_book.entries[idx]) {
          window.AppState.activeCard.character_book.entries[idx].position = sel.value;
          await self.syncEditorToCard();
        }
      });
    });
  },

  async addLorebookEntry() {
    const { activeCard } = window.AppState;
    if (!activeCard) return;
    if (!activeCard.character_book) activeCard.character_book = { entries: [] };
    if (!activeCard.character_book.entries) activeCard.character_book.entries = [];
    activeCard.character_book.entries.push({ key: I18n.t ? I18n.t('editor.loreNewEntry') : 'New Entry', content: '', keysecondary: [], constant: false, selective: false, position: 'after_char', order: 100, comment: '' });
    this.renderLorebook(activeCard);
    await this.syncEditorToCard();
  },
};

window.Editor = Editor;
