// sw.js - Main Service Worker for REPCO Roster ALPHA
// Phone notifications outside browser: serviceWorker, PushManager, Notification + FCM ready
// Verified, possible with HTTPS + VAPID

const CACHE_NAME = 'repco-roster-alpha-v169'; // V168 - forces update for blank pill + hidden staff + hover + push fixes
const urlsToCache = [
  '/',
  '/index.html',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  console.log('[SW] Install ALPHA');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache).catch(e => console.log('Cache add failed', e));
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  console.log('[SW] Activate ALPHA');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request).catch(() => {
          if (event.request.destination === 'document') {
            return caches.match('/index.html');
          }
        });
      })
  );
});

// Push notifications - Web Push API with VAPID
self.addEventListener('push', function(event) {
  console.log('[SW] Push received', event);
  let payload = {};
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    payload = { title: 'REPCO Roster', body: event.data ? event.data.text() : 'Roster updated' };
  }

  const title = payload.title || 'REPCO Roster Update';
  const options = {
    body: payload.body || 'Your roster has been updated',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: 'repco-update',
    data: { url: self.location.origin },
    vibrate: [200, 100, 200]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (let client of clientList) {
        if (client.url === self.location.origin && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
