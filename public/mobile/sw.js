// Service Worker for PWA + notifications
//
// Strategy: network-first for navigation/document requests so users always
// get fresh HTML (and fresh CSP headers). Cache-first for static assets
// that are immutable per version. Push + notification click handlers
// remain unchanged.

const CACHE_NAME = 'openclaw-chat-v2';
const STATIC_ASSETS = [
  '/login.html',
  '/favicon.ico',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/apple-touch-icon.png',
  '/manifest.json',
];

// Requests that should always go to the network first (HTML documents,
// API calls, SSE).  If the network fails we fall back to cache.
function isNetworkFirst(request) {
  const mode = request.mode;
  if (mode === 'navigate') return true;             // page navigations
  if (request.destination === 'document') return true;
  if (request.url.includes('/api/')) return true;   // API + SSE
  return false;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[sw] install error:', err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  // Never intercept non-GET requests (POST, PUT, etc.)
  if (request.method !== 'GET') return;

  // Network-first for navigations, documents, and API/SSE
  if (isNetworkFirst(request)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache successful navigations for offline fallback
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then(response => response || fetch(request))
  );
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data?.json?.() || {};
  } catch {
    const text = event.data?.text?.();
    data = text ? { body: text } : {};
  }

  const title = data.title || 'OpenClaw Chat';
  const body = data.body || 'New message';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || 'openclaw-chat-new-message',
      renotify: true,
      data: {
        url: data.url || '/'
      }
    })
  );
});

self.addEventListener('notificationclick', event => {
  const targetUrl = event.notification?.data?.url || '/';
  event.notification.close();

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          await client.navigate(targetUrl);
        }
        return;
      }
    }

    if (clients.openWindow) {
      await clients.openWindow(targetUrl);
    }
  })());
});
