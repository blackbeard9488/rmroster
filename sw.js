// sw.js - Main Service Worker for REPCO Roster ALPHA
// Phone notifications outside browser: serviceWorker, PushManager, Notification + FCM ready
// FIXED V157: Clean notifications, no blackbeard, single icon, Monday 22/10

const CACHE_NAME = 'repco-roster-alpha-v165-fix-new-shift-accept-deny';

const urlsToCache = [
  '/',
  '/index.html',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  console.log('[SW] Install V165 FIX NEW SHIFT ACCEPT DENY - Accept adds, Deny removes + admin notified - Instant - works even when logged out');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache).catch(e => console.log('Cache add failed', e));
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  console.log('[SW] Activate V165 FIX NEW SHIFT ACCEPT DENY - Accept adds, Deny removes + admin notified - Instant - works even when logged out');
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

self.addEventListener('push', function(event) {
  console.log('[SW] Push received - will show even if logged out (V158)', event);
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch(e) {
      data = { body: event.data.text() };
    }
  }
  
  let title = (data.title || 'REPCO').replace(/blackbeard.*$/gi,'').replace(/github\.io/gi,'').trim();
  if(title.length>30) title = title.substring(0,30);
  if(title.includes('...')) title = 'REPCO';
  
  let body = (data.body || 'Your roster has been updated').replace(/blackbeard9488\.github\.io/g,'').replace(/blackbeard9\.\.\./g,'').replace(/https?:\/\/[^\s]+/g,'').trim();
  
  try{
    body = body.replace(/(\d{4})-(\d{2})-(\d{2})/g, function(match, y, m, d){
      try{
        const date = new Date(parseInt(y), parseInt(m)-1, parseInt(d));
        const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        return dayNames[date.getDay()] + ' ' + d + '/' + m;
      }catch(e){ return d + '/' + m; }
    });
  }catch(e){}
  
  body = body.substring(0,120);
  
  const options = {
    body: body,
    icon: './icon-192.png',
    tag: data.tag || 'repco-push-'+Date.now(),
    vibrate: [200, 100, 200],
    renotify: true,
    data: { url: './', timestamp: Date.now() }
  };
  
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if (client.url.includes('blackbeard9488.github.io') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./');
      }
    })
  );
});
