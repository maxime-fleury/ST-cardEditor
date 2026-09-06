import { test, expect } from 'bun:test';

// Settings reads CardStorage (and I18n) at call time only — stub the globals
// with a tiny in-memory store before importing.
globalThis.I18n = { t: (key) => key };
const store = {
  provider: 'openrouter',
  defaultModel: '',
  customModelId: '',
  providerModelIds: {},
  getProvider: () => store.provider,
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
globalThis.CardStorage = store;

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
  expect(CardStorage.getAllProviderModelIds()).toEqual({ deepseek: 'deepseek-chat', nanogpt: 'gpt-x' });
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