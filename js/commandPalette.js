// @ts-check
/* ============================================================
   commandPalette.js — Ctrl/Cmd+K: cards, fields and actions
   ============================================================
   One input for the whole app: open a card, jump to a field of the current
   card, or run an action. Everything it exposes already exists somewhere in the
   UI — the palette just removes the hunting.

   Loaded as a lazy chunk (first Ctrl+K), so it must not touch any other module
   at module-evaluation time; every call below happens inside a handler. The
   actions call the same entry points the buttons do (Ui.toggleTheme,
   CardManager.saveCurrentCard, …) rather than duplicating logic, so a palette
   action can never drift from its button. */

import { I18n } from './i18n.js';
import { Ui } from './ui.js';
import { CardState } from './cardState.js';
import { CardSearch } from './cardSearch.js';
import { CardManager } from './cardManager.js';
import { ExportUtils } from './exportUtils.js';
import { Settings } from './settings.js';
import { AiChat } from './aiChat.js';
import { Editor } from './editor.js';

// Editor field id → the tab pane that owns it, so a jump can switch tabs first.
// `editName` lives in the always-visible card header, hence no pane.
const FIELD_TABS = {
  editName: '',
  editDescription: '#tabCore',
  editFirstMes: '#tabCore',
  editScenario: '#tabCore',
  editCreator: '#tabCore',
  editVersion: '#tabCore',
  editTags: '#tabCore',
  editPersonality: '#tabPersonality',
  editMesExample: '#tabPersonality',
  editSystemPrompt: '#tabAdvanced',
  editPostHistory: '#tabAdvanced',
  editCreatorNotes: '#tabAdvanced',
  editExtensions: '#tabAdvanced',
};

// Fields offered by the palette: label key + the editor element they focus.
const JUMP_FIELDS = [
  { id: 'editName', labelKey: 'editor.name', field: 'name' },
  { id: 'editDescription', labelKey: 'editor.desc', field: 'description' },
  { id: 'editFirstMes', labelKey: 'editor.firstMes', field: 'first_mes' },
  { id: 'editScenario', labelKey: 'editor.scenario', field: 'scenario' },
  { id: 'editPersonality', labelKey: 'editor.personalitySummary', field: 'personality' },
  { id: 'editMesExample', labelKey: 'editor.mesExample', field: 'mes_example' },
  { id: 'editSystemPrompt', labelKey: 'editor.systemPrompt', field: 'system_prompt' },
  { id: 'editPostHistory', labelKey: 'editor.postHistory', field: 'post_history_instructions' },
  { id: 'editCreatorNotes', labelKey: 'editor.creatorNotes', field: 'creator_notes' },
  { id: 'editCreator', labelKey: 'editor.creator', field: 'creator' },
  { id: 'editVersion', labelKey: 'editor.version', field: 'character_version' },
  { id: 'editTags', labelKey: 'editor.tags', field: 'tags' },
  { id: 'editExtensions', labelKey: 'editor.extensions', field: 'extensions' },
];

const MAX_PER_SECTION = 12;

/** Lowercase + strip diacritics, matching the search index's normalization. */
const fold = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Relevance of a label against the query: prefix > word start > contains. */
function labelScore(label, query) {
  const hay = fold(label);
  const at = hay.indexOf(query);
  if (at < 0) return 0;
  if (at === 0) return hay === query ? 100 : 80;
  return /\s|[-_/]/.test(hay.charAt(at - 1)) ? 60 : 40;
}

/** @typedef {{ id: string, kind: string, label: string, sub: string, icon: string, run: () => void, _score?: number }} PaletteItem */

const KIND_ORDER = { field: 0, action: 1, card: 2 };

