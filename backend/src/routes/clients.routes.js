const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID, isDuplicateKey, getSetting, setSetting } = require('../utils/db');
const { requireTab, requireAdmin, requireClientsSub, canSeeAmounts } = require('../utils/auth');
const { deleteThread, waitingByClient } = require('../utils/messaging');
const { getBaseUrl } = require('../utils/baseUrl');
const {
  ONLINE_MODE,
  MODES_SETTING,
  allModes,
  modeLabels,
  DEFAULT_TYPES,
  newId,
  formatNumero,
  parseNumero,
  freeNumero,
  nextProvisoire,
  normalizeEmail,
  logClient,
  sendTemporaryPassword,
  manualTemporaryPassword,
  newIdentifiant,
  linkPastPayments,
  SHOW_STRIPE_SETTING,
  showStripe,
  visibleVersements
} = require('../utils/clients');

// Onglet « Clients » de l'admin (gestionnaire) : fiches clients, groupes, types de
// versement, versements (offrandes, dons, cotisations…) et journal. Les clients voient
// leurs informations en lecture seule dans l'espace client (espaceClient.routes.js).

const router = asyncRouter();
const clients = () => col('clients');
const groupes = () => col('client_groups');
const versements = () => col('client_versements');
const history = () => col('client_history');
// E-mails envoyés par l'Église à un paroissien (onglet « Messages envoyés » de la fiche).
const emails = () => col('client_emails');
const canManage = requireTab('clients');
router.use(canManage);
// Droits par sous-onglet (l'onglet seul, sans détail, donne tout) :
const fiches = requireClientsSub('paroissiens');
const lireFiche = requireClientsSub('paroissiens', 'quetes', 'situation', 'votes');
const lireQuetes = requireClientsSub('paroissiens', 'quetes', 'situation', 'rapports');
const groupesTypes = requireClientsSub('groupes');
const journal = requireClientsSub('journal');

const TYPES_SETTING = 'client-versement-types';
// Postes attribuables dans un groupe (Directeur du groupe SLK…) : liste réglable.
const POSTES_SETTING = 'client-postes';
const DEFAULT_POSTES = ['Directeur', 'Président', 'Vice-président', 'Secrétaire', 'Trésorier', 'Responsable'];
const MAX_CENTS = 10_000_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH_NAMES = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

