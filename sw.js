const CACHE_NAME = "repco-v175-yellow-time-persist-login";
const urlsToCache = [
  "./",
  "./index.html",
  "./manifest.json"
];

self.addEventListener('install', function(event) {
  // Don't skipWaiting immediately - let old SW handle current page until reload
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('V175 SW: Caching');
        return cache.addAll(urlsToCache);
      })
  );
  // Skip waiting to activate new SW quickly but not break login
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          // Delete old caches but keep current
          if (cacheName !== CACHE_NAME && cacheName.startsWith('repco-')) {
            console.log('V175 SW: Deleting old cache', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(function(){
      // Claim clients so new SW takes over without requiring reload that loses login
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  // For index.html, always try network first, then cache - ensures HTML updates work but login stays
  if (event.request.url.includes('index.html') || event.request.url.endsWith('/') || event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(function(response){
        // Clone and cache new version
        var responseClone = response.clone();
        caches.open(CACHE_NAME).then(function(cache){
          cache.put(event.request, responseClone);
        });
        return response;
      }).catch(function(){
        // Network failed, use cache
        return caches.match(event.request).then(function(response){
          return response || caches.match('./index.html') || caches.match('./');
        });
      })
    );
  } else {
    event.respondWith(
      caches.match(event.request).then(function(response){
        return response || fetch(event.request);
      })
    );
  }
});

// V175: Handle push notifications even when user hasn't logged in recently - keep login alive
self.addEventListener('push', function(event){
  console.log('V175 SW: Push received', event);
  var data = {};
  try{
    data = event.data ? event.data.json() : {};
  }catch(e){
    data = {title: 'REPCO Roster', body: event.data ? event.data.text() : 'New notification'};
  }
  var title = data.title || 'REPCO Roster';
  var options = {
    body: data.body || data.message || 'New shift update',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || 'repco-notif',
    data: data,
    requireInteraction: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(
    clients.openWindow('./')
  );
});
