// Minimal app-shell service worker: network-first, falls back to cache when offline.
// Only the app's own files are cached. API calls (/server/…) are never cached and never queued —
// a change made without internet fails and is not saved for later.
// Pages (index.html) are always fetched past the browser's HTTP cache: some hosts (Catalyst Slate) send
// "max-age = 1 year" for every file, which would otherwise keep an old version of the app forever.
// The other files have a content hash in their names, so a long cache for them is fine.
const CACHE = 'billpoodum-v5'
const scope = new URL(self.registration.scope).pathname // '/' or e.g. '/app/'
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll([new Request(scope, { cache: 'no-store' }), new Request(`${scope}index.html`, { cache: 'no-store' })]))) })
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())))
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/server/')) return
  const page = e.request.mode === 'navigate' || url.pathname === scope || url.pathname.endsWith('.html') || url.pathname.endsWith('.webmanifest')
  const load = page ? fetch(url.href, { cache: 'no-store', credentials: 'same-origin' }) : fetch(e.request)
  e.respondWith(
    load
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(page ? url.pathname : e.request, copy)) } return res })
      .catch(() => caches.match(page ? url.pathname : e.request).then((r) => r || caches.match(`${scope}index.html`)))
  )
})

// Order tracking ("Notify me"): the server sends a push when the order is confirmed, ready or not accepted.
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { title: e.data ? e.data.text() : 'Order update' } }
  const title = String(d.title || 'Order update')
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: String(d.body || ''), tag: String(d.tag || 'order'), renotify: true, icon: `${scope}icon.svg`, badge: `${scope}icon.svg`,
      vibrate: [200, 100, 200], data: { businessId: d.businessId, orderId: d.orderId },
    }),
    // Open tracking pages refresh at once.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: 'order-status', orderId: d.orderId }))),
  ]))
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { businessId, orderId } = e.notification.data || {}
  const ok = /^[A-Za-z0-9_-]{1,40}$/
  const url = businessId && orderId && ok.test(businessId) && ok.test(orderId) ? `${scope}?track=${businessId}.${orderId}` : scope
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.includes('/track') && c.url.includes(String(orderId)))
    return open ? open.focus() : self.clients.openWindow(url)
  }))
})