const CommandPalette = {
  /** @type {{ show(): void; hide(): void } | null} */
  _modal: null,
  /** @type {HTMLElement | null} */
  _modalEl: null,
  /** @type {HTMLInputElement | null} */
  _input: null,
  /** @type {HTMLElement | null} */
  _results: null,
  /** @type {PaletteItem[]} */
  _items: [],
  _active: 0,
  _bound: false,
  // Bumped on every open and every run: a pending close/action from a previous
  // run must never affect the palette the user just reopened.
  _runToken: 0,

  /** The actions the palette can run; `enabled` hides irrelevant ones. */
  _actions() {
    const hasCard = !!CardState.activeCard;
    return [
      { id: 'quick.newCard', labelKey: 'nav.newCard', icon: 'bi-plus-circle', enabled: true, run: () => CardManager.createNewCard() },
      { id: 'quick.save', labelKey: 'nav.save', icon: 'bi-save', enabled: hasCard, run: () => CardManager.saveCurrentCard() },
      { id: 'quick.exportJson', labelKey: 'editor.exportJson', icon: 'bi-filetype-json', enabled: hasCard, run: () => ExportUtils.exportAsJSON() },
      { id: 'quick.exportPng', labelKey: 'editor.exportPng', icon: 'bi-file-image', enabled: hasCard, run: () => ExportUtils.exportAsPNG() },
      { id: 'quick.duplicate', labelKey: 'editor.duplicate', icon: 'bi-copy', enabled: hasCard, run: () => CardManager.duplicateCard() },
      { id: 'quick.delete', labelKey: 'editor.delete', icon: 'bi-trash', enabled: hasCard, run: () => CardManager.deleteActiveCard() },
      { id: 'quick.theme', labelKey: 'nav.theme', icon: 'bi-circle-half', enabled: true, run: () => { if (Ui.toggleTheme) Ui.toggleTheme(); } },
      { id: 'quick.focus', labelKey: 'nav.focus', icon: 'bi-arrows-fullscreen', enabled: true, run: () => {
        const app = Ui.$el('#appContainer');
        const focused = app.classList.contains('side-left-collapsed') && app.classList.contains('side-right-collapsed');
        if (Ui.setFocusMode) Ui.setFocusMode(!focused);
      } },
      { id: 'quick.settings', labelKey: 'nav.settings', icon: 'bi-gear', enabled: true, run: () => Settings.openSettings() },
      { id: 'quick.shortcuts', labelKey: 'shortcuts.title', icon: 'bi-keyboard', enabled: true, run: () => {
        Ui._shortcutsModal = Ui._shortcutsModal || new bootstrap.Modal('#shortcutsModal');
        Ui._shortcutsModal.show();
      } },
      { id: 'quick.clearChat', labelKey: 'ai.clearChat', icon: 'bi-eraser', enabled: hasCard, run: () => AiChat.clearChat() },
    ];
  },

  init() {
    if (this._bound) return;
    this._bound = true;
    this._modalEl = document.querySelector('#commandPalette');
    this._input = /** @type {HTMLInputElement | null} */ (document.querySelector('#paletteInput'));
    this._results = document.querySelector('#paletteResults');
    if (!this._modalEl || !this._input || !this._results) return;
    this._modal = new bootstrap.Modal(this._modalEl);

    this._input.addEventListener('input', () => this._render(this._input ? this._input.value : ''));
    this._input.addEventListener('keydown', (e) => {
      const ke = /** @type {KeyboardEvent} */ (e);
      if (ke.key === 'ArrowDown') { ke.preventDefault(); this._move(1); }
      else if (ke.key === 'ArrowUp') { ke.preventDefault(); this._move(-1); }
      else if (ke.key === 'Enter') { ke.preventDefault(); this._runActive(); }
    });
    // Keep the highlight in step with the mouse without stealing focus from the
    // input (mousemove, not mouseover: the modal re-renders on every keystroke).
    this._results.addEventListener('mousemove', (e) => {
      const row = (/** @type {Element} */ (e.target)).closest('.palette-item');
      if (!row) return;
      const idx = Number(row.getAttribute('data-index') || -1);
      if (idx >= 0 && idx !== this._active) { this._active = idx; this._highlight(); }
    });
    this._results.addEventListener('click', (e) => {
      const row = (/** @type {Element} */ (e.target)).closest('.palette-item');
      if (!row) return;
      const idx = Number(row.getAttribute('data-index') || -1);
      if (idx >= 0) { this._active = idx; this._runActive(); }
    });
    // A reopened palette must start fresh: Bootstrap keeps the DOM, so a stale
    // query + highlight would look like the palette ignored the last action.
    this._modalEl.addEventListener('shown.bs.modal', () => {
      if (this._input) { this._input.value = ''; this._input.focus(); }
      this._render('');
    });
  },

  show() {
    this.init();
    if (!this._modal) return;
    this._runToken++; // invalidate any close/action still queued from a past run
    this._modal.show();
  },

  hide() {
    if (this._modal) this._modal.hide();
  },

  get isOpen() {
    return !!this._modalEl && this._modalEl.classList.contains('show');
  },

  /** Build the ranked item list for a query. */
  _build(query) {
    const q = fold(query).trim();
    /** @type {PaletteItem[]} */
    const items = [];
    /** @param {Omit<PaletteItem, '_score'>} item */
    const push = (item, score) => items.push({ ...item, _score: score });

    if (CardState.activeCard) {
      for (const field of JUMP_FIELDS) {
        const label = I18n.t(field.labelKey);
        const score = q ? labelScore(label, q) : 0;
        if (q && score === 0) continue;
        push({
          id: 'field.' + field.id,
          kind: 'field',
          label: I18n.t('palette.jumpTo', { field: label }),
          sub: '',
          icon: 'bi-input-cursor-text',
          run: () => Editor.revealField(field.id, FIELD_TABS[field.id] || ''),
        }, score || 1);
      }
    }

    for (const action of this._actions()) {
      const label = I18n.t(action.labelKey);
      if (!action.enabled) continue;
      const score = q ? labelScore(label, q) : 0;
      if (q && score === 0) continue;
      push({ id: action.id, kind: 'action', label, sub: '', icon: action.icon, run: action.run }, score || 1);
    }

    if (q) {
      const hits = CardSearch.search(q, { limit: MAX_PER_SECTION });
      const byId = new Map((CardState.cards || []).map((c) => [c._id, c]));
      for (const hit of hits) {
        const card = byId.get(hit.id);
        if (!card) continue;
        // Cards rank below a direct label hit, but above nothing: a full-text
        // hit counts as much as a "contains" label match.
        const score = labelScore(String(card.name || ''), q) || 30;
        push({
          id: 'card.' + hit.id,
          kind: 'card',
          label: String(card.name || I18n.t('gen.unnamed')),
          sub: I18n.t(hit.labelKey) + (hit.snippet ? ' · ' + hit.snippet.slice(0, 90) : ''),
          icon: 'bi-person-vcard',
          run: () => {
            const meta = (CardState.cards || []).find((c) => c._id === hit.id);
            if (meta) CardManager.selectCard(meta);
          },
        }, score);
      }
    }

    items.sort((a, b) => ((b._score || 0) - (a._score || 0))
      || ((KIND_ORDER[a.kind] || 0) - (KIND_ORDER[b.kind] || 0))
      || a.label.localeCompare(b.label));
    return items.slice(0, MAX_PER_SECTION * 2);
  },

  _render(query) {
    if (!this._results) return;
    const items = this._build(query);
    this._items = items;
    this._active = 0;
    if (items.length === 0) {
      this._results.innerHTML = '<div class="palette-empty">' + Ui.escapeHtml(I18n.t('palette.empty')) + '</div>';
      return;
    }
    this._results.innerHTML = items.map((item, i) => '<div class="palette-item' + (i === 0 ? ' active' : '')
      + '" role="option" aria-selected="' + (i === 0) + '" data-index="' + i + '">'
      + '<i class="bi ' + item.icon + ' palette-item-icon"></i>'
      + '<div class="palette-item-text"><div class="palette-item-label">' + Ui.escapeHtml(item.label) + '</div>'
      + (item.sub ? '<div class="palette-item-sub">' + Ui.escapeHtml(item.sub) + '</div>' : '')
      + '</div>'
      + '<span class="palette-item-kind">' + Ui.escapeHtml(I18n.t('palette.kind.' + item.kind)) + '</span>'
      + '</div>').join('');
    this._scrollIntoView();
  },

  _highlight() {
    if (!this._results) return;
    this._results.querySelectorAll('.palette-item').forEach((el, i) => {
      const on = i === this._active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
    });
    this._scrollIntoView();
  },

  _scrollIntoView() {
    if (!this._results) return;
    const active = /** @type {HTMLElement | null} */ (this._results.querySelector('.palette-item.active'));
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
  },

  _move(delta) {
    if (this._items.length === 0) return;
    this._active = (this._active + delta + this._items.length) % this._items.length;
    this._highlight();
  },

  _runActive() {
    const item = this._items[this._active];
    if (item) this._run(item);
  },

  _run(item) {
    const run = () => {
      try {
        item.run();
      } catch (err) {
        console.error('commandPalette: action failed', err);
      }
    };
    const token = ++this._runToken;
    const modalEl = this._modalEl;
    if (!modalEl || !modalEl.classList.contains('show')) {
      setTimeout(() => { if (token === this._runToken) run(); }, 0);
      return;
    }

    // The action runs once the modal finished closing: its focus restore fires
    // on hidden.bs.modal and would otherwise pull focus back out of the field an
    // action just revealed (the "go to field" entries).
    let started = false;
    const start = () => {
      if (started || token !== this._runToken) return;
      started = true;
      setTimeout(run, 0);
    };
    modalEl.addEventListener('hidden.bs.modal', start, { once: true });
    this.hide();
    // Belt and braces: the modal carries no transition class (see index.html),
    // so hide() is synchronous — but a stale Bootstrap instance or a re-added
    // fade must not be able to leave the palette stuck open with the command
    // silently dropped. Both fallbacks are token-guarded: without that, the
    // close timer fired *after* the user reopened the palette and slammed the
    // new one shut.
    setTimeout(() => {
      if (token === this._runToken && modalEl.classList.contains('show')) this.hide();
    }, 200);
    setTimeout(start, 450);
  },
};

export { CommandPalette };
if (typeof window !== 'undefined') window.CommandPalette = CommandPalette;
