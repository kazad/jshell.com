const CACHE = 'valeye-v20260804-1556';
const ASSETS = [
  './',
  'index.html',
  'about.html',
  'style.css',
  'js/app.js',
  'js/counter.js',
  'vendor/opencv.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/doodle.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // Never let a stale shell survive: the new worker takes over immediately
  // and pre-caches the new build's assets.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// The page asks for an immediate takeover after it detects a new worker.
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Test bench assets stay network-only so dev iteration is never stale.
  if (url.pathname.includes('/testdata/') || url.pathname.endsWith('/test.html') || url.pathname.includes('/tools/')) return;

  // The huge immutable OpenCV wasm is cache-first; everything else is
  // network-first with cache fallback, so app updates land on plain reload
  // and offline still works.
  const cacheFirst = url.pathname.includes('/vendor/');
  e.respondWith(
    cacheFirst
      ? caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        }))
      : fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        }).catch(() => caches.match(e.request))
  );
});
