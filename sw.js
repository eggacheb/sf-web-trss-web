const CACHE_NAME = 'sfchat-v8';
const urlsToCache = [
  './',
  'index.html',
  'manifest.json',
  'css/main.css',
  'css/github.min.css',
  'js/app.js',
  'js/marked.min.js',
  'js/highlight.min.js',
  'js/mathjax/tex-mml-chtml.js',
  'fonts/LXGWWenKai-Regular-9375313a.ttf',
  'fonts/HYWH-65W.ttf',
  'fonts/SpaceMono-Regular.ttf',
  'images/bot-avatar.png',
  'images/user-avatar.png',
  'images/icon-192x192.png',
  'images/icon-512x512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Network succeeded - update cache and return
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed - fall back to cache
        return caches.match(event.request);
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
