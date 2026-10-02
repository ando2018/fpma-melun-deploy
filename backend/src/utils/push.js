const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const JsonStore = require('./jsonStore');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VAPID_PATH = path.join(DATA_DIR, 'push-vapid.json');

const subscriptionsStore = new JsonStore(path.join(DATA_DIR, 'push-subscriptions.json'));
const historyStore = new JsonStore(path.join(DATA_DIR, 'push-history.json'));

// Clés VAPID : depuis l'environnement si fournies, sinon générées une fois et gardées
// dans data/push-vapid.json. Elles ne doivent plus changer ensuite, sinon les abonnements
// existants deviennent invalides.
function loadVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (fs.existsSync(VAPID_PATH)) {
    return JSON.parse(fs.readFileSync(VAPID_PATH, 'utf-8'));
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_PATH, JSON.stringify(keys, null, 2), 'utf-8');
  return keys;
}

const vapidKeys = loadVapidKeys();
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || `mailto:${process.env.MAIL_TO || 'fpmamelun77@gmail.com'}`,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

function getPublicKey() {
  return vapidKeys.publicKey;
}

function isValidSubscription(sub) {
  return (
    sub &&
    typeof sub.endpoint === 'string' &&
    /^https:\/\//.test(sub.endpoint) &&
    sub.endpoint.length < 1000 &&
    sub.keys &&
    typeof sub.keys.p256dh === 'string' &&
    typeof sub.keys.auth === 'string'
  );
}

function addSubscription(sub) {
  const subs = subscriptionsStore.readAll().filter(s => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: new Date().toISOString() });
  subscriptionsStore.writeAll(subs);
}

function removeSubscription(endpoint) {
  subscriptionsStore.writeAll(subscriptionsStore.readAll().filter(s => s.endpoint !== endpoint));
}

function countSubscriptions() {
  return subscriptionsStore.readAll().length;
}

// Envoie { title, body, url, image? } à tous les abonnés. Les abonnements expirés
// (navigateur désinstallé, permission retirée…) sont supprimés au passage.
async function sendToAll(notification, meta) {
  const subs = subscriptionsStore.readAll();
  const payload = JSON.stringify(notification);
  const expired = new Set();
  let sent = 0;

  await Promise.all(
    subs.map(sub =>
      webpush
        .sendNotification(sub, payload, { TTL: 24 * 60 * 60 })
        .then(() => sent++)
        .catch(err => {
          if (err.statusCode === 404 || err.statusCode === 410) expired.add(sub.endpoint);
          else console.error('Échec d\'envoi push', err.statusCode || err.message);
        })
    )
  );

  if (expired.size) {
    subscriptionsStore.writeAll(subscriptionsStore.readAll().filter(s => !expired.has(s.endpoint)));
  }

  const entry = {
    id: `push-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    date: new Date().toISOString(),
    type: meta.type,
    utilisateur: meta.utilisateur,
    title: notification.title,
    body: notification.body,
    url: notification.url,
    destinataires: subs.length,
    envoyes: sent,
    expires: expired.size
  };
  historyStore.writeAll([...historyStore.readAll(), entry]);
  return entry;
}

function getHistory() {
  return [...historyStore.readAll()].sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = { getPublicKey, isValidSubscription, addSubscription, removeSubscription, countSubscriptions, sendToAll, getHistory };
