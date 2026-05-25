// Trade Genius — Service Worker
const VERSION = 'tg-v6.7';
const CACHE_NAME = `trade-genius-${VERSION}`;

const CORE = [
  './',
  './index.html',
  './scene-01.html?v=67',
  './scene-02.html?v=67',
  './scene-03.html?v=67',
  './scene-04.html?v=67',
  './scene-05.html?v=67',
  './scene-06.html?v=67',
  './scene-07.html?v=67',
  './scene-08.html?v=67',
  './scene-09.html?v=67',
  './scene-10.html?v=67',
  './scene-11.html?v=67',
  './bill_20.webp?v=1',
  './bill_20.png?v=1',
  './tg-common.js?v=67',
  './tg-analyst.js?v=67',
  './tg-bubble.js?v=67',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('trade-genius-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Stratégie : cache-first pour assets, network-first pour HTML (fraîcheur)
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isHTML = req.destination === 'document' || url.pathname.endsWith('.html');

  if (isHTML) {
    // network-first pour HTML
    e.respondWith(
      fetch(req).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone));
        return resp;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
  } else {
    // cache-first pour le reste
    e.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return resp;
      }))
    );
  }
});
