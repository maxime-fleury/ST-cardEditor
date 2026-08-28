// Bun global — Bun.serve is always available
// import.meta.dir is supported in Bun

import { join, extname, resolve, sep } from "path";

const PORT = parseInt(process.env.PORT || '8182');
const PUBLIC_DIR = resolve(join(import.meta.dir, "public"));
const JS_DIR = resolve(join(import.meta.dir, "js"));

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
  if (file.size > 0) {
    const content = await file.arrayBuffer();
    const mimeType = getMimeType(filePath);
    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
        // CSP: dedupe script hosts; connect-src must allow loopback APIs
        // (LM Studio, Ollama, etc.) used by the Custom provider.
        // script-src intentionally omits 'unsafe-inline' (all app/CDN scripts are
        // loaded via external src) to block inline-script injection via XSS.
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval' cdn.jsdelivr.net cdnjs.cloudflare.com esm.sh; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net fonts.googleapis.com; font-src 'self' cdn.jsdelivr.net fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https://openrouter.ai https://api.nano-gpt.com https://api.x.ai https://api.z.ai https://llm.chutes.ai https://api.deepseek.com https://api.waifu.im;",
      },
    });
  }
  const fallbackFile = fallbackPath ? Bun.file(fallbackPath) : null;
  if (fallbackFile && fallbackFile.size > 0) {
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
      const targetUrl = `https://openrouter.ai/api${targetPath}${url.search}`;
      const headers = new Headers();
      for (const [key, val] of req.headers) {
        if (key.toLowerCase() === "host") continue;
        headers.set(key, val);
      }
      const body = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
      });
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

    return serveStatic(filePath, join(PUBLIC_DIR, "index.html"));
  },
});

console.log(`\n🧙 SillyTavern Card Editor running at http://localhost:${PORT}\n`);
