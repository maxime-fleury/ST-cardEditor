// @ts-check
/* ============================================================
   cardManager.js — Card List Rendering, Selection, CRUD
   ============================================================ */

// Module dependencies (ES imports — window.* exports kept for compat).
import { I18n } from './i18n.js';
import { Ui } from './ui.js';
import { Anims } from './animations.js';
import { CardStorage } from './storage.js';
import { CardEngine } from './cardEngine.js';
import { Editor } from './editor.js';
import { ExportUtils } from './exportUtils.js';
import { AiChat } from './aiChat.js';
import { CardState } from './cardState.js';
import { ChatState } from './chatState.js';
import { CardSearch } from './cardSearch.js';
import { CardHealth } from './cardHealth.js';

// Same debounce delay as ui.js's DEBOUNCE_SEARCH_MS. Kept as a local copy
// instead of an import: index.html loads the modules with ?v= cache-busters,
// so an import specifier (bare path) would evaluate ui.js twice, registering
// duplicate init() listeners. A future bundle step can unify these.
const DEBOUNCE_SEARCH_MS = 300;

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
    CardState.cards = CardStorage.getCards();
  },

  handleFileSelect(e) {
    if (e.target.files?.length) {
      // Snapshot the FileList: resetting input.value below empties the live
      // list, so the async loop would otherwise only ever import the first
      // file (the multi-file Browse path silently dropped the rest).
      this.processFiles(Array.from(e.target.files));
    }
    e.target.value = '';
  },

  async processFiles(fileList) {
    const validExts = ['png', 'webp', 'json'];
    let loaded = 0, errors = 0, lastCardId = '';

    for (const file of fileList) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!validExts.includes(ext)) { errors++; continue; }
      try {
        const card = await CardEngine.parseFile(file);
        // Auto-rename exact duplicates (same name + same content) so
        // re-importing a card never silently creates two identical entries.
        if (await this._ensureUniqueImportName(card)) {
          Ui.showToast(I18n.t('toast.importDupe', { name: card.name }), 'info');
        }
        if (card._imageBase64) {
          // Soft-warn on very large embedded images so users can trim them
          // before they silently consume the IndexedDB quota.
          const approxBytes = Math.round(card._imageBase64.length * 3 / 4);
          if (approxBytes > 5 * 1024 * 1024) {
            Ui.showToast(I18n.t('toast.largeImage', { name: file.name, size: (approxBytes / (1024 * 1024)).toFixed(1) }), 'warning');
          }
          await CardStorage.saveImage(card._id, card._imageBase64);
        }
        await CardStorage.upsertCard(card);
        lastCardId = card._id || '';
        loaded++;
      } catch (err) {
        console.error('Parse error:', file.name, err);
        errors++;
        Ui.showToast(I18n.t('toast.loadFailed', { name: file.name + ' — ' + err.message }), 'danger');
      }
    }

    if (loaded > 0) {
      CardState.cards = CardStorage.getCards();
      this.renderCardList();
      if (loaded === 1 && lastCardId) {
        const meta = CardState.cards.find(c => c._id === lastCardId);
        if (meta) await this.selectCard(meta);
      }
      Ui.showToast(I18n.t('toast.loaded', { count: loaded }), 'success');
    }
    if (errors > 0 && loaded === 0)
      Ui.showToast(I18n.t('toast.noValid'), 'warning');
  },

  _cardListBound: false,

  /**
   * Content signature used to detect exact duplicate imports. Delegates to
   * CardEngine: storage.js records the version history with the same function,
   * and it cannot import this store without a cycle.
   */
  _cardSignature(card) {
    return CardEngine.cardSignature(card);
  },

  // Rename an imported card when an identical one already exists so re-imports
  // never silently duplicate (#38). Mutates the card in place and reports
  // whether a rename happened (so callers can surface it to the user).
  async _ensureUniqueImportName(card) {
    const trimmedName = (card.name || '').trim();
    if (!trimmedName) return false;
    const existing = CardStorage.getCards().find(c => (c.name || '').trim().toLowerCase() === trimmedName.toLowerCase());
    if (!existing) return false;
    let existingFull = null;
    try { existingFull = await CardStorage.getCard(existing._id); } catch (_) {}
    if (!existingFull || this._cardSignature(card) !== this._cardSignature(existingFull)) return false;
    const base = trimmedName;
    let n = 2;
    const used = new Set(CardStorage.getCards().map(c => (c.name || '').toLowerCase()));
    let candidate = base + ' (' + n + ')';
    while (used.has(candidate.toLowerCase())) { n++; candidate = base + ' (' + n + ')'; }
    card.name = candidate;
    return true;
  },

  // Lowercased string set of a card's tags, tolerant of malformed values so
  // a stray numeric/null tag can never crash search or filtering.
  _tagSet(card) {
    return new Set((card.tags || []).map(t => String(t == null ? '' : t).trim().toLowerCase()).filter(Boolean));
  },

  _searchQuery: '',
  _selectedIds: new Set(),
  // Default matches the default <option> (Manual) in the sort dropdown, so the
  // displayed selection and the applied order agree on first load and
  // drag-to-reorder works immediately. Persisted across reloads (see ui.js).
  _sortMode: 'manual',
  _activeTagFilters: new Set(),
  // Letter-groups the user collapsed; kept so a re-render (search/filter/sort)
  // doesn't silently re-expand them mid-session.
  _collapsedGroups: new Set(),

  /**
   * Persist the library view (query, tag filters, collapsed groups). The sort
   * mode was already persisted while these three reset on every reload — an
   * inconsistency users notice as "my filters are gone" (the query is only
   * restored together with the input text, see ui.js, so a filtered library is
   * never invisible).
   */
  _persistLibraryView() {
    if (!CardStorage.setLibraryView) return;
    CardStorage.setLibraryView({
      query: this._searchQuery,
      tags: [...this._activeTagFilters],
      collapsed: [...this._collapsedGroups],
    });
  },

  /** Restore the persisted library view (called once, before the first render). */
  restoreLibraryView() {
    if (!CardStorage.getLibraryView) return;
    const view = CardStorage.getLibraryView();
    if (!view || typeof view !== 'object') return;
    if (typeof view.query === 'string') this._searchQuery = view.query;
    if (Array.isArray(view.tags)) this._activeTagFilters = new Set(view.tags.filter(t => typeof t === 'string' && t));
    if (Array.isArray(view.collapsed)) this._collapsedGroups = new Set(view.collapsed.filter(l => typeof l === 'string'));
  },

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
    if (this._selectedIds.size > 0) {
      toolbar.classList.remove('d-none');
      if (count) count.textContent = I18n.t('left.selected', { count: this._selectedIds.size });
      // Show compare button only when exactly 2 cards are selected
      if (compareBtn) compareBtn.classList.toggle('d-none', this._selectedIds.size !== 2);
    } else {
      toolbar.classList.add('d-none');
    }
  },

  async batchDelete() {
    if (this._selectedIds.size === 0) { Ui.showToast(I18n.t('toast.noSelected'), 'info'); return; }
    if (!await Ui.confirm({
      title: I18n.t('batch.deleteTitle', { count: this._selectedIds.size }),
      message: I18n.t('batch.deleteConfirm', { count: this._selectedIds.size }),
      buttonLabel: I18n.t('dialog.delete'),
    })) return;
    // Capture what `deleteCard` is about to drop (content, artwork, chat) BEFORE
    // deleting, so undo restores the cards themselves and not empty shells.
    const ids = [...this._selectedIds];
    const snapshots = [];
    for (const id of ids) {
      const snap = await CardStorage.snapshotForDelete(id);
      if (snap) snapshots.push(snap);
    }
    if (!await this._deleteCards(ids)) return;
    this._selectedIds.clear();
    this._updateBatchToolbar();
    this.renderCardList();
    this._showUndoToast({
      message: I18n.t('toast.cardsDeleted'),
      onUndo: async () => {
        for (const snap of snapshots) await CardStorage.restoreDeleted(snap);
        CardState.cards = CardStorage.getCards();
        this.renderCardList();
        Ui.showToast(I18n.t('toast.cardsRestored', { count: snapshots.length }), 'success');
      },
    });
  },

  async batchCompare() {
    if (this._selectedIds.size !== 2) { Ui.showToast((I18n.t ? I18n.t('batch.select2ForCompare') : 'Select exactly 2 cards to compare'), 'info'); return; }
    const [idA, idB] = [...this._selectedIds];
    const cardA = await CardStorage.getCard(idA);
    const cardB = await CardStorage.getCard(idB);
    if (!cardA || !cardB) { Ui.showToast((I18n.t ? I18n.t('batch.compareLoadFailed') : 'Failed to load cards for comparison'), 'danger'); return; }

    const fallback = (key, text) => (I18n.t ? I18n.t(key) : text);
    this._showComparison(
      '<i class="bi bi-layout-sidebar-inset me-2 text-accent"></i>'
        + fallback('batch.comparePrefix', 'Compare: ') + Ui.escapeHtml(cardA.name || fallback('batch.cardA', 'Card A'))
        + fallback('batch.compareVs', ' vs ') + Ui.escapeHtml(cardB.name || fallback('batch.cardB', 'Card B')),
      CardEngine.toJSON(cardA),
      CardEngine.toJSON(cardB),
    );
  },

  /**
   * Read-only two-column diff in the AI preview modal. Both `batchCompare` and
   * the version history show one, and the read-only setup is subtle enough to
   * deserve a single home: a stray visible "Apply all" would let a click apply
   * pending AI changes from inside a comparison.
   */
  _showComparison(titleHtml, jsonA, jsonB) {
    const oldEl = document.querySelector('#aiDiffOld');
    const newEl = document.querySelector('#aiDiffNew');
    const titleEl = document.querySelector('#aiPreviewModal .modal-title');
    if (!oldEl || !newEl) return;
    if (titleEl) titleEl.innerHTML = titleHtml;

    // Reuse the existing diff renderer
    AiChat._renderDiff(jsonA, jsonB);

    // Hide accept/discard/apply-all buttons (comparison is read-only).
    // Apply-all must be hidden too: its click handler may still be attached
    // from a previous Review & Apply run, and leaving it visible would let a
    // click apply pending AI changes from inside the comparison modal.
    const acceptBtn = document.querySelector('#btnAcceptAI');
    const discardBtn = document.querySelector('#btnDiscardAI');
    const applyAllBtn = document.querySelector('#btnApplyAll');
    if (acceptBtn) acceptBtn.classList.add('d-none');
    if (discardBtn) discardBtn.classList.add('d-none');
    if (applyAllBtn) applyAllBtn.classList.add('d-none');
    // Detach any leftover Review & Apply handlers bound to this modal so the
    // comparison can never trigger an apply (Enter/A/←/→ or the hidden
    // buttons' listeners).
    if (AiChat._previewCleanup) { try { AiChat._previewCleanup(); } catch (_) {} }
    // Prev/Next nav belongs to AI apply, not comparison — hide any leftover.
    const applyNav = document.querySelector('#applyNavGroup');
    if (applyNav) applyNav.style.display = 'none';

    // Reuse a single Modal instance — constructing one per open re-runs
    // _addEventListeners() and stacks backdrop/Escape handlers (#32/#104).
    const modal = (this._aiPreviewModal = this._aiPreviewModal || new bootstrap.Modal('#aiPreviewModal'));
    // Restore button visibility on close
    const modalEl = document.querySelector('#aiPreviewModal');
    if (!modalEl) return;
    const restoreButtons = () => {
      if (acceptBtn) acceptBtn.classList.remove('d-none');
      if (discardBtn) discardBtn.classList.remove('d-none');
      if (applyAllBtn) applyAllBtn.classList.remove('d-none');
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
        // Strip internal metadata + huge base64 image from the JSON export,
        // mirroring how single-card toJSON treats internals.
        delete clone._id;
        delete clone._filename;
        delete clone._createdAt;
        delete clone._fileSize;
        delete clone._thumbnail;
        delete clone._imageBase64;
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
        sorted.sort((a, b) => (b._createdAt || 0) - (a._createdAt || 0));
        break;
      case 'oldest':
        sorted.sort((a, b) => (a._createdAt || 0) - (b._createdAt || 0));
        break;
      case 'largest':
        sorted.sort((a, b) => (b._fileSize || 0) - (a._fileSize || 0));
        break;
      case 'smallest':
        sorted.sort((a, b) => (a._fileSize || 0) - (b._fileSize || 0));
        break;
      case 'manual':
        // Keep the current index order (including drag-reorders) as-is. The
        // input is already search/tag-filtered by the caller, so no sorting or
        // extra-append logic belongs here — appending would re-add cards that
        // the active filter excluded.
        break;
    }
    return sorted;
  },

  /**
   * Whether a manual reorder is meaningful right now, explaining why not.
   * Two cases make the visible order diverge from the stored index order: an
   * active search/tag filter (the list shows a subset) and any sort mode other
   * than Manual (the list is re-sorted, so a move would silently reshuffle a
   * hidden order). Shared by drag & drop and the keyboard arrows so both refuse
   * in exactly the same situations.
   */
  _canReorder() {
    if (this._searchQuery || this._activeTagFilters.size > 0) {
      Ui.showToast(I18n.t('toast.reorderFiltered'), 'info');
      return false;
    }
    if (this._sortMode !== 'manual') {
      Ui.showToast(I18n.t('toast.reorderManual'), 'info');
      return false;
    }
    return true;
  },

  /**
   * Move a card by `delta` slots in the stored manual order (the keyboard path
   * — drag & drop drops onto a target row instead). Re-renders because the
   * reorder changes the DOM order, then restores focus to the same handle: the
   * re-render replaces every node, so without this the second arrow press
   * would go nowhere.
   */
  _moveCardBy(id, delta) {
    if (!id || !this._canReorder()) return;
    const list = CardState.cards;
    const from = list.findIndex(c => c._id === id);
    if (from < 0) return;
    const to = from + delta;
    if (to < 0 || to >= list.length) return;
    const [moved] = list.splice(from, 1);
    if (!moved) return;
    list.splice(to, 0, moved);
    CardStorage.saveCardIndex(list);
    this.renderCardList();
    const handle = document.querySelector('.card-drag-handle[data-card-id="' + id + '"]');
    if (handle && typeof handle.focus === 'function') handle.focus();
  },

  // ─── TAG CLOUD ────────────────────────────────────────
  _renderTagCloud() {
    const tagCloudEl = document.querySelector('#tagCloud');
    if (!tagCloudEl) return;

    const tagCounts = {};
    (CardState.cards || []).forEach(c => {
      (c.tags || []).forEach(t => {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      });
    });

    const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

    if (sortedTags.length === 0) {
      tagCloudEl.innerHTML = '<span style="font-size:0.68rem;color:var(--text-muted);">' + I18n.t('gen.untagged') + '</span>';
      return;
    }

    // <button>, not <span>: the chips filter the list, so they must be reachable
    // with Tab and activatable with Enter/Space. aria-pressed carries the
    // on/off state that the `.active` class only shows visually.
    tagCloudEl.innerHTML = sortedTags.map(([tag, count]) => {
      const isActive = this._activeTagFilters.has(tag);
      return '<button type="button" class="tag-chip' + (isActive ? ' active' : '') + '" data-tag="' + Ui.escapeAttr(tag) + '"'
        + ' aria-pressed="' + isActive + '">'
        + Ui.escapeHtml(tag)
        + ' <span class="tag-count" aria-hidden="true">' + count + '</span>'
        + '</button>';
    }).join('');

    tagCloudEl.querySelectorAll('.tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (this._activeTagFilters.has(tag)) {
          this._activeTagFilters.delete(tag);
        } else {
          this._activeTagFilters.add(tag);
        }
        this._persistLibraryView();
        this.renderCardList();
      });
    });
  },

  /**
   * "Found in <field>" badge + snippet for a full-text hit. The snippet is raw
   * card text, so each slice is escaped on its own before the matched span is
   * wrapped in <mark> — escaping the joined string first would break the
   * offsets the index reported.
   */
  _matchHtml(match) {
    const label = I18n.t(match.labelKey);
    const { snippet, snippetMatchStart: start, snippetMatchLength: len } = match;
    let body;
    if (len > 0 && start >= 0 && start + len <= snippet.length) {
      body = Ui.escapeHtml(snippet.slice(0, start))
        + '<mark>' + Ui.escapeHtml(snippet.slice(start, start + len)) + '</mark>'
        + Ui.escapeHtml(snippet.slice(start + len));
    } else {
      body = Ui.escapeHtml(snippet);
    }
    return '<div class="card-list-match"><span class="card-match-field">' + Ui.escapeHtml(label) + '</span>'
      + '<span class="card-match-snippet">' + body + '</span></div>';
  },

  // One row of the library list (shared by flat and grouped rendering).
  _rowHtml(card, activeCard, match) {
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
      + '</div>'
      + (match ? this._matchHtml(match) : '')
      + '</div>'
      + '<button type="button" class="card-preview-btn" data-card-id="' + card._id + '" title="' + (I18n.t ? I18n.t('preview.open') : 'Preview card') + '" aria-label="' + (I18n.t ? I18n.t('preview.open') : 'Preview card') + '"><i class="bi bi-eye"></i></button>'
      + '<input type="checkbox" class="card-batch-check" data-card-id="' + card._id + '"' + (isBatch ? ' checked' : '') + '>'
      // The handle is also the keyboard reorder control: `role="button"` +
      // tabindex makes the arrow-key shortcut reachable, since drag & drop is
      // pointer-only. `draggable` still drives the mouse path.
      + '<span class="card-drag-handle" draggable="true" data-card-id="' + card._id + '"'
      + ' role="button" tabindex="0" aria-label="' + Ui.escapeAttr(I18n.t('library.reorderHandle')) + '">'
      + '<i class="bi bi-grip-vertical" aria-hidden="true"></i></span>'
      + (card.spec_version ? '<span class="card-list-badge bg-purple">v' + Ui.escapeHtml(card.spec_version) + '</span>' : '')
      + '<div class="card-preview-tooltip">'
      + (thumb ? '<img class="preview-avatar" src="' + Ui.escapeAttr(thumb) + '" alt="">' : '')
      + '<div class="fw-semibold">' + Ui.escapeHtml(card.name || I18n.t('gen.unnamed')) + '</div>'
      + (card.creator ? '<div class="text-muted" style="font-size:0.7rem;">' + I18n.t('gen.byCreator', { name: Ui.escapeHtml(card.creator) }) + '</div>' : '')
      + (desc ? '<div class="preview-desc">' + Ui.escapeHtml(desc) + '</div>' : '')
      + '</div></div>';
  },

  // Glued first-letter group headers when sorted by name; flat otherwise.
  _groupCards(list) {
    // While searching, the list is ordered by relevance — letter headers would
    // re-bucket it and hide the ranking, so search results stay flat.
    if (this._searchQuery) return [{ letter: '', items: list }];
    if (this._sortMode !== 'name-asc' && this._sortMode !== 'name-desc') {
      return [{ letter: '', items: list }];
    }
    const groups = []; const byLetter = new Map();
    for (const card of list) {
      const name = (card.name || '').trim();
      const ch = name ? name[0] : '';
      let letter = '#';
      if (/[A-Za-z0-9]/.test(ch)) letter = ch.toUpperCase();
      let g = byLetter.get(letter);
      if (!g) { g = { letter, items: [] }; byLetter.set(letter, g); groups.push(g); }
      g.items.push(card);
    }
    if (this._sortMode === 'name-desc') {
      groups.sort((a, b) => (a.letter < b.letter ? 1 : a.letter > b.letter ? -1 : 0));
    }
    return groups;
  },

  // Compact `#tag` quick-filter chips above the tag cloud (handles big libraries).
  _renderTagChipStrip() {
    const el = document.querySelector('#tagChipStrip');
    if (!el) return;
    const counts = {};
    (CardState.cards || []).forEach(c => (c.tags || []).forEach(t => counts[t] = (counts[t] || 0) + 1));
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (sorted.length === 0) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    el.innerHTML = sorted.map(([tag]) => {
      const active = this._activeTagFilters.has(tag);
      return '<button type="button" class="tag-chip-strip-chip' + (active ? ' active' : '') + '" data-tag="' + Ui.escapeAttr(tag) + '">#' + Ui.escapeHtml(tag) + '</button>';
    }).join('')
      + (this._activeTagFilters.size ? '<button type="button" class="tag-chip-strip-clear" data-clear="1" aria-label="Clear filters">×</button>' : '');
    el.querySelectorAll('.tag-chip-strip-chip, .tag-chip-strip-clear').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.clear) this._activeTagFilters.clear();
        else { const t = btn.dataset.tag; this._activeTagFilters.has(t) ? this._activeTagFilters.delete(t) : this._activeTagFilters.add(t); }
        this._persistLibraryView();
        this.renderCardList();
      });
    });
  },

  /** Is a query or a tag filter narrowing the list right now? */
  _filterActive() {
    return !!this._searchQuery || this._activeTagFilters.size > 0;
  },

  renderCardList() {
    const $ = Ui.$;
    const { cards, activeCard } = CardState;
    const container = $('#cardList');
    const emptyState = $('#emptyState');
    const searchWrap = $('#cardSearchWrap');
    const controlsWrap = $('#libraryControls');

    // Show the search box and the sort/tag controls as soon as there is a card.
    // The old 4-card threshold predates the full-text index: it hid a search
    // that now indexes every field, and it hid *sorting* for no reason at all.
    const hasCards = cards.length > 0;
    if (searchWrap) searchWrap.style.display = hasCards ? '' : 'none';
    if (controlsWrap) controlsWrap.style.display = hasCards ? '' : 'none';

    this._renderTagCloud();
    this._renderTagChipStrip();

    this._bindCardEvents();

    let filtered = cards;

    // Tag filter first: the full-text pass below is restricted to this set, so
    // a tag filter and a query compose (AND) instead of one overriding the
    // other.
    if (this._activeTagFilters.size > 0) {
      filtered = filtered.filter(c => {
        const cardTags = this._tagSet(c);
        for (const filter of this._activeTagFilters) {
          if (!cardTags.has(filter.toLowerCase())) return false;
        }
        return true;
      });
    }

    // Text search — full-text across every field and the lorebook, ranked by
    // relevance (name > creator/tags > body). Ranked order replaces the sort
    // dropdown while a query is active; the dropdown still governs the
    // unsearched list.
    /** @type {Map<string, SearchHit> | null} */
    let hits = null;
    let capped = false;
    if (this._searchQuery) {
      const allow = new Set(filtered.map(c => String(c._id || '')).filter(Boolean));
      const results = CardSearch.search(this._searchQuery, { allow });
      capped = results.length >= CardSearch.MAX_RESULTS;
      hits = new Map(results.map(h => [h.id, h]));
      const byId = new Map(filtered.map(c => [c._id, c]));
      filtered = results.map(h => byId.get(h.id)).filter(c => !!c);
    } else {
      filtered = this._sortCards(filtered);
    }

    // The count has to describe what is on screen: with a query or a tag filter
    // active, the whole-library total is simply wrong (and now that both persist
    // across reloads, it would be wrong on first paint).
    $('#cardCount').textContent = this._filterActive()
      ? I18n.t('search.results', { count: filtered.length })
      : I18n.t('left.cards', { count: cards.length });

    if (filtered.length === 0 && (this._searchQuery || this._activeTagFilters.size > 0)) {
      container.innerHTML = '<div class="text-center text-muted py-4">' + I18n.t('gen.noMatch') + '</div>';
      emptyState.style.display = 'none';
      return;
    }
    if (filtered.length === 0) { container.innerHTML = ''; emptyState.style.display = 'flex'; return; }
    emptyState.style.display = 'none';

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    container.innerHTML = (capped
      ? '<div class="search-notice">' + I18n.t('search.capped', { count: CardSearch.MAX_RESULTS }) + '</div>'
      : '')
      + this._groupCards(filtered).map(group => {
      const rows = group.items.map(card => this._rowHtml(card, activeCard, hits ? hits.get(card._id) : null)).join('');
      const collapsed = group.letter ? this._collapsedGroups.has(group.letter) : false;
      return '<div class="card-list-group" data-letter="' + Ui.escapeAttr(group.letter) + '">'
        + (group.letter
            ? '<button type="button" class="card-group-header" data-letter="' + Ui.escapeAttr(group.letter) + '" aria-expanded="' + (collapsed ? 'false' : 'true') + '"><span class="card-group-letter">' + Ui.escapeHtml(group.letter) + '</span><span class="card-group-count">' + group.items.length + '</span></button>'
            : '')
        + '<div class="card-group-body' + (collapsed ? ' collapsed' : '') + '">' + rows + '</div>'
        + '</div>';
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

    // Hover tooltip enrichment: meta cards carry no description, so fetch the
    // full card once (cached) and fill the tooltip's description line.
    if (!this._previewHoverBound && container) {
      this._previewHoverBound = true;
      container.addEventListener('mouseover', (e) => {
        const item = e.target.closest('.card-list-item');
        if (!item) return;
        const descEl = item.querySelector('.preview-desc');
        if (!descEl || descEl.dataset.filled) return;
        const id = item.dataset.cardId;
        if (this._readPreview(id)) { this._fillTooltipDesc(descEl, id); return; }
        CardStorage.getCard(id).then((full) => {
          if (full) { this._cachePreview(full); this._fillTooltipDesc(descEl, id); }
        }).catch(() => {});
      });
    }

    if (!this._cardListBound && container) {
      this._cardListBound = true;
      container.addEventListener('click', (e) => {
        const groupHeader = e.target.closest('.card-group-header');
        if (groupHeader) {
          const letter = groupHeader.dataset.letter;
          const body = groupHeader.parentElement && groupHeader.parentElement.querySelector('.card-group-body');
          if (body) {
            const collapsed = body.classList.toggle('collapsed');
            groupHeader.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            // Persist so a re-render (search/filter/sort) keeps the group collapsed.
            if (collapsed) this._collapsedGroups.add(letter);
            else this._collapsedGroups.delete(letter);
            this._persistLibraryView();
          }
          return;
        }
        const previewBtn = e.target.closest('.card-preview-btn');
        if (previewBtn) {
          e.stopPropagation();
          CardManager.showCardPreview(previewBtn.dataset.cardId);
          return;
        }
        const checkbox = e.target.closest('.card-batch-check');
        if (checkbox) {
          e.stopPropagation();
          CardManager._toggleBatchSelect(checkbox.dataset.cardId);
          return;
        }
        const item = e.target.closest('.card-list-item');
        if (!item) return;
        const card = CardState.cards.find(c => c._id === item.dataset.cardId);
        if (card) CardManager.selectCard(card);
      });
      const searchInput = $('#cardSearchInput');
      if (searchInput) {
        searchInput.addEventListener('input', Ui.debounce(async () => {
          this._searchQuery = searchInput.value.trim();
          this._persistLibraryView();
          // Fill the index BEFORE rendering: the index may still be cold (first
          // search of the session) or hold a card that was just imported, and
          // rendering cold-then-warm animated the whole result set twice.
          try { await CardSearch.ensure((id) => CardStorage.getCard(id)); } catch (_) { /* render what we have */ }
          this.renderCardList();
        }, DEBOUNCE_SEARCH_MS));
      }

      let dragId = null;
      container.addEventListener('dragstart', (e) => {
        const handle = e.target.closest('.card-drag-handle');
        if (!handle) return;
        dragId = handle.dataset.cardId;
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
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
        // Same guard as the keyboard path: reordering by DOM position corrupts
        // the stored order under an active filter or a non-manual sort.
        if (!this._canReorder()) {
          dragId = null;
          return;
        }
        const dropId = item.dataset.cardId;
        if (dragId === dropId) return;
        const dropCards = CardState.cards;
        const fromIdx = dropCards.findIndex(c => c._id === dragId);
        const toIdx = dropCards.findIndex(c => c._id === dropId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = dropCards.splice(fromIdx, 1);
        if (!moved) return; // splice already removed it; nothing left to re-insert
        const adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx;
        dropCards.splice(adjustedTo, 0, moved);
        CardStorage.saveCardIndex(dropCards);
        this.renderCardList();
        dragId = null;
      });
      container.addEventListener('dragend', () => {
        const dragItem = container.querySelector('.card-list-item[style*="scale"]');
        if (dragItem) { dragItem.style.transform = ''; dragItem.style.opacity = ''; }
        dragId = null;
      });

      // Keyboard equivalent of drag & drop (delegated: the rows are rebuilt on
      // every render). Arrow keys move the card; the handle is the only
      // focusable part of a row, so this cannot fight with list navigation.
      container.addEventListener('keydown', (e) => {
        const handle = e.target.closest('.card-drag-handle');
        if (!handle) return;
        if (e.key === 'ArrowUp') { e.preventDefault(); this._moveCardBy(handle.dataset.cardId, -1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); this._moveCardBy(handle.dataset.cardId, 1); }
        else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); }
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
    const { activeCard } = CardState;
    const { isAiLoading } = ChatState;
    // Abort any ongoing AI generation when switching cards
    if (isAiLoading) {
      AiChat._abortAll();
      AiChat._bumpGen(); // invalidate the aborted run's callbacks (mirror retry/clear)
      ChatState.isAiLoading = false;
      AiChat.updateSendButton();
    }
    if (activeCard && activeCard._id !== cardMeta._id) await Editor.syncEditorToCard();
    const fullCard = await CardStorage.getCard(cardMeta._id);
    if (!fullCard) return;
    // Legacy damage repair: fields may still contain a whole card JSON (dumped
    // there by the old broken editor). Unwrap them once, on load, so prompts,
    // diffs and the editor stop re-seeing the JSON. A failed persistence (e.g.
    // quota exceeded) must NOT abort the selection: the in-memory card is
    // already repaired and the next save will persist it.
    // Repair legacy damage before the card becomes active: unwrap whole-card
    // JSON blobs stuck in a field, and normalize {user}/{char} placeholders
    // into their canonical {{user}}/{{char}} form (any casing, one/two braces).
    const jsonRepaired = AiChat._repairStoredCardJSON(fullCard);
    const phRepaired = AiChat._repairStoredPlaceholders(fullCard);
    if (jsonRepaired > 0 || phRepaired > 0) {
      try {
        await CardStorage.upsertCard(fullCard);
        const notes = [];
        if (jsonRepaired > 0) notes.push(I18n.t('toast.jsonCleaned', { count: jsonRepaired }));
        if (phRepaired > 0) notes.push(I18n.t('toast.placeholdersFixed', { count: phRepaired }));
        Ui.showToast(notes.join(' · '), 'info');
      } catch (e) {
        console.error('cardManager: failed to persist repaired card:', e);
      }
    }
    CardState.activeCard = fullCard;
    CardStorage.setActiveCardId(fullCard._id);

    // Pending AI responses and chat sessions belong to a single card: never
    // let a stale apply-queue entry, session ID, callback or rendered flag
    // bleed into the new card. _resetChat is the single full reset.
    AiChat._resetChat();

    try {
      const b64 = await CardStorage.getImage(fullCard._id);
      // Re-read the CURRENT active card: the destructured `activeCard` above
      // predates the `CardState.activeCard = fullCard` reassignment, so mutating
      // it would attach the image to the previous card (or drop it).
      const imgCard = CardState.activeCard;
      if (b64 && imgCard) imgCard._imageBase64 = b64;
    } catch (e) {
      console.error('Failed to load image from IndexedDB:', e);
    }

    const cardHistory = CardStorage.getChatHistory(fullCard._id);
    ChatState.history = cardHistory;
    // Load the latest session's messages if available
    const sessions = CardStorage.getChatSessions(fullCard._id);
    if (sessions.length > 0) {
      const latestSession = sessions[0]; // sessions are sorted newest first
      const sessionMessages = CardStorage.getSessionMessages(fullCard._id, latestSession.id);
      if (sessionMessages.length > 0) {
        ChatState.history = sessionMessages;
        AiChat._setCurrentSession(latestSession.id);
      } else {
        // Fallback: migrate THIS card's own chat history into a session. The
        // history above was re-read for fullCard._id, so a previous card's
        // conversation can never be copied into this card's session.
        AiChat._setCurrentSession(latestSession.id);
        CardStorage.saveSessionMessages(fullCard._id, latestSession.id, cardHistory);
      }
    }
    AiChat.renderChatHistory(); // _resetChat already cleared the rendered flag
    Editor.populateEditor(fullCard);
    this.renderCardList();
    Ui.setDirty(false);
    Ui.updateUIState();
    AiChat.updateContextBar();
    // Autofocus the AI input for the quick editing workflow — but only if the
    // user has not moved on in the meantime. The delay makes this a real race:
    // this runs 100 ms after the switch, so clicking an editor field in that
    // window used to lose the caret mid-typing (and the field's own click was
    // silently undone). Clicking a card row does not focus anything (the rows
    // are not focusable), so the normal path still lands focus on the AI input.
    setTimeout(() => {
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused !== document.documentElement) return;
      const aiInput = document.querySelector('#aiInput');
      if (aiInput) aiInput.focus();
    }, 100);
  },

  async createNewCard() {
    const { activeCard } = CardState;
    if (activeCard) await Editor.syncEditorToCard();
    const card = CardEngine.createEmptyCard();
    await CardStorage.upsertCard(card);
    CardState.cards = CardStorage.getCards();
    this.renderCardList();
    await this.selectCard(card);
    const nameEl = document.querySelector('#editName');
    if (nameEl) nameEl.focus();
    Ui.showToast(I18n.t('toast.newBlank'), 'success');
  },

  async saveCurrentCard() {
    const { activeCard } = CardState;
    if (!activeCard) { Ui.showToast(I18n.t('toast.noCardSave'), 'warning'); return; }
    await Editor.syncEditorToCard();
    CardState.clearDirty();
    Ui.setDirty(false);
    Ui.flashSaved();
    this.renderCardList();
    Ui.showToast(I18n.t('toast.cardSaved'), 'success');
  },

  async duplicateCard() {
    const { activeCard } = CardState;
    if (!activeCard) { Ui.showToast(I18n.t('toast.noCardDup'), 'warning'); return; }
    await Editor.syncEditorToCard();
    const clone = JSON.parse(JSON.stringify(activeCard));
    clone._id = CardEngine._uniqueId();
    clone.name = (clone.name || (I18n.t ? I18n.t('gen.unnamed') : 'Unnamed')) + (I18n.t ? I18n.t('gen.copySuffix') : ' (Copy)');
    await CardStorage.upsertCard(clone);
    if (clone._imageBase64) await CardStorage.saveImage(clone._id, clone._imageBase64);
    CardState.cards = CardStorage.getCards();
    this.renderCardList();
    await this.selectCard(clone);
    Ui.showToast(I18n.t('toast.cardDup'), 'success');
  },

  /**
   * Toast with an Undo button and a live countdown. Both delete paths need
   * exactly this; duplicating it is how they drifted apart (the single-card
   * delete had undo, the batch delete did not).
   */
  _showUndoToast({ message, onUndo, duration = 8000 }) {
    let undone = false;
    const t = (key, fallback) => (I18n && I18n.t ? I18n.t(key) : fallback);
    const toastEl = document.createElement('div');
    toastEl.className = 'toast align-items-center border-0';
    toastEl.setAttribute('role', 'alert');
    toastEl.innerHTML = '<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2 w-100"><div class="flex-grow-1 d-flex align-items-center gap-2">'
      + '<i class="bi bi-trash-fill text-danger"></i>' + message
      // A class, not an id: two delete toasts can be on screen at once (delete a
      // card, then batch-delete), and duplicate ids are invalid HTML that any
      // `document.querySelector('#…')` would resolve arbitrarily.
      + '<button class="btn btn-sm btn-outline-accent ms-2 undo-delete-btn">' + t('toast.undo', 'Undo') + '</button>'
      + '</div><div class="toast-timer" style="font-size:0.62rem;white-space:nowrap;font-family:var(--font-mono);min-width:3.2em;text-align:right;">'
      + t('gen.toastAutoHide', { s: Math.ceil(duration / 1000) }) + '</div>'
      + '<button type="button" class="btn-close btn-close-white ms-2" data-bs-dismiss="toast"></button></div></div>';
    const toastContainer = document.querySelector('#toastContainer');
    if (toastContainer) toastContainer.appendChild(toastEl);
    const toast = new bootstrap.Toast(toastEl, { delay: duration });
    toast.show();

    // Live countdown. The interval has to die with the toast however it goes
    // away — including when something removes the node without hiding it — or
    // it keeps ticking against a detached element.
    const timerEl = toastEl.querySelector('.toast-timer');
    if (timerEl) {
      const interval = 200;
      let remaining = duration;
      const timer = setInterval(() => {
        remaining -= interval;
        if (remaining <= 0 || undone) { timerEl.textContent = ''; clearInterval(timer); return; }
        timerEl.textContent = t('gen.toastAutoHide', { s: Math.ceil(remaining / 1000) });
      }, interval);
      const stop = () => clearInterval(timer);
      toastEl.addEventListener('hidden.bs.toast', stop);
      const observer = new MutationObserver(() => {
        if (!document.body.contains(toastEl)) { stop(); observer.disconnect(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());

    const undoBtn = toastEl.querySelector('.undo-delete-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', async () => {
        undone = true;
        toast.hide();
        await onUndo();
      });
    }
  },

  /**
   * Delete cards by id and keep CardState in step with the result. The callers
   * own their own capture/undo: this is only the irreversible half.
   */
  async _deleteCards(ids) {
    try {
      for (const id of ids) await CardStorage.deleteCard(id);
    } catch (e) {
      console.error('Failed to delete card:', e);
      Ui.showToast(I18n.t ? (I18n.t('toast.deleteFailed') || 'Failed to delete card') : 'Failed to delete card', 'danger');
      return false;
    }
    CardState.cards = CardStorage.getCards();
    const activeCard = CardState.activeCard;
    if (activeCard && !CardState.cards.find(c => c._id === activeCard._id)) {
      CardState.activeCard = null;
      Editor.hideEditor();
    }
    return true;
  },

  async deleteActiveCard() {
    const { activeCard } = CardState;
    if (!activeCard) return;
    await Editor.syncEditorToCard();
    const snapshot = await CardStorage.snapshotForDelete(activeCard._id);
    if (!snapshot) return;
    if (!await this._deleteCards([activeCard._id])) return;
    this.renderCardList();
    if (CardState.cards.length > 0) await this.selectCard(CardState.cards[0]);
    this._showUndoToast({
      message: I18n.t('toast.cardDeleted', { name: Ui.escapeHtml(snapshot.card.name || I18n.t('gen.unnamed')) }),
      onUndo: async () => {
        const restored = await CardStorage.restoreDeleted(snapshot);
        if (!restored) return;
        CardState.cards = CardStorage.getCards();
        this.renderCardList();
        await this.selectCard(restored);
        Ui.showToast(I18n.t('toast.cardRestored'), 'success');
      },
    });
  },

  // ─── Mini card preview ─────────────────────────────────

  /** @type {{ show(): void; hide(): void } | null} */
  _previewModal: null,
  _previewCardId: null,
  // Full cards fetched for the hover tooltip / preview modal (id → full card),
  // capped LRU: the map is never invalidated by the browser, so an unbounded
  // cache both leaked memory and kept serving stale descriptions after an edit.
  _previewCache: new Map(),
  _PREVIEW_CACHE_MAX: 30,
  _previewHoverBound: false,

  /** Cache a full card, evicting the least recently used entry. */
  _cachePreview(card) {
    if (!card || !card._id) return;
    this._previewCache.delete(card._id); // re-insert so the order stays LRU
    this._previewCache.set(card._id, card);
    while (this._previewCache.size > this._PREVIEW_CACHE_MAX) {
      const oldest = this._previewCache.keys().next().value;
      if (oldest === undefined) break;
      this._previewCache.delete(oldest);
    }
  },

  /** Read a cached card and mark it as recently used. */
  _readPreview(id) {
    const card = this._previewCache.get(id);
    if (card) this._cachePreview(card);
    return card;
  },

  _cardEventsBound: false,

  /**
   * Same-tab reaction to every write: keep the full-text index and the preview
   * cache in step with storage. `CardStorage.upsertCard` / `deleteCard` are the
   * app's only write funnels, so these three events cover every save path
   * (editor autosave, AI apply, import, wizard, delete, clear-all). Cross-tab
   * writes arrive separately through the `storage` event.
   */
  _bindCardEvents() {
    if (this._cardEventsBound || typeof window === 'undefined') return;
    this._cardEventsBound = true;
    window.addEventListener('stce:card-saved', (e) => {
      const card = /** @type {CustomEvent} */ (e).detail && /** @type {CustomEvent} */ (e).detail.card;
      if (!card) return;
      CardSearch.remember(card);
      this._previewCache.delete(card._id); // a stale tooltip is worse than a refetch
    });
    window.addEventListener('stce:card-deleted', (e) => {
      const id = /** @type {CustomEvent} */ (e).detail && /** @type {CustomEvent} */ (e).detail.id;
      if (!id) return;
      CardSearch.forget(id);
      this._previewCache.delete(id);
    });
    window.addEventListener('stce:cards-cleared', () => {
      CardSearch.reset();
      this._previewCache.clear();
    });
  },

  /** @type {ReturnType<typeof setTimeout> | null} */
  _indexRefreshTimer: null,

  /**
   * Rebuild the full-text index from storage, debounced. Another tab's save
   * arrives as a `cardIndex` change that does not name the card (IndexedDB has
   * no cross-tab event), and indexing is idempotent — so refreshing the whole
   * index is both simpler and cheaper than guessing which card moved. Without
   * it, a card edited elsewhere keeps its old text here and a snippet can quote
   * words that no longer exist.
   */
  refreshSearchIndex() {
    if (this._indexRefreshTimer) clearTimeout(this._indexRefreshTimer);
    this._indexRefreshTimer = setTimeout(() => {
      this._indexRefreshTimer = null;
      CardSearch.reset();
      this.primeSearchIndex();
    }, 500);
  },

  /**
   * Build the full-text index in the background so the first search is instant.
   * Deferred to an idle slot: reading every card out of IndexedDB is cheap but
   * not free, and nothing on screen depends on it yet.
   */
  primeSearchIndex() {
    this._bindCardEvents();
    const run = () => {
      CardSearch.ensure((id) => CardStorage.getCard(id))
        // Only re-render when the index is actually on screen: with no query and
        // no tag filter the indexed text is invisible, and re-rendering the
        // freshly painted library replayed its entrance animation on every load.
        .then((indexed) => { if (indexed > 0 && this._filterActive()) this.renderCardList(); })
        .catch(() => {});
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run);
    else setTimeout(run, 300);
  },

  _fillTooltipDesc(descEl, cardId) {
    const full = this._readPreview(cardId);
    if (!full) return;
    const text = (full.description || '').trim();
    const snippet = (text || (full.first_mes || '').trim()).slice(0, 400);
    if (snippet) {
      descEl.textContent = snippet;
      descEl.dataset.filled = '1';
    }
  },

  async showCardPreview(cardId) {
    const full = await CardStorage.getCard(cardId);
    if (!full) return;
    this._previewCardId = cardId;
    const $ = Ui.$;
    const t = (key, fallback) => (I18n && I18n.t ? I18n.t(key) : fallback);

    $('#cardPreviewTitle').textContent = full.name || t('gen.unnamed', 'Unnamed');
    const img = $('#cardPreviewAvatar');
    const b64 = full._imageBase64 || full._thumbnail;
    if (b64) {
      img.src = b64;
      img.hidden = false;
      $('#cardPreviewAvatarPlaceholder').style.display = 'none';
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      $('#cardPreviewAvatarPlaceholder').style.display = '';
    }
    const metaParts = [];
    if (full.creator) metaParts.push(Ui.escapeHtml(full.creator));
    if (full.spec_version) metaParts.push('v' + Ui.escapeHtml(full.spec_version));
    if ((full.tags || []).length) metaParts.push((full.tags || []).map(x => Ui.escapeHtml(String(x))).join(', '));
    $('#cardPreviewMeta').innerHTML = metaParts.join(' · ');

    const body = $('#cardPreviewBody');
    const sections = [];
    if ((full.description || '').trim()) {
      sections.push('<h6 class="card-preview-section-title">' + t('editor.desc', 'Description') + '</h6>'
        + '<div class="card-preview-section" id="cardPreviewDesc"></div>');
    }
    if ((full.first_mes || '').trim()) {
      sections.push('<h6 class="card-preview-section-title">' + t('editor.firstMes', 'First Message') + '</h6>'
        + '<div class="card-preview-section" id="cardPreviewFirstMes"></div>');
    }
    if (!sections.length) {
      sections.push('<p class="text-muted mb-0" style="font-size:0.85rem;">' + t('preview.empty', 'No description or first message.') + '</p>');
    }
    // Diagnostics and history always render — "nothing found" and "never
    // edited" are answers, not reasons to hide the section.
    sections.push('<h6 class="card-preview-section-title">' + t('health.title', 'Card health') + '</h6>'
      + '<div class="card-preview-section" id="cardPreviewHealth"></div>');
    sections.push('<h6 class="card-preview-section-title">' + t('history.title', 'Version history') + '</h6>'
      + '<div class="card-preview-section" id="cardPreviewHistory"></div>');
    body.innerHTML = sections.join('');
    const descEl = $('#cardPreviewDesc');
    if (descEl) descEl.innerHTML = Ui.renderMarkdown(full.description || '', descEl);
    const fmEl = $('#cardPreviewFirstMes');
    if (fmEl) fmEl.innerHTML = Ui.renderMarkdown(full.first_mes || '', fmEl);

    this._renderHealth(full, t);
    this._bindPreviewHistory();
    await this._renderHistory(cardId, t);

    this._previewModal = this._previewModal || new bootstrap.Modal('#cardPreviewModal');
    this._previewModal.show();
  },

  /** Diagnostics for the previewed card (see js/cardHealth.js for the rules). */
  _renderHealth(card, t) {
    const el = document.querySelector('#cardPreviewHealth');
    if (!el) return;
    const issues = CardHealth.analyze(card, {
      maxTokens: CardStorage.getMaxTokens ? CardStorage.getMaxTokens() : 0,
      // The thumbnail counts: a card with art but no full-size image still looks
      // illustrated, so "no image" would be a false alarm.
      hasImage: !!(card._imageBase64 || card._thumbnail),
    });
    const styles = {
      error: { cls: 'is-danger', icon: 'bi-x-circle-fill' },
      warning: { cls: 'is-warn', icon: 'bi-exclamation-triangle-fill' },
      info: { cls: 'is-info', icon: 'bi-info-circle-fill' },
    };
    const rows = issues.map((issue) => {
      const style = styles[issue.level] || styles.info;
      return '<div class="health-issue ' + style.cls + '"><i class="bi ' + style.icon + '" aria-hidden="true"></i>'
        + '<span>' + Ui.escapeHtml(I18n.t(issue.labelKey, issue.values)) + '</span></div>';
    });
    if (!rows.length) {
      rows.push('<div class="health-issue is-ok"><i class="bi bi-check-circle-fill" aria-hidden="true"></i>'
        + '<span>' + t('health.ok', 'No problems found.') + '</span></div>');
    }
    // Silent lorebook entries are the most common reason a card "does nothing"
    // in chat, so say up front how many can fire on the card alone.
    const active = CardHealth.simulate(card, null).length;
    if (active) {
      rows.push('<div class="health-issue is-info"><i class="bi bi-journal-text" aria-hidden="true"></i>'
        + '<span>' + Ui.escapeHtml(I18n.t('health.loreActive', { count: active })) + '</span></div>');
    }
    el.innerHTML = rows.join('');
  },

  /**
   * A version's timestamp in the language the interface is set to, not the one
   * the operating system happens to use — the two disagree for anyone who
   * picked a language other than their OS locale.
   */
  _formatTimestamp(ms) {
    const lang = (I18n && I18n.getLang) ? I18n.getLang() : undefined;
    return new Date(ms).toLocaleString(lang);
  },

  /** Fill the preview's version list (newest first). */
  async _renderHistory(cardId, t) {
    const el = document.querySelector('#cardPreviewHistory');
    if (!el) return;
    const versions = await CardStorage.getSnapshots(cardId).catch(() => []);
    if (!versions.length) {
      el.innerHTML = '<p class="text-muted mb-0" style="font-size:0.8rem;">' + t('history.empty', 'No earlier versions yet.') + '</p>';
      return;
    }
    el.innerHTML = versions.map((v, i) => ('<div class="history-item" data-index="' + i + '">'
      + '<div class="history-item-when"><i class="bi bi-clock-history me-1"></i>' + Ui.escapeHtml(this._formatTimestamp(v.at)) + '</div>'
      + '<div class="history-item-actions">'
      + '<button type="button" class="btn btn-sm btn-outline-secondary history-compare" data-index="' + i + '">' + t('history.compare', 'Compare with current') + '</button>'
      + '<button type="button" class="btn btn-sm btn-outline-accent history-restore" data-index="' + i + '">' + t('history.restore', 'Restore') + '</button>'
      + '</div></div>')).join('');
  },

  _previewHistoryBound: false,

  /** Delegated once on the modal body, so a re-render can never stack handlers. */
  _bindPreviewHistory() {
    if (this._previewHistoryBound) return;
    const body = document.querySelector('#cardPreviewBody');
    if (!body) return;
    this._previewHistoryBound = true;
    body.addEventListener('click', (e) => {
      const restoreBtn = (/** @type {Element} */ (e.target)).closest('.history-restore');
      const compareBtn = (/** @type {Element} */ (e.target)).closest('.history-compare');
      const btn = restoreBtn || compareBtn;
      if (!btn || !this._previewCardId) return;
      const index = Number(btn.getAttribute('data-index') || -1);
      if (index < 0) return;
      if (restoreBtn) this.restoreVersion(this._previewCardId, index);
      else this.compareVersion(this._previewCardId, index);
    });
  },

  /**
   * Put a stored version's text back on the card. Image bytes are not versioned
   * (they live in their own store and dominate the size), so the artwork the
   * card has right now is kept — and the restore is itself recorded as a
   * version, which makes it reversible like any other edit.
   */
  async restoreVersion(cardId, index) {
    const versions = await CardStorage.getSnapshots(cardId).catch(() => []);
    const version = versions[index];
    const current = await CardStorage.getCard(cardId);
    if (!version || !version.data || !current) return;
    const restored = {
      ...version.data,
      _id: cardId,
      _filename: current._filename,
      _thumbnail: current._thumbnail,
      _hasImage: current._hasImage,
    };
    // The stored _fileSize belongs to the old content; the library list shows it
    // until the next editor sync, so recompute it here rather than lie.
    restored._fileSize = CardEngine.computeFileSize(restored);
    await CardStorage.upsertCard(restored);
    CardState.cards = CardStorage.getCards();
    this.renderCardList();
    await this.selectCard(CardState.cards.find(c => c._id === cardId) || restored);
    Ui.showToast(I18n.t('history.restored'), 'success');
    await this.showCardPreview(cardId);
  },

  /** Show a stored version against the card as it is now, read-only. */
  async compareVersion(cardId, index) {
    const versions = await CardStorage.getSnapshots(cardId).catch(() => []);
    const version = versions[index];
    const current = await CardStorage.getCard(cardId);
    if (!version || !current) return;
    const title = '<i class="bi bi-clock-history me-2 text-accent"></i>'
      + (I18n.t ? I18n.t('history.comparePrefix') : 'Changes since ')
      + Ui.escapeHtml(this._formatTimestamp(version.at));
    const open = () => this._showComparison(title, CardEngine.toJSON({ ...version.data, _id: cardId }), CardEngine.toJSON(current));
    // Two Bootstrap modals must never be mid-transition together (the palette
    // bug: hide() is ignored during an opening animation), so wait for the
    // preview to be fully hidden before opening the diff.
    const previewEl = document.querySelector('#cardPreviewModal');
    if (previewEl && previewEl.classList.contains('show') && this._previewModal) {
      previewEl.addEventListener('hidden.bs.modal', open, { once: true });
      this._previewModal.hide();
    } else {
      open();
    }
  },

  // ─── Clipboard paste (card import + paste-to-avatar) ───

  /**
   * True when a PNG buffer carries a chara/ccv3 text chunk, i.e. it is a
   * character card and not a plain image. Scans the chunk structure exactly
   * like CardEngine.parsePNG (no regex false positives on IDAT data).
   */
  async _fileHasChara(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length < 8) return false;
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return false;
      const dec = new TextDecoder('utf-8');
      let offset = 8;
      while (offset + 12 <= bytes.length) {
        // Bounds guarantee these 4 bytes exist; ?? 0 is only for the typechecker.
        const b0 = bytes[offset] ?? 0, b1 = bytes[offset + 1] ?? 0, b2 = bytes[offset + 2] ?? 0, b3 = bytes[offset + 3] ?? 0;
        const len = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
        const type = dec.decode(bytes.slice(offset + 4, offset + 8));
        if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
          const data = bytes.slice(offset + 8, offset + 8 + len);
          const nullIdx = data.indexOf(0);
          if (nullIdx > 0) {
            const kw = dec.decode(data.slice(0, nullIdx)).toLowerCase();
            if (kw === 'chara' || kw === 'ccv3') return true;
          }
        } else if (type === 'IEND') {
          break;
        }
        offset += 12 + len;
      }
      return false;
    } catch (_) {
      return false;
    }
  },

  async _pasteAsAvatar(file) {
    if (!CardState.activeCard) {
      Ui.showToast(I18n.t ? I18n.t('toast.pasteAvatarNoCard') : 'Select a card first, then paste the image as its avatar', 'warning');
      return;
    }
    try {
      await Editor.setAvatar(file);
    } catch (_) { /* Editor.setAvatar already toasts failures */ }
  },

  async _importPastedFile(file) {
    await this.processFiles([file]);
  },

  async processPaste(files, text) {
    const t = (key, fallback) => (I18n && I18n.t ? I18n.t(key) : fallback);
    if (files && files.length) {
      for (const file of files) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const isImage = (file.type || '').startsWith('image/');
        if (ext === 'json') { await this._importPastedFile(file); continue; }
        if (isImage && ext === 'png' && await this._fileHasChara(file)) { await this._importPastedFile(file); continue; }
        if (isImage) { await this._pasteAsAvatar(file); continue; }
        Ui.showToast(t('toast.pasteNoCard', 'Clipboard contains no character card or image'), 'warning');
      }
      return;
    }
    if (!text) return;
    // Pasted text: data-URL image → avatar; otherwise try to parse as card JSON.
    if (/^data:image\//i.test(text)) {
      try {
        const blob = await (await fetch(text)).blob();
        await this._pasteAsAvatar(new File([blob], 'pasted-avatar', { type: blob.type || 'image/png' }));
      } catch (_) {
        Ui.showToast(t('toast.pasteNoCard', 'Clipboard contains no character card or image'), 'warning');
      }
      return;
    }
    if (text[0] === '{' || text[0] === '[') {
      await this._importPastedFile(new File([text], 'pasted-card.json', { type: 'application/json' }));
      return;
    }
    Ui.showToast(t('toast.pasteNoCard', 'Clipboard contains no character card or image'), 'warning');
  },
};

export { CardManager };
if (typeof window !== 'undefined') window.CardManager = CardManager;
