// Offline cache of the viewer shell: the app opens without network once visited (projects live in IndexedDB).
const CACHE = 'p2pv-0.4.1';
const SHELL = ['./', 'index.html', 'viewer.css', 'viewer.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'js/model.js', 'js/render.js', 'js/export.js', 'js/stage3d.js', 'js/stagefx.js', 'js/projview.js', 'js/meshmap.js', 'js/projectors.js', 'js/projlib.js', 'js/share.js', 'vendor/three/three.module.js', 'vendor/mp4-muxer.mjs', 'fonts/geist-latin-wght-normal.woff2', 'fonts/geist-latin-ext-wght-normal.woff2', 'assets/logo-256.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // network first (fresh version when online), cache when offline
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
