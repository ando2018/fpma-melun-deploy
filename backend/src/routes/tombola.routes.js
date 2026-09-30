const express = require('express');
const fs = require('fs');
const path = require('path');
const JsonStore = require('../utils/jsonStore');
const { requireRole } = require('../utils/auth');

const router = express.Router();
router.use(requireRole('admin', 'tombola'));

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEGACY_CONFIG_PATH = path.join(DATA_DIR, 'tombola-config.json');
const eventsStore = new JsonStore(path.join(DATA_DIR, 'tombola-events.json'));
const ticketsStore = new JsonStore(path.join(DATA_DIR, 'tombola-tickets.json'));
const drawsStore = new JsonStore(path.join(DATA_DIR, 'tombola-draws.json'));
const historyStore = new JsonStore(path.join(DATA_DIR, 'tombola-history.json'));

const PAYMENT_MODES = { cb: 'CB', especes: 'Espèces', cheque: 'Chèque' };

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function formatEuros(amount) {
  return `${amount.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} €`;
}

// Journal de toutes les actions d'un évènement (qui, quand, quoi).
function logHistory(req, eventId, action, details) {
  historyStore.writeAll([
    ...historyStore.readAll(),
    {
      id: generateId('histo'),
      eventId,
      date: new Date().toISOString(),
      utilisateur: req.user?.username || 'inconnu',
      action,
      details
    }
  ]);
}

function describeEvent(event) {
  return `${event.nom} — ${event.date}${event.lieu ? ` — ${event.lieu}` : ''} — ${event.totalTickets} billets à ${formatEuros(event.ticketPrice)}`;
}

// Avant les évènements, la tombola était unique (tombola-config.json) : on transforme
// cette configuration en un premier évènement et on y rattache les billets/tirages.
function migrateLegacyConfig() {
  if (!fs.existsSync(LEGACY_CONFIG_PATH)) return;
  let legacy = {};
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, 'utf-8'));
  } catch {
    // configuration illisible : valeurs par défaut ci-dessous
  }

  const event = {
    id: generateId('tombola'),
    nom: legacy.eventName || 'Tombola FPMA Melun',
    date: new Date().toISOString().slice(0, 10),
    lieu: '',
    totalTickets: Number.isInteger(legacy.totalTickets) ? legacy.totalTickets : 300,
    ticketPrice: Number.isFinite(legacy.ticketPrice) ? legacy.ticketPrice : 2,
    createdAt: new Date().toISOString()
  };
  eventsStore.writeAll([...eventsStore.readAll(), event]);
  ticketsStore.writeAll(ticketsStore.readAll().map(t => (t.eventId ? t : { ...t, eventId: event.id })));
  drawsStore.writeAll(drawsStore.readAll().map(d => (d.eventId ? d : { ...d, eventId: event.id })));
  fs.unlinkSync(LEGACY_CONFIG_PATH);
}
migrateLegacyConfig();

function findEvent(id) {
  return eventsStore.readAll().find(e => e.id === id);
}

function withStats(event) {
  const tickets = ticketsStore.readAll().filter(t => t.eventId === event.id && !t.annule);
  return { ...event, ticketsVendus: tickets.length };
}

// Valide le corps d'une création/modification d'évènement. `current` = évènement
// existant (modification) : les champs absents gardent leur valeur actuelle.
function parseEventBody(body, current) {
  const merged = { ...current, ...body };
  const nom = String(merged.nom || '').trim();
  if (!nom) return { error: "Le nom de l'évènement est requis." };

  const date = String(merged.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'La date est requise (AAAA-MM-JJ).' };

  const totalTickets = Number(merged.totalTickets);
  if (!Number.isInteger(totalTickets) || totalTickets < 1) {
    return { error: 'Le nombre de billets doit être un entier positif.' };
  }

  const ticketPrice = Number(merged.ticketPrice);
  if (!Number.isFinite(ticketPrice) || ticketPrice < 0) {
    return { error: 'Le prix doit être un nombre positif.' };
  }

  return { value: { nom, date, lieu: String(merged.lieu || '').trim(), totalTickets, ticketPrice } };
}

// ---------- Évènements ----------

// GET /api/tombola/events - du plus récent au plus ancien
router.get('/events', (req, res) => {
  const events = [...eventsStore.readAll()].sort((a, b) => b.date.localeCompare(a.date));
  res.json(events.map(withStats));
});

router.get('/events/:id', (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable' });
  res.json(withStats(event));
});