function siteUrl(req) {
  return (process.env.SITE_URL || process.env.PUBLIC_BASE_URL || getBaseUrl(req)).replace(/\/+$/, '');
}

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(cents) {
  return `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

const SEXES = { H: 'Homme', F: 'Femme' };
const NO_ACCESS = 'Sans e-mail, le mot de passe ne peut pas être envoyé : créez-le dans la fiche (« Mot de passe à remettre ») et transmettez-le avec l’identifiant.';

// Fiche renvoyée à l'admin (jamais le mot de passe).
function adminClient(client) {
  const { _id, passwordHash, passwordVersion, ...rest } = client;
  return {
    ...rest,
    numero: client.numero || null,
    email: client.email || '',
    sexe: client.sexe || null,
    conjointId: client.conjointId || null,
    parentIds: client.parentIds || [],
    postes: client.postes || [],
    admin: !!client.admin,
    numeroLabel: formatNumero(client.numero),
    hasPassword: !!passwordHash
  };
}

function fullName(client) {
  return `${client.prenom} ${client.nom}`;
}

// Envoi du mot de passe par e-mail : n° client et adresse e-mail. Sans e-mail, l'espace
// reste possible avec l'identifiant à 8 chiffres et un mot de passe remis à la main.
function hasAccess(client) {
  return !!(client.numero && client.email);
}

async function personNames(ids) {
  const list = ids.length ? await clients().find({ id: { $in: ids } }, NO_ID).toArray() : [];
  return new Map(list.map(c => [c.id, fullName(c)]));
}

async function types() {
  return getSetting(TYPES_SETTING, DEFAULT_TYPES);
}

async function groupNames() {
  const list = await groupes().find({}, NO_ID).toArray();
  return new Map(list.map(g => [g.id, g.name]));
}

// selfId : fiche modifiée (null pour une création).
async function parseClient(body, selfId = null) {
  const nom = text(body.nom, 80);
  const prenom = text(body.prenom, 80);
  const email = normalizeEmail(body.email).slice(0, 160);
  if (!nom) return { error: 'Le nom est obligatoire.' };
  if (!prenom) return { error: 'Le prénom est obligatoire.' };
  if (email && !EMAIL_RE.test(email)) return { error: 'Adresse e-mail invalide.' };
  const numero = parseNumero(body.numero);
  if (numero === undefined) return { error: 'Le n° paroissien ne contient que des chiffres (ex. 0012), et ne peut pas être 0.' };
  const sexe = ['H', 'F'].includes(body.sexe) ? body.sexe : null;

  // Famille. Une fiche sans n° client est celle d'un enfant : elle a jusqu'à deux parents,
  // pas de conjoint. Une fiche avec n° (adulte) a un conjoint, pas de parents.
  const conjointId = numero && body.conjointId ? String(body.conjointId) : null;
  const parentIds = numero ? [] : [...new Set((Array.isArray(body.parentIds) ? body.parentIds : []).filter(Boolean).map(String))];
  if (parentIds.length > 2) return { error: 'Deux parents au maximum.' };
  if (selfId && (conjointId === selfId || parentIds.includes(selfId))) return { error: 'Une personne ne peut pas être liée à elle-même.' };
  if (conjointId && parentIds.includes(conjointId)) return { error: 'Le conjoint ne peut pas être aussi un parent.' };
  const linked = [...new Set([conjointId, ...parentIds].filter(Boolean))];
  if (linked.length) {
    const found = await clients().find({ id: { $in: linked } }, NO_ID).toArray();
    if (found.length !== linked.length) return { error: 'Une personne liée est introuvable (fiche supprimée ?).' };
    if (found.some(c => !c.numero)) return { error: 'Le conjoint et les parents doivent être des paroissiens avec un n° (pas des membres rattachés).' };
    if (selfId && found.some(c => (c.parentIds || []).includes(selfId))) {
      return { error: 'Un enfant de cette personne ne peut pas être son conjoint ou son parent.' };
    }
  }

  const known = await groupNames();
  const groupIds = [...new Set(Array.isArray(body.groupes) ? body.groupes.map(String) : [])].filter(id => known.has(id));

  // Postes (« Directeur » du groupe SLK…) : pour les paroissiens avec un n° seulement.
  const allowed = await getSetting(POSTES_SETTING, DEFAULT_POSTES);
  const seen = new Set();
  const postes = numero
    ? (Array.isArray(body.postes) ? body.postes : [])
        .map(p => ({ poste: text(p?.poste, 40), groupId: String(p?.groupId || '') }))
        .filter(p => p.poste && known.has(p.groupId))
        .map(p => ({ ...p, poste: allowed.find(a => a.toLowerCase() === p.poste.toLowerCase()) || p.poste }))
        .filter(p => !seen.has(`${p.poste}|${p.groupId}`) && seen.add(`${p.poste}|${p.groupId}`))
        .slice(0, 10)
    : [];
  for (const p of postes) if (!groupIds.includes(p.groupId)) groupIds.push(p.groupId);
  return {
    value: {
      numero,
      nom,
      prenom,
      sexe,
      email: email || null,
      conjointId,
      parentIds,
      telephone: text(body.telephone, 30),
      adresse: text(body.adresse, 200),
      notes: String(body.notes ?? '').trim().slice(0, 1000),
      groupes: groupIds,
      postes,
      // Label « Admin » : prévenu par e-mail quand un paroissien écrit à l'Église (avec un n° seulement).
      admin: !!numero && body.admin === true,
      active: body.active !== false
    }
  };
}

function toCents(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

async function parseVersement(body, client, { stripe = false, currentMode = null } = {}) {
  const type = text(body.type, 60);
  if (!type) return { error: 'Choisissez le type de quête.' };
  const groupId = body.groupId ? String(body.groupId) : null;
  if (groupId && !client.groupes.includes(groupId)) return { error: 'Ce paroissien ne fait pas partie de ce groupe.' };
  const note = String(body.note ?? '').trim().slice(0, 300);
  // Paiement en ligne : la date, le montant et le moyen viennent de Stripe.
  if (stripe) return { value: { type, groupId, note } };

  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { error: 'Date invalide.' };
  const amount = toCents(body.amount);
  if (!(amount > 0 && amount <= MAX_CENTS)) return { error: 'Montant invalide (entre 0,01 € et 100 000 €).' };
  // Type de paiement proposé, ou celui déjà enregistré sur le versement modifié.
  const active = (await allModes()).filter(m => !m.removed).map(m => m.key);
  const mode = body.mode && (active.includes(body.mode) || body.mode === currentMode) ? body.mode : active[0];
  if (!mode) return { error: 'Aucun type de paiement : ajoutez-en un dans « Groupes et types ».' };
  return { value: { date, amount, type, mode, groupId, note } };
}

// Sans le droit « Voir les montants » : aucune somme n'est envoyée. Une quête garde
// seulement « payé » (1 centime) pour que les mois payés / non payés restent justes, et
// les sommes écrites dans le journal sont masquées.
function maskVersement(v) {
  return { ...v, amount: v.amount > 0 ? 1 : 0, amountHidden: true };
}

function maskText(text) {
  return String(text || '').replace(/-?\d[\d\s\u00a0\u202f.,]*\s?€/g, '••• €');
}

function forAmounts(req, list) {
  return canSeeAmounts(req.user) ? list : list.map(maskVersement);
}

function forHistory(req, list) {
  return canSeeAmounts(req.user) ? list : list.map(h => ({ ...h, detail: maskText(h.detail) }));
}

function describeVersement(v, labels) {
  return `${v.date} — ${v.type} — ${money(v.amount)} (${labels[v.mode] || v.mode})`;
}

function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Liste des changements lisible pour le journal.
function changesOf(before, after, labels) {
  return Object.entries(labels)
    .filter(([key]) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))
    .map(([key, label]) => `${label} : « ${before[key] ?? ''} » → « ${after[key] ?? ''} »`);
}

// N° client ou e-mail déjà pris par une autre fiche : message d'erreur, sinon null.
async function conflictOf(value, selfId = null) {
  const notSelf = selfId ? { id: { $ne: selfId } } : {};
  if (value.numero) {
    const other = await clients().findOne({ numero: value.numero, ...notSelf }, NO_ID);
    if (other) return `Le n° paroissien ${value.numero} est déjà attribué à ${fullName(other)}.`;
  }
  // L'e-mail peut être partagé par plusieurs paroissiens (chacun a son identifiant).
  return null;
}

// Le lien de conjoint est réciproque : rattacher A à B rattache B à A, et détache les
// anciens conjoints de l'un et de l'autre.
async function syncConjoint(client, previousId, user) {
  const nextId = client.conjointId || null;
  if (previousId === nextId) return;
  const detach = async (person, from) => {
    await clients().updateOne({ id: person.id }, { $set: { conjointId: null } });
    await logClient(person, user, 'Conjoint détaché', fullName(from));
  };
  if (previousId) {
    const old = await clients().findOne({ id: previousId, conjointId: client.id }, NO_ID);
    if (old) await detach(old, client);
  }
  if (!nextId) return;
  const partner = await clients().findOne({ id: nextId }, NO_ID);
  if (!partner || partner.conjointId === client.id) return;
  if (partner.conjointId) {
    const former = await clients().findOne({ id: partner.conjointId, conjointId: partner.id }, NO_ID);
    if (former) await detach(former, partner);
  }
  await clients().updateOne({ id: partner.id }, { $set: { conjointId: client.id } });
  await logClient(partner, user, 'Conjoint rattaché', fullName(client));
}

// ---------- Groupes ----------

router.get('/groupes', async (req, res) => {
  res.json(await groupes().find({}, NO_ID).sort({ name: 1 }).toArray());
});

router.post('/groupes', groupesTypes, async (req, res) => {
  const name = text(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: 'Le nom du groupe est obligatoire.' });
  if (await groupes().findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } })) {
    return res.status(409).json({ error: 'Ce groupe existe déjà.' });
  }
  const groupe = { id: newId('groupe'), name, description: text(req.body?.description, 200), createdAt: new Date().toISOString() };
  await groupes().insertOne({ ...groupe });
  await logClient(null, req.user.username, 'Groupe créé', name);
  res.status(201).json(groupe);
});

router.put('/groupes/:id', groupesTypes, async (req, res) => {
  const current = await groupes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Groupe introuvable.' });
  const name = text(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: 'Le nom du groupe est obligatoire.' });
  const description = text(req.body?.description, 200);
  await groupes().updateOne({ id: current.id }, { $set: { name, description } });
  if (name !== current.name) await logClient(null, req.user.username, 'Groupe renommé', `${current.name} → ${name}`);
  res.json({ ...current, name, description });
});

router.delete('/groupes/:id', groupesTypes, async (req, res) => {
  const current = await groupes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Groupe introuvable.' });
  await groupes().deleteOne({ id: current.id });
  // Les clients quittent le groupe ; les versements gardent leur montant, sans groupe.
  const { modifiedCount } = await clients().updateMany({ groupes: current.id }, { $pull: { groupes: current.id, postes: { groupId: current.id } } });
  await versements().updateMany({ groupId: current.id }, { $set: { groupId: null, groupName: current.name } });
  await logClient(null, req.user.username, 'Groupe supprimé', `${current.name} (${modifiedCount} paroissien(s) retiré(s) du groupe)`);
  res.status(204).end();
});

// POST /api/clients/groupes/:id/membres  { clientIds } - ajoute des personnes au groupe.
router.post('/groupes/:id/membres', groupesTypes, async (req, res) => {
  const groupe = await groupes().findOne({ id: req.params.id }, NO_ID);
  if (!groupe) return res.status(404).json({ error: 'Groupe introuvable.' });
  const ids = [...new Set((Array.isArray(req.body?.clientIds) ? req.body.clientIds : []).map(String))].slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'Choisissez au moins une personne.' });
  const list = await clients().find({ id: { $in: ids }, groupes: { $ne: groupe.id } }, NO_ID).toArray();
  if (list.length) await clients().updateMany({ id: { $in: list.map(c => c.id) } }, { $addToSet: { groupes: groupe.id } });
  for (const client of list) await logClient(client, req.user.username, 'Ajouté au groupe', groupe.name);
  res.json({ added: list.length });
});

// DELETE /api/clients/groupes/:id/membres/:clientId - retire une personne du groupe.
// Ses versements déjà faits pour ce groupe sont conservés.
router.delete('/groupes/:id/membres/:clientId', groupesTypes, async (req, res) => {
  const groupe = await groupes().findOne({ id: req.params.id }, NO_ID);
  if (!groupe) return res.status(404).json({ error: 'Groupe introuvable.' });
  const client = await clients().findOne({ id: req.params.clientId, groupes: groupe.id }, NO_ID);
  if (!client) return res.status(404).json({ error: 'Cette personne ne fait pas partie du groupe.' });
  await clients().updateOne({ id: client.id }, { $pull: { groupes: groupe.id, postes: { groupId: groupe.id } } });
  await logClient(client, req.user.username, 'Retiré du groupe', groupe.name);
  res.status(204).end();
});

// ---------- Types de versement ----------

router.get('/types', async (req, res) => {
  // Paiements en ligne cachés : le type « Paiement en ligne » n'est plus proposé.
  const online = await showStripe();
  const all = await allModes();
  const modes = all.filter(m => !m.removed && (online || m.key !== ONLINE_MODE)).map(({ key, label }) => ({ key, label }));
  res.json({ types: await types(), modes, allModes: all });
});

// POST /api/clients/modes  { label } - ajoute un type de paiement (ou réactive un supprimé).
router.post('/modes', groupesTypes, async (req, res) => {
  const label = text(req.body?.label, 40);
  const base = slugify(label);
  if (!label || !base) return res.status(400).json({ error: 'Indiquez le nom du type de paiement.' });
  const list = await allModes();
  const same = list.find(m => m.label.toLowerCase() === label.toLowerCase());
  if (same && !same.removed) return res.status(409).json({ error: 'Ce type de paiement existe déjà.' });
  let next;
  if (same) {
    next = list.map(m => (m === same ? { key: m.key, label } : m));
  } else {
    let key = base;
    for (let i = 2; list.some(m => m.key === key); i++) key = `${base}-${i}`;
    next = [...list, { key, label }];
  }
  await setSetting(MODES_SETTING, next);
  await logClient(null, req.user.username, 'Type de paiement ajouté', label);
  res.status(201).json({ allModes: next });
});

// DELETE /api/clients/modes/:key - n'est plus proposé ; les anciens versements le gardent.
router.delete('/modes/:key', groupesTypes, async (req, res) => {
  const list = await allModes();
  const mode = list.find(m => m.key === req.params.key && !m.removed);
  if (!mode) return res.status(404).json({ error: 'Type de paiement introuvable.' });
  if (mode.key === ONLINE_MODE) return res.status(400).json({ error: 'Le paiement en ligne ne peut pas être supprimé (il vient de Stripe).' });
  if (list.filter(m => !m.removed && m.key !== ONLINE_MODE).length <= 1) {
    return res.status(400).json({ error: 'Gardez au moins un type de paiement.' });
  }
  const next = list.map(m => (m === mode ? { ...m, removed: true } : m));
  await setSetting(MODES_SETTING, next);
  await logClient(null, req.user.username, 'Type de paiement supprimé', mode.label);
  res.json({ allModes: next });
});

router.get('/postes', async (req, res) => {
  res.json({ postes: await getSetting(POSTES_SETTING, DEFAULT_POSTES) });
});

// PUT /api/clients/postes  { postes } - liste des postes proposés (les postes déjà attribués restent).
router.put('/postes', groupesTypes, async (req, res) => {
  const list = [...new Set((Array.isArray(req.body?.postes) ? req.body.postes : []).map(t => text(t, 40)).filter(Boolean))].slice(0, 30);
  if (!list.length) return res.status(400).json({ error: 'Gardez au moins un poste.' });
  await setSetting(POSTES_SETTING, list);
  await logClient(null, req.user.username, 'Postes modifiés', list.join(', '));
  res.json({ postes: list });
});

router.put('/types', groupesTypes, async (req, res) => {
  const list = [...new Set((Array.isArray(req.body?.types) ? req.body.types : []).map(t => text(t, 60)).filter(Boolean))].slice(0, 30);
  if (!list.length) return res.status(400).json({ error: 'Gardez au moins un type de quête.' });
  await setSetting(TYPES_SETTING, list);
  await logClient(null, req.user.username, 'Types de quête modifiés', list.join(', '));
  res.json({ types: list });
});

// ---------- Versements (tous clients) et journal ----------

// GET /api/clients/versements?year=2026 - pour les rapports par mois, type et groupe ;
// year=tous : tous les versements (export de la liste des clients).
router.get('/versements', lireQuetes, async (req, res) => {
  const all = req.query.year === 'tous';
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : String(new Date().getFullYear());
  const period = all ? {} : { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } };
  const list = await versements()
    .find({ ...period, ...(await visibleVersements()) }, NO_ID)
    .sort({ date: -1 })
    .toArray();
  res.json(forAmounts(req, list));
});

router.put('/versements/:id', fiches, async (req, res) => {
  const current = await versements().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Quête introuvable.' });
  const client = await clients().findOne({ id: current.clientId });
  if (!client) return res.status(404).json({ error: 'Paroissien introuvable.' });
  // Sans le droit de voir les montants, on ne peut pas changer le montant (il est gardé).
  const body = canSeeAmounts(req.user) ? req.body || {} : { ...(req.body || {}), amount: current.amount / 100 };
  const parsed = await parseVersement(body, client, { stripe: current.source === 'stripe', currentMode: current.mode });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const update = { ...parsed.value, updatedAt: new Date().toISOString(), updatedBy: req.user.username };
  await versements().updateOne({ id: current.id }, { $set: update });
  const after = { ...current, ...update };
  const labels = await modeLabels();
  await logClient(client, req.user.username, 'Quête modifiée', `${describeVersement(current, labels)} → ${describeVersement(after, labels)}`);
  res.json(forAmounts(req, [after])[0]);
});

router.delete('/versements/:id', fiches, async (req, res) => {
  const current = await versements().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Quête introuvable.' });
  await versements().deleteOne({ id: current.id });
  const client = await clients().findOne({ id: current.clientId });
  await logClient(client, req.user.username, 'Quête supprimée', describeVersement(current, await modeLabels()));
  res.status(204).end();
});

router.get('/historique', journal, async (req, res) => {
  res.json(forHistory(req, await history().find({}, NO_ID).sort({ at: -1 }).limit(500).toArray()));
});

// ---------- Réglages (superadmin) ----------

router.get('/reglages', async (req, res) => {
  res.json({ showStripe: await showStripe() });
});

router.put('/reglages', requireAdmin, async (req, res) => {
  if (typeof req.body?.showStripe !== 'boolean') return res.status(400).json({ error: 'Valeur « showStripe » manquante.' });
  await setSetting(SHOW_STRIPE_SETTING, req.body.showStripe);
  await logClient(
    null,
    req.user.username,
    req.body.showStripe ? 'Paiements en ligne affichés' : 'Paiements en ligne cachés',
    'Quêtes venant de Stripe dans les fiches et l’espace paroissien'
  );
  res.json({ showStripe: req.body.showStripe });
});

// ---------- Clients ----------

router.get('/', async (req, res) => {
  const year = String(new Date().getFullYear());
  const [list, totals] = await Promise.all([
    clients().find({}, NO_ID).sort({ numero: 1, nom: 1, prenom: 1 }).toArray(),
    versements()
      .aggregate([
        { $match: await visibleVersements() },
        {
          $group: {
            _id: '$clientId',
            total: { $sum: '$amount' },
            year: { $sum: { $cond: [{ $eq: [{ $substrBytes: ['$date', 0, 4] }, year] }, '$amount', 0] } },
            count: { $sum: 1 },
            last: { $max: '$date' }
          }
        }
      ])
      .toArray()
  ]);
  const byClient = new Map(totals.map(t => [t._id, t]));
  // Réponses de paroissiens pas encore lues dans l'admin (messages individuels).
  const unread = await col('message_threads')
    .aggregate([{ $match: { kind: 'individuel', adminUnread: true } }, { $group: { _id: '$clientId', n: { $sum: 1 } } }])
    .toArray();
  const unreadOf = new Map(unread.map(u => [u._id, u.n]));
  // Messages de l'Église pas encore lus par le paroissien.
  const waitingOf = await waitingByClient();
  // Les fiches avec un n° d'abord, puis celles sans n° (classées par nom).
  list.sort((a, b) => (a.numero ? 0 : 1) - (b.numero ? 0 : 1));
  // Sans le droit « Voir les montants » : pas de totaux en euros dans la liste.
  const amounts = canSeeAmounts(req.user);
  res.json(
    list.map(c => {
      const t = byClient.get(c.id);
      return {
        ...adminClient(c),
        messagesNonLus: unreadOf.get(c.id) || 0,
        messagesEnAttente: waitingOf.get(c.id) || 0,
        totals: { total: amounts ? t?.total || 0 : null, year: amounts ? t?.year || 0 : null, count: t?.count || 0, last: t?.last || null }
      };
    })
  );
});

// GET /api/clients/numero-libre - n° proposé à l'admin (le plus grand + 1).
router.get('/numero-libre', fiches, async (req, res) => {
  res.json({ numero: await freeNumero() });
});

router.post('/', fiches, async (req, res) => {
  const parsed = await parseClient(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const conflict = await conflictOf(parsed.value);
  if (conflict) return res.status(409).json({ error: conflict });
  const now = new Date().toISOString();
  const client = {
    id: newId('client'),
    ...parsed.value,
    // Sans n° définitif : un ID provisoire (P0001…), qui ne donne aucun droit.
    provisoire: parsed.value.numero ? null : await nextProvisoire(),
    // Identifiant de connexion à 8 chiffres (paroissiens avec un n°).
    identifiant: parsed.value.numero ? await newIdentifiant() : null,
    passwordHash: null,
    passwordVersion: 0,
    mustChangePassword: true,
    createdAt: now,
    createdBy: req.user.username,
    updatedAt: now
  };
  try {
    await clients().insertOne({ ...client });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Ce n° paroissien ou cette adresse e-mail est déjà utilisé.' });
    throw err;
  }
  const detail = [fullName(client), client.numero ? `n° ${client.numero}` : 'sans n° paroissien', client.email].filter(Boolean).join(' — ');
  await logClient(client, req.user.username, 'Fiche créée', detail);
  await syncConjoint(client, null, req.user.username);
  for (const parent of await clients().find({ id: { $in: client.parentIds } }, NO_ID).toArray()) {
    await logClient(parent, req.user.username, 'Enfant rattaché', fullName(client));
  }
  const linked = await linkPastPayments(client);
  let mail = null;
  if (req.body?.sendPassword) {
    mail = hasAccess(client)
      ? await sendTemporaryPassword(client, `${siteUrl(req)}/espace-client`, req.user.username)
      : { sent: false, error: NO_ACCESS };
  }
  res.status(201).json({ ...adminClient(client), linkedPayments: linked, mail });
});

router.get('/:id', lireFiche, async (req, res) => {
  const client = await clients().findOne({ id: req.params.id }, NO_ID);
  if (!client) return res.status(404).json({ error: 'Paroissien introuvable.' });
  const [list, log, sent] = await Promise.all([
    versements().find({ clientId: client.id, ...(await visibleVersements()) }, NO_ID).sort({ date: -1, createdAt: -1 }).toArray(),
    history().find({ clientId: client.id }, NO_ID).sort({ at: -1 }).limit(300).toArray(),
    emails().find({ clientId: client.id }, NO_ID).sort({ sentAt: -1 }).limit(200).toArray()
  ]);
  res.json({ client: adminClient(client), versements: forAmounts(req, list), history: forHistory(req, log), emails: sent });
});

router.put('/:id', fiches, async (req, res) => {
  const current = await clients().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Paroissien introuvable.' });
  const parsed = await parseClient(req.body || {}, current.id);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const conflict = await conflictOf(parsed.value, current.id);
  if (conflict) return res.status(409).json({ error: conflict });
  // Un enfant peut devenir client (avec n°), mais un client ne redevient jamais enfant.
  if (current.numero && !parsed.value.numero) {
    return res.status(400).json({ error: 'Un paroissien avec n° ne peut pas redevenir membre rattaché : gardez-lui son n° paroissien.' });
  }

  const names = await groupNames();
  const label = ids => ids.map(id => names.get(id) || '?').join(', ');
  const people = await personNames([current.conjointId, parsed.value.conjointId, ...(current.parentIds || []), ...parsed.value.parentIds].filter(Boolean));
  const shown = c => ({
    ...c,
    sexe: SEXES[c.sexe] || '',
    conjoint: c.conjointId ? people.get(c.conjointId) || '?' : '',
    parents: (c.parentIds || []).map(id => people.get(id) || '?').join(', ')
  });
  const changes = changesOf(shown(current), shown(parsed.value), {
    numero: 'N° paroissien',
    nom: 'Nom',
    prenom: 'Prénom',
    sexe: 'Sexe',
    email: 'E-mail',
    telephone: 'Téléphone',
    adresse: 'Adresse',
    conjoint: 'Conjoint',
    parents: 'Parents',
    notes: 'Notes'
  });
  if (JSON.stringify([...current.groupes].sort()) !== JSON.stringify([...parsed.value.groupes].sort())) {
    changes.push(`Groupes : « ${label(current.groupes)} » → « ${label(parsed.value.groupes)} »`);
  }
  if (current.active !== parsed.value.active) changes.push(parsed.value.active ? 'Compte réactivé' : 'Compte désactivé');
  if (!!current.admin !== parsed.value.admin) changes.push(parsed.value.admin ? 'Label Admin ajouté' : 'Label Admin retiré');
  const posteLabel = list => (list || []).map(p => `${p.poste} ${names.get(p.groupId) || '?'}`).join(', ');
  if (posteLabel(current.postes) !== posteLabel(parsed.value.postes)) {
    changes.push(`Postes : « ${posteLabel(current.postes)} » → « ${posteLabel(parsed.value.postes)} »`);
  }

  const update = { ...parsed.value, updatedAt: new Date().toISOString() };
  // Passage de l'ID provisoire au n° définitif : l'ID provisoire est gardé en mémoire.
  const promoted = !current.numero && !!parsed.value.numero;
  if (promoted) {
    Object.assign(update, { provisoire: null, ancienProvisoire: current.provisoire || null });
    if (!current.identifiant) update.identifiant = await newIdentifiant();
    changes.push(`ID provisoire ${current.provisoire || '—'} remplacé par le n° ${parsed.value.numero} (devenu paroissien)`);
  }
  // Compte désactivé : les sessions ouvertes du client sont fermées.
  const inc = current.active !== false && !parsed.value.active ? { $inc: { passwordVersion: 1 } } : {};
  try {
    await clients().updateOne({ id: current.id }, { $set: update, ...inc });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Ce n° paroissien ou cette adresse e-mail est déjà utilisé.' });
    throw err;
  }
  const updated = { ...current, ...update };
  if (promoted) {
    // Toutes les actions faites sous l'ID provisoire passent sous le n° définitif (les quêtes,
    // e-mails et votes sont déjà liés à la fiche elle-même).
    const { modifiedCount } = await history().updateMany(
      { clientId: current.id, numero: { $in: [current.provisoire || null, null] } },
      { $set: { numero: parsed.value.numero, ancienProvisoire: current.provisoire || null } }
    );
    const quetes = await versements().countDocuments({ clientId: current.id });
    await logClient(
      updated,
      req.user.username,
      'ID provisoire migré',
      `${current.provisoire || 'Sans ID'} → n° ${parsed.value.numero} : ${modifiedCount} action(s) de l’historique et ${quetes} quête(s) reprises`
    );
  }
  if (changes.length) await logClient(updated, req.user.username, 'Fiche modifiée', changes.join(' ; '));
  await syncConjoint(updated, current.conjointId || null, req.user.username);
  const linked = current.email !== updated.email ? await linkPastPayments(updated) : 0;
  res.json({ ...adminClient(updated), linkedPayments: linked });
});

// Suppression d'une fiche et de ses versements : superadmin seulement.
router.delete('/:id', requireAdmin, async (req, res) => {
  const current = await clients().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Paroissien introuvable.' });
  const { deletedCount } = await versements().deleteMany({ clientId: current.id });
  await emails().deleteMany({ clientId: current.id });
  for (const t of await col('message_threads').find({ kind: 'individuel', clientId: current.id }, NO_ID).toArray()) await deleteThread(t);
  await clients().deleteOne({ id: current.id });
  // Le conjoint et les enfants restent, sans ce lien.
  await clients().updateMany({ conjointId: current.id }, { $set: { conjointId: null } });
  await clients().updateMany({ parentIds: current.id }, { $pull: { parentIds: current.id } });
  await logClient(current, req.user.username, 'Fiche supprimée', `${current.prenom} ${current.nom} — ${deletedCount} quête(s) supprimée(s)`);
  res.status(204).end();
});

// PUT /api/clients/:id/note  { notes } - note interne, modifiable d'un clic depuis la liste
// (jamais visible par le paroissien).
router.put('/:id/note', fiches, async (req, res) => {
  const client = await clients().findOne({ id: req.params.id }, NO_ID);
  if (!client) return res.status(404).json({ error: 'Paroissien introuvable.' });
  const notes = String(req.body?.notes ?? '').trim().slice(0, 1000);
  if (notes === (client.notes || '')) return res.json({ notes });
  await clients().updateOne({ id: client.id }, { $set: { notes, updatedAt: new Date().toISOString() } });
  await logClient(client, req.user.username, notes ? 'Note modifiée' : 'Note effacée', notes ? `« ${notes.slice(0, 200)}${notes.length > 200 ? '…' : ''} »` : '');
  res.json({ notes });
});

// POST /api/clients/:id/mot-de-passe - envoie un mot de passe provisoire au client (premier
// envoi, ou réinitialisation s'il en avait déjà un).
router.post('/:id/mot-de-passe', fiches, async (req, res) => {
  const client = await clients().findOne({ id: req.params.id }, NO_ID);
  if (!client) return res.status(404).json({ error: 'Paroissien introuvable.' });
  if (client.active === false) return res.status(400).json({ error: 'Le compte est désactivé : réactivez-le d’abord.' });
  if (!client.numero) return res.status(400).json({ error: 'Donnez d’abord un n° paroissien à cette personne : sans n° paroissien, pas d’espace paroissien.' });
  if (!client.email) return res.status(400).json({ error: 'Ajoutez d’abord une adresse e-mail : le mot de passe est envoyé par e-mail.' });
  const result = await sendTemporaryPassword(client, `${siteUrl(req)}/espace-client`, req.user.username);
  if (!result.sent) return res.status(502).json({ error: result.error });
  res.json({ sent: true, reset: result.reset, to: client.email });
});

// POST /api/clients/:id/mot-de-passe-manuel - crée un mot de passe provisoire renvoyé à
// l'admin (pas d'e-mail), qui le transmet à la main avec l'identifiant de connexion.
router.post('/:id/mot-de-passe-manuel', fiches, async (req, res) => {
  const client = await clients().findOne({ id: req.params.id }, NO_ID);
  if (!client) return res.status(404).json({ error: 'Paroissien introuvable.' });
  if (client.active === false) return res.status(400).json({ error: 'Le compte est désactivé : réactivez-le d’abord.' });
  if (!client.numero) return res.status(400).json({ error: 'Donnez d’abord un n° paroissien à cette personne : sans n° paroissien, pas d’espace paroissien.' });
  res.json(await manualTemporaryPassword(client, req.user.username));
});

router.post('/:id/versements', fiches, async (req, res) => {
  const client = await clients().findOne({ id: req.params.id }, NO_ID);
  if (!client) return res.status(404).json({ error: 'Paroissien introuvable.' });
  const parsed = await parseVersement(req.body || {}, client);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const versement = {
    id: newId('versement'),
    clientId: client.id,
    ...parsed.value,
    source: 'manuel',
    paymentId: null,
    createdAt: new Date().toISOString(),
    createdBy: req.user.username
  };
  await versements().insertOne({ ...versement });
  await logClient(client, req.user.username, 'Quête ajoutée', describeVersement(versement, await modeLabels()));
  res.status(201).json(forAmounts(req, [versement])[0]);
});

// POST /api/clients/:id/versements/mois - saisie d'une année mois par mois.
// { year, day, type, mode, groupId, note, amounts: { '01': 20, '02': 15.5, … } }
// Un versement est créé pour chaque mois rempli.
router.post('/:id/versements/mois', fiches, async (req, res) => {
  const client = await clients().findOne({ id: req.params.id }, NO_ID);
  if (!client) return res.status(404).json({ error: 'Paroissien introuvable.' });
  const year = Number(req.body?.year);
  if (!(Number.isInteger(year) && year >= 2000 && year <= 2100)) return res.status(400).json({ error: 'Année invalide.' });
  const day = Math.min(Math.max(parseInt(req.body?.day, 10) || 1, 1), 31);
  const amounts = req.body?.amounts && typeof req.body.amounts === 'object' ? req.body.amounts : {};

  const items = [];
  for (let month = 1; month <= 12; month++) {
    const key = String(month).padStart(2, '0');
    const raw = amounts[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    // Jour ramené à la fin du mois (31 -> 28/29 en février, 30 en avril…).
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const date = `${year}-${key}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
    const parsed = await parseVersement({ ...req.body, date, amount: raw }, client);
    if (parsed.error) return res.status(400).json({ error: `${MONTH_NAMES[month - 1]} : ${parsed.error}` });
    items.push(parsed.value);
  }
  if (!items.length) return res.status(400).json({ error: 'Indiquez au moins un montant.' });

  const now = new Date().toISOString();
  const created = items.map(value => ({
    id: newId('versement'),
    clientId: client.id,
    ...value,
    source: 'manuel',
    paymentId: null,
    createdAt: now,
    createdBy: req.user.username
  }));
  await versements().insertMany(created.map(v => ({ ...v })));
  const total = created.reduce((sum, v) => sum + v.amount, 0);
  await logClient(
    client,
    req.user.username,
    'Quêtes saisies par mois',
    `${year} — ${created[0].type} (${(await modeLabels())[created[0].mode] || created[0].mode}) : ${created.map(v => `${MONTH_NAMES[Number(v.date.slice(5, 7)) - 1]} ${money(v.amount)}`).join(', ')} — total ${money(total)}`
  );
  res.status(201).json({ created: created.length, total: canSeeAmounts(req.user) ? total : null });
});

module.exports = router;
