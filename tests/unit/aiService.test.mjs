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
  aiTimeout: 0,
  getAiTimeout: () => storage.aiTimeout,
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

test('the request timeout follows the stored setting, clamped', () => {
  // Unset (or 0) keeps the built-in 2-minute default.
  storage.aiTimeout = 0;
  expect(AIService.getRequestTimeoutMs()).toBe(120000);
  // The Settings field is in seconds, so 180 means the 3 minutes #5 asked for.
  storage.aiTimeout = 180;
  expect(AIService.getRequestTimeoutMs()).toBe(180000);
  // Clamped: a typo can neither abort instantly nor hang for a day.
  storage.aiTimeout = 1;
  expect(AIService.getRequestTimeoutMs()).toBe(5000);
  storage.aiTimeout = 99999;
  expect(AIService.getRequestTimeoutMs()).toBe(3600000);
  // A signal is still produced for callers that pass none.
  expect(AIService._withTimeout(null)).toBeInstanceOf(AbortSignal);
  storage.aiTimeout = 0;
});

// ─── Distinguishable failures (issue #5 follow-up) ────────────────────────

test('describeError names a timeout, an unreachable endpoint and a rejected key apart', () => {
  AIService.setProvider('openrouter', '');
  storage.aiTimeout = 0;
  // DOMException from AbortSignal.timeout(), the shape fetch actually rejects with.
  const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  expect(AIService.describeError(timeout)).toEqual({ key: 'error.timeout', values: { seconds: 120 } });
  // The message reports the timeout that was actually in effect.
  storage.aiTimeout = 180;
  expect(AIService.describeError(timeout).values).toEqual({ seconds: 180 });
  storage.aiTimeout = 0;

  // A dead endpoint: fetch rejects with a TypeError, tagged with the URL it tried.
  const dead = Object.assign(new TypeError('Failed to fetch'), { url: 'http://localhost:1/v1' });
  expect(AIService.describeError(dead)).toEqual({ key: 'error.network', values: { url: 'http://localhost:1/v1' } });
  // …and the wording is recognized even when the URL was not tagged.
  expect(AIService.describeError(new TypeError('NetworkError when attempting to fetch resource.')).key).toBe('error.network');

  // HTTP failures are classified from the status we now attach.
  expect(AIService.describeError(Object.assign(new Error('bad key'), { status: 401 })))
    .toEqual({ key: 'error.auth', values: { status: 401, provider: 'OpenRouter' } });
  expect(AIService.describeError(Object.assign(new Error('nope'), { status: 403 })).key).toBe('error.auth');
  expect(AIService.describeError(Object.assign(new Error('busy'), { status: 429 })).key).toBe('error.rateLimit');
  expect(AIService.describeError(Object.assign(new Error('boom'), { status: 503 })))
    .toEqual({ key: 'error.serverError', values: { status: 503, provider: 'OpenRouter' } });
  expect(AIService.describeError(Object.assign(new Error('who?'), { status: 404, model: 'ghost-9' })))
    .toEqual({ key: 'error.modelRejected', values: { provider: 'OpenRouter', model: 'ghost-9' } });

  // Already-localized / local validation errors keep their own text.
  expect(AIService.describeError(Object.assign(new Error('Insufficient credits.'), { status: 402 }))).toBeNull();
  expect(AIService.describeError(new Error('No model selected.'))).toBeNull();
  expect(AIService.describeError(null)).toBeNull();
  expect(AIService.describeError('nope')).toBeNull();
});

test('testConnection probes the real request path and reports latency, model and timeout', async () => {
  AIService.setProvider('custom', '');
  AIService._customApiUrl = 'http://mock.test/v1';
  storage.customModelId = 'mock-model';
  storage.aiTimeout = 180;
  let seen = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(String(init && init.body)) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'mock-model' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  let res;
  try {
    res = await AIService.testConnection();
  } finally {
    globalThis.fetch = origFetch;
  }
  expect(res.ok).toBe(true);
  expect(res.provider).toBe('Custom');
  expect(res.model).toBe('mock-model');
  expect(res.reply).toBe('ok');
  expect(res.timeoutMs).toBe(180000);
  expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  // It goes through chat/completions with a capped output, so a probe costs
  // a handful of tokens rather than a whole generation.
  expect(seen.url).toBe('http://mock.test/v1/chat/completions');
  expect(seen.body.max_tokens).toBe(8);
  storage.aiTimeout = 0;
  storage.customModelId = '';
});

test('testConnection surfaces the failure so it can be classified', async () => {
  AIService.setProvider('custom', '');
  AIService._customApiUrl = 'http://mock.test/v1';
  storage.customModelId = 'mock-model';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  let err = null;
  try {
    await AIService.testConnection();
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = origFetch;
  }
  expect(err).not.toBeNull();
  // Tagged with the endpoint it could not reach, so Settings can say which.
  expect(AIService.describeError(err)).toEqual({ key: 'error.network', values: { url: 'http://mock.test/v1' } });
  storage.customModelId = '';
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