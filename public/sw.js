// Minimal app-shell service worker: network-first, falls back to cache when offline.
// Only the app's own files are cached. API calls (/server/…) are never cached and never queued —
// a change made without internet fails and is not saved for later.
const CACHE = 'billpoodum-v2'
const scope = new URL(self.registration.scope).pathname // '/' or e.g. '/app/'
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll([scope, `${scope}index.html`]))) })
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())))
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/server/')) return
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res })
      .catch(() => caches.match(e.request).then((r) => r || caches.match(`${scope}index.html`)))
  )
})
