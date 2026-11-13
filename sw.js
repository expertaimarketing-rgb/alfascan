'use strict';
const V = 'alfascan-v7';
const SHARE = 'alfascan-share'; // входящие фото из «Поделиться» (переживает обновления)
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
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('alfascan-v') && k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // «Поделиться» из галереи: Android присылает фото POST-запросом. Кладём их в кеш,
  // приложение заберёт их при открытии (/?shared=1) и откроет по очереди в редакторе краёв
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await req.formData();
        const files = fd.getAll('photos').filter(f => f && f.size);
        const c = await caches.open(SHARE);
        const t = Date.now();
        await Promise.all(files.map((f, i) => c.put(
          new Request(`./share/${t}-${String(i).padStart(3, '0')}`),
          new Response(f, { headers: { 'Content-Type': f.type || 'image/jpeg', 'X-Name': encodeURIComponent(f.name || 'photo.jpg') } })
        )));
      } catch (err) { /* без фото просто откроем приложение */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;

  // stale-while-revalidate: быстро из кеша, в фоне обновляем
  e.respondWith(
    caches.open(V).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req, { cache: 'no-cache' }).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
