/* ============================================================
   sw.js — Service Worker for Offline Support
   Caches the app shell (HTML/CSS/JS) for offline usage.
   The same file is deployed at the site root and under /dev/, so all
   paths are resolved relative to this service worker's own directory.
   ============================================================ */

const BASE_PATH = new URL('.', self.location.href).pathname;
const CACHE_PREFIX = 'stce-v2.5.1';
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
  // App JS is a single built bundle (bun run build) — js/app.js. Source modules
  // under js/*.js are bundled into it, so the shell only needs the artifact.
  'js/app.js',
];

const shellUrl = (file) => new URL(file || './', self.location.href).toString();
const shellPaths = new Set(SHELL_FILES.map(file => new URL(file || './', self.location.href).pathname));

// Third-party CDN origins the UI depends on (Bootstrap CSS/JS, bootstrap-icons
// font, Google Fonts, anime.js, jsdiff, and the lazy-loaded markdown/tokenizer
// libs). They're cross-origin, so the shell list above cannot precache them;
// cache them at runtime (stale-while-revalidate) so the app truly works offline.
const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);
const CDN_CACHE = 'stce-cdn-v2.5.1';

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
  caches.open(CDN_CACHE).then((cache) =>
    cache.match(request, { ignoreVary: true }).then((cached) => {
      // Revalidate in the background (and prewarm the cache on first hit).
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CDN_CACHE).then((c) => c.put(request, copy));
          }
        })
        .catch(() => {});
      return cached || fetch(request);
    })
  );

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Third-party CDN assets: serve stale-from-cache first, refresh in background.
  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // The stable worker's scope includes /dev/, but it must not serve or cache
  // development requests. The /dev/ worker owns those requests instead.
  if (url.origin !== self.location.origin || url.pathname.startsWith(`${BASE_PATH}api/`)
      || (!BASE_PATH.endsWith('/dev/') && url.pathname.startsWith(DEV_PATH))) return;

  const store = (request, response) => {
    // Only clairvoyaged shell assets belong in the app cache. Caching every
    // same-origin GET would grow the cache without bound (#35); shell files are
    // the only assets the offline UI needs. Keep writes inside waitUntil so the
    // worker doesn't die mid-write.
    if (!isShellFile) return;
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, response)));
  };

  // Shell files are cached under their bare path (query strings stripped) so a
  // ?v= bump still hits the cached copy when offline.
  const isShellFile = shellPaths.has(url.pathname);
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
