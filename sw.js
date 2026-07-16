/* ============================================================
   sw.js — Service Worker for Offline Support
   Caches the app shell (HTML/CSS/JS) for offline usage.
   ============================================================ */

const CACHE_NAME = 'stce-v2.1';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/css/theme.css',
  '/css/base.css',
  '/css/layout.css',
  '/css/library.css',
  '/css/editor.css',
  '/css/ai-assistant.css',
  '/css/modal.css',
  '/css/diff.css',
  '/css/wizard.css',
  '/css/components.css',
  '/css/responsive.css',
  '/js/aiChat.js',
  '/js/aiService.js',
  '/js/animations.js',
  '/js/cardEngine.js',
  '/js/cardManager.js',
  '/js/editor.js',
  '/js/exportUtils.js',
  '/js/i18n.js',
  '/js/settings.js',
  '/js/storage.js',
  '/js/tokenizer.js',
  '/js/ui.js',
  '/js/wizard.js',
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_FILES).catch((err) => {
        console.warn('SW: Failed to cache some shell files:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for non-shell files, cache-first for app shell
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;

  const isShellFile = SHELL_FILES.some(f => url.pathname === f || url.pathname === f.replace(/^\//, '/'));

  if (isShellFile) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => { cache.put(event.request, clone); });
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
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => { cache.put(event.request, clone); });
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
  }
});
