/**
 * Ambient declarations for the ST Card Editor's window-glued singletons.
 *
 * The modules are classic ES objects that register themselves on `window` and
 * reference each other as bare globals at call time (never at module-eval
 * time). These declarations make `tsc --checkJs` usable incrementally on the
 * @ts-check files (aiChat.js, cardManager.js, editor.js).
 *
 * Deliberate looseness (all documented in tsconfig.json too):
 *  - `strictNullChecks` is off: legacy code assumes elements/cards exist after
 *    init, so null-tracking is pure noise for now.
 *  - `Ui.$` and card objects (`CardShape[K]`) are the DOM/data boundary: they
 *    return `any` because selectors and card fields are dynamic strings.
 *  - Facade objects (`AiChat`, `ExportUtils`, …) keep precise signatures for
 *    the members the checked files actually use, plus an `any` index
 *    signature so unlisted members still work.
 *
 * What IS checked: type mismatches on data, unknown flows, wrong argument
 * counts, property typos on declared shapes, and arithmetic on non-numbers.
 */

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** A stored chat session (grouped by time in the AI history panel). */
interface ChatSession {
  id: string;
  created: number;
  lastUpdated: number;
  preview: string;
  messageCount: number;
  [k: string]: any;
}

/**
 * A character card as stored by the app: the flattened card fields plus the
 * internal metadata (`_id`, `_imageBase64`, …). Values are `any` because card
 * data is user-provided and arbitrary; the declared field names keep typos on
 * known fields visible.
 */
interface CardShape {
  _id?: string;
  _filename?: string;
  _imageBase64?: string;
  _thumbnail?: string;
  _hasImage?: boolean;
  _createdAt?: number;
  _fileSize?: number;
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  alternate_greetings?: string[];
  tags?: unknown[];
  system_prompt?: string;
  post_history_instructions?: string;
  creator_notes?: string;
  creator?: string;
  character_version?: string;
  spec?: string;
  spec_version?: string;
  character_book?: { entries?: Array<{ [k: string]: any }> };
  extensions?: { [k: string]: any };
  [k: string]: any;
}

