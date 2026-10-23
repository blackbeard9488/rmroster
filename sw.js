// sw.js - Repco Roster service worker: shows phone notifications. It caches nothing,
// so every visit loads the latest roster code.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('push', function (event) {
  var data = {};
  if (event.data) {
    try { data = event.data.json(); } catch (e) { data = { body: event.data.text() }; }
  }
  var scope = self.registration.scope;
  var tag = data.tag || 'repco-roster';
  var show = function () {
    return self.registration.showNotification(data.title || 'Repco Roster', {
      body: data.body || 'Your roster was updated',
      icon: scope + 'icon-192.png',
      badge: scope + 'icon-192.png',
      tag: tag,
      renotify: !data.close,
      silent: !!data.close,
      vibrate: data.close ? undefined : [200, 100, 200],
      data: { url: scope }
    });
  };
  // A withdrawn shift offer: remove its alert. Phones require something to be shown for every push,
  // so a quiet "withdrawn" note takes its place under the same tag.
  if (data.close) {
    event.waitUntil(self.registration.getNotifications({ tag: tag }).then(function (list) {
      list.forEach(function (n) { n.close(); });
      return show();
    }));
    return;
  }
  event.waitUntil(show());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(url) === 0 && 'focus' in list[i]) return list[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
