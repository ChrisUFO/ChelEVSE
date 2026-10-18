// ChelEVSE service worker — cache-first for the local app shell only.
// Never caches gstatic/firebase requests: cross-origin and non-GET are passed through.
// Bump CACHE version when any shell file changes.
const CACHE = 'chelevse-v10';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './js/firebase.js',
  './js/auth.js',
  './js/store.js',
  './js/format.js',
  './js/ui.js',
  './js/screens/status.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return; // gstatic/firebase: network only
  // firebase-config.js is served no-cache; never serve it from, or store it in,
  // the Cache API (which would ignore that header).
  const uncached = url.pathname.endsWith('/firebase-config.js');
  event.respondWith(
    (uncached ? Promise.resolve(null) : caches.match(event.request)).then(
      (hit) =>
        hit ||
        fetch(event.request)
          .then((res) => {
            if (res.ok && !uncached) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return res;
          })
          .catch(() =>
            event.request.mode === 'navigate'
              ? caches.match('./index.html')
              : new Response('Offline', { status: 503 }),
          ),
    ),
  );
});
