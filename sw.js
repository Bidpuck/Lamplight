// Lamplight — service worker. Two jobs:
//  1. Keep the app shell cached so it opens with no network (voices still need one
//     unless they're on the device).
//  2. Receive a book handed to the installed app through the system share sheet
//     (Web Share Target). The share arrives as a POST; the file is parked in a cache
//     and the app is opened with ?shared=1 to pick it up.
const SHELL_CACHE = 'lamplight-shell-v1';
const SHARED_CACHE = 'lamplight-shared';
const SHELL_FILES = ['./', './index.html', './style.css', './app.js', './book.js', './text.js', './store.js',
  './voice.js', './player.js', './kokoro-engine.js', './piper-engine.js', './manifest.json',
  './icon-32.png', './icon-180.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('lamplight-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return; // CDN libraries, voice models and servers go straight through

  if(event.request.method === 'POST' && url.pathname.endsWith('/share-target')){
    event.respondWith((async () => {
      try{
        const form = await event.request.formData();
        const file = form.get('book');
        if(file && file.size){
          const cache = await caches.open(SHARED_CACHE);
          await cache.put('shared-file', new Response(file, { headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name || 'book.epub')
          }}));
        }
      } catch(e){ /* fall through to the app, which will just show the library */ }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if(event.request.method !== 'GET') return;
  // Network first, so a new deploy shows up right away; the cache is the offline fallback.
  event.respondWith((async () => {
    try{
      const res = await fetch(event.request);
      if(res && res.ok){ const cache = await caches.open(SHELL_CACHE); cache.put(event.request, res.clone()).catch(() => {}); }
      return res;
    } catch(err){
      const cached = await caches.match(event.request, { ignoreSearch: true });
      if(cached) return cached;
      throw err;
    }
  })());
});