router.post('/events', (req, res) => {
  const parsed = parseEventBody(req.body, { totalTickets: 300, ticketPrice: 2 });
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const event = { id: generateId('tombola'), ...parsed.value, createdAt: new Date().toISOString() };
  eventsStore.writeAll([...eventsStore.readAll(), event]);
  logHistory(req, event.id, 'creation_evenement', describeEvent(event));
  res.status(201).json(withStats(event));
});

router.put('/events/:id', (req, res) => {
  const events = eventsStore.readAll();
  const index = events.findIndex(e => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Évènement introuvable' });

  const parsed = parseEventBody(req.body, events[index]);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const highestSold = ticketsStore
    .readAll()
    .filter(t => t.eventId === req.params.id)
    .reduce((max, t) => Math.max(max, t.numero), 0);
  if (parsed.value.totalTickets < highestSold) {
    return res.status(400).json({ error: `Impossible : le billet n°${highestSold} a déjà été vendu.` });
  }

  events[index] = { ...events[index], ...parsed.value };
  eventsStore.writeAll(events);
  logHistory(req, events[index].id, 'modification_evenement', describeEvent(events[index]));
  res.json(withStats(events[index]));
});

// DELETE /api/tombola/events/:id - supprime l'évènement avec ses billets, tirages et
// son historique
router.delete('/events/:id', (req, res) => {
  const events = eventsStore.readAll();
  const filtered = events.filter(e => e.id !== req.params.id);
  if (filtered.length === events.length) return res.status(404).json({ error: 'Évènement introuvable' });

  eventsStore.writeAll(filtered);
  ticketsStore.writeAll(ticketsStore.readAll().filter(t => t.eventId !== req.params.id));
  drawsStore.writeAll(drawsStore.readAll().filter(d => d.eventId !== req.params.id));
  historyStore.writeAll(historyStore.readAll().filter(h => h.eventId !== req.params.id));
  res.status(204).end();
});

// GET /api/tombola/events/:id/history - journal des actions, du plus récent au plus ancien
router.get('/events/:id/history', (req, res) => {
  const history = historyStore.readAll().filter(h => h.eventId === req.params.id);
  res.json(history.sort((a, b) => b.date.localeCompare(a.date)));
});

// ---------- Billets ----------

// GET /api/tombola/events/:id/tickets - billets de l'évènement, triés par numéro
router.get('/events/:id/tickets', (req, res) => {
  const tickets = ticketsStore.readAll().filter(t => t.eventId === req.params.id);
  res.json(tickets.sort((a, b) => a.numero - b.numero));
});

// POST /api/tombola/events/:id/tickets - vente d'un ou plusieurs billets à un même
// acheteur ({ numeros: [..], nom, telephone, modePaiement }). Tout ou rien : si un seul
// numéro est déjà pris, aucun billet n'est vendu.
router.post('/events/:id/tickets', (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable' });

  const { numeros, nom, telephone, modePaiement } = req.body;
  if (!PAYMENT_MODES[modePaiement]) {
    return res.status(400).json({ error: 'Choisissez le moyen de paiement (CB, espèces ou chèque).' });
  }
  if (!Array.isArray(numeros) || !numeros.length) {
    return res.status(400).json({ error: 'Choisissez au moins un numéro.' });
  }
  const numerosInt = [...new Set(numeros.map(Number))].sort((a, b) => a - b);
  if (numerosInt.some(n => !Number.isInteger(n) || n < 1 || n > event.totalTickets)) {
    return res.status(400).json({ error: `Les numéros doivent être compris entre 1 et ${event.totalTickets}.` });
  }
  if (!nom || !String(nom).trim()) {
    return res.status(400).json({ error: 'Le nom est requis.' });
  }
  if (!telephone || !String(telephone).trim()) {
    return res.status(400).json({ error: 'Le numéro de téléphone est requis.' });
  }

  const tickets = ticketsStore.readAll();
  const taken = new Set(tickets.filter(t => t.eventId === event.id).map(t => t.numero));
  const conflicts = numerosInt.filter(n => taken.has(n));
  if (conflicts.length) {
    return res.status(409).json({
      error: `Déjà attribué${conflicts.length > 1 ? 's' : ''} : n°${conflicts.join(', ')}.`,
      conflicts
    });
  }

  const createdAt = new Date().toISOString();
  const venteId = generateId('vente');
  const created = numerosInt.map((numero, i) => ({
    id: `${generateId('ticket')}-${i}`,
    eventId: event.id,
    venteId,
    numero,
    nom: String(nom).trim(),
    telephone: String(telephone).trim(),
    prixPaye: event.ticketPrice,
    modePaiement,
    vendeur: req.user.username,
    createdAt,
    annule: false
  }));
  ticketsStore.writeAll([...tickets, ...created]);

  const montant = created.length * event.ticketPrice;
  logHistory(
    req,
    event.id,
    'vente',
    `${created.length > 1 ? 'Billets' : 'Billet'} n°${numerosInt.join(', ')} — ${created[0].nom} (${created[0].telephone}) — ${formatEuros(montant)} — ${PAYMENT_MODES[modePaiement]}`
  );
  res.status(201).json(created);
});

// PATCH /api/tombola/tickets/:id/annuler - annule un billet (ou le réactive). Le billet
// reste dans la liste : son numéro ne redevient jamais disponible, pour éviter de le
// revendre par erreur.
router.patch('/tickets/:id/annuler', (req, res) => {
  const tickets = ticketsStore.readAll();
  const index = tickets.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Billet introuvable' });
  const ticket = tickets[index];
  ticket.annule = !ticket.annule;
  ticketsStore.writeAll(tickets);
  logHistory(
    req,
    ticket.eventId,
    ticket.annule ? 'annulation_billet' : 'reactivation_billet',
    `Billet n°${ticket.numero} — ${ticket.nom} — ${formatEuros(ticket.prixPaye)}`
  );
  res.json(ticket);
});

// ---------- Tirages ----------

function eventDraws(eventId) {
  return drawsStore
    .readAll()
    .filter(d => d.eventId === eventId)
    .sort((a, b) => new Date(a.drawnAt) - new Date(b.drawnAt));
}

function setScreenDraw(eventId, drawId) {
  const events = eventsStore.readAll();
  const index = events.findIndex(e => e.id === eventId);
  if (index === -1) return;
  events[index].screenDrawId = drawId;
  eventsStore.writeAll(events);
}

// GET /api/tombola/events/:id/draws - gagnants dans l'ordre du tirage
router.get('/events/:id/draws', (req, res) => {
  res.json(eventDraws(req.params.id));
});

// POST /api/tombola/events/:id/draws - enregistre le numéro sorti de l'urne ({ numero })
// comme gagnant et l'envoie sur l'écran de projection.
router.post('/events/:id/draws', (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable' });

  const numero = Number(req.body?.numero);
  const ticket = ticketsStore.readAll().find(t => t.eventId === event.id && t.numero === numero);
  if (!ticket) return res.status(400).json({ error: `Le numéro ${req.body?.numero} n'a pas été vendu.` });
  if (ticket.annule) return res.status(400).json({ error: `Le billet n°${numero} est annulé.` });

  const draws = drawsStore.readAll();
  if (draws.some(d => d.eventId === event.id && d.numero === numero)) {
    return res.status(409).json({ error: `Le numéro ${numero} a déjà gagné.` });
  }

  const draw = {
    id: generateId('tirage'),
    eventId: event.id,
    numero,
    nom: ticket.nom,
    telephone: ticket.telephone,
    drawnAt: new Date().toISOString()
  };
  drawsStore.writeAll([...draws, draw]);
  setScreenDraw(event.id, draw.id);
  const rang = draws.filter(d => d.eventId === event.id).length + 1;
  logHistory(req, event.id, 'tirage', `${rang}${rang === 1 ? 'er' : 'e'} tiré : n°${numero} — ${ticket.nom}`);
  res.status(201).json(draw);
});

// DELETE /api/tombola/draws/:id - annule un tirage, le numéro redevient éligible. S'il
// était affiché sur l'écran de projection, l'écran se vide.
router.delete('/draws/:id', (req, res) => {
  const draws = drawsStore.readAll();
  const draw = draws.find(d => d.id === req.params.id);
  if (!draw) return res.status(404).json({ error: 'Tirage introuvable' });

  drawsStore.writeAll(draws.filter(d => d.id !== draw.id));
  if (findEvent(draw.eventId)?.screenDrawId === draw.id) setScreenDraw(draw.eventId, null);
  logHistory(req, draw.eventId, 'annulation_tirage', `N°${draw.numero} — ${draw.nom}`);
  res.status(204).end();
});

// GET /api/tombola/events/:id/screen - état de l'écran de projection (sans téléphones)
router.get('/events/:id/screen', (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable' });

  const winners = eventDraws(event.id).map(d => ({ drawId: d.id, numero: d.numero, nom: d.nom }));
  res.json({
    nom: event.nom,
    totalTickets: event.totalTickets,
    current: winners.find(w => w.drawId === event.screenDrawId) || null,
    winners
  });
});

module.exports = router;
