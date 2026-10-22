const CACHE_NAME = "repco-v194-closed-siren-excel";
const urlsToCache = ["./","./manifest.json"];
self.addEventListener('install', e=>{ self.skipWaiting(); e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(urlsToCache))); });
self.addEventListener('activate', e=>{ e.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(k=>{ if(k!==CACHE_NAME && k.startsWith('repco-')) return caches.delete(k); }))).then(()=>self.clients.claim())); });
self.addEventListener('fetch', e=>{
  if(e.request.url.includes('index.html') || e.request.mode==='navigate' || e.request.url.endsWith('/')){
    e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>r).catch(()=>caches.match(e.request).then(r=>r||caches.match('./'))));
  } else { e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))); }
});
