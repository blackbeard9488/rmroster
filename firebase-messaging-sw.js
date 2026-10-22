// firebase-messaging-sw.js - FIXED V168 - Real DB URL
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyAVoyJM45o62AZNSPzdRPmQME_xe24prHI",
  authDomain: "testing-de079.firebaseapp.com",
  databaseURL: "https://testing-de079-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "testing-de079",
  storageBucket: "testing-de079.appspot.com",
  messagingSenderId: "901580162196",
  appId: "1:901580162196:web:4b3ee98714d3c51d2ce081"
};

try {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();
  console.log('[FCM SW] Initialized with real DB URL - asia-southeast1');

  messaging.onBackgroundMessage((payload) => {
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
} catch(e){ console.error('[FCM SW] Init error - replace dummy keys:', e); }

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
