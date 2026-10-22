// REPCO ROSTER Service Worker - Phone Notifications Outside Browser
// Version: V224 - All Features Preserved

const CACHE_NAME = 'repco-roster-v224';
const urlsToCache = [
  './',
  './index.html',
  './rmroster/index.html',
  './manifest.json'
];

// Install - cache core files
self.addEventListener('install', event => {
  console.log('[SW] Install V224');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching app shell');
        return cache.addAll(urlsToCache.map(url => new Request(url, {cache: 'reload'}))).catch(err => {
          console.log('[SW] Cache addAll error (some files may not exist yet)', err);
          // Try to cache at least root
          return cache.add('./').catch(()=>{});
        });
      })
      .then(() => self.skipWaiting())
  );
});

// Activate - clean old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activate V224');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch - network first, fallback to cache for navigation
self.addEventListener('fetch', event => {
  // Skip Firebase requests - always network
  if (event.request.url.includes('firebaseio.com') || 
      event.request.url.includes('googleapis.com') ||
      event.request.url.includes('fcm') ||
      event.request.url.includes('firestore')) {
    return;
  }

  // For navigation requests (HTML), network first
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Clone and cache
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // Fallback to cache
          return caches.match(event.request).then(cached => {
            return cached || caches.match('./').then(r=>r || caches.match('./index.html'));
          });
        })
    );
    return;
  }

  // For other requests, cache first then network
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request).then(fetchResponse => {
          // Don't cache non-successful responses
          if (!fetchResponse || fetchResponse.status !== 200 || fetchResponse.type !== 'basic') {
            return fetchResponse;
          }
          const responseToCache = fetchResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
          return fetchResponse;
        });
      })
  );
});

// Push - handle FCM push notifications (phone outside browser)
self.addEventListener('push', event => {
  console.log('[SW] Push received:', event);
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    try {
      data = { body: event.data.text() };
    } catch (e2) {
      data = { body: 'New roster update' };
    }
  }

  // Default notification for roster
  const title = data.notification?.title || data.title || 'REPCO ROSTER';
  const options = {
    body: data.notification?.body || data.body || data.message || 'New roster update available',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [200, 100, 200],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1,
      url: data.fcmOptions?.link || data.click_action || './',
      ...data.data
    },
    actions: [
      { action: 'open', title: 'Open Roster' },
      { action: 'close', title: 'Dismiss' }
    ],
    tag: 'repco-roster-' + (data.data?.type || 'general'),
    renotify: true,
    requireInteraction: false,
    silent: false
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click - open app
self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification click:', event);
  event.notification.close();

  if (event.action === 'close') {
    return;
  }

  const urlToOpen = event.notification.data?.url || './';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // If app is already open, focus it
        for (let client of windowClients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.navigate(urlToOpen);
            return client.focus();
          }
        }
        // Otherwise open new window
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// Background sync for roster updates
self.addEventListener('sync', event => {
  console.log('[SW] Background sync:', event.tag);
  if (event.tag === 'repco-roster-sync') {
    event.waitUntil(
      // Sync roster data when back online
      fetch('https://repco-roster-default-rtdb.firebaseio.com/repco_state/retail_roster_byFortnight_v1.json')
        .then(r=>r.json())
        .then(data=>{
          console.log('[SW] Background sync roster data', data ? 'has data' : 'no data');
        })
        .catch(err=>console.log('[SW] Sync failed', err))
    );
  }
});

// Message from client
self.addEventListener('message', event => {
  console.log('[SW] Message:', event.data);
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'roster_update') {
    // Broadcast to all clients
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'roster_updated', ts: Date.now() });
      });
    });
  }
});

console.log('[SW] Repco Roster V224 Service Worker loaded - All features preserved');
