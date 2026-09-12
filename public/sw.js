/* ============================================================
   sw.js — Service Worker for Offline Support
   Caches the app shell (HTML/CSS/JS) for offline usage.
   The same file is deployed at the site root and under /dev/, so all
   paths are resolved relative to this service worker's own directory.
   ============================================================ */

const BASE_PATH = new URL('.', self.location.href).pathname;
const CACHE_PREFIX = 'stce-v2.8.1';
const CACHE_NAME = `${CACHE_PREFIX}:${BASE_PATH}`;
const DEV_PATH = BASE_PATH.endsWith('/dev/')
  ? BASE_PATH
  : `${BASE_PATH.replace(/\/$/, '')}/dev/`;
const SHELL_FILES = [
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'css/theme.css',
  'css/appearance.css',
  'css/base.css',
  'css/layout.css',
  'css/library.css',
  'css/editor.css',
  'css/ai-assistant.css',
  'css/modal.css',
  'css/diff.css',
  'css/wizard.css',
  'css/components.css',
  'css/responsive.css',
  // Vendored third-party assets (see scripts/vendor.mjs): Bootstrap CSS/JS,
  // bootstrap-icons + its fonts, jsdiff, anime.js and the lazily-loaded
  // markdown libs. They are same-origin now, so the offline shell can precache
  // them instead of relying on a runtime CDN round-trip.
  'vendor/bootstrap.min.css',
  'vendor/bootstrap.rtl.min.css',
  'vendor/bootstrap.bundle.min.js',
  'vendor/bootstrap-icons.css',
  'vendor/fonts/bootstrap-icons.woff2',
  'vendor/fonts/bootstrap-icons.woff',
  'vendor/diff.min.js',
  'vendor/anime.min.js',
  'vendor/marked.min.js',
  'vendor/purify.min.js',
  // App JS is built by `bun run build` into a code-split ESM bundle: a tiny
  // entry (js/app.js), one shared chunk (js/app.chunk.js), and one lazy chunk
  // per deferred module (js/wizard.chunk.js, js/waifuTab.chunk.js,
  // js/commandPalette.chunk.js). All are precached so the app — and the lazy
  // surfaces on first open — work offline. check-assets verifies this list
  // matches the build output.
  'js/app.js',
  'js/app.chunk.js',
  'js/wizard.chunk.js',
  'js/waifuTab.chunk.js',
  'js/commandPalette.chunk.js',
];

const shellUrl = (file) => new URL(file || './', self.location.href).toString();
const shellPaths = new Set(SHELL_FILES.map(file => new URL(file || './', self.location.href).pathname));

// Google Fonts is the only third-party origin left in the UI (fonts are pure
// data, no code): its stylesheet and the woff2 files it points at are
// cross-origin, so the shell list above cannot precache them. They are cached
// at runtime (stale-while-revalidate) so typography survives offline.
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
// Named for what it holds. It used to be CDN_CACHE ('stce-cdn-…') back when
// Bootstrap/jsdiff/anime/marked came from jsdelivr; those are vendored now, so
// the only cross-origin requests left are these fonts.
const FONT_CACHE = 'stce-fonts-v2.8.1';

// Same-origin assets that are deliberately NOT in the precached shell because
// of their size, but should still work offline after their first successful
// fetch (the vendored BPE tokenizer, ~2.7 MB). Caching on demand keeps the
// install cheap while preserving the "used it once → works offline" property.
const RUNTIME_FILES = ['vendor/gpt-tokenizer.js'].map(
  (file) => new URL(file, self.location.href).pathname
);
const runtimePaths = new Set(RUNTIME_FILES);

// Install: cache the app shell. Precaching is done per-file so one missing
// asset (404) degrades offline coverage instead of aborting the whole install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.allSettled(
      SHELL_FILES.map((file) => cache.add(shellUrl(file)))
    )).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) console.warn(`SW: ${failed} shell file(s) could not be precached.`);
    })
  );
  self.skipWaiting();
});

// Activate: clean old app-shell caches, but do not touch unrelated origins.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      // Only remove caches belonging to this app and this deployment path.
      // The stable worker must never delete the /dev/ worker's cache.
      keys.filter((key) => {
        const separator = key.indexOf(':');
        const cachePath = separator >= 0 ? key.slice(separator + 1) : '';
        // The font cache is deliberately global (cross-path) and must survive
        // activation: its name contains no ':', so without this exemption it
        // would be classified as a legacy cache and deleted on every update,
        // leaving typography unstyled right after an upgrade.
        if (key === FONT_CACHE || key.startsWith('stce-fonts-')) return false;
        // Keys without a ':' are legacy caches (pre-path-scoping, e.g.
        // "stce-v2.2"). They carry no path, so they can't be matched to any
        // deployment and must be removed rather than leaked forever.
        return key.startsWith('stce-') && key !== CACHE_NAME &&
          (cachePath === BASE_PATH || cachePath === '');
      })
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

// Fetch: network-first for everything, cache as fallback (and offline cache).
// Network-first means a freshly deployed index.html (with its new ?v= busters)
// is always served online; the cache only matters when offline.
const staleWhileRevalidate = (request) =>
  caches.open(FONT_CACHE).then((cache) =>
    cache.match(request, { ignoreVary: true }).then((cached) => {
      // Revalidate in the background (and prewarm the cache on first hit).
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(FONT_CACHE).then((c) => c.put(request, copy));
          }
        })
        .catch(() => {});
      return cached || fetch(request);
    })
  );

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Cross-origin font assets: serve stale-from-cache first, refresh in background.
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // The stable worker's scope includes /dev/, but it must not serve or cache
  // development requests. The /dev/ worker owns those requests instead.
  if (url.origin !== self.location.origin || url.pathname.startsWith(`${BASE_PATH}api/`)
      || (!BASE_PATH.endsWith('/dev/') && url.pathname.startsWith(DEV_PATH))) return;

  // Shell files (and the handful of opted-in runtime files above) are cached
  // under their bare path (query strings stripped) so a ?v= bump still hits the
  // cached copy when offline.
  const isShellFile = shellPaths.has(url.pathname);
  const isRuntimeFile = runtimePaths.has(url.pathname);

  const store = (request, response) => {
    // Only the shell assets and the recorded runtime opt-ins belong in the app
    // cache. Caching every same-origin GET would grow the cache without bound
    // (#35); these are the only assets the offline UI needs. Keep writes inside
    // waitUntil so the worker doesn't die mid-write.
    if (!isShellFile && !isRuntimeFile) return;
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, response)));
  };

  const cacheKey = isShellFile ? new Request(url.pathname) : event.request;
  const fallbackUrl = isShellFile
    ? event.request
    : event.request.mode === 'navigate'
      ? new Request(new URL('index.html', self.location.href))
      : event.request;

  const offlineHit = (request) =>
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request, { ignoreVary: true }).then((hit) => hit || null)
    );

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && !response.redirected) store(cacheKey, response.clone());
        return response;
      })
      .catch(() =>
        // Offline: prefer the exact asset, then the SPA shell. A cache miss on
        // BOTH must not resolve to undefined — respondWith(undefined) throws a
        // TypeError and the request fails without a meaningful response (#67).
        offlineHit(cacheKey).then((hit) => {
          if (hit) return hit;
          const nav = event.request.mode === 'navigate';
          return offlineHit(fallbackUrl).then((shell) => {
            if (shell) return shell;
            return new Response(
              nav
                ? '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:system-ui;text-align:center;padding:3rem"><h1>ST Card Editor</h1><p>You appear to be offline and the app shell has not been cached yet.</p></body>'
                : 'Offline',
              {
                status: 503,
                headers: { 'Content-Type': nav ? 'text/html; charset=utf-8' : 'text/plain' },
              }
            );
          });
        })
      )
  );
});
