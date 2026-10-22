// firebase-messaging-sw.js - FIXED - must be at /rmroster/firebase-messaging-sw.js AND at root for FCM
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyDummy-Repco-Roster-V216",
  authDomain: "testing-de079.firebaseapp.com",
  databaseURL: "https://testing-de079-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "testing-de079",
  storageBucket: "testing-de079.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};

try {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();
  console.log('[FCM SW] Initialized with real DB URL');

  messaging.onBackgroundMessage((payload) => {
    console.log('[FCM SW] Background message:', payload);
    const title = payload.notification?.title || payload.data?.title || 'REPCO ROSTER';
    const options = {
      body: payload.notification?.body || payload.data?.body || 'New roster update',
      icon: '/rmroster/icon-192.png',
      badge: '/rmroster/icon-192.png',
      vibrate: [200,100,200],
      data: { url: payload.fcmOptions?.link || '/rmroster/' },
      tag: 'repco-fcm-'+Date.now(),
      renotify: true
    };
    self.registration.showNotification(title, options);
  });
} catch(e){ console.error('[FCM SW] Error', e); }

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/rmroster/';
  event.waitUntil(
    clients.matchAll({type:'window'}).then(clients=>{
      for(let c of clients){ if(c.url.includes('/rmroster/') && 'focus' in c) return c.focus(); }
      return clients.openWindow(url);
    })
  );
});
