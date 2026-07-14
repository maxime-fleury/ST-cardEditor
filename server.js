// Bun global — Bun.serve is always available
// import.meta.dir is supported in Bun

import { join, extname, resolve } from "path";

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

    // Determine file path and prevent directory traversal
    let filePath;
    if (pathname.startsWith("/js/")) {
      filePath = resolve(join(import.meta.dir, pathname));
      if (!filePath.startsWith(JS_DIR)) {
        return new Response("Forbidden", { status: 403 });
      }
    } else {
      filePath = resolve(join(PUBLIC_DIR, pathname));
      if (!filePath.startsWith(PUBLIC_DIR)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    return serveStatic(filePath, join(PUBLIC_DIR, "index.html"));
  },
});

console.log(`\n🧙 SillyTavern Card Editor running at http://localhost:${PORT}\n`);
