// Service worker mínimo — só o necessário para o PWA ser instalável (Chrome exige um
// fetch handler ativo). Sem estratégia de cache agressiva: o dashboard é leitura de
// dados que mudam o tempo todo, cache offline de verdade não é meta deste MH-009.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
