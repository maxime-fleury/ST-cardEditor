/* ============================================================
   cardState.js — Single source of truth for the card collection
   ============================================================
   Before this module, the active card, the card list and the dirty flag
   lived as plain fields on window.AppState, mutated from six files at once
   (ui, editor, cardManager, aiChat, settings, wizard). That split is what
   let stale activeCard/cards values survive card switches and imports
   (#2/#21/#24). CardState owns those three pieces of state and the
   transitions that mutate them, so a reset is ONE call instead of ad-hoc
   field assignments scattered across files.

   window.AppState keeps its other fields (chatHistory, models, isAiLoading)
   and exposes cards/activeCard/dirty as delegating accessors, so legacy
   callers and the e2e suite keep working against a single source of truth. */

// @ts-check

/** @type {CardShape[]} */
let cards = [];
/** @type {CardShape | null} */
let activeCard = null;
/** @type {boolean} */
let dirty = false;

const CardState = {
  // ── Collection ───────────────────────────────────────────
  get cards() { return cards; },
  set cards(v) { cards = v; },
  get activeCard() { return activeCard; },
  set activeCard(v) { activeCard = v; },
  get dirty() { return dirty; },
  set dirty(v) { dirty = v; },

  // ── Transitions ──────────────────────────────────────────
  /** Mark the active card as having unsaved edits. */
  markDirty() { dirty = true; },
  /** Clear the unsaved-edits flag (after save or a full reload). */
  clearDirty() { dirty = false; },
};

export { CardState };
if (typeof window !== 'undefined') window.CardState = CardState;