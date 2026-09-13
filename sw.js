/* ============================================================
   sw.js — Service Worker for Offline Support
   Caches the app shell (HTML/CSS/JS) for offline usage.
   The same file is deployed at the site root and under /dev/, so all
   paths are resolved relative to this service worker's own directory.
   ============================================================ */

const BASE_PATH = new URL('.', self.location.href).pathname;
const CACHE_PREFIX = 'stce-v2.9.0';
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
  // Google Fonts (Inter / Plus Jakarta Sans / JetBrains Mono), vendored by
  // scripts/vendor.mjs: the stylesheet plus the 17 woff2 subsets it names.
  // They used to be the one cross-origin dependency left in the UI, cached at
  // runtime; same-origin now, so offline typography is part of the install.
  'vendor/fonts.css',
  'vendor/fonts/inter-latin.woff2',
  'vendor/fonts/inter-latin-ext.woff2',
  'vendor/fonts/inter-cyrillic.woff2',
  'vendor/fonts/inter-cyrillic-ext.woff2',
  'vendor/fonts/inter-greek.woff2',
  'vendor/fonts/inter-greek-ext.woff2',
  'vendor/fonts/inter-vietnamese.woff2',
  'vendor/fonts/plus-jakarta-sans-latin.woff2',
  'vendor/fonts/plus-jakarta-sans-latin-ext.woff2',
  'vendor/fonts/plus-jakarta-sans-cyrillic-ext.woff2',
  'vendor/fonts/plus-jakarta-sans-vietnamese.woff2',
  'vendor/fonts/jetbrains-mono-latin.woff2',
  'vendor/fonts/jetbrains-mono-latin-ext.woff2',
  'vendor/fonts/jetbrains-mono-cyrillic.woff2',
  'vendor/fonts/jetbrains-mono-cyrillic-ext.woff2',
  'vendor/fonts/jetbrains-mono-greek.woff2',
  'vendor/fonts/jetbrains-mono-vietnamese.woff2',
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

// NOTE: there is no cross-origin cache any more. Every asset the UI loads —
// scripts, styles, icons and fonts — is same-origin and listed in the shell
// above, so nothing needs a stale-while-revalidate path keyed on a hostname.

// Same-origin assets that are deliberately NOT part of the install-time shell,
// but should still work offline after their first successful fetch. Caching on
// demand keeps the install cheap while preserving the "used it once → works
// offline" property:
//   - the vendored BPE tokenizer (~2.7 MB, fetched on the first token count);
//   - the 26 language dictionaries. Only English ships inside the boot chunk:
//     the other 26 were ~845 KB of the ~1.2 MB it used to be, i.e. 71% of the
//     JavaScript every user downloaded so that each user could read one of them.
//     A dictionary is fetched when its language is selected and cached here, so
//     a language works offline once it has been used online once. Switching to
//     a never-fetched language while offline falls back to English and says so
//     (js/i18n.js). check-assets fails if this list and js/i18n.js disagree.
const RUNTIME_FILES = [
  'vendor/gpt-tokenizer.js',
  'js/i18n/fr.js',
  'js/i18n/es.js',
  'js/i18n/de.js',
  'js/i18n/pt.js',
  'js/i18n/ja.js',
  'js/i18n/zh.js',
  'js/i18n/ko.js',
  'js/i18n/el.js',
  'js/i18n/ru.js',
  'js/i18n/it.js',
  'js/i18n/pl.js',
  'js/i18n/tr.js',
  'js/i18n/nl.js',
  'js/i18n/uk.js',
  'js/i18n/vi.js',
  'js/i18n/id.js',
  'js/i18n/hi.js',
  'js/i18n/ar.js',
  'js/i18n/he.js',
  'js/i18n/fa.js',
  'js/i18n/ro.js',
  'js/i18n/cs.js',
  'js/i18n/sv.js',
  'js/i18n/th.js',
  'js/i18n/pt-pt.js',
  'js/i18n/tl.js',
].map((file) => new URL(file, self.location.href).pathname);
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
        // Keys without a ':' are legacy caches (pre-path-scoping, e.g.
        // "stce-v2.2") or the retired cross-origin font cache
        // ("stce-fonts-…"); neither carries a path, so they can't be matched to
        // any deployment and must be removed rather than leaked forever.
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
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

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
