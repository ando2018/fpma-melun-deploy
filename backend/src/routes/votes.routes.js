const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID } = require('../utils/db');
const { requireTab, requireClientsSub } = require('../utils/auth');
const { newId, logClient } = require('../utils/clients');
const { isSpecial, newMatchNumber, matchNumberOf } = require('../utils/votes');

// Votes des groupes (onglet « Groupes et votes » de l'admin). Un vote appartient à un
// groupe : question Oui / Non, élection d'une personne (une seule) ou de plusieurs, ou avis
// sur chaque personne d'une liste (réponses définies par l'admin : Oui, Non, Peut-être…). Les
// paroissiens votent dans leur espace (espaceClient.routes.js), une seule fois. Le vote est
// secret : on garde qui a voté (vote_participations) mais jamais son choix, seulement les
// totaux (counts). Les paroissiens voient les résultats quand l'admin les publie.
//
// Statuts : brouillon (modifiable) → ouvert (on vote) → clos → résultats publiés.
//
// Accès : « normal » (paroissiens connectés à leur espace, choisis parmi les présents) ou
// « spécial » (vote rapide, sans identifiant : code générique choisi par l'admin, nombre
// annoncé dans la salle à choisir parmi trois, puis le nom ; voir voteRapide.routes.js).

const router = asyncRouter();
const votes = () => col('votes');
const participations = () => col('vote_participations');
const clients = () => col('clients');
router.use(requireTab('clients'), requireClientsSub('votes'));

const KINDS = ['oui-non', 'unique', 'multiple', 'avis'];
const DEFAULT_ANSWERS = ['Oui', 'Non'];
const YES_NO = [
  { id: 'oui', label: 'Oui' },
  { id: 'non', label: 'Non' }
];

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Votants : les personnes présentes dans la salle, choisies par l'admin parmi les
// paroissiens qui ont un n° (donc un espace) et un compte actif.
async function eligibleIds(ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 2000);
  if (!wanted.length) return [];
  const list = await clients().find({ id: { $in: wanted }, numero: { $type: 'string' }, active: { $ne: false } }, { projection: { id: 1 } }).toArray();
  const found = new Set(list.map(c => c.id));
  return wanted.filter(id => found.has(id));
}

