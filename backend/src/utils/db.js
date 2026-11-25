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
  live_recordings: [{ key: { id: 1 }, unique: true }, { key: { startedAt: -1 } }],
  live_sessions: [{ key: { id: 1 }, unique: true }, { key: { startedAt: -1 } }],
  payment_choices: [{ key: { id: 1 }, unique: true }, { key: { slug: 1 }, unique: true }],
  payments: [{ key: { id: 1 }, unique: true }, { key: { stripeSessionId: 1 } }, { key: { createdAt: -1 } }],
  payment_logs: [{ key: { at: -1 } }],
  tombola_events: [{ key: { id: 1 }, unique: true }],
  // Un même numéro ne peut jamais être vendu deux fois dans un évènement, même si deux
  // vendeurs valident au même instant.
  tombola_tickets: [{ key: { id: 1 }, unique: true }, { key: { eventId: 1, numero: 1 }, unique: true }],
  tombola_draws: [{ key: { id: 1 }, unique: true }, { key: { eventId: 1, numero: 1 }, unique: true }],
  tombola_history: [{ key: { eventId: 1, date: -1 } }],
  // N° client unique, mais facultatif (enfant sans n°). E-mail facultatif et partageable
  // (un couple, une famille) : chacun se connecte alors avec son identifiant.
  clients: [
    { key: { id: 1 }, unique: true },
    { key: { numero: 1 }, unique: true, partial: { numero: { $type: 'string' } } },
    { key: { email: 1 }, partial: { email: { $type: 'string' } } },
    // ID provisoire (P0001…) des fiches sans n° définitif : unique, jamais réattribué.
    { key: { provisoire: 1 }, unique: true, partial: { provisoire: { $type: 'string' } } },
    // Identifiant de connexion (8 chiffres au hasard) des paroissiens qui ont un n°.
    { key: { identifiant: 1 }, unique: true, partial: { identifiant: { $type: 'string' } } },
    { key: { parentIds: 1 } }
  ],
  client_groups: [{ key: { id: 1 }, unique: true }],
  client_versements: [{ key: { id: 1 }, unique: true }, { key: { clientId: 1, date: -1 } }, { key: { date: -1 } }, { key: { paymentId: 1 } }],
  client_history: [{ key: { clientId: 1, at: -1 } }, { key: { at: -1 } }],
  client_emails: [{ key: { id: 1 }, unique: true }, { key: { clientId: 1, sentAt: -1 } }],
  // Messagerie de l'espace paroissien : fils, messages (avec pièces jointes), lectures.
  message_threads: [{ key: { id: 1 }, unique: true }, { key: { clientId: 1, lastAt: -1 } }, { key: { groupId: 1, lastAt: -1 } }],
  message_posts: [{ key: { id: 1 }, unique: true }, { key: { threadId: 1, at: 1 } }],
  message_reads: [{ key: { threadId: 1, clientId: 1 }, unique: true }],
  votes: [{ key: { id: 1 }, unique: true }, { key: { groupId: 1, createdAt: -1 } }],
  // Un paroissien ne vote qu'une fois par vote (son choix n'est pas enregistré ici).
  vote_participations: [{ key: { voteId: 1, clientId: 1 }, unique: true }, { key: { voteId: 1, nameKey: 1 } }],
  // Vote rapide (votes spéciaux) : nombre à annoncer par code, sessions d'une journée.
  vote_codes: [{ key: { code: 1 }, unique: true }],
  vote_sessions: [{ key: { id: 1 }, unique: true }, { key: { code: 1, expiresAt: 1 } }],
  group_messages: [{ key: { id: 1 }, unique: true }, { key: { groupId: 1, sentAt: -1 } }, { key: { senderId: 1, sentAt: -1 } }],
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
  await migrate();
  for (const [name, indexes] of Object.entries(INDEXES)) {
    const existing = await db.collection(name).indexes().catch(() => []);
    for (const { key, unique, partial } of indexes) {
      // Index déjà créé avec d'autres options (ex. devenu partiel) : on le remplace.
      const indexName = Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_');
      const old = existing.find(i => i.name === indexName);
      if (old && (!!old.unique !== !!unique || JSON.stringify(old.partialFilterExpression || null) !== JSON.stringify(partial || null))) {
        await db.collection(name).dropIndex(indexName);
      }
      await db.collection(name).createIndex(key, { ...(unique ? { unique: true } : {}), ...(partial ? { partialFilterExpression: partial } : {}) });
    }
  }
}

// Mises à jour des anciennes données, avant les index.
async function migrate() {
  // Nouveau droit « Voir les montants » : les comptes qui avaient déjà des parties de
  // « Paroissiens et dons » le reçoivent (une seule fois), pour ne rien leur retirer.
  const settings = db.collection('settings');
  if (!(await settings.findOne({ _id: 'migration-droit-montants' }))) {
    await db
      .collection('users')
      .updateMany({ tabs: { $regex: '^clients\\.' }, 'tabs.0': { $exists: true } }, { $addToSet: { tabs: 'clients.montants' } });
    await settings.updateOne({ _id: 'migration-droit-montants' }, { $set: { value: new Date().toISOString() } }, { upsert: true });
  }
  // N° client : autrefois un nombre attribué automatiquement (1, 2…), maintenant un texte
  // saisi par l'admin (« 0001 »), facultatif. E-mail vide : null (facultatif).
  const clients = db.collection('clients');
  for (const c of await clients.find({ numero: { $type: 'number' } }).toArray()) {
    await clients.updateOne({ _id: c._id }, { $set: { numero: String(c.numero).padStart(4, '0') } });
  }
  await clients.updateMany({ email: '' }, { $set: { email: null } });
  // Fiches sans n° définitif : un ID provisoire unique (P0001, P0002…), dans l'ordre de création.
  const sansId = await clients
    .find({ numero: { $not: { $type: 'string' } }, provisoire: { $not: { $type: 'string' } } })
    .sort({ createdAt: 1 })
    .toArray();
  for (const c of sansId) {
    const counter = await db
      .collection('settings')
      .findOneAndUpdate({ _id: 'client-provisoire-counter' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
    const value = counter?.value?.value ?? counter?.value;
    await clients.updateOne({ _id: c._id }, { $set: { provisoire: `P${String(value).padStart(4, '0')}` } });
  }
  // Identifiant de connexion à 8 chiffres pour chaque paroissien qui a un n° (fiches
  // d'avant : donné une fois, il ne change plus).
  const sansIdentifiant = await clients.find({ numero: { $type: 'string' }, identifiant: { $not: { $type: 'string' } } }).toArray();
  if (sansIdentifiant.length) {
    const taken = new Set((await clients.distinct('identifiant')).filter(Boolean));
    for (const c of sansIdentifiant) {
      let value;
      do value = String(require('crypto').randomInt(10000000, 100000000));
      while (taken.has(value));
      taken.add(value);
      await clients.updateOne({ _id: c._id }, { $set: { identifiant: value } });
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
