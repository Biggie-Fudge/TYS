// Offline shell. Bump V whenever the shell file list changes.
const V = 'tys-shell-1', PHOTOS = 'tys-photos';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/fonts/archivo-narrow-latin-wght-normal.woff2'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== PHOTOS).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  // Photos never change once stored, so keep every one that has been viewed.
  if (u.pathname.startsWith('/api/photos/')) {
    e.respondWith(caches.open(PHOTOS).then(async (c) => {
      const hit = await c.match(r);
      if (hit) return hit;
      const res = await fetch(r);
      if (res.ok) c.put(r, res.clone());
      return res;
    }));
    return;
  }
  if (u.pathname.startsWith('/api/')) return; // data goes through the app's own outbox and cache
  // The page itself: take the newest copy when the network answers within 3 seconds, else open from cache.
  if (r.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = await caches.match('/');
      const fresh = fetch(r).then((res) => { if (res.ok) { const cp = res.clone(); caches.open(V).then((c) => c.put('/', cp)); } return res; });
      if (!cached) return fresh;
      fresh.catch(() => {});
      return Promise.race([fresh.catch(() => cached), new Promise((ok) => setTimeout(() => ok(cached), 3000))]);
    })());
    return;
  }
  e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then((res) => {
    if (res.ok) { const cp = res.clone(); caches.open(V).then((c) => c.put(r, cp)); }
    return res;
  })));
});
