// Service worker: lets the app open offline and keeps the text-reader files
// (Tesseract) and card pictures cached so later scans start fast.
const VERSION = 'pokescan-v2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/net.js', 'js/tcgdex.js', 'js/parse.js', 'js/ocr.js', 'js/identify.js', 'js/prices.js', 'js/market.js', 'js/chart.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/card-back.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'pokescan-cdn' && k !== 'pokescan-img').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Text reader engine + language data: cache forever (versioned URLs).
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname.endsWith('projectnaptha.com')) {
    e.respondWith(cacheFirst('pokescan-cdn', req));
    return;
  }
  // Card pictures.
  if (url.hostname === 'assets.tcgdex.net') {
    e.respondWith(cacheFirst('pokescan-img', req, 400));
    return;
  }
  // App files: network first so updates arrive, cache when offline.
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
  }
  // Everything else (card & price APIs) goes straight to the network.
});

async function cacheFirst(name, req, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    cache.put(req, res.clone());
    if (max) cache.keys().then(keys => { if (keys.length > max) keys.slice(0, keys.length - max).forEach(k => cache.delete(k)); });
  }
  return res;
}
