// sw.js - Main Service Worker for REPCO Roster - FIXED V168
const CACHE_NAME = 'repco-roster-v168-base-fix';

const urlsToCache = [
  '/rmroster/',
  '/rmroster/index.html',
  '/rmroster/icon-192.png',
  '/rmroster/icon-512.png',
  '/rmroster/manifest.json'
];

self.addEventListener('install', event => {
  console.log('[SW] Install V168 - base /rmroster/ fix');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache).catch(e=>console.log(e)))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(
      names.map(n => { if(n!==CACHE_NAME) return caches.delete(n); })
    ))
  );
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Always network for Firebase RTDB
  if (url.hostname.includes('firebasedatabase.app') || url.hostname.includes('firestore')) {
    return event.respondWith(fetch(event.request));
  }
  // Network-first for documents, cache-first for assets
  if (event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE_NAME).then(c=>c.put(event.request, clone));
        return r;
      }).catch(()=>caches.match(event.request).then(r=>r||caches.match('/rmroster/index.html')))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});

self.addEventListener('push', function(event) {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); } catch(e){ data = { body: event.data.text() }; }
  }
  let title = (data.title || 'REPCO').replace(/blackbeard.*$/gi,'').trim();
  if(title.length>30) title = title.substring(0,30);
  let body = (data.body || 'Your roster updated').replace(/https?:\/\/[^\s]+/g,'').trim().substring(0,120);
  const options = {
    body,
    icon: '/rmroster/icon-192.png',
    badge: '/rmroster/icon-192.png',
    tag: data.tag || 'repco-push',
    vibrate: [200,100,200],
    renotify: true,
    data: { url: '/rmroster/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list=>{
      for(let c of list){ if(c.url.includes('/rmroster/') && 'focus' in c) return c.focus(); }
      return clients.openWindow('/rmroster/');
    })
  );
});
