// Bun global — Bun.serve is always available
// import.meta.dir is supported in Bun

import { join, extname } from "path";
import { existsSync, readFileSync } from "fs";

const PORT = parseInt(process.env.PORT || '8182');
const PUBLIC_DIR = join(import.meta.dir, "public");

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

function serveStatic(filePath, fallbackPath) {
  if (existsSync(filePath)) {
    const content = readFileSync(filePath);
    const mimeType = getMimeType(filePath);
    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  if (fallbackPath && existsSync(fallbackPath)) {
    const content = readFileSync(fallbackPath);
    return new Response(content, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Not Found", { status: 404 });
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Root serves index.html
    if (pathname === "/") {
      pathname = "/index.html";
    }

    // Determine file path
    let filePath;
    if (pathname.startsWith("/js/")) {
      filePath = join(import.meta.dir, pathname);
    } else {
      filePath = join(PUBLIC_DIR, pathname);
    }

    return serveStatic(filePath, join(PUBLIC_DIR, "index.html"));
  },
});

console.log(`\n🧙 SillyTavern Card Editor running at http://localhost:${PORT}\n`);
