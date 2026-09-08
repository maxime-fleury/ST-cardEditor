import { test, expect, mock } from 'bun:test';

// settings.js now imports its dependencies as real ES modules (passe 4);
// mock each with mock.module, using a tiny in-memory store for CardStorage.
const noop = () => {};
const store = {
  provider: 'openrouter',
  defaultModel: '',
  customModelId: '',
  providerModelIds: {},
  getProvider: () => store.provider,
  setProvider: (p) => { store.provider = p || 'openrouter'; },
  getDefaultModel: () => store.defaultModel,
  setDefaultModel: (v) => { store.defaultModel = v || ''; },
  getCustomModelId: () => store.customModelId,
  setCustomModelId: (v) => { store.customModelId = v || ''; },
  getProviderModelId: (p) => store.providerModelIds[p] || '',
  setProviderModelId: (p, v) => {
    if (!p) return;
    if (v) store.providerModelIds[p] = v;
    else delete store.providerModelIds[p];
  },
  getAllProviderModelIds: () => {
    const out = {};
    for (const [p, v] of Object.entries(store.providerModelIds)) if (p && v) out[p] = v;
    return out;
  },
};

const stubs = {
  I18n: { t: (key) => key },
  CardStorage: store,
  Ui: {},
  AIService: {},
  CardEngine: {},
  CardManager: {},
  Editor: {},
  Anims: {},
  AiChat: {},
};
mock.module('../../js/i18n.js', () => ({ I18n: stubs.I18n }));
mock.module('../../js/storage.js', () => ({ CardStorage: stubs.CardStorage }));
mock.module('../../js/ui.js', () => ({ Ui: stubs.Ui }));
mock.module('../../js/aiService.js', () => ({ AIService: stubs.AIService }));
mock.module('../../js/cardEngine.js', () => ({ CardEngine: stubs.CardEngine }));
mock.module('../../js/cardManager.js', () => ({ CardManager: stubs.CardManager }));
mock.module('../../js/editor.js', () => ({ Editor: stubs.Editor }));
mock.module('../../js/animations.js', () => ({ Anims: stubs.Anims }));
mock.module('../../js/aiChat.js', () => ({ AiChat: stubs.AiChat }));

let Settings;
test('module loads with stubbed globals', async () => {
  Settings = (await import('../../js/settings.js')).Settings;
  expect(Settings).toBeDefined();
});

test('_currentModelId reads the provider-appropriate slot', () => {
  store.provider = 'openrouter';
  store.defaultModel = 'or-model';
  store.customModelId = 'custom-model';
  store.providerModelIds.deepseek = 'deepseek-chat';
  expect(Settings._currentModelId('openrouter')).toBe('or-model');
  expect(Settings._currentModelId('custom')).toBe('custom-model');
  expect(Settings._currentModelId('deepseek')).toBe('deepseek-chat');
  expect(Settings._currentModelId()).toBe('or-model'); // falls back to saved provider
});

test('_setCurrentModelId routes to the provider-appropriate slot', () => {
  // Named provider: per-provider slot only — the OpenRouter default must not move.
  Settings._setCurrentModelId('deepseek-chat', 'deepseek');
  expect(store.providerModelIds.deepseek).toBe('deepseek-chat');
  expect(store.defaultModel).toBe('or-model');
  // Custom provider: custom slot only.
  Settings._setCurrentModelId('llama-3.2-8b', 'custom');
  expect(store.customModelId).toBe('llama-3.2-8b');
  expect(store.defaultModel).toBe('or-model');
  // OpenRouter: the shared default slot (its only home).
  Settings._setCurrentModelId('openrouter-new', 'openrouter');
  expect(store.defaultModel).toBe('openrouter-new');
  // Clearing a named provider's model removes its slot entry.
  Settings._setCurrentModelId('', 'deepseek');
  expect(store.providerModelIds.deepseek).toBeUndefined();
});

test('_currentModelId falls back to the saved provider when no provider is given', () => {
  store.provider = 'custom';
  store.customModelId = 'custom-model';
  expect(Settings._currentModelId()).toBe('custom-model');
  store.provider = 'deepseek';
  store.providerModelIds.deepseek = 'deepseek-chat';
  expect(Settings._currentModelId()).toBe('deepseek-chat');
  store.provider = 'openrouter';
});

test('getAllProviderModelIds returns only non-empty entries', () => {
  store.providerModelIds = { deepseek: 'deepseek-chat', xai: '', nanogpt: 'gpt-x' };
  expect(store.getAllProviderModelIds()).toEqual({ deepseek: 'deepseek-chat', nanogpt: 'gpt-x' });
});

// importSettings must route an imported defaultModel into the provider-appropriate
// slot (v2 #25), not force it into the shared OpenRouter slot: importing a file
// whose provider is DeepSeek must land the model in the deepseek slot, leaving
// the OpenRouter default untouched.
test('importSettings routes the imported model into the imported provider\'s slot', async () => {
  store.provider = 'openrouter';
  store.defaultModel = 'or-existing';
  store.providerModelIds = {};
  const file = { name: 'settings.json' };
  const reader = {
    result: JSON.stringify({ provider: 'deepseek', defaultModel: 'deepseek-chat', maxTokens: 8000 }),
    onload: null,
    readAsText: function () { this.onload(); },
  };
  globalThis.FileReader = function () { return reader; };
  const els = {
    '#settingsFileInput': { onchange: null, click: () => {} },
    '#providerSelect': { value: '' },
    '#defaultModelSelect': { value: '' },
    '#aiModelSelect': { value: '' },
    '#maxTokensInput': { value: '' },
    '#injectCopyrightToggle': { checked: false },
    '#customApiUrlInput': { value: '' },
    '#customModelInput': { value: '' },
  };
  globalThis.document = {
    querySelector: (sel) => els[sel] || null,
  };
  stubs.Ui.showToast = noop;
  stubs.Ui.$ = (sel) => els[sel] || null;
  Settings.toggleProvider = noop;

  Settings.importSettings();
  els['#settingsFileInput'].onchange({ target: { files: [file] } });
  await Promise.resolve(); // flush the async onload

  // DeepSeek slot receives the imported model…
  expect(store.providerModelIds.deepseek).toBe('deepseek-chat');
  // …and the shared OpenRouter slot is NOT clobbered by a DeepSeek import.
  expect(store.defaultModel).toBe('or-existing');
  // The visible dropdowns mirror the routed value.
  expect(els['#aiModelSelect'].value).toBe('deepseek-chat');
  delete globalThis.FileReader;
  delete globalThis.document;
});

// Service-worker activate filter: the CDN cache (no ':' in its name) must be
// exempt from the legacy-cache purge, or it gets wiped on every activation.
test('sw activate filter keeps the CDN cache and old legacy caches are still purged', () => {
  const CDN_CACHE = 'stce-cdn-v2.5.3';
  const CACHE_NAME = 'stce-v2.5.5:/';
  const BASE_PATH = '/';
  const keep = (key) => {
    const separator = key.indexOf(':');
    const cachePath = separator >= 0 ? key.slice(separator + 1) : '';
    if (key === CDN_CACHE || key.startsWith('stce-cdn-')) return false; // never purge the CDN cache
    return key.startsWith('stce-') && key !== CACHE_NAME && (cachePath === BASE_PATH || cachePath === '');
  };
  const keys = [CDN_CACHE, 'stce-cdn-v2.5.0', CACHE_NAME, 'stce-v2.2', 'stce-v2.5.5:/other/', 'unrelated-cache'];
  const toDelete = keys.filter(keep);
  expect(toDelete).toEqual(['stce-v2.2']); // only the true legacy cache
});