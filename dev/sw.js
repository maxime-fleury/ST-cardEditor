/* ============================================================
   sw.js — Service Worker for Offline Support
   Caches the app shell (HTML/CSS/JS) for offline usage.
   The same file is deployed at the site root and under /dev/, so all
   paths are resolved relative to this service worker's own directory.
   ============================================================ */

const BASE_PATH = new URL('.', self.location.href).pathname;
const CACHE_PREFIX = 'stce-v2.3';
const CACHE_NAME = `${CACHE_PREFIX}:${BASE_PATH}`;
const DEV_PATH = BASE_PATH.endsWith('/dev/')
  ? BASE_PATH
  : `${BASE_PATH.replace(/\/$/, '')}/dev/`;
const SHELL_FILES = [
  '',
  'index.html',
  'css/theme.css',
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
  'js/aiChat.js',
  'js/aiService.js',
  'js/animations.js',
  'js/cardEngine.js',
  'js/cardManager.js',
  'js/editor.js',
  'js/exportUtils.js',
  'js/i18n.js',
  'js/settings.js',
  'js/storage.js',
  'js/tokenizer.js',
  'js/ui.js',
  'js/wizard.js',
];

const shellUrl = (file) => new URL(file || './', self.location.href).toString();
const shellPaths = new Set(SHELL_FILES.map(file => new URL(file || './', self.location.href).pathname));

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_FILES.map(shellUrl)).catch((err) => {
        console.warn('SW: Failed to cache some shell files:', err);
      });
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
        return key.startsWith('stce-') && key !== CACHE_NAME && cachePath === BASE_PATH;
      })
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

// Fetch: network-first for non-shell files, cache-first for app shell.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // The stable worker's scope includes /dev/, but it must not serve or cache
  // development requests. The /dev/ worker owns those requests instead.
  if (url.origin !== self.location.origin || url.pathname.startsWith(`${BASE_PATH}api/`)
      || (!BASE_PATH.endsWith('/dev/') && url.pathname.startsWith(DEV_PATH))) return;

  const isShellFile = shellPaths.has(url.pathname);
  if (isShellFile) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((response) => {
          if (response.ok && response.type === 'basic') {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  } else {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok && response.type === 'basic') {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
  }
});
