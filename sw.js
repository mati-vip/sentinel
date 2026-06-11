/* Sentinel — service worker: cache de la app + recepción de push */
const CACHE = 'sentinel-v1';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/calc.js', 'js/prices.js', 'js/store.js', 'js/app.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero para la app (siempre la última versión); cache como respaldo offline.
// Las llamadas a APIs externas (precios, supabase) no se cachean.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Sentinel', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || '🛡 Sentinel', {
    body: data.body || '',
    tag: data.tag || 'sentinel',
    badge: 'icons/icon-192.png',
    icon: 'icons/icon-192.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(e.notification.data?.url || './');
  }));
});