async function parseVote(body) {
  const group = await col('client_groups').findOne({ id: String(body.groupId || '') }, NO_ID);
  if (!group) return { error: 'Choisissez le groupe.' };
  const title = text(body.title, 120);
  if (!title) return { error: 'Le titre du vote est obligatoire.' };
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return { error: 'Choisissez le type de vote.' };
  let options = YES_NO;
  let maxChoices = 1;
  if (kind !== 'oui-non') {
    // Personnes à élire : membres du groupe (clientId) ou noms saisis.
    const seen = new Set();
    options = (Array.isArray(body.options) ? body.options : [])
      .map(o => ({ label: text(o?.label, 80), clientId: o?.clientId ? String(o.clientId) : null }))
      .filter(o => o.label && !seen.has(o.label.toLowerCase()) && seen.add(o.label.toLowerCase()))
      .slice(0, 50)
      .map((o, i) => ({ id: `c${i + 1}`, ...o }));
    if (kind !== 'avis' && options.length < 2) return { error: 'Ajoutez au moins deux personnes à élire.' };
    if (kind === 'avis' && !options.length) return { error: 'Ajoutez au moins une personne.' };
    if (kind === 'multiple') {
      const max = parseInt(body.maxChoices, 10);
      maxChoices = Number.isInteger(max) && max >= 1 ? Math.min(max, options.length) : options.length;
    }
  }
  // Avis : les réponses possibles pour chaque personne (2 à 6).
  let answers = [];
  if (kind === 'avis') {
    const seen = new Set();
    const labels = (Array.isArray(body.answers) && body.answers.length ? body.answers : DEFAULT_ANSWERS)
      .map(a => text(a, 30))
      .filter(a => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
    if (labels.length < 2) return { error: 'Indiquez au moins deux réponses possibles (ex. Oui, Non).' };
    answers = labels.slice(0, 6).map((label, i) => ({ id: `a${i + 1}`, label }));
  }
  // Vote spécial : pas de liste de présents, un code générique (4 à 8 chiffres).
  const access = body.access === 'special' ? 'special' : 'normal';
  const code = access === 'special' ? String(body.code ?? '').replace(/\s/g, '') : null;
  if (access === 'special' && !/^\d{4,8}$/.test(code)) return { error: 'Le code du vote spécial doit avoir de 4 à 8 chiffres.' };
  const presentIds = access === 'special' ? [] : await eligibleIds(body.presentIds);
  if (access === 'normal' && !presentIds.length) return { error: 'Sélectionnez les personnes présentes dans la salle de vote.' };
  return {
    value: { groupId: group.id, groupName: group.name, title, description: String(body.description ?? '').trim().slice(0, 1000), kind, maxChoices, options, answers, presentIds, access, code }
  };
}

function describe(vote) {
  return `${vote.title} (groupe ${vote.groupName})`;
}

// GET /api/votes?groupId=… - votes d'un groupe (ou de tous), avec participation et totaux.
// Vote spécial : le nombre à annoncer dans la salle, les noms des votants (jamais leur choix)
// et les personnes connectées à la page du vote rapide avec ce code (sessions en cours, une
// par nom), à comparer avec le nombre de personnes présentes dans la salle.
router.get('/', async (req, res) => {
  const filter = req.query.groupId ? { groupId: String(req.query.groupId) } : {};
  const list = await votes().find(filter, NO_ID).sort({ createdAt: -1 }).toArray();
  const special = list.filter(isSpecial);
  if (special.length) {
    const codes = await col('vote_codes').find({ code: { $in: [...new Set(special.map(v => v.code))] } }, NO_ID).toArray();
    const numberOf = new Map(codes.map(c => [c.code, c.number]));
    const names = await participations()
      .find({ voteId: { $in: special.map(v => v.id) } }, { projection: { _id: 0, voteId: 1, name: 1, at: 1 } })
      .sort({ at: 1 })
      .toArray();
    const live = await col('vote_sessions')
      .find({ code: { $in: [...numberOf.keys()] }, expiresAt: { $gt: new Date().toISOString() } }, { projection: { _id: 0, code: 1, name: 1, nameKey: 1, createdAt: 1 } })
      .sort({ createdAt: 1 })
      .toArray();
    const connectedOf = code => {
      const byName = new Map();
      for (const s of live) if (s.code === code && !byName.has(s.nameKey)) byName.set(s.nameKey, s.name);
      return [...byName.values()];
    };
    for (const v of special) {
      v.matchNumber = numberOf.get(v.code) ?? null;
      v.voterNames = names.filter(n => n.voteId === v.id).map(n => n.name);
      v.connectedNames = connectedOf(v.code);
    }
  }
  res.json(list);
});

// POST /api/votes/:id/nombre - nouveau nombre à annoncer (pour tous les votes de ce code) :
// ceux qui ont déjà ouvert leur session continuent, les nouveaux doivent choisir le nouveau.
router.post('/:id/nombre', async (req, res) => {
  const current = await votes().findOne({ id: req.params.id }, NO_ID);
  if (!current || !isSpecial(current)) return res.status(404).json({ error: 'Vote spécial introuvable.' });
  const match = await newMatchNumber(current.code);
  await logClient(null, req.user.username, 'Nombre du vote rapide changé', `code ${current.code}`);
  res.json({ code: current.code, matchNumber: match.number });
});

router.post('/', async (req, res) => {
  const parsed = await parseVote(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const vote = {
    id: newId('vote'),
    ...parsed.value,
    status: 'brouillon',
    published: false,
    electorate: [],
    counts: {},
    voters: 0,
    createdAt: new Date().toISOString(),
    createdBy: req.user.username
  };
  await votes().insertOne({ ...vote });
  await logClient(null, req.user.username, 'Vote créé', describe(vote));
  res.status(201).json(vote);
});

// Modifier : seulement tant que le vote n'est pas ouvert.
router.put('/:id', async (req, res) => {
  const current = await votes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Vote introuvable.' });
  if (current.status !== 'brouillon') return res.status(400).json({ error: 'Un vote ouvert ne peut plus être modifié.' });
  const parsed = await parseVote(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  await votes().updateOne({ id: current.id }, { $set: { ...parsed.value, updatedAt: new Date().toISOString() } });
  await logClient(null, req.user.username, 'Vote modifié', describe({ ...current, ...parsed.value }));
  res.json({ ...current, ...parsed.value });
});

// Ouvrir : les votants sont les personnes présentes (toujours avec un n° et un compte actif).
router.post('/:id/ouvrir', async (req, res) => {
  const current = await votes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Vote introuvable.' });
  if (current.status !== 'brouillon') return res.status(400).json({ error: 'Ce vote est déjà ouvert.' });
  const special = isSpecial(current);
  const electorate = special ? [] : await eligibleIds(current.presentIds);
  if (!special && !electorate.length) return res.status(400).json({ error: 'Aucun votant : sélectionnez les personnes présentes (avec un n° paroissien).' });
  const update = { status: 'ouvert', electorate, openedAt: new Date().toISOString(), openedBy: req.user.username };
  await votes().updateOne({ id: current.id }, { $set: update });
  const match = special ? await matchNumberOf(current.code, true) : null;
  await logClient(null, req.user.username, 'Vote ouvert', `${describe(current)} — ${special ? `vote rapide, code ${current.code}` : `${electorate.length} votant(s)`}`);
  res.json({ ...current, ...update, ...(match ? { matchNumber: match.number } : {}) });
});

// POST /api/votes/:id/presents  { clientIds } - personnes arrivées après l'ouverture : elles
// peuvent voter elles aussi (on ne retire personne d'un vote ouvert).
router.post('/:id/presents', async (req, res) => {
  const current = await votes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Vote introuvable.' });
  if (current.status !== 'ouvert') return res.status(400).json({ error: 'Le vote n’est pas ouvert.' });
  if (isSpecial(current)) return res.status(400).json({ error: 'Vote spécial : pas de liste de présents.' });
  const ids = (await eligibleIds(req.body?.clientIds)).filter(id => !current.electorate.includes(id));
  if (!ids.length) return res.status(400).json({ error: 'Choisissez au moins une personne présente (avec un n° paroissien).' });
  await votes().updateOne({ id: current.id }, { $addToSet: { electorate: { $each: ids }, presentIds: { $each: ids } } });
  await logClient(null, req.user.username, 'Présents ajoutés au vote', `${describe(current)} — ${ids.length} personne(s)`);
  res.json(await votes().findOne({ id: current.id }, NO_ID));
});

router.post('/:id/clore', async (req, res) => {
  const current = await votes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Vote introuvable.' });
  if (current.status !== 'ouvert') return res.status(400).json({ error: 'Ce vote n’est pas ouvert.' });
  const update = { status: 'clos', closedAt: new Date().toISOString(), closedBy: req.user.username };
  await votes().updateOne({ id: current.id }, { $set: update });
  const after = await votes().findOne({ id: current.id }, NO_ID);
  await logClient(null, req.user.username, 'Vote clos', `${describe(current)} — ${isSpecial(current) ? after.voters : `${after.voters}/${after.electorate.length}`} votant(s)`);
  res.json(after);
});

// Publier (ou retirer) les résultats pour les paroissiens. Un vote ouvert est d'abord clos.
router.post('/:id/publier', async (req, res) => {
  const current = await votes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Vote introuvable.' });
  if (current.status === 'brouillon') return res.status(400).json({ error: 'Ouvrez d’abord le vote.' });
  const publish = req.body?.published !== false;
  const now = new Date().toISOString();
  const update = publish
    ? { published: true, publishedAt: now, ...(current.status === 'ouvert' ? { status: 'clos', closedAt: now, closedBy: req.user.username } : {}) }
    : { published: false };
  await votes().updateOne({ id: current.id }, { $set: update });
  await logClient(null, req.user.username, publish ? 'Résultats du vote publiés' : 'Résultats du vote retirés', describe(current));
  res.json(await votes().findOne({ id: current.id }, NO_ID));
});

// Archiver (ou désarchiver) : le vote disparaît de l'espace des paroissiens, l'admin le garde
// dans ses archives. Un vote encore ouvert est d'abord clos.
router.post('/:id/archiver', async (req, res) => {
  const current = await votes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Vote introuvable.' });
  const archive = req.body?.archived !== false;
  const now = new Date().toISOString();
  const update = archive
    ? { archived: true, archivedAt: now, archivedBy: req.user.username, ...(current.status === 'ouvert' ? { status: 'clos', closedAt: now, closedBy: req.user.username } : {}) }
    : { archived: false };
  await votes().updateOne({ id: current.id }, { $set: update });
  await logClient(null, req.user.username, archive ? 'Vote archivé' : 'Vote désarchivé', describe(current));
  res.json(await votes().findOne({ id: current.id }, NO_ID));
});

router.delete('/:id', async (req, res) => {
  const current = await votes().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Vote introuvable.' });
  await votes().deleteOne({ id: current.id });
  await participations().deleteMany({ voteId: current.id });
  await logClient(null, req.user.username, 'Vote supprimé', `${describe(current)} — ${current.voters || 0} vote(s)`);
  res.status(204).end();
});

module.exports = router;
