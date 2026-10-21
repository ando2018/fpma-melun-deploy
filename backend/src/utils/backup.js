const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BSON } = require('mongodb');
const { ensureIndexes, getDb, getSetting } = require('./db');

// Sauvegarde automatique de toute la base, et surveillance qu'elle n'a pas été vidée.
//
// - Toutes les heures, chaque collection est copiée dans un fichier
//   backups/fpma-AAAA-MM-JJTHH-MM.json.gz (les 5 dernières sont gardées).
// - Toutes les 3 heures, le backend vérifie que la base contient toujours le marqueur
//   d'installation. S'il a disparu, la base a été vidée : l'incident est noté (heure,
//   MongoDB redémarré ou non, bases présentes) dans les journaux PM2 et dans
//   backups/incidents.log, puis la dernière sauvegarde est restaurée automatiquement.
// - Une base vide n'est jamais sauvegardée : les sauvegardes restent toujours bonnes.

// BACKUP_ENABLED=false dans le .env désactive tout (sauvegardes, surveillance et
// restauration automatique) : le backend se comporte alors comme avant.
const ENABLED = !/^(false|0|non|no|off)$/i.test(String(process.env.BACKUP_ENABLED ?? '').trim());
const BACKUP_DIR =process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) || 5;
const BACKUP_EVERY_MS = 60 * 60 * 1000;
const WATCH_EVERY_MS = (Number(process.env.DB_WATCH_SECONDS) || 3 * 60 * 60) * 1000;
const MARKER = 'json-import';
const FILE_RE = /^fpma-.*\.json\.gz$/;

let lastHealthy = null;
let restoring = false;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.error(line);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.appendFileSync(path.join(BACKUP_DIR, 'incidents.log'), `${line}\n`);
  } catch {
    // le journal PM2 garde quand même le message
  }
}

async function isHealthy() {
  return !!(await getSetting(MARKER, null));
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(f => FILE_RE.test(f)).sort();
}

async function backupNow() {
  if (restoring || !(await isHealthy())) return null;
  const db = getDb();
  const data = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    data[name] = await db.collection(name).find({}).toArray();
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = `fpma-${new Date().toISOString().slice(0, 16).replace(':', '-')}.json.gz`;
  const tmp = path.join(BACKUP_DIR, `${file}.tmp`);
  // EJSON (relaxed: false) garde les types MongoDB (dates, ObjectId) à l'identique.
  fs.writeFileSync(tmp, zlib.gzipSync(BSON.EJSON.stringify(data, { relaxed: false })));
  fs.renameSync(tmp, path.join(BACKUP_DIR, file));
  for (const old of listBackups().slice(0, -KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, old));
  return file;
}

// Remplace le contenu de chaque collection par celui de la dernière sauvegarde.
async function restoreLatest() {
  if (!ENABLED) return null;
  const latest = listBackups().pop();
  if (!latest) return null;
  restoring = true;
  try {
    const db = getDb();
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(BACKUP_DIR, latest))).toString('utf8');
    const data = BSON.EJSON.parse(raw, { relaxed: false });
    const counts = {};
    for (const [name, docs] of Object.entries(data)) {
      await db.collection(name).deleteMany({});
      if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
      counts[name] = docs.length;
    }
    await ensureIndexes();
    return { file: latest, counts };
  } finally {
    restoring = false;
  }
}

// Diagnostic au moment où la base est trouvée vide.
async function describeIncident() {
  const details = [];
  try {
    const status = await getDb().admin().serverStatus();
    const minutes = Math.round(status.uptime / 60);
    details.push(
      minutes <= WATCH_EVERY_MS / 60000 + 1
        ? `MongoDB a redémarré il y a ${minutes} min : il n'a pas conservé ses données (stockage non persistant ?)`
        : `MongoDB tourne sans interruption depuis ${minutes} min : les tables ont été supprimées par une connexion (commande ou attaque)`
    );
  } catch (err) {
    details.push(`état de MongoDB illisible (${err.message})`);
  }
  try {
    const { databases } = await getDb().admin().listDatabases({ nameOnly: true });
    details.push(`bases présentes : ${databases.map(d => d.name).join(', ')}`);
  } catch {
    // facultatif
  }
  return details.join(' ; ');
}

async function watch() {
  if (restoring) return;
  if (await isHealthy()) {
    lastHealthy = new Date();
    return;
  }
  const since = lastHealthy ? lastHealthy.toISOString() : 'le démarrage';
  log(`ALERTE BASE : la base « ${getDb().databaseName} » a été vidée (dernière vérification correcte : ${since}). ${await describeIncident()}`);
  const restored = await restoreLatest();
  if (restored) {
    log(`Base restaurée depuis la sauvegarde ${restored.file} : ${JSON.stringify(restored.counts)}`);
    lastHealthy = new Date();
  } else {
    log('Aucune sauvegarde disponible : redémarrez le backend pour réimporter les anciennes données JSON.');
  }
}

function startBackups() {
  if (!ENABLED) {
    console.log('Sauvegardes automatiques de la base désactivées (BACKUP_ENABLED=false).');
    return;
  }
  const safe = (fn, label) => () => fn().catch(err => console.error(`${label} :`, err.message));
  safe(backupNow, 'Sauvegarde impossible')();
  setInterval(safe(backupNow, 'Sauvegarde impossible'), BACKUP_EVERY_MS).unref();
  setInterval(safe(watch, 'Surveillance de la base impossible'), WATCH_EVERY_MS).unref();
  lastHealthy = new Date();
  console.log(`Sauvegardes automatiques de la base dans ${BACKUP_DIR} (toutes les heures, ${KEEP} gardées)`);
}

module.exports = { backupNow, restoreLatest, startBackups, isHealthy, listBackups, log };
