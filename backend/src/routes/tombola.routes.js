const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID, isDuplicateKey } = require('../utils/db');
const { requireRole } = require('../utils/auth');

const router = asyncRouter();
router.use(requireRole('admin', 'tombola'));

const events = () => col('tombola_events');
const tickets = () => col('tombola_tickets');
const draws = () => col('tombola_draws');
const history = () => col('tombola_history');

const PAYMENT_MODES = { cb: 'CB', especes: 'Espèces', cheque: 'Chèque' };

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function formatEuros(amount) {
  return `${amount.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} €`;
}

// Journal de toutes les actions d'un évènement (qui, quand, quoi).
async function logHistory(req, eventId, action, details) {
  await history().insertOne({
    id: generateId('histo'),
    eventId,
    date: new Date().toISOString(),
    utilisateur: req.user?.username || 'inconnu',
    action,
    details
  });
}

function describeEvent(event) {
  return `${event.nom} — ${event.date}${event.lieu ? ` — ${event.lieu}` : ''} — ${event.totalTickets} billets à ${formatEuros(event.ticketPrice)}`;
}

function findEvent(id) {
  return events().findOne({ id }, NO_ID);
}

async function withStats(event) {
  const ticketsVendus = await tickets().countDocuments({ eventId: event.id, annule: { $ne: true } });
  return { ...event, ticketsVendus };
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
router.get('/events', async (req, res) => {
  const list = await events().find({}, NO_ID).sort({ date: -1 }).toArray();
  res.json(await Promise.all(list.map(withStats)));
});

router.get('/events/:id', async (req, res) => {
  const event = await findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable' });
  res.json(await withStats(event));
});

router.post('/events', async (req, res) => {
  const parsed = parseEventBody(req.body, { totalTickets: 300, ticketPrice: 2 });
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const event = { id: generateId('tombola'), ...parsed.value, createdAt: new Date().toISOString() };
  await events().insertOne({ ...event });
  await logHistory(req, event.id, 'creation_evenement', describeEvent(event));
  res.status(201).json(await withStats(event));
});

router.put('/events/:id', async (req, res) => {
  const current = await findEvent(req.params.id);
  if (!current) return res.status(404).json({ error: 'Évènement introuvable' });

  const parsed = parseEventBody(req.body, current);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const highest = await tickets().find({ eventId: req.params.id }).sort({ numero: -1 }).limit(1).next();
  if (highest && parsed.value.totalTickets < highest.numero) {
    return res.status(400).json({ error: `Impossible : le billet n°${highest.numero} a déjà été vendu.` });
  }

  const updated = await events().findOneAndUpdate(
    { id: req.params.id },
    { $set: parsed.value },
    { returnDocument: 'after', ...NO_ID }
  );
  await logHistory(req, updated.id, 'modification_evenement', describeEvent(updated));
  res.json(await withStats(updated));
});

// DELETE /api/tombola/events/:id - supprime l'évènement avec ses billets, tirages et
// son historique
router.delete('/events/:id', async (req, res) => {
  const { deletedCount } = await events().deleteOne({ id: req.params.id });
  if (!deletedCount) return res.status(404).json({ error: 'Évènement introuvable' });

  await Promise.all([
    tickets().deleteMany({ eventId: req.params.id }),
    draws().deleteMany({ eventId: req.params.id }),
    history().deleteMany({ eventId: req.params.id })
  ]);
  res.status(204).end();
});

// GET /api/tombola/events/:id/history - journal des actions, du plus récent au plus ancien
router.get('/events/:id/history', async (req, res) => {
  res.json(await history().find({ eventId: req.params.id }, NO_ID).sort({ date: -1 }).toArray());
});

// ---------- Billets ----------

// GET /api/tombola/events/:id/tickets - billets de l'évènement, triés par numéro
router.get('/events/:id/tickets', async (req, res) => {
  res.json(await tickets().find({ eventId: req.params.id }, NO_ID).sort({ numero: 1 }).toArray());
});

// POST /api/tombola/events/:id/tickets - vente d'un ou plusieurs billets à un même
// acheteur ({ numeros: [..], nom, telephone, modePaiement }). Tout ou rien : si un seul
// numéro est déjà pris, aucun billet n'est vendu.
router.post('/events/:id/tickets', async (req, res) => {
  const event = await findEvent(req.params.id);
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

  const conflictMessage = conflicts => ({
    error: `Déjà attribué${conflicts.length > 1 ? 's' : ''} : n°${conflicts.join(', ')}.`,
    conflicts
  });

  const taken = await tickets().find({ eventId: event.id, numero: { $in: numerosInt } }).toArray();
  if (taken.length) {
    return res.status(409).json(conflictMessage(taken.map(t => t.numero).sort((a, b) => a - b)));
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

  try {
    await tickets().insertMany(created.map(t => ({ ...t })), { ordered: true });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Un autre vendeur a pris un de ces numéros à l'instant : on annule toute la vente.
    await tickets().deleteMany({ venteId });
    const nowTaken = await tickets().find({ eventId: event.id, numero: { $in: numerosInt } }).toArray();
    return res.status(409).json(conflictMessage(nowTaken.map(t => t.numero).sort((a, b) => a - b)));
  }

  const montant = created.length * event.ticketPrice;
  await logHistory(
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
router.patch('/tickets/:id/annuler', async (req, res) => {
  const ticket = await tickets().findOneAndUpdate(
    { id: req.params.id },
    [{ $set: { annule: { $not: [{ $eq: ['$annule', true] }] } } }],
    { returnDocument: 'after', ...NO_ID }
  );
  if (!ticket) return res.status(404).json({ error: 'Billet introuvable' });
  await logHistory(
    req,
    ticket.eventId,
    ticket.annule ? 'annulation_billet' : 'reactivation_billet',
    `Billet n°${ticket.numero} — ${ticket.nom} — ${formatEuros(ticket.prixPaye)}`
  );
  res.json(ticket);
});

// ---------- Tirages ----------

function eventDraws(eventId) {
  return draws().find({ eventId }, NO_ID).sort({ drawnAt: 1 }).toArray();
}

function setScreenDraw(eventId, drawId) {
  return events().updateOne({ id: eventId }, { $set: { screenDrawId: drawId } });
}

// GET /api/tombola/events/:id/draws - gagnants dans l'ordre du tirage
router.get('/events/:id/draws', async (req, res) => {
  res.json(await eventDraws(req.params.id));
});

// POST /api/tombola/events/:id/draws - enregistre le numéro sorti de l'urne ({ numero })
// comme gagnant et l'envoie sur l'écran de projection.
router.post('/events/:id/draws', async (req, res) => {
  const event = await findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable' });

  const numero = Number(req.body?.numero);
  const ticket = await tickets().findOne({ eventId: event.id, numero });
  if (!ticket) return res.status(400).json({ error: `Le numéro ${req.body?.numero} n'a pas été vendu.` });
  if (ticket.annule) return res.status(400).json({ error: `Le billet n°${numero} est annulé.` });

  const draw = {
    id: generateId('tirage'),
    eventId: event.id,
    numero,
    nom: ticket.nom,
    telephone: ticket.telephone,
    drawnAt: new Date().toISOString()
  };
  try {
    await draws().insertOne({ ...draw });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: `Le numéro ${numero} a déjà gagné.` });
    throw err;
  }
  await setScreenDraw(event.id, draw.id);
  const rang = await draws().countDocuments({ eventId: event.id });
  await logHistory(req, event.id, 'tirage', `${rang}${rang === 1 ? 'er' : 'e'} tiré : n°${numero} — ${ticket.nom}`);
  res.status(201).json(draw);
});

// DELETE /api/tombola/draws/:id - annule un tirage, le numéro redevient éligible. S'il
// était affiché sur l'écran de projection, l'écran se vide.
router.delete('/draws/:id', async (req, res) => {
  const draw = await draws().findOneAndDelete({ id: req.params.id }, NO_ID);
  if (!draw) return res.status(404).json({ error: 'Tirage introuvable' });

  await events().updateOne({ id: draw.eventId, screenDrawId: draw.id }, { $set: { screenDrawId: null } });
  await logHistory(req, draw.eventId, 'annulation_tirage', `N°${draw.numero} — ${draw.nom}`);
  res.status(204).end();
});

// GET /api/tombola/events/:id/screen - état de l'écran de projection (sans téléphones)
router.get('/events/:id/screen', async (req, res) => {
  const event = await findEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable' });

  const winners = (await eventDraws(event.id)).map(d => ({ drawId: d.id, numero: d.numero, nom: d.nom }));
  res.json({
    nom: event.nom,
    totalTickets: event.totalTickets,
    current: winners.find(w => w.drawId === event.screenDrawId) || null,
    showWinners: event.screenShowWinners !== false,
    winners
  });
});

// PATCH /api/tombola/events/:id/screen - réglages de l'écran de projection
// ({ showWinners: boolean } : afficher ou masquer la liste des gagnants)
router.patch('/events/:id/screen', async (req, res) => {
  if (typeof req.body?.showWinners !== 'boolean') {
    return res.status(400).json({ error: 'showWinners doit valoir true ou false.' });
  }
  const updated = await events().findOneAndUpdate(
    { id: req.params.id },
    { $set: { screenShowWinners: req.body.showWinners } },
    { returnDocument: 'after', ...NO_ID }
  );
  if (!updated) return res.status(404).json({ error: 'Évènement introuvable' });
  res.json({ showWinners: updated.screenShowWinners });
});

module.exports = router;
