const { MongoClient } = require('mongodb');

// Connexion MongoDB unique, partagée par toutes les routes.
// MONGODB_URI : adresse du serveur (par défaut le MongoDB local).
// MONGODB_DB  : nom de la base (par défaut « fpma »).

let client = null;
let db = null;

// Les documents gardent leur identifiant applicatif « id » (chaîne) : le _id interne de
// MongoDB n'est jamais renvoyé au site.
const NO_ID = { projection: { _id: 0 } };

const INDEXES = {
  annonces: [{ key: { id: 1 }, unique: true }],
  evenements: [{ key: { id: 1 }, unique: true }],
  messages: [{ key: { id: 1 }, unique: true }, { key: { receivedAt: -1 } }],
  pageviews: [{ key: { timestamp: 1 } }, { key: { sessionId: 1 } }],
  ip_locations: [{ key: { ip: 1 }, unique: true }],
  users: [{ key: { username: 1 }, unique: true }],
  sary_albums: [{ key: { id: 1 }, unique: true }],
  bannieres: [{ key: { id: 1 }, unique: true }],
  tombola_events: [{ key: { id: 1 }, unique: true }],
  // Un même numéro ne peut jamais être vendu deux fois dans un évènement, même si deux
  // vendeurs valident au même instant.
  tombola_tickets: [{ key: { id: 1 }, unique: true }, { key: { eventId: 1, numero: 1 }, unique: true }],
  tombola_draws: [{ key: { id: 1 }, unique: true }, { key: { eventId: 1, numero: 1 }, unique: true }],
  tombola_history: [{ key: { eventId: 1, date: -1 } }],
  push_subscriptions: [{ key: { endpoint: 1 }, unique: true }],
  push_history: [{ key: { date: -1 } }]
};

async function connectDb() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  // Affichera l'URL dans PM2 pour confirmer que le .env est lu
  console.log("=== URL CHARGÉE :", process.env.MONGODB_URI, "===");
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'fpma');
  await ensureIndexes();
  return db;
}

// Crée les index (et donc les collections). Rappelé après une restauration de sauvegarde.
async function ensureIndexes() {
  for (const [name, indexes] of Object.entries(INDEXES)) {
    for (const { key, unique } of indexes) {
      await db.collection(name).createIndex(key, unique ? { unique: true } : {});
    }
  }
}

function getDb() {
  if (!db) throw new Error('Base de données non connectée');
  return db;
}

function col(name) {
  if (!db) throw new Error('Base de données non connectée');
  return db.collection(name);
}

// Petits réglages isolés (direct vidéo, clés des notifications…) : un document par clé.
async function getSetting(key, fallback) {
  const doc = await col('settings').findOne({ _id: key });
  return doc ? doc.value : fallback;
}

async function setSetting(key, value) {
  await col('settings').updateOne({ _id: key }, { $set: { value } }, { upsert: true });
}

function isDuplicateKey(err) {
  return err && err.code === 11000;
}

async function closeDb() {
  await client?.close();
}

module.exports = { connectDb, closeDb, ensureIndexes, getDb, col, getSetting, setSetting, isDuplicateKey, NO_ID };
