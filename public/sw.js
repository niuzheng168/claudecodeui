// Service Worker for CloudCLI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
const scopedUrl = path => new URL(path.replace(/^\/+/, ''), self.registration.scope).href;
// Lossless encoding matters: node-a and node_a are distinct valid node IDs.
const scopeCacheKey = encodeURIComponent(new URL(self.registration.scope).pathname);
const CACHE_PREFIX = `claude-ui-scope-${scopeCacheKey}-`;
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const urlsToCache = [
  scopedUrl('manifest.json')
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  const url = requestUrl.pathname;

  // Never intercept API requests or WebSocket upgrades
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin ||
      url.includes('/api/') || url.includes('/ws') || url.startsWith('/portal-auth/')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      )
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached?.ok) return cached;
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone()).catch(() => {});
        return response;
      }).catch(() => fetch(event.request))
    );
    return;
  }

  // Everything else — network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.open(CACHE_NAME).then(cache => cache.match(event.request)))
  );
});

// Only remove this workspace's older caches. Legacy lossy names cannot be
// attributed safely, so leave them (and every other node's caches) untouched.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: scopedUrl('logo-256.png'),
    badge: scopedUrl('logo-128.png'),
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CloudCLI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = scopedUrl(sessionId ? `session/${encodeURIComponent(sessionId)}` : '');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
