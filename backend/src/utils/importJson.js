const fs = require('fs');
const path = require('path');
const { col, getSetting, setSetting } = require('./db');

// Import des anciennes données JSON (src/data/*.json et métadonnées des albums Sary) dans
// MongoDB. Lancé automatiquement une seule fois par base (au premier démarrage), ou à la main
// avec « npm run import-json ». Sans risque de doublons : chaque document est inséré ou mis
// à jour selon son identifiant. Les fichiers JSON ne sont ni modifiés ni supprimés.

const DATA_DIR = path.join(__dirname, '..', 'data');
const SARY_DIR = path.join(__dirname, '..', 'storage', 'sary');
const MARKER = 'json-import';

function readJson(file, fallback) {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf-8'));
  } catch (err) {
    console.warn(`Import : ${file} illisible (${err.message}), ignoré.`);
    return fallback;
  }
}

function readArray(file) {
  const data = readJson(file, []);
  return Array.isArray(data) ? data : [];
}

async function upsertMany(collectionName, docs, key = 'id') {
  const valid = docs.filter(d => d && d[key] !== undefined && d[key] !== null);
  if (!valid.length) return 0;
  await col(collectionName).bulkWrite(
    valid.map(doc => ({ replaceOne: { filter: { [key]: doc[key] }, replacement: doc, upsert: true } })),
    { ordered: false }
  );
  return valid.length;
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// Ancienne tombola unique (avant les évènements) : on en fait un premier évènement et on
// y rattache les billets et tirages qui n'ont pas d'évènement.
function tombolaData() {
  const events = readArray('tombola-events.json');
  let tickets = readArray('tombola-tickets.json');
  let draws = readArray('tombola-draws.json');
  const legacy = readJson('tombola-config.json', null);

  const orphans = tickets.some(t => !t.eventId) || draws.some(d => !d.eventId);
  if (legacy || (orphans && !events.length)) {
    const event = {
      id: generateId('tombola'),
      nom: legacy?.eventName || 'Tombola FPMA Melun',
      date: new Date().toISOString().slice(0, 10),
      lieu: '',
      totalTickets: Number.isInteger(legacy?.totalTickets) ? legacy.totalTickets : 300,
      ticketPrice: Number.isFinite(legacy?.ticketPrice) ? legacy.ticketPrice : 2,
      createdAt: new Date().toISOString()
    };
    events.push(event);
    tickets = tickets.map(t => (t.eventId ? t : { ...t, eventId: event.id }));
    draws = draws.map(d => (d.eventId ? d : { ...d, eventId: event.id }));
  }
  return { events, tickets, draws, history: readArray('tombola-history.json') };
}

function saryAlbums() {
  if (!fs.existsSync(SARY_DIR)) return [];
  const readAlbumJson = (dir, file, fallback) => {
    const full = path.join(dir, file);
    try {
      return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf-8')) : fallback;
    } catch {
      return fallback;
    }
  };
  return fs
    .readdirSync(SARY_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const dir = path.join(SARY_DIR, entry.name);
      const meta = readAlbumJson(dir, 'meta.json', {});
      const links = readAlbumJson(dir, 'links.json', []);
      const titles = readAlbumJson(dir, 'titles.json', {});
      return {
        id: entry.name,
        nom: meta.nom || entry.name,
        dateCreation: meta.dateCreation || fs.statSync(dir).birthtime.toISOString().slice(0, 10),
        links: Array.isArray(links) ? links : [],
        // Liste plutôt qu'objet : les noms de fichiers contiennent des points.
        titles: titles && typeof titles === 'object' ? Object.entries(titles).map(([file, titre]) => ({ file, titre })) : []
      };
    });
}

async function importJson() {
  const summary = {};
  summary.annonces = await upsertMany('annonces', readArray('annonces.json'));
  // Ces fichiers gardaient le plus récent en premier : insérés à l'envers pour que l'ordre
  // d'ajout en base (utilisé pour le tri) reste le même.
  summary.evenements = await upsertMany('evenements', readArray('evenements.json').reverse());
  summary.messages = await upsertMany('messages', readArray('messages.json').reverse());
  summary.utilisateurs = await upsertMany('users', readArray('users.json'), 'username');
  summary.localisations = await upsertMany('ip_locations', readArray('ip-locations.json'), 'ip');
  summary.pageviews = await upsertMany('pageviews', readArray('pageviews.json'));

  const tombola = tombolaData();
  summary.tombola_evenements = await upsertMany('tombola_events', tombola.events);
  summary.tombola_billets = await upsertMany('tombola_tickets', tombola.tickets);
  summary.tombola_tirages = await upsertMany('tombola_draws', tombola.draws);
  summary.tombola_historique = await upsertMany('tombola_history', tombola.history);

  summary.abonnes_push = await upsertMany('push_subscriptions', readArray('push-subscriptions.json'), 'endpoint');
  summary.historique_push = await upsertMany('push_history', readArray('push-history.json'));
  const vapid = readJson('push-vapid.json', null);
  if (vapid?.publicKey && vapid?.privateKey && !(await getSetting('push-vapid', null))) {
    await setSetting('push-vapid', vapid);
    summary.cles_push = 1;
  }
  const live = readJson('live.json', null);
  if (live && !(await getSetting('live-config', null))) {
    await setSetting('live-config', live);
    summary.direct = 1;
  }

  summary.albums_sary = await upsertMany('sary_albums', saryAlbums());
  return summary;
}

// Au démarrage : importe une seule fois (une base vide déjà utilisée ne sera pas
// re-remplie avec les anciens fichiers).
async function importJsonOnce() {
  if (await getSetting(MARKER, null)) return null;
  const summary = await importJson();
  await setSetting(MARKER, { date: new Date().toISOString(), summary });
  return summary;
}

module.exports = { importJson, importJsonOnce };
