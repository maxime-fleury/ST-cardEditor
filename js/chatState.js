/* ============================================================
   chatState.js — Single source of truth for the AI chat's state
   ============================================================
   Before this module, the chat's mutable state lived as bare fields on the
   AiChat singleton AND was written directly by cardManager (AiChat._gen++,
   AiChat._currentSessionId = …, AiChat._historyRendered = false). That split
   is what let stale apply-queue entries, session IDs and callbacks survive a
   card switch (#2/#21/#24). ChatState owns every piece of that state and the
   transitions that mutate it, so a reset is ONE call (resetChat) instead of
   six ad-hoc field assignments scattered across files.

   DOM elements are still referenced (applyElMap keys, queue item `.el`) — the
   store keeps them so the review modal can badge the source message — but the
   *state* (indexes, flags, queues) lives here and only here. */

// @ts-check

/** @type {Set<string>} fields selected for editing (chips) */
let selectedFields = new Set();
/** @type {number} greeting count requested for alternate_greetings */
let greetingCount = 3;
/** @type {boolean} whether the chat transcript has been rendered once */
let historyRendered = false;
/** @type {string | null} active session ID for per-session storage */
let currentSessionId = null;
/** @type {number} generation token: bumped on every send/clear/switch so
 * stale aborted callbacks bail out instead of clobbering the new run's state */
let gen = 0;
/** @type {number} generation token for updateContextBar: each new call
 * supersedes in-flight ones so the bar can never show a stale estimate */
let contextBarGen = 0;
/** @type {AbortController[]} per-field controllers for parallel requests */
let abortControllers = [];

/** @type {ApplyItem[]} every pending apply-able response { el, field, content, applied } */
let applyQueue = [];
/** @type {Map<string, { content: string, field: string }>} msgId → response, for re-apply */
let applyStore = new Map();
/** @type {WeakMap<object, ApplyItem>} element → apply item (dup-free registration) */
let applyElMap = new WeakMap();
/** @type {number} active item index in applyQueue */
let applyIndex = 0;

const ChatState = {
  // ── Selection & generation ──────────────────────────────
  get selectedFields() { return selectedFields; },
  set selectedFields(v) { selectedFields = v; },
  get greetingCount() { return greetingCount; },
  set greetingCount(v) { greetingCount = v; },
  get historyRendered() { return historyRendered; },
  set historyRendered(v) { historyRendered = v; },
  get currentSessionId() { return currentSessionId; },
  set currentSessionId(v) { currentSessionId = v; },
  get gen() { return gen; },
  set gen(v) { gen = v; },
  get contextBarGen() { return contextBarGen; },
  set contextBarGen(v) { contextBarGen = v; },
  get abortControllers() { return abortControllers; },
  set abortControllers(v) { abortControllers = v; },

  // ── Apply queue ─────────────────────────────────────────
  get applyQueue() { return applyQueue; },
  set applyQueue(v) { applyQueue = v; },
  get applyStore() { return applyStore; },
  set applyStore(v) { applyStore = v; },
  get applyElMap() { return applyElMap; },
  set applyElMap(v) { applyElMap = v; },
  get applyIndex() { return applyIndex; },
  set applyIndex(v) { applyIndex = v; },

  // ── Generation tokens ───────────────────────────────────
  /** Invalidate stale callbacks; returns the new token. */
  bumpGen() { return ++gen; },
  /** Invalidate stale context-bar estimates; returns the new token. */
  bumpContextBarGen() { return ++contextBarGen; },

  // ── Abort controllers ───────────────────────────────────
  addController(controller) { abortControllers.push(controller); },
  releaseController(controller) {
    const idx = abortControllers.indexOf(controller);
    if (idx >= 0) abortControllers.splice(idx, 1);
  },
  abortAll() {
    abortControllers.forEach(c => c.abort());
    abortControllers = [];
  },

  // ── Apply queue transitions ─────────────────────────────
  /**
   * Register an apply-able response so Prev/Next can move between every
   * pending change in the transcript. Duplicate registration for the same DOM
   * element just updates content/field (retries regenerate the response).
   * @returns {ApplyItem | null}
   */
  registerApply(el, field, content) {
    if (!el) return null;
    let item = applyElMap.get(el);
    if (item) { item.field = field; item.content = content; return item; }
    item = { el, field, content, applied: false };
    applyElMap.set(el, item);
    applyQueue.push(item);
    return item;
  },

  /** Index of the first not-yet-applied change in the queue (-1 when all done). */
  firstUnappliedIndex() {
    for (let i = 0; i < applyQueue.length; i++) {
      const item = applyQueue[i];
      if (item && !item.applied) return i;
    }
    return -1;
  },

  /** Index of the next not-yet-applied change after the current one (-1 when exhausted). */
  nextUnappliedIndex() {
    for (let i = applyIndex + 1; i < applyQueue.length; i++) {
      const item = applyQueue[i];
      if (item && !item.applied) return i;
    }
    return -1;
  },

  /** True once nothing in the queue is pending anymore. */
  allApplied() { return applyQueue.every(it => it.applied); },

  /**
   * Drop queue items whose source message left the DOM (chat cleared, or
   * removed by retry) so the Prev/Next nav never lists stale changes.
   */
  pruneDetached() {
    applyQueue = applyQueue.filter(it => {
      const el = /** @type {{ isConnected?: boolean } | null | undefined} */ (it.el);
      return !!el && el.isConnected === true;
    });
    if (applyIndex >= applyQueue.length) applyIndex = Math.max(0, applyQueue.length - 1);
  },

  /** Drop all pending apply-able responses (queue, index, DOM-element map and
   * re-apply store). Called when switching cards so a response generated for
   * one card can never be applied to another via Prev/Next or a stale entry. */
  resetApply() {
    applyQueue = [];
    applyIndex = 0;
    applyElMap = new WeakMap();
    applyStore.clear();
  },

  /**
   * Full reset for a card switch: abort in-flight requests, invalidate stale
   * callbacks, drop pending applies and the session pointer, and force the
   * transcript to re-render. Selection (chips) intentionally survives.
   */
  resetChat() {
    this.abortAll();
    this.bumpGen();
    this.resetApply();
    currentSessionId = null;
    historyRendered = false;
  },
};

export { ChatState };
if (typeof window !== 'undefined') window.ChatState = ChatState;