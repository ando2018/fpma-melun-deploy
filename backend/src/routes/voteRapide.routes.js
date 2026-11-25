const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID } = require('../utils/db');
const { createSignedValue, verifySignedValue } = require('../utils/auth');
const { newId } = require('../utils/clients');
const { isSpecial, voteView, castBallot, matchNumberOf, nameKey } = require('../utils/votes');

// Vote rapide (page publique /vote-rapide), pour les votes « spéciaux » : sans identifiant.
// 1. le votant tape le code générique choisi par l'admin ;
// 2. trois nombres s'affichent : il choisit celui que l'admin annonce dans la salle ;
// 3. il donne son nom. Une session d'une journée est ouverte : il vote (une fois par vote et
//    par nom) dans tous les votes spéciaux de ce code, et voit les résultats publiés.

const router = asyncRouter();
const sessions = () => col('vote_sessions');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const CODE_LIMIT = 20; // codes tapés par adresse IP et par quart d'heure
const PICK_LIMIT = 5; // mauvais nombres choisis par adresse IP et par quart d'heure

const attempts = new Map();
function tooMany(kind, ip, limit) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter(t => now - t < WINDOW_MS);
  attempts.set(key, hits);
  return hits.length >= limit;
}
function countAttempt(kind, ip) {
  const key = `${kind}:${ip}`;
  attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
}

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const cleanCode = value => String(value ?? '').replace(/\D/g, '').slice(0, 8);

/** Votes spéciaux visibles pour un code : ouverts, clos ou publiés, pas archivés. */
function votesOf(code) {
  return col('votes')
    .find({ access: 'special', code, status: { $ne: 'brouillon' }, archived: { $ne: true } }, NO_ID)
    .sort({ openedAt: -1 })
    .toArray();
}

async function requireSession(req, res, next) {
  try {
    const data = verifySignedValue((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    if (!data || data.kind !== 'vote-rapide') return res.status(401).json({ error: 'Session terminée : tapez à nouveau le code.' });
    const session = await sessions().findOne({ id: data.session }, NO_ID);
    if (!session || session.expiresAt < new Date().toISOString()) return res.status(401).json({ error: 'Session terminée : tapez à nouveau le code.' });
    req.voteSession = session;
    next();
  } catch (err) {
    next(err);
  }
}

// POST /api/vote-rapide/code  { code } - les trois nombres à proposer (dont le bon).
router.post('/code', async (req, res) => {
  if (tooMany('code', req.ip, CODE_LIMIT)) return res.status(429).json({ error: 'Trop de tentatives : réessayez dans quelques minutes.' });
  countAttempt('code', req.ip);
  const code = cleanCode(req.body?.code);
  const list = code.length >= 4 ? await votesOf(code) : [];
  const match = list.some(v => v.status === 'ouvert') ? await matchNumberOf(code, true) : null;
  if (!match) return res.status(404).json({ error: 'Code inconnu, ou aucun vote ouvert pour ce code.' });
  res.json({ code, choices: match.choices });
});

// POST /api/vote-rapide/session  { code, number, nom } - ouvre la session d'une journée.
router.post('/session', async (req, res) => {
  if (tooMany('pick', req.ip, PICK_LIMIT)) return res.status(429).json({ error: 'Trop d’erreurs : réessayez dans quelques minutes.' });
  const code = cleanCode(req.body?.code);
  const name = text(req.body?.nom, 80);
  if (name.length < 3 || !/\s/.test(name)) return res.status(400).json({ error: 'Indiquez votre prénom et votre nom.' });
  const match = code.length >= 4 ? await matchNumberOf(code) : null;
  const open = match ? (await votesOf(code)).some(v => v.status === 'ouvert') : false;
  if (!match || !open) return res.status(404).json({ error: 'Code inconnu, ou aucun vote ouvert pour ce code.' });
  if (Number(req.body?.number) !== match.number) {
    countAttempt('pick', req.ip);
    return res.status(400).json({ error: 'Ce n’est pas le nombre annoncé dans la salle : regardez à nouveau.' });
  }
  const now = Date.now();
  const session = {
    id: newId('vsession'),
    code,
    name,
    nameKey: nameKey(name),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
  };
  await sessions().insertOne({ ...session });
  res.status(201).json({
    token: createSignedValue({ kind: 'vote-rapide', session: session.id }, SESSION_TTL_MS),
    name,
    expiresAt: session.expiresAt
  });
});

// GET /api/vote-rapide/votes - votes spéciaux du code de la session.
router.get('/votes', requireSession, async (req, res) => {
  const session = req.voteSession;
  const list = await votesOf(session.code);
  const mine = await col('vote_participations')
    .find({ voteId: { $in: list.map(v => v.id) }, $or: [{ clientId: `rapide:${session.id}` }, { nameKey: session.nameKey }] }, NO_ID)
    .toArray();
  const byVote = new Map(mine.map(p => [p.voteId, p]));
  res.json({ name: session.name, expiresAt: session.expiresAt, votes: list.map(v => voteView(v, { eligible: true, votedAt: byVote.get(v.id)?.at })) });
});

// POST /api/vote-rapide/votes/:id  { choices } ou { answers } - une fois par vote et par nom.
router.post('/votes/:id', requireSession, async (req, res) => {
  const session = req.voteSession;
  const vote = await col('votes').findOne({ id: req.params.id }, NO_ID);
  if (!vote || !isSpecial(vote) || vote.code !== session.code || vote.status === 'brouillon' || vote.archived) {
    return res.status(404).json({ error: 'Vote introuvable.' });
  }
  if (await col('vote_participations').findOne({ voteId: vote.id, nameKey: session.nameKey }, { projection: { _id: 1 } })) {
    return res.status(409).json({ error: `Un vote a déjà été enregistré au nom de ${session.name}.` });
  }
  const result = await castBallot(vote, { key: `rapide:${session.id}`, name: session.name, nameKey: session.nameKey }, req.body);
  if (result.error) return res.status(result.status).json({ error: result.error });
  const updated = await col('votes').findOne({ id: vote.id }, NO_ID);
  res.json(voteView(updated, { eligible: true, votedAt: result.at }));
});

module.exports = router;
