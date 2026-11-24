// App shell: network-first so updates arrive at once, cached copy when offline; API reads are network-first with the last good copy as fallback.
// Writes are never cached here: the page keeps an outbox and replays it when the connection returns.
const SHELL = 'slate-shell-v1';
const DATA = 'slate-data-v1';
const FILES = ['/', '/index.html', '/app.js', '/i18n.js', '/styles.css', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/auth')) return;
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || new Response(JSON.stringify({ error: 'Offline and not cached yet' }), { status: 503, headers: { 'content-type': 'application/json' } }))));
    return;
  }
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/index.html'))));
});
