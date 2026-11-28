'use strict';

const CACHE_NAME = 'rideasevx-shell-v21';
const APP_SHELL = [
  './',
  './index.html',
  './app.js?v=19',
  './style.css',
  './manifest.json',
  './easypaisa-qr.png',
  './assets/ev-bike-blue.png',
  './assets/ev-charging-bike.jpg',
  './assets/charge-start.aac',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('rideasevx-shell-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Media playback sends Range requests that need a 206 partial response; serving the cached full 200 cuts audio short.
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(async () => (
        await caches.match(request)
        || await caches.match(new URL('./index.html', self.registration.scope).href)
      ))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
