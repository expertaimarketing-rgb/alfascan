'use strict';
const V = 'alfascan-v5';
const SHELL = ['./', 'index.html', 'app.js', 'opencv.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

// GitHub Pages отдаёт файлы с max-age=600: чтобы не получать устаревшие копии из HTTP-кеша
// браузера, при установке и обновлении всегда спрашиваем сервер (cache: 'reload' / 'no-cache')
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(V)
      .then(c => Promise.all(SHELL.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => { if (!r.ok) throw new Error(u); return c.put(u, r); }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// stale-while-revalidate: быстро из кеша, в фоне обновляем (в том числе opencv.js с CDN)
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.open(V).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: false });
      const net = fetch(req, { cache: 'no-cache' }).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
