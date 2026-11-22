// 오프라인 캐시 (브라우저에서 PWA로 쓸 때만 등록됨)
const C = 'gaegul-v2';
const FILES = ['./', './index.html', './css/app.css', './js/saju.js', './js/data.js', './js/frog.js', './js/voice.js', './js/app.js', './icon.svg', './manifest.webmanifest'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request)));
});
