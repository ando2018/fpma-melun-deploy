const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID, isDuplicateKey } = require('../utils/db');
const { createSignedValue, verifySignedValue, hashPassword, verifyPassword } = require('../utils/auth');
const { modeLabels, formatNumero, parseNumero, normalizeEmail, logClient, visibleVersements, linkPastPayments } = require('../utils/clients');
const messaging = require('../utils/messaging');
const { isSpecial, voteView, castBallot } = require('../utils/votes');

// Espace client public. Les fiches sont créées seulement par l'admin, qui envoie le mot de
// passe provisoire (ou une réinitialisation) par e-mail. Le client se connecte avec son
// n° client ou son e-mail, choisit son mot de passe, puis consulte ses versements (en
// lecture seule) et peut corriger ses coordonnées (nom, sexe, téléphone, adresse, e-mail).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEXES = { H: 'Homme', F: 'Femme' };

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const router = asyncRouter();
const clients = () => col('clients');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 10;

// Limite de tentatives par adresse IP (anti-essais en série).
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

function createClientToken(client) {
  return createSignedValue({ kind: 'client', client: client.id, pv: client.passwordVersion || 0 }, TOKEN_TTL_MS);
}

// Le jeton n'est plus valable si le mot de passe a changé ou si le compte est désactivé.
async function requireClient(req, res, next) {
  try {
    const data = verifySignedValue((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    if (!data || data.kind !== 'client') return res.status(401).json({ error: 'Connexion requise.' });
    const client = await clients().findOne({ id: data.client }, NO_ID);
    if (!client || client.active === false || !client.numero || (client.passwordVersion || 0) !== data.pv) {
      return res.status(401).json({ error: 'Session expirée : reconnectez-vous.' });
    }
    req.client = client;
    next();
  } catch (err) {
    next(err);
  }
}

function profile(client) {
  return {
    id: client.id,
    numero: formatNumero(client.numero),
    nom: client.nom,
    prenom: client.prenom,
    sexe: client.sexe || null,
    email: client.email || '',
    identifiant: client.identifiant || null,
    mustChangePassword: !!client.mustChangePassword
  };
}

// POST /api/espace-client/login  { identifiant (n° client ou e-mail), password }
router.post('/login', async (req, res) => {
  if (tooMany('login', req.ip, LOGIN_LIMIT)) {
    return res.status(429).json({ error: 'Trop de tentatives : réessayez dans quelques minutes.' });
  }
  const identifiant = String(req.body?.identifiant || '').trim();
  const password = String(req.body?.password || '');
  // Seules les fiches qui ont un n° client ont un espace client. Connexion avec l'e-mail ou
  // l'identifiant à 8 chiffres (le n° paroissien reste accepté pour les comptes d'avant).
  const digits = identifiant.replace(/\D/g, '');
  const query = identifiant.includes('@')
    ? { email: normalizeEmail(identifiant), numero: { $type: 'string' } }
    : digits.length === 8
      ? { $or: [{ identifiant: digits }, { numero: parseNumero(digits) || '-' }], numero: { $type: 'string' } }
      : { numero: parseNumero(digits) || '-' };
  // Adresse partagée par plusieurs paroissiens : c'est le mot de passe qui désigne la fiche
  // (s'il en désigne plusieurs, il faut se connecter avec son identifiant).
  const found = await clients().find(query, NO_ID).toArray();
  const matching = found.filter(c => c.active !== false && c.passwordHash && verifyPassword(password, c.passwordHash));
  if (matching.length > 1) {
    return res.status(409).json({ error: 'Plusieurs paroissiens partagent cette adresse e-mail : connectez-vous avec votre identifiant (8 chiffres).' });
  }
  const client = matching[0];
  if (!client) {
    countAttempt('login', req.ip);
    return res.status(401).json({ error: 'N° paroissien (ou e-mail) ou mot de passe incorrect.' });
  }
  await clients().updateOne({ id: client.id }, { $set: { lastLoginAt: new Date().toISOString() } });
  await logClient(client, 'client', 'Connexion à l’espace paroissien');
  res.json({ token: createClientToken(client), ...profile(client) });
});

// GET /api/espace-client/me - fiche et versements (lecture seule).
router.get('/me', requireClient, async (req, res) => {
  const client = req.client;
  const [groups, family, list] = await Promise.all([
    col('client_groups').find({}, NO_ID).toArray(),
    // Famille (noms seulement) : conjoint, et enfants du client ou de son conjoint.
    clients()
      .find(
        { $or: [{ id: client.conjointId || '-' }, { parentIds: { $in: [client.id, client.conjointId].filter(Boolean) } }] },
        { projection: { _id: 0, id: 1, nom: 1, prenom: 1, numero: 1 } }
      )
      .sort({ prenom: 1 })
      .toArray(),
    col('client_versements').find({ clientId: client.id, ...(await visibleVersements()) }, NO_ID).sort({ date: -1, createdAt: -1 }).toArray()
  ]);
  const names = new Map(groups.map(g => [g.id, g.name]));
  const labels = await modeLabels();
  const shown = v => ({
    id: v.id,
    date: v.date,
    amount: v.amount,
    type: v.type,
    mode: labels[v.mode] || v.mode,
    groupe: v.groupId ? names.get(v.groupId) || null : v.groupName || null,
    note: v.note || '',
    online: v.source === 'stripe',
    test: !!v.test
  });
  // Les parents (l'un ou les deux, s'ils sont mariés) voient aussi les quêtes de leurs enfants
  // rattachés (fiches sans n° paroissien, donc sans espace à eux).
  const children = family.filter(p => p.id !== client.conjointId && !p.numero);
  const childList = children.length
    ? await col('client_versements')
        .find({ clientId: { $in: children.map(c => c.id) }, ...(await visibleVersements()) }, NO_ID)
        .sort({ date: -1, createdAt: -1 })
        .toArray()
    : [];
  res.json({
    ...profile(client),
    telephone: client.telephone || '',
    adresse: client.adresse || '',
    groupes: (client.groupes || []).map(id => names.get(id)).filter(Boolean),
    // Postes (Directeur du groupe SLK…) : donnent accès à l'onglet du groupe.
    postes: (client.postes || []).filter(p => names.has(p.groupId)).map(p => ({ poste: p.poste, groupId: p.groupId, groupName: names.get(p.groupId) })),
    conjoint: family.filter(p => p.id === client.conjointId).map(p => `${p.prenom} ${p.nom}`)[0] || null,
    enfants: family.filter(p => p.id !== client.conjointId).map(p => `${p.prenom} ${p.nom}`),
    memberSince: client.createdAt,
    // Messages non lus (individuels et des groupes) : pastille de l'onglet « Messages ».
    messagesNonLus: (await messaging.clientThreads(client)).filter(t => t.unread).length,
    // Faux : on lui propose de vérifier et compléter ses informations (après la première connexion).
    profileReviewed: !!client.profileReviewedAt,
    versements: list.map(shown),
    enfantsQuetes: children.map(c => ({
      id: c.id,
      prenom: c.prenom,
      nom: c.nom,
      versements: childList.filter(v => v.clientId === c.id).map(shown)
    }))
  });
});

// PUT /api/espace-client/profil  { prenom, nom, sexe, telephone, adresse, email, password? }
// Le paroissien corrige ses coordonnées. Le n° paroissien, les groupes et la famille restent
// gérés par l'Église. Changer d'e-mail (identifiant de connexion) demande le mot de passe.
router.put('/profil', requireClient, async (req, res) => {
  const client = req.client;
  const body = req.body || {};
  const value = {
    prenom: text(body.prenom, 80),
    nom: text(body.nom, 80),
    sexe: Object.keys(SEXES).includes(body.sexe) ? body.sexe : null,
    telephone: text(body.telephone, 30),
    adresse: text(body.adresse, 200)
  };
  if (!value.prenom || !value.nom) return res.status(400).json({ error: 'Le prénom et le nom sont obligatoires.' });
  // E-mail facultatif pour celui qui se connecte avec son identifiant (pas d'adresse) ;
  // une adresse déjà enregistrée ne peut pas être effacée (elle sert à se connecter).
  const email = normalizeEmail(body.email).slice(0, 160);
  if (email ? !EMAIL_RE.test(email) : !!client.email) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  const emailChanged = email !== (client.email || '');
  if (emailChanged) {
    if (tooMany('profil', req.ip, LOGIN_LIMIT)) {
      return res.status(429).json({ error: 'Trop de tentatives : réessayez dans quelques minutes.' });
    }
    if (!verifyPassword(String(body.password || ''), client.passwordHash)) {
      countAttempt('profil', req.ip);
      return res.status(400).json({ error: 'Pour changer d’adresse e-mail, confirmez avec votre mot de passe actuel.' });
    }
    value.email = email;
  }

  const shown = c => ({ ...c, sexe: SEXES[c.sexe] || '' });
  const labels = { prenom: 'Prénom', nom: 'Nom', sexe: 'Sexe', telephone: 'Téléphone', adresse: 'Adresse', email: 'E-mail' };
  const changes = Object.entries(labels)
    .filter(([key]) => key in value && (shown(client)[key] || '') !== (shown(value)[key] || ''))
    .map(([key, label]) => `${label} : « ${shown(client)[key] || ''} » → « ${shown(value)[key] || ''} »`);

  const now = new Date().toISOString();
  try {
    await clients().updateOne({ id: client.id }, { $set: { ...value, profileReviewedAt: now, ...(changes.length ? { updatedAt: now } : {}) } });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Cette adresse e-mail est déjà utilisée par une autre fiche : contactez l’Église.' });
    throw err;
  }
  const updated = { ...client, ...value };
  if (changes.length) await logClient(updated, 'client', 'Fiche modifiée par le paroissien', changes.join(' ; '));
  // Nouvelle adresse : les paiements en ligne déjà faits avec elle sont rattachés.
  if (emailChanged) await linkPastPayments(updated);
  res.json({ changed: changes.length, ...profile(updated) });
});

// POST /api/espace-client/profil/plus-tard - la proposition de compléter la fiche n'est
// plus affichée (les informations restent modifiables à tout moment).
router.post('/profil/plus-tard', requireClient, async (req, res) => {
  await clients().updateOne({ id: req.client.id }, { $set: { profileReviewedAt: new Date().toISOString() } });
  res.status(204).end();
});

// ---------- Responsables de groupe (poste) : membres et messages d'information ----------

// Un paroissien qui a un poste dans un groupe (Directeur du groupe SLK…) voit la liste des
// membres (sans leurs quêtes ni leurs e-mails) et publie des messages pour tout le groupe :
// signés « Le bureau du groupe », visibles dans l'espace de chaque membre (qui est prévenu
// par e-mail), avec pièces jointes ; les membres peuvent y répondre.
const MESSAGES_PER_HOUR = 10;
const REPLIES_PER_HOUR = 30;

/** Groupe où le paroissien a un poste, avec ses postes dans ce groupe ; sinon null. */
async function posteGroup(client, groupId) {
  const postes = (client.postes || []).filter(p => p.groupId === groupId).map(p => p.poste);
  if (!postes.length) return null;
  const group = await col('client_groups').findOne({ id: groupId }, NO_ID);
  return group ? { group, postes } : null;
}

async function groupMembers(groupId) {
  const list = await clients()
    .find({ groupes: groupId, active: { $ne: false } }, { projection: { _id: 0, id: 1, numero: 1, nom: 1, prenom: 1, email: 1, postes: 1 } })
    .toArray();
  return list.sort((a, b) => (a.numero ? 0 : 1) - (b.numero ? 0 : 1) || (a.numero || '').localeCompare(b.numero || '') || a.nom.localeCompare(b.nom));
}

function bureauAuthor(client, group) {
  return { type: 'bureau', id: client.id, name: `${client.prenom} ${client.nom}`, label: `Le bureau du groupe ${group.name}` };
}

function clientAuthor(client) {
  return { type: 'client', id: client.id, name: `${client.prenom} ${client.nom}`, label: `${client.prenom} ${client.nom}` };
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendError(req, res, err) {
  messaging.removeUploaded(req);
  if (err.status) return res.status(err.status).json({ error: err.message });
  throw err;
}

// GET /api/espace-client/groupes/:groupId - membres du groupe et messages publiés.
router.get('/groupes/:groupId', requireClient, async (req, res) => {
  const found = await posteGroup(req.client, req.params.groupId);
  if (!found) return res.status(403).json({ error: 'Vous n’avez pas de poste dans ce groupe.' });
  const [members, list] = await Promise.all([
    groupMembers(found.group.id),
    messaging.threads().find({ kind: 'groupe', groupId: found.group.id }, NO_ID).sort({ lastAt: -1 }).limit(100).toArray()
  ]);
  res.json({
    group: { id: found.group.id, name: found.group.name, description: found.group.description || '' },
    postes: found.postes,
    // Pas d'e-mail ni de quête : seulement le n°, le nom et s'il est prévenu par e-mail.
    members: members.map(mb => ({
      id: mb.id,
      numero: formatNumero(mb.numero),
      prenom: mb.prenom,
      nom: mb.nom,
      hasEmail: !!(mb.email && mb.numero),
      postes: (mb.postes || []).filter(p => p.groupId === found.group.id).map(p => p.poste)
    })),
    messages: await Promise.all(list.map(t => messaging.threadWithPosts(t)))
  });
});

// POST /api/espace-client/groupes/:groupId/messages  (multipart : subject, body, files) -
// message du bureau à tout le groupe ; les membres sont prévenus par e-mail.
router.post('/groupes/:groupId/messages', requireClient, messaging.upload, async (req, res) => {
  const client = req.client;
  const found = await posteGroup(client, req.params.groupId);
  if (!found) return sendError(req, res, fail(403, 'Vous n’avez pas de poste dans ce groupe.'));
  const content = messaging.parseContent(req.body, { withSubject: true });
  if (content.error) return sendError(req, res, fail(400, content.error));
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if ((await messaging.threads().countDocuments({ 'createdBy.id': client.id, kind: 'groupe', createdAt: { $gte: hourAgo } })) >= MESSAGES_PER_HOUR) {
    return sendError(req, res, fail(429, 'Trop de messages publiés : réessayez dans une heure.'));
  }
  let created;
  try {
    created = await messaging.createThread({
      kind: 'groupe',
      group: found.group,
      subject: content.subject,
      author: bureauAuthor(client, found.group),
      body: content.body,
      attachments: messaging.attachmentsOf(req)
    });
  } catch (err) {
    return sendError(req, res, err);
  }
  // Prévenus : les membres qui ont un espace (n° et e-mail), sauf celui qui écrit.
  const recipients = (await groupMembers(found.group.id)).filter(mb => mb.numero && mb.email && mb.id !== client.id);
  const notified = await messaging.notifyClients(req, recipients, `Le bureau du groupe ${found.group.name}`, content.subject);
  await logClient(client, 'client', 'Message publié au groupe', `${found.group.name} — « ${content.subject} » — ${notified} prévenu(s) par e-mail`);
  res.status(201).json({ thread: await messaging.threadWithPosts(created.thread), notified });
});

// POST /api/espace-client/groupes/:groupId/messages/:id/reponses - réponse au nom du bureau.
router.post('/groupes/:groupId/messages/:id/reponses', requireClient, messaging.upload, async (req, res) => {
  const found = await posteGroup(req.client, req.params.groupId);
  if (!found) return sendError(req, res, fail(403, 'Vous n’avez pas de poste dans ce groupe.'));
  const thread = await messaging.threads().findOne({ id: req.params.id, kind: 'groupe', groupId: found.group.id }, NO_ID);
  if (!thread) return sendError(req, res, fail(404, 'Message introuvable.'));
  try {
    await messaging.addPost(thread, bureauAuthor(req.client, found.group), messaging.parseContent(req.body, {}).body, messaging.attachmentsOf(req));
  } catch (err) {
    return sendError(req, res, err);
  }
  await notifyGroupReply(req, thread, req.client, `Le bureau du groupe ${found.group.name}`);
  res.status(201).json({ thread: await messaging.threadWithPosts(await messaging.threads().findOne({ id: thread.id }, NO_ID)) });
});

// DELETE /api/espace-client/groupes/:groupId/messages/:id - supprime le message, ses
// réponses et ses pièces jointes (pour tous les membres).
router.delete('/groupes/:groupId/messages/:id', requireClient, async (req, res) => {
  const found = await posteGroup(req.client, req.params.groupId);
  if (!found) return res.status(403).json({ error: 'Vous n’avez pas de poste dans ce groupe.' });
  const thread = await messaging.threads().findOne({ id: req.params.id, kind: 'groupe', groupId: found.group.id }, NO_ID);
  if (!thread) return res.status(404).json({ error: 'Message introuvable.' });
  await messaging.deleteThread(thread);
  await logClient(req.client, 'client', 'Message du groupe supprimé', `${found.group.name} — « ${thread.subject} »`);
  res.status(204).end();
});

/** Réponse dans un fil de groupe : prévient le bureau et ceux qui ont déjà écrit dans le fil. */
async function notifyGroupReply(req, thread, writer, fromLabel) {
  const authors = await messaging.posts().distinct('author.id', { threadId: thread.id });
  const list = (await groupMembers(thread.groupId)).filter(
    mb => mb.id !== writer.id && mb.numero && mb.email && (authors.includes(mb.id) || (mb.postes || []).some(p => p.groupId === thread.groupId))
  );
  return messaging.notifyClients(req, list, fromLabel || `${writer.prenom} ${writer.nom} (groupe ${thread.groupName})`, thread.subject);
}

// ---------- Mes messages (individuels et de mes groupes) ----------

// GET /api/espace-client/messages - liste des messages (non lus signalés).
router.get('/messages', requireClient, async (req, res) => {
  res.json(await messaging.clientThreads(req.client));
});

async function visibleThread(req) {
  const thread = await messaging.threads().findOne({ id: req.params.id }, NO_ID);
  return thread && messaging.canClientSee(thread, req.client) ? thread : null;
}

// POST /api/espace-client/messages  (multipart : subject, body, files) - nouveau message
// du paroissien à l'Église ; les paroissiens « Admin » sont prévenus par e-mail.
router.post('/messages', requireClient, messaging.upload, async (req, res) => {
  const client = req.client;
  const content = messaging.parseContent(req.body, { withSubject: true });
  if (content.error) return sendError(req, res, fail(400, content.error));
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if ((await messaging.posts().countDocuments({ 'author.id': client.id, at: { $gte: hourAgo } })) >= REPLIES_PER_HOUR) {
    return sendError(req, res, fail(429, 'Trop de messages envoyés : réessayez dans une heure.'));
  }
  let created;
  try {
    created = await messaging.createThread({
      kind: 'individuel',
      clientId: client.id,
      subject: content.subject,
      author: clientAuthor(client),
      body: content.body,
      attachments: messaging.attachmentsOf(req)
    });
  } catch (err) {
    return sendError(req, res, err);
  }
  await messaging.notifyAdmins(req, client, content.subject);
  await logClient(client, 'client', 'Message envoyé à l’Église', `« ${content.subject} »`);
  res.status(201).json(await messaging.threadWithPosts(created.thread));
});

// GET /api/espace-client/messages/:id - le fil et ses messages (marqué comme lu).
router.get('/messages/:id', requireClient, async (req, res) => {
  const thread = await visibleThread(req);
  if (!thread) return res.status(404).json({ error: 'Message introuvable.' });
  await messaging.markRead(thread.id, req.client.id);
  res.json(await messaging.threadWithPosts(thread));
});

// POST /api/espace-client/messages/:id/reponses  (multipart : body, files) - répondre.
router.post('/messages/:id/reponses', requireClient, messaging.upload, async (req, res) => {
  const client = req.client;
  const thread = await visibleThread(req);
  if (!thread) return sendError(req, res, fail(404, 'Message introuvable.'));
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if ((await messaging.posts().countDocuments({ 'author.id': client.id, at: { $gte: hourAgo } })) >= REPLIES_PER_HOUR) {
    return sendError(req, res, fail(429, 'Trop de réponses envoyées : réessayez dans une heure.'));
  }
  try {
    await messaging.addPost(thread, clientAuthor(client), messaging.parseContent(req.body, {}).body, messaging.attachmentsOf(req));
  } catch (err) {
    return sendError(req, res, err);
  }
  if (thread.kind === 'individuel') await messaging.notifyAdmins(req, client, thread.subject);
  else await notifyGroupReply(req, thread, client);
  await logClient(client, 'client', 'Réponse à un message', `« ${thread.subject} »${thread.groupName ? ` (groupe ${thread.groupName})` : ''}`);
  res.status(201).json(await messaging.threadWithPosts(await messaging.threads().findOne({ id: thread.id }, NO_ID)));
});

// GET /api/espace-client/messages/:id/fichiers/:fileId - pièce jointe.
router.get('/messages/:id/fichiers/:fileId', requireClient, async (req, res) => {
  const thread = await visibleThread(req);
  if (!thread) return res.status(404).json({ error: 'Message introuvable.' });
  await messaging.sendAttachment(res, thread.id, req.params.fileId);
});

// ---------- Votes des groupes ----------

// GET /api/espace-client/votes - votes « normaux » ouverts, clos ou publiés où le paroissien
// était présent (votant) ; les votes archivés par l'admin n'apparaissent plus.
router.get('/votes', requireClient, async (req, res) => {
  const client = req.client;
  const list = await col('votes')
    .find({ status: { $ne: 'brouillon' }, archived: { $ne: true }, access: { $ne: 'special' }, electorate: client.id }, NO_ID)
    .sort({ openedAt: -1 })
    .toArray();
  const mine = await col('vote_participations').find({ clientId: client.id, voteId: { $in: list.map(v => v.id) } }, NO_ID).toArray();
  const byVote = new Map(mine.map(p => [p.voteId, p]));
  res.json(list.map(v => voteView(v, { eligible: (v.electorate || []).includes(client.id), votedAt: byVote.get(v.id)?.at })));
});

// POST /api/espace-client/votes/:id  { choices: [id d'option] } ou, pour un avis,
// { answers: { idPersonne: idRéponse } } (une réponse pour chaque personne) - une seule fois.
router.post('/votes/:id', requireClient, async (req, res) => {
  const client = req.client;
  const vote = await col('votes').findOne({ id: req.params.id }, NO_ID);
  if (!vote || vote.status === 'brouillon' || vote.archived || isSpecial(vote)) return res.status(404).json({ error: 'Vote introuvable.' });
  if (vote.status !== 'ouvert') return res.status(400).json({ error: 'Ce vote est clos.' });
  if (!(vote.electorate || []).includes(client.id)) return res.status(403).json({ error: 'Vous ne faites pas partie des votants de ce vote.' });
  const result = await castBallot(vote, { key: client.id }, req.body);
  if (result.error) return res.status(result.status).json({ error: result.error });
  await logClient(client, 'client', 'A voté', `${vote.title} (groupe ${vote.groupName})`);
  const updated = await col('votes').findOne({ id: vote.id }, NO_ID);
  res.json(voteView(updated, { eligible: true, votedAt: result.at }));
});

// POST /api/espace-client/mot-de-passe  { current, next }
router.post('/mot-de-passe', requireClient, async (req, res) => {
  const client = req.client;
  const next = String(req.body?.next || '');
  if (!verifyPassword(String(req.body?.current || ''), client.passwordHash)) {
    return res.status(400).json({ error: 'Le mot de passe actuel est incorrect.' });
  }
  if (next.length < 8) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères.' });
  if (next === req.body?.current) return res.status(400).json({ error: 'Choisissez un mot de passe différent du mot de passe provisoire.' });
  const passwordVersion = (client.passwordVersion || 0) + 1;
  await clients().updateOne(
    { id: client.id },
    { $set: { passwordHash: hashPassword(next), mustChangePassword: false, passwordVersion, passwordChangedAt: new Date().toISOString() } }
  );
  await logClient(client, 'client', 'Mot de passe changé par le paroissien');
  const updated = { ...client, passwordVersion, mustChangePassword: false };
  res.json({ token: createClientToken(updated), ...profile(updated) });
});

module.exports = router;
