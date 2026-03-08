// Service Worker for PWA + notifications
const CACHE_NAME = 'openclaw-chat-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/login.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
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
