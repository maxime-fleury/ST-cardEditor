import { test, expect, mock } from 'bun:test';

// aiService.js now imports its dependencies as real ES modules (passe 4);
// mock I18n / CardStorage / Tokenizer with mock.module before importing.
const storage = {
  customModelId: '',
  providerModelIds: {},
  getCustomModelId: () => storage.customModelId,
  getProviderModelId: (p) => storage.providerModelIds[p] || '',
  getCustomApiKey: () => '',
  getCustomApiUrl: () => '',
  getProviderKey: () => '',
  getApiKey: () => '',
  getMaxTokens: () => 0,
};

const stubs = {
  I18n: { t: (key) => key },
  CardStorage: storage,
  Tokenizer: { count: async () => 0, syncCount: () => 0 },
};
mock.module('../../js/i18n.js', () => ({ I18n: stubs.I18n }));
mock.module('../../js/storage.js', () => ({ CardStorage: stubs.CardStorage }));
mock.module('../../js/tokenizer.js', () => ({ Tokenizer: stubs.Tokenizer }));

let AIService;
test('module loads with stubbed globals', async () => {
  AIService = (await import('../../js/aiService.js')).AIService;
  expect(AIService).toBeDefined();
});

test('_v1BaseUrl appends /v1 only to host roots', () => {
  expect(AIService._v1BaseUrl('http://localhost:1234')).toBe('http://localhost:1234/v1');
  expect(AIService._v1BaseUrl('http://localhost:1234/')).toBe('http://localhost:1234/v1');
  // Already-versioned URLs must never get a second /v1.
  expect(AIService._v1BaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
  expect(AIService._v1BaseUrl('http://localhost:1234/v2')).toBe('http://localhost:1234/v2');
  expect(AIService._v1BaseUrl('http://host/api/paas/v4')).toBe('http://host/api/paas/v4');
  // Query strings are not part of the path check.
  expect(AIService._v1BaseUrl('http://host/v1?tenant=x')).toBe('http://host/v1?tenant=x');
});

test('_resolveModel uses the per-provider slot, not the custom slot', () => {
  AIService.setProvider('deepseek', '');
  storage.customModelId = 'custom-model';
  storage.providerModelIds.deepseek = 'deepseek-chat';
  expect(AIService._resolveModel('')).toBe('deepseek-chat');
  expect(AIService._resolveModel('explicit-model')).toBe('explicit-model');
  // Custom provider falls back to the legacy custom slot.
  AIService.setProvider('custom', '');
  expect(AIService._resolveModel('')).toBe('custom-model');
});

test('chatStream keeps the final SSE line when the stream has no trailing newline', async () => {
  // Simulated SSE response: two data events, the last one with NO trailing
  // newline — a shape some OpenAI-compatible servers produce.
  const body = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n' +
               'data: {"choices":[{"delta":{"content":" world"}}]}';
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(body));
      controller.close();
    },
  });

  // Point the custom provider at a fake endpoint and answer the chat-completions
  // request with the simulated SSE stream (no trailing newline on the last line).
  AIService.setProvider('custom', '');
  AIService._customApiUrl = 'http://local.test/v1';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const chunks = [];
  let result;
  try {
    result = await AIService.chatStream(
      'prompt', 'system', 'model',
      (full, delta) => { chunks.push(delta); },
      null, false, []
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  expect(chunks).toEqual(['Hello', ' world']);
  expect(result.content).toBe('Hello world');
  expect(result.model).toBe('model');
});