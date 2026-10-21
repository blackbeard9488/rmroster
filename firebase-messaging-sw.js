// firebase-messaging-sw.js - Service Worker for Phone Notifications Outside Browser
// ALPHA Build - Phone notifications outside browser: serviceWorker, PushManager, Notification + FCM ready
// Verified, possible with HTTPS + VAPID

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

const FIREBASE_CONFIG = {
  apiKey: "AIzaSy placeholder",
  authDomain: "testing-de079.firebaseapp.com",
  databaseURL: "https://testing-de079-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "testing-de079",
  storageBucket: "testing-de079.appspot.com",
  messagingSenderId: "0",
  appId: "1:0:web:repco"
};

try {
  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }
  const messaging = firebase.messaging();

  // Background message handler - shows notification even when browser closed (phone)
  messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Received background message ', payload);
    const notificationTitle = payload.notification?.title || payload.data?.title || 'REPCO Roster Update';
    const notificationOptions = {
      body: payload.notification?.body || payload.data?.body || 'Your roster has been updated',
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      tag: payload.data?.tag || 'repco-roster',
      data: payload.data || {},
      vibrate: [200, 100, 200],
      requireInteraction: false,
      actions: [
        { action: 'open', title: 'Open Roster' },
        { action: 'close', title: 'Close' }
      ]
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
  });

} catch (e) {
  console.error('[firebase-messaging-sw.js] Init error', e);
}

// Push event handler for Web Push (PushManager + VAPID)
self.addEventListener('push', function(event) {
  console.log('[Service Worker] Push Received.');
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    data = { title: 'REPCO Roster', body: event.data ? event.data.text() : 'Update available' };
  }

  const title = data.title || data.notification?.title || 'REPCO Roster Update';
  const options = {
    body: data.body || data.notification?.body || 'Your roster has been updated - tap to view',
    icon: data.icon || '/icon-192.png',
    badge: '/badge-72.png',
    tag: data.tag || 'repco-roster-update',
    data: data.data || { url: '/' },
    vibrate: [200, 100, 200],
    requireInteraction: false
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click handler - opens app
self.addEventListener('notificationclick', function(event) {
  console.log('[Service Worker] Notification click Received.');
  event.notification.close();

  const action = event.action;
  const data = event.notification.data || {};
  const urlToOpen = data.url || self.location.origin + '/';

  if (action === 'close') {
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// Sync event for background sync (roster updates)
self.addEventListener('sync', function(event) {
  if (event.tag === 'repco-sync') {
    console.log('[Service Worker] Background sync');
    event.waitUntil(
      fetch('https://testing-de079-default-rtdb.asia-southeast1.firebasedatabase.app/repco_state.json')
        .then(res => res.json())
        .then(data => {
          if (data && data._ts) {
            return self.registration.showNotification('REPCO Roster Synced', {
              body: 'Latest roster data synced',
              tag: 'repco-sync'
            });
          }
        })
    );
  }
});

// Install and activate
self.addEventListener('install', function(event) {
  console.log('[Service Worker] Install');
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  console.log('[Service Worker] Activate');
  event.waitUntil(clients.claim());
});
