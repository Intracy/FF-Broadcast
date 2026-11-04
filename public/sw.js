// Minimaler Service Worker: App-Shell offline verfügbar, API immer live
const CACHE = 'ffr-v13';
const SHELL = ['/', '/css/app.css', '/css/fonts.css', '/fonts/ibm-plex-sans-var.woff2', '/fonts/ibm-plex-mono-400.woff2', '/fonts/ibm-plex-mono-500.woff2', '/fonts/ibm-plex-mono-600.woff2', '/fonts/barlow-condensed-600.woff2', '/fonts/barlow-condensed-700.woff2', '/js/app.js', '/js/ui.js', '/js/live.js', '/js/qr.js', '/js/print.js', '/css/print.css', '/shared/timing.js', '/live.html', '/img/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
