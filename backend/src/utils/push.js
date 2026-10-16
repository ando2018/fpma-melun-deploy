const webpush = require('web-push');
const { col, getSetting, setSetting, NO_ID } = require('./db');

const subscriptions = () => col('push_subscriptions');
const pushHistory = () => col('push_history');

let publicKey = null;

// Clés VAPID : depuis l'environnement si fournies, sinon générées une fois et gardées en
// base (réglage « push-vapid »). Elles ne doivent plus changer ensuite, sinon les
// abonnements existants deviennent invalides.
async function initPush() {
  let keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    keys = await getSetting('push-vapid', null);
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      await setSetting('push-vapid', keys);
    }
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || `mailto:${process.env.MAIL_TO || 'fpmamelun77@gmail.com'}`,
    keys.publicKey,
    keys.privateKey
  );
  publicKey = keys.publicKey;
}

function getPublicKey() {
  return publicKey;
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

async function addSubscription(sub) {
  await subscriptions().updateOne(
    { endpoint: sub.endpoint },
    {
      $set: { keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      $setOnInsert: { endpoint: sub.endpoint, createdAt: new Date().toISOString() }
    },
    { upsert: true }
  );
}

async function removeSubscription(endpoint) {
  await subscriptions().deleteOne({ endpoint });
}

function countSubscriptions() {
  return subscriptions().countDocuments();
}

// Envoie { title, body, url, image?, action? } à tous les abonnés. Les abonnements expirés
// (navigateur désinstallé, permission retirée…) sont supprimés au passage.
async function sendToAll(notification, meta) {
  const subs = await subscriptions().find({}, NO_ID).toArray();
  const payload = JSON.stringify(notification);
  const expired = [];
  let sent = 0;

  await Promise.all(
    subs.map(sub =>
      webpush
        .sendNotification(sub, payload, { TTL: 24 * 60 * 60 })
        .then(() => sent++)
        .catch(err => {
          if (err.statusCode === 404 || err.statusCode === 410) expired.push(sub.endpoint);
          else console.error('Échec d\'envoi push', err.statusCode || err.message);
        })
    )
  );

  if (expired.length) await subscriptions().deleteMany({ endpoint: { $in: expired } });

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
    expires: expired.length
  };
  await pushHistory().insertOne({ ...entry });
  return entry;
}

function getHistory() {
  return pushHistory().find({}, NO_ID).sort({ date: -1 }).toArray();
}

module.exports = { initPush, getPublicKey, isValidSubscription, addSubscription, removeSubscription, countSubscriptions, sendToAll, getHistory };
