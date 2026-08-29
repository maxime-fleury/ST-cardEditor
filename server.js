// Bun global — Bun.serve is always available
// import.meta.dir is supported in Bun

import { join, extname, resolve, sep } from "path";

const PORT = parseInt(process.env.PORT || '8182');
const PUBLIC_DIR = resolve(join(import.meta.dir, "public"));
const JS_DIR = resolve(join(import.meta.dir, "js"));

// Extra origins allowed in CSP connect-src, e.g. a LAN-hosted LLM server
// (LM Studio, Ollama, vLLM) reachable at something other than localhost/
// 127.0.0.1. Space-separated list, e.g.
// "http://192.168.1.189:1234 http://192.168.1.189:11434".
const EXTRA_CONNECT_SRC = (process.env.CUSTOM_LLM_ORIGINS || '').trim();

// MIME types map
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function getMimeType(path) {
  return MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

async function serveStatic(filePath, fallbackPath) {
  const file = Bun.file(filePath);
  // Bun.file(filename) has size 0 for a *missing* file, so distinguish a real
  // zero-byte asset from "not found" via exists() (#46).
  if (await file.exists()) {
    const content = await file.arrayBuffer();
    const mimeType = getMimeType(filePath);
    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        // CSP: dedupe script hosts; connect-src must allow loopback APIs
        // (LM Studio, Ollama, etc.) used by the Custom provider.
        // script-src intentionally omits 'unsafe-inline' (all app/CDN scripts are
        // loaded via external src) to block inline-script injection via XSS.
        // connect-src allows any http: origin (not just localhost) because the
        // Custom provider's whole purpose is reaching OpenAI-compatible servers
        // on local/LAN/WAN addresses (LM Studio, Ollama, vLLM...). https: stays
        // host-allowlisted; CUSTOM_LLM_ORIGINS adds further hosts (e.g. https).
        // cdn.waifu.im is where the wizard blob-fetches image bytes.
        "Content-Security-Policy": "default-src 'self'; script-src 'self' cdn.jsdelivr.net cdnjs.cloudflare.com esm.sh; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net fonts.googleapis.com; font-src 'self' cdn.jsdelivr.net fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' http: ws://localhost:* ws://127.0.0.1:* https://openrouter.ai https://api.nano-gpt.com https://api.x.ai https://api.z.ai https://llm.chutes.ai https://api.deepseek.com https://api.waifu.im https://cdn.waifu.im" + (EXTRA_CONNECT_SRC ? " " + EXTRA_CONNECT_SRC : "") + ";",
      },
    });
  }
  const fallbackFile = fallbackPath ? Bun.file(fallbackPath) : null;
  if (fallbackFile && (await fallbackFile.exists())) {
    const content = await fallbackFile.arrayBuffer();
    return new Response(content, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Not Found", { status: 404 });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Root serves index.html
    if (pathname === "/") {
      pathname = "/index.html";
    }

    // API proxy — forwards requests to OpenRouter to avoid CORS
    if (pathname.startsWith("/api/")) {
      // The editor itself is a same-origin SPA, so the proxy must not serve as an
      // open relay for third-party sites. Browsers attach an Origin header to
      // cross-site requests (and cannot spoof it from page JS); require that any
      // Origin we do receive is the editor's own, since a foreign site could
      // otherwise drive the proxy (and relay its own Authorization). Non-browser
      // CLI clients omit Origin and are treated as trusted local tooling.
      const requestOrigin = req.headers.get("origin");
      if (requestOrigin) {
        const own = url.origin; // e.g. http://localhost:8182
        if (requestOrigin !== own) {
          return new Response("Forbidden", { status: 403 });
        }
      }
      // Handle CORS preflight before proxying API requests.
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
      const targetPath = pathname.slice(4); // remove /api prefix
      const targetUrl = new URL(`https://openrouter.ai/api${targetPath}${url.search}`);
      // Ensure path manipulation (e.g. encoded "//host" tricks) can never
      // redirect the proxy to a different origin than the intended upstream.
      if (targetUrl.origin !== "https://openrouter.ai") {
        return new Response("Forbidden", { status: 403 });
      }
      const headers = new Headers();
      // Forward only a safe whitelist upstream — never cookies or caller-supplied
      // X-Forwarded-* headers (#20). Cloudflare/NGINX rewrite these downstream;
      // trusting caller values would let the client hoist arbitrary hops.
      const SAFE_UPLINK_HEADERS = new Set(['content-type', 'accept', 'authorization', 'accept-encoding']);
      for (const [key, val] of req.headers) {
        const lower = key.toLowerCase();
        if (SAFE_UPLINK_HEADERS.has(lower)) headers.set(key, val);
      }
      headers.set('x-forwarded-host', url.host);
      headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
      const body = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;
      let upstream;
      try {
        // Reject redirects: following a cross-origin Location would let an
        // upstream response bounce the proxy to internal or metadata services (SSRF).
        upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.timeout(120000),
          redirect: "error",
        });
      } catch (err) {
        console.error("API proxy request failed:", err?.message || err);
        return new Response(
          JSON.stringify({ error: { message: "Upstream request failed: " + (err?.message || "network error"), type: "proxy_error" } }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
      const respHeaders = new Headers();
      const safeHeaders = ['content-type', 'cache-control', 'x-ratelimit-remaining', 'x-ratelimit-limit'];
      for (const [key, val] of upstream.headers) {
        if (safeHeaders.includes(key.toLowerCase())) respHeaders.set(key, val);
      }
      respHeaders.set("Access-Control-Allow-Origin", "*");
      return new Response(upstream.body, {
        status: upstream.status,
        headers: respHeaders,
      });
    }

    // Determine file path and prevent directory traversal
    let filePath;
    if (pathname.startsWith("/js/")) {
      filePath = resolve(join(import.meta.dir, pathname));
      if (filePath !== JS_DIR && !filePath.startsWith(JS_DIR + sep)) {
        return new Response("Forbidden", { status: 403 });
      }
    } else {
      filePath = resolve(join(PUBLIC_DIR, pathname));
      if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    // SPA fallback: only rewrite request-like extension-less paths (e.g. a
    // deep link) to index.html. Missing real assets (js/css/png/etc.) must 404
    // instead of silently returning HTML with a 200.
    const isAsset = extname(pathname) !== "";
    const fallback = isAsset ? null : join(PUBLIC_DIR, "index.html");
    return serveStatic(filePath, fallback);
  },
});

console.log(`\n🧙 SillyTavern Card Editor running at http://localhost:${PORT}\n`);