/** A parsed SillyTavern character card JSON (chara_card_v2). */
interface CardJSON {
  spec?: string;
  spec_version?: string;
  data?: {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    alternate_greetings?: string[];
    tags?: unknown[];
    system_prompt?: string;
    post_history_instructions?: string;
    creator_notes?: string;
    creator?: string;
    character_version?: string;
    character_book?: { entries?: unknown[] };
    extensions?: { [k: string]: unknown };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** A pending AI change ready to be reviewed/applied. */
interface ApplyItem {
  el: unknown;
  field: string;
  content: string;
  applied: boolean;
}

/** Result of _prepareApply: what the diff modal shows and how to apply it. */
interface ApplyPrep {
  oldVal: string;
  newVal: string;
  applyFn: () => void;
}

/** One entry of AiChat.FIELD_DEFS. */
interface FieldDef {
  id: string;
  labelKey: string;
  icon: string;
  hasCount?: boolean;
}

interface AppStateShape {
  cards: CardShape[];
  activeCard: CardShape | null;
  chatHistory: ChatMessage[];
  isAiLoading: boolean;
  models?: Array<{ id: string; name?: string; max_output_tokens?: number; context_length?: number; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * DOM boundary augmentation: the checked files query elements by dynamic ID
 * selectors and immediately touch `.value`, `.style`, `.dataset`, … without
 * narrowing. Element in lib.dom lacks these (they live on HTML*Element
 * subtypes), so we widen pragmatically for this codebase.
 */
interface Element {
  style: CSSStyleDeclaration;
  value: string;
  disabled: boolean;
  title: string;
  dataset: DOMStringMap;
  focus(options?: FocusOptions): void;
  offsetParent: Element | null;
}

declare const I18n: {
  t(key: string, vars?: Record<string, unknown>): string;
  getLang(): string;
  [k: string]: unknown;
};

declare const Ui: {
  // DOM boundary: selectors are dynamic strings ('#aiInput', '.ai-field-chip'),
  // so the plumbing returns `any`; strict checks apply to the data logic.
  $(sel: string): any;
  $$(sel: string): NodeListOf<HTMLElement>;
  escapeHtml(s: unknown): string;
  escapeAttr(s: unknown): string;
  showToast(msg: string, type?: string): void;
  setDirty(v: boolean): void;
  updateUIState(): void;
  renderMarkdown(text: string, target?: unknown): string;
  debounce(fn: (...args: unknown[]) => void, ms?: number): (...args: unknown[]) => void;
  formatFileSize(n: number): string;
  downloadFile(filename: string, content: unknown, mimeType?: string): void;
  flashSaved(): void;
  // prompt() resolves to the user's input (string | null); `any` because the
  // callers use the value directly without narrowing.
  prompt(opts: unknown): Promise<any>;
  confirm(opts: unknown): Promise<boolean>;
  [k: string]: unknown;
};

declare const Anims: {
  staggerFadeIn(el: unknown, opts?: unknown): void;
  _disabled?(): boolean;
  [k: string]: unknown;
};

declare const Editor: {
  populateEditor(card: unknown): void;
  syncEditorToCard(card?: unknown): unknown;
  renderGreetings(card: unknown): void;
  hideEditor(): void;
  setAvatar(...args: unknown[]): void;
  [k: string]: unknown;
};

declare const CardManager: {
  renderCardList(): void;
  saveCurrentCard(): unknown;
  [k: string]: unknown;
};

declare const CardStorage: {
  PREFIX: string;
  _keys: Record<string, string>;
  getPrompt(name: string): string;
  getMaxTokens(): number;
  getChatHistory(id?: string): ChatMessage[];
  saveChatHistory(history: ChatMessage[], id?: string): void;
  clearChatHistory(id?: string): void;
  getChatSessions(id?: string): ChatSession[];
  getSessionMessages(id: string, sessionId: string): ChatMessage[];
  saveChatSession(id: string, session: ChatSession): void;
  saveSessionMessages(id: string, sessionId: string, messages: ChatMessage[]): void;
  getCards(): CardShape[];
  saveCardIndex(index: CardShape[]): void;
  getCard(id: string): Promise<CardShape | null>;
  upsertCard(card: CardShape): Promise<unknown>;
  deleteCard(id: string): Promise<void>;
  setActiveCardId(id: string | null): void;
  getActiveCardId(): string | null;
  getImage(id: string): Promise<string | null>;
  saveImage(id: string, data: unknown): Promise<void>;
  getInjectCopyright(): boolean;
  _extractMeta(card: CardShape): CardShape;
  [k: string]: unknown;
};

declare const CardEngine: {
  createEmptyCard(): CardShape;
  toJSON(card: unknown): string;
  parseJSON(text: string, filename?: string): unknown;
  parseFile(file: unknown): Promise<CardShape>;
  parsePNG(...args: unknown[]): unknown;
  computeFileSize(...args: unknown[]): number;
  _uniqueId(): string;
  _createThumbnail?(data: string): Promise<string | null>;
  _blobToBase64(file: unknown): Promise<string>;
  [k: string]: unknown;
};

declare const Settings: {
  getDefaultPrompt(name: string): string;
  refreshCredits(): void;
  [k: string]: unknown;
};

declare const Tokenizer: {
  count(text: string): Promise<number>;
  syncCount(text: string): number;
  [k: string]: unknown;
};

declare const AIService: {
  DEFAULT_MAX_TOKENS: number;
  hasApiKey(): boolean;
  chatStream(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    onChunk?: (text: string) => void,
    signal?: AbortSignal | null,
    jsonMode?: boolean,
    history?: ChatMessage[]
  ): Promise<{
    content: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number } | null;
    model: string;
  }>;
  chat(
    prompt: string,
    systemPrompt?: string,
    model?: string,
    opts?: { jsonMode?: boolean; signal?: AbortSignal | null; history?: ChatMessage[]; [k: string]: unknown }
  ): Promise<{
    content: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number } | null;
    model: string;
  }>;
  getContextLength(modelId: string): number;
  resolveMaxTokens(modelId: string, messages?: unknown[]): Promise<number>;
  [k: string]: unknown;
};

declare const AiChat: {
  FIELD_DEFS: FieldDef[];
  MAX_PARALLEL_FIELDS: number;
  send(retryPrompt?: string): void;
  clearChat(): void;
  toggleHistory(force?: boolean): void;
  updateSendButton(): void;
  updateContextBar(): void;
  addChatMessage(role: string, content: string, extra?: unknown, index?: unknown, userIdx?: unknown): void;
  renderChatHistory(): void;
  _abortAll(): void;
  _resetApplyQueue(): void;
  _bumpGen(): number;
  _resetChat(): void;
  _setCurrentSession(id: string | null): void;
  _renderDiff(...args: unknown[]): void;
  _renderFieldChips(): void;
  _inferFields(text: string): string[];
  _normalizePlaceholders(text: string): string;
  _repairStoredPlaceholders(card: CardShape): number;
  [k: string]: any;
};

/**
 * Single source of truth for the AI chat's mutable state (see chatState.js):
 * the apply queue, chip selection, session pointer, generation tokens and
 * abort controllers. Everything else must read/write through this store — no
 * caller may bypass it by mutating AiChat fields.
 */
declare const ChatState: {
  selectedFields: Set<string>;
  greetingCount: number;
  historyRendered: boolean;
  currentSessionId: string | null;
  gen: number;
  contextBarGen: number;
  abortControllers: AbortController[];
  applyQueue: ApplyItem[];
  applyStore: Map<string, { content: string; field: string }>;
  applyElMap: WeakMap<object, ApplyItem>;
  applyIndex: number;
  bumpGen(): number;
  bumpContextBarGen(): number;
  addController(controller: AbortController): void;
  releaseController(controller: AbortController): void;
  abortAll(): void;
  registerApply(el: unknown, field: string, content: string): ApplyItem | null;
  firstUnappliedIndex(): number;
  nextUnappliedIndex(): number;
  allApplied(): boolean;
  pruneDetached(): void;
  resetApply(): void;
  resetChat(): void;
};

/**
 * Single source of truth for the card collection state (see cardState.js):
 * the card list, the active card and the dirty flag. window.AppState exposes
 * these same three fields as delegating accessors so legacy callers and the
 * e2e suite keep working against this store.
 */
declare const CardState: {
  cards: CardShape[];
  activeCard: CardShape | null;
  dirty: boolean;
  markDirty(): void;
  clearDirty(): void;
};

declare const ExportUtils: {
  injectCopyright(card: CardShape): void;
  embedCharaChunk(pngBytes: unknown, jsonStr: string): unknown;
  [k: string]: any;
};

declare const Wizard: {
  show(): void;
  [k: string]: unknown;
};

declare const Diff: {
  diffWords(oldText: string, newText: string): Array<{ value: string; added?: boolean; removed?: boolean }>;
};

declare const bootstrap: {
  Modal: new (el: unknown, opts?: unknown) => { show(): void; hide(): void };
  Toast: new (el: unknown, opts?: unknown) => { show(): void; hide(): void };
  [k: string]: unknown;
};

interface Window {
  AppState: AppStateShape;
  AiChat: typeof AiChat;
  Tokenizer: typeof Tokenizer;
  Ui: typeof Ui;
  Editor: typeof Editor;
  CardManager: typeof CardManager;
  CardStorage: typeof CardStorage;
  Settings: typeof Settings;
  Anims: typeof Anims;
  ExportUtils: typeof ExportUtils;
  AIService: typeof AIService;
  Wizard: typeof Wizard;
  ChatState: typeof ChatState;
  CardState: typeof CardState;
  syncFloatingLabels?: () => void;
  [k: string]: unknown;
}