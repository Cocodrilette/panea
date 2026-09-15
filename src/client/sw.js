/**
 * Service worker del canvas: lo mínimo que Chrome pide para ofrecer "Instalar
 * app", más un caché del shell para que un arranque en frío sin servidor
 * muestre el canvas en vez del dinosaurio.
 *
 * Network-first a propósito: `npm run dev` reescribe dist/ todo el tiempo y un
 * worker cache-first seguiría sirviendo el main.js de ayer.
 */
const CACHE = 'tcv-shell-v1'
const SHELL = ['/', '/main.js', '/main.css', '/manifest.webmanifest']

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (ev) => {
  const { request } = ev
  const url = new URL(request.url)
  // Las subidas de imágenes y el WebSocket no pasan por aquí; sólo GETs propios.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  ev.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone()
          void caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return res
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('/'))),
  )
})
