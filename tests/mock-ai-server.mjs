/* ============================================================
   mock-ai-server.mjs — scripted OpenAI-compatible endpoint for e2e
   ============================================================
   Serves the two chat-completions shapes AIService consumes, so the
   live-model suite runs hermetically in CI without a real model:
     - POST /v1/chat/completions with stream:true + response_format
       json_object  -> SSE-streams a JSON array (suggest-tags / intent)
     - POST /v1/chat/completions with stream:true only
                    -> SSE-streams descriptive prose (field edits)
     - POST /v1/chat/completions with stream:false
                    -> plain JSON with a JSON-array content
     - GET  /v1/models (and /models) -> the model list for the dropdown
   Chunks are flushed progressively with small delays so the app's real
   streaming, token-counter and [DONE] paths are exercised. */

const PORT = Number(process.env.MOCK_AI_PORT || 9900);
const MODEL_ID = process.env.MOCK_AI_MODEL || 'mock-model';
const MODEL_NAME = process.env.MOCK_AI_MODEL_NAME || 'Mock Model';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const TAG_ARRAY = '["anime","fantasy","slice of life"]';
const PROSE =
  'She is a broke student who cleans apartments for money, sharp-eyed and pragmatic. '
  + 'Nothing escapes her notice: the habits, the clutter, the small secrets left out in the open. '
  + 'She works fast, talks little, and remembers everything.';

/** @param {string[]} chunks @returns {Response} */
function streamResponse(chunks, extra = {}) {
  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for (const [i, chunk] of chunks.entries()) {
        // First chunk carries the role; later chunks carry content deltas.
        const delta = i === 0 ? { role: 'assistant', content: chunk } : { content: chunk };
        const payload = JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: null }],
        });
        controller.enqueue(enc.encode('data: ' + payload + '\n\n'));
        await new Promise((r) => { setTimeout(r, 25); });
      }
      const done = JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...extra,
      });
      controller.enqueue(enc.encode('data: ' + done + '\n\n'));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS },
  });
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS },
});

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Model list for the settings dropdown.
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return json({
        data: [{
          id: MODEL_ID,
          name: MODEL_NAME,
          context_length: 8192,
          max_output_tokens: 2048,
        }],
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await req.json().catch(() => ({}));
      const stream = body.stream === true;
      const jsonMode = body.response_format && body.response_format.type === 'json_object';

      if (!stream) {
        // Non-streaming (intent classification): a JSON-array answer.
        return json({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: TAG_ARRAY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18, cost: 0 },
          model: MODEL_ID,
        });
      }

      if (jsonMode) {
        // Suggest-tags: SSE-stream the JSON array so the app's streaming
        // parser AND its array parsing are both exercised.
        const parts = TAG_ARRAY.match(/(\[|,|"|]|[a-z ]+)/g) || [TAG_ARRAY];
        return streamResponse(parts, { usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, cost: 0 } });
      }

      // Field edit: stream descriptive prose word by word.
      return streamResponse(PROSE.split(/(?<=\s)/), { usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70, cost: 0 } });
    }

    return json({ error: { message: 'not found: ' + url.pathname } }, 404);
  },
});

console.log(`🤖 Mock AI server (${MODEL_ID}) running at http://localhost:${PORT}/v1`);