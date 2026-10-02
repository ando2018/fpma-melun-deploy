// Service worker des notifications push (articles et informations de la FPMA Melun).
// Il ne met rien en cache : il affiche seulement les notifications et gère le clic.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'FPMA Melun', body: event.data ? event.data.text() : '' };
  }

  const options = {
    body: data.body || '',
    icon: '/assets/images/logomini.png',
    badge: '/assets/images/logomini.png',
    data: { url: data.url || '/' }
  };
  if (data.image) options.image = data.image;
  // Bouton dans la notification (Chrome, Edge, Android). Ailleurs, le clic sur la
  // notification ouvre le même lien.
  if (data.action) options.actions = [{ action: 'open', title: data.action }];

  event.waitUntil(self.registration.showNotification(data.title || 'FPMA Melun', options));
});

// Au clic : ouvre toujours le lien dans un nouvel onglet (les onglets déjà ouverts ne
// sont pas modifiés).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.openWindow(target));
});
