// Firebase Cloud Messaging Service Worker - Phone Notifications Outside Browser
// Must be at root: /firebase-messaging-sw.js
// REPCO ROSTER V224

importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

// Your Firebase config - same as main app
const firebaseConfig = {
  apiKey: "AIzaSyDummy-Repco-Roster-V216",
  authDomain: "repco-roster.firebaseapp.com",
  databaseURL: "https://repco-roster-default-rtdb.firebaseio.com",
  projectId: "repco-roster",
  storageBucket: "repco-roster.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};

try {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();
  
  console.log('[FCM SW] Firebase Messaging initialized');

  // Background message handler - when app is closed
  messaging.onBackgroundMessage((payload) => {
    console.log('[FCM SW] Background message received:', payload);
    
    const notificationTitle = payload.notification?.title || payload.data?.title || 'REPCO ROSTER';
    const notificationOptions = {
      body: payload.notification?.body || payload.data?.body || payload.data?.message || 'New roster update',
      icon: payload.notification?.icon || './icon-192.png',
      badge: './icon-192.png',
      vibrate: [200, 100, 200],
      data: {
        url: payload.fcmOptions?.link || payload.data?.click_action || './',
        ...payload.data
      },
      actions: [
        { action: 'open', title: 'Open' },
        { action: 'close', title: 'Dismiss' }
      ],
      tag: 'repco-fcm-' + (payload.data?.type || Date.now()),
      renotify: true
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
  });

} catch (e) {
  console.error('[FCM SW] Init error:', e);
}

// Fallback push handler (if FCM compat fails)
self.addEventListener('push', function(event) {
  console.log('[FCM SW] Push event (fallback):', event);
  if (!event.data) return;
  
  try {
    const data = event.data.json();
    if (data.notification) return; // Already handled by FCM
  } catch (e) {
    // Not JSON, show generic
  }
  
  const title = 'REPCO ROSTER';
  const options = {
    body: 'New update available',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: './' }
  };
  
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  console.log('[FCM SW] Notification click');
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clients => {
      for (let client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus().then(c=>c.navigate(url));
        }
      }
      return clients.openWindow(url);
    })
  );
});

console.log('[FCM SW] Repco Roster FCM Service Worker loaded');
