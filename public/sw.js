// Till service worker (spec 4.9): serves the selling screen, Next.js chunks, and product photos when offline.
// API calls always go to the network; sales wait in the IndexedDB outbox instead of the cache.
const SHELL = 'pos-shell-v1';
const STATIC = 'pos-static-v1';
const IMAGES = 'pos-images';
const KEEP = [SHELL, STATIC, IMAGES];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.status === 200) await cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.status === 200 && !res.redirected) await cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: true });
    return hit ?? new Response('<p>Offline. Open the till once while online first.</p>', { status: 503, headers: { 'Content-Type': 'text/html' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_next/static/')) return event.respondWith(cacheFirst(request, STATIC));
  if (/^\/api\/[^/]+\/device\/images\//.test(url.pathname)) return event.respondWith(cacheFirst(request, IMAGES));
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && /\/till\/sell\/?$/.test(url.pathname)) return event.respondWith(networkFirst(request));
});
