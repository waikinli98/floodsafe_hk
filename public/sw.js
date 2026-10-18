// Minimal service worker: makes FloodSafe installable and keeps the app shell available on a flaky connection.
// API calls (reports, routes, weather) always go to the network – stale flood data is worse than none.
const CACHE = 'floodsafe-v25';
const SHELL = ['/', '/styles.css', '/app.js', '/i18n.js', '/icon.svg', '/icon-192.png', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // network first, fall back to cache when offline
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});

// Route alerts pushed by the server when a flood is reported on the route being walked
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'FloodSafe HK', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'FloodSafe HK', {
    body: d.body || '', tag: d.tag || 'floodsafe', renotify: true, requireInteraction: true,
    icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [300, 120, 300, 120, 300],
    data: { url: d.url || '/', reportId: d.reportId },
    actions: [{ action: 'reroute', title: d.title?.includes('路線') ? '改道' : 'Reroute' }],
  }));
});
// Tap: bring FloodSafe to the front and reroute (or open it, which reroutes to the saved destination)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === location.origin);
    if (open) { await open.focus(); open.postMessage({ type: 'route-alert', reportId: data.reportId, reroute: true }); return; }
    await self.clients.openWindow(data.url || '/?reroute=1');
  })());
});
