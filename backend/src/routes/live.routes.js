const crypto = require('crypto');
const asyncRouter = require('../utils/asyncRouter');
const { col, getSetting, setSetting, NO_ID } = require('../utils/db');
const { authenticate, requireTab } = require('../utils/auth');
const { liveShareImage, shareImageKey } = require('../utils/liveShareImage');

// Direct vidéo en pair-à-pair (WebRTC) : la vidéo va directement de l'appareil qui filme
// (admin) à chaque spectateur. Ce serveur ne fait que la mise en relation (échange des
// descriptions de connexion), suit qui regarde, et garde un historique des directs.

const router = asyncRouter();

const DEFAULT_MAX_VIEWERS = Number(process.env.LIVE_MAX_VIEWERS) || 25;
const MAX_VIEWERS_LIMIT = 200;
const MAX_WAITING = 50;
const VIEWER_TIMEOUT_MS = 20000;
const BROADCASTER_TIMEOUT_MS = 20000;
const REMOVED_MEMORY_MS = 2 * 60 * 1000;
const SESSION_SAVE_MS = 30000;
const MAX_SDP_LENGTH = 30000;
const HISTORY_SIZE = 30;

// Interactions des membres d'un direct privé : chat, main levée, réactions.
const CHAT_MAX_MESSAGES = 200;
const CHAT_SENT_TO_VIEWERS = 100;
const CHAT_MAX_LENGTH = 300;
const CHAT_MIN_INTERVAL_MS = 1500;
const REACTIONS = ['🙏', '❤️', '👏', '🙌', '😊'];
const REACTION_MIN_INTERVAL_MS = 700;
const REACTION_MEMORY_MS = 60000;

// audience :
// - 'public'  : tout le monde voit le direct (page d'accueil, /direct) ;
// - 'test'    : seulement les comptes connectés qui ont l'onglet Direct ;
// - 'private' : jamais affiché sur le site ; accessible par un lien secret, en donnant
//               son nom. Les membres privés entrent directement, les autres attendent
//               l'autorisation d'un administrateur.
const DEFAULT_CONFIG = {
  title: 'Culte en direct',
  description: '',
  visible: false,
  audience: 'public',
  maxViewers: DEFAULT_MAX_VIEWERS,
  privateToken: null,
  // Jour (Paris) de création du lien privé : un nouveau lien est créé chaque jour.
  privateTokenDate: null
};
const AUDIENCES = ['public', 'test', 'private'];
const MEMBERS_KEY = 'live-private-members';

// Date du jour à Paris (AAAA-MM-JJ) : le lien privé change à minuit, heure française.
function todayParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

async function readConfig() {
  const config = { ...DEFAULT_CONFIG, ...(await getSetting('live-config', {})) };
  // Lien privé du jour : renouvelé à la première utilisation de chaque journée. Jamais
  // pendant un direct (les spectateurs qui arrivent après minuit gardent le même lien).
  if (config.privateToken && config.privateTokenDate !== todayParis() && !state.onAir) {
    config.privateToken = newToken();
    config.privateTokenDate = todayParis();
    await writeConfig(config);
  }
  return config;
}

function writeConfig(config) {
  return setSetting('live-config', config);
}

// Configuration renvoyée à l'admin (le jeton du lien privé n'est utile qu'à lui).
function adminConfig(config) {
  return { ...config, maxViewers: config.maxViewers || DEFAULT_MAX_VIEWERS };
}

const sessions = () => col('live_sessions');

// État du direct en mémoire : une session est éphémère et n'a pas à survivre à un
// redémarrage du serveur (l'historique, lui, est enregistré en base).
const state = {
  onAir: false,
  sessionId: null,
  startedAt: null,
  lastBroadcasterSeen: 0,
  // viewerId -> { id, name, account, status: 'waiting'|'approved', offer, answer,
  //               answerDelivered, playing, joinedAt, lastSeen }
  viewers: new Map(),
  // Spectateurs refusés ou retirés : on le leur dit à leur prochaine interrogation.
  removed: new Map(),
  // Historique du direct en cours (enregistré régulièrement en base).
  session: null,
  sessionDirty: false,
  // Chat du direct en cours (version incrémentée à chaque ajout ou suppression, pour
  // ne renvoyer la liste aux spectateurs que quand elle change).
  chat: [],
  chatVersion: 0,
  // Réactions des 60 dernières secondes (numérotées pour l'animation chez chacun).
  reactions: [],
  reactionSeq: 0
};

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

// « Élodie  RAKOTO » et « elodie rakoto » sont le même nom.
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function approvedCount() {
  let n = 0;
  for (const viewer of state.viewers.values()) if (viewer.status === 'approved') n++;
  return n;
}

// ---------- Historique ----------

function attendee(viewer) {
  return state.session?.attendees.find(a => a.viewerId === viewer.id);
}

function logAttendee(viewer, status) {
  if (!state.session) return;
  let entry = attendee(viewer);
  if (!entry) {
    entry = { viewerId: viewer.id, name: viewer.name, account: viewer.account, joinedAt: new Date().toISOString(), leftAt: null, status };
    state.session.attendees.push(entry);
  } else {
    entry.status = status;
  }
  state.session.peakViewers = Math.max(state.session.peakViewers, approvedCount());
  state.sessionDirty = true;
}

function logLeave(viewer, status) {
  const entry = attendee(viewer);
  if (!entry) return;
  if (!entry.leftAt) entry.leftAt = new Date().toISOString();
  if (status) entry.status = status;
  state.sessionDirty = true;
}

async function saveSession() {
  if (!state.session || !state.sessionDirty) return;
  state.sessionDirty = false;
  const { attendees, ...rest } = state.session;
  const chat = state.chat.map(({ author, text, at, admin }) => ({ author, text, at, admin }));
  await sessions()
    .updateOne(
      { id: rest.id },
      { $set: { ...rest, attendees: attendees.map(({ viewerId, ...a }) => a), chat } },
      { upsert: true }
    )
    .catch(err => console.error('Historique du direct non enregistré :', err.message));
}

function removeViewer(id, reason) {
  const viewer = state.viewers.get(id);
  if (!viewer) return;
  state.viewers.delete(id);
  if (reason) state.removed.set(id, { reason, at: Date.now() });
  logLeave(viewer, reason === 'refused' ? 'refused' : reason ? 'removed' : null);
}

function stopLive() {
  if (state.session) {
    for (const viewer of state.viewers.values()) logLeave(viewer);
    state.session.endedAt = new Date().toISOString();
    state.sessionDirty = true;
    saveSession();
  }
  state.onAir = false;
  state.sessionId = null;
  state.startedAt = null;
  state.viewers.clear();
  state.session = null;
  state.chat = [];
  state.chatVersion++;
  state.reactions = [];
}

// Seuls les membres admis dans un direct privé peuvent écrire, lever la main, réagir.
function canInteract(viewer) {
  return !!viewer && viewer.status === 'approved' && viewer.privateAccess;
}

function addChatMessage(message) {
  state.chat.push({ id: newId('msg'), at: new Date().toISOString(), ...message });
  if (state.chat.length > CHAT_MAX_MESSAGES) state.chat.splice(0, state.chat.length - CHAT_MAX_MESSAGES);
  state.chatVersion++;
  state.sessionDirty = true;
}

function publicMessage(m) {
  return { id: m.id, author: m.author, text: m.text, at: m.at, admin: !!m.admin };
}

function recentReactions() {
  const since = Date.now() - REACTION_MEMORY_MS;
  state.reactions = state.reactions.filter(r => r.atMs >= since);
  return state.reactions;
}

// Coupe le direct si l'appareil qui filme ne donne plus signe de vie (onglet fermé,
// réseau coupé) et oublie les spectateurs partis.
function cleanup() {
  const now = Date.now();
  if (state.onAir && now - state.lastBroadcasterSeen > BROADCASTER_TIMEOUT_MS) stopLive();
  for (const [id, viewer] of state.viewers) {
    if (now - viewer.lastSeen > VIEWER_TIMEOUT_MS) removeViewer(id);
  }
  for (const [id, info] of state.removed) {
    if (now - info.at > REMOVED_MEMORY_MS) state.removed.delete(id);
  }
}
setInterval(cleanup, 5000).unref();
setInterval(() => saveSession(), SESSION_SAVE_MS).unref();

// Le direct est-il visible pour ce visiteur ?
// - test : il faut être connecté avec l'onglet Direct (jeton envoyé par le site) ;
// - privé : il faut le lien secret (jamais visible sur les pages du site).
async function canWatch(req, config, token) {
  if (config.audience === 'private') return !!config.privateToken && token === config.privateToken;
  if (!config.visible) return false;
  if (config.audience !== 'test') return true;
  const user = await authenticate(req).catch(() => null);
  return !!user && (user.role === 'admin' || user.tabs.includes('direct'));
}

function isValidSdp(sdp) {
  return typeof sdp === 'string' && sdp.length > 0 && sdp.length < MAX_SDP_LENGTH;
}

// Ce que voit le public du direct (lien de partage, aperçu) : un direct en mode test ou
// privé n'est jamais annoncé.
async function publicShareInfo() {
  cleanup();
  const config = await readConfig();
  const onAir = state.onAir && config.visible && config.audience === 'public';
  return { onAir, title: config.title, description: config.description };
}

// Aperçu du lien d'un direct privé : seulement si le lien est valide (sinon rien n'est
// révélé, pas même le titre).
async function privateShareInfo(token) {
  cleanup();
  const config = await readConfig();
  if (config.audience !== 'private' || !config.privateToken || token !== config.privateToken) return null;
  return { private: true, onAir: state.onAir, title: config.title, description: config.description };
}

// ---------- Public (spectateurs) ----------

// GET /api/live/share-image.jpg - image d'aperçu du lien /direct (WhatsApp, Facebook…)
// ?token=... : image du lien d'un direct privé.
router.get('/share-image.jpg', async (req, res) => {
  const token = req.query.token ? String(req.query.token) : null;
  const info = (token && (await privateShareInfo(token))) || (await publicShareInfo());
  const image = await liveShareImage(info);
  res.set('Cache-Control', 'public, max-age=300');
  res.type('image/jpeg').send(image);
});

// GET /api/live/status[?token=...] - le jeton est celui du lien d'un direct privé.
router.get('/status', async (req, res) => {
  cleanup();
  const config = await readConfig();
  const token = req.query.token ? String(req.query.token) : null;
  const visible = await canWatch(req, config, token);
  const max = config.maxViewers || DEFAULT_MAX_VIEWERS;
  // Réponse propre à chaque visiteur (mode test, lien privé) : pas de cache.
  res.set('Cache-Control', 'no-store');
  res.json({
    title: visible ? config.title : '',
    description: visible ? config.description : '',
    visible,
    test: visible && config.audience === 'test',
    private: visible && config.audience === 'private',
    onAir: visible && state.onAir,
    startedAt: visible ? state.startedAt : null,
    viewers: visible ? approvedCount() : 0,
    full: approvedCount() >= max
  });
});

// POST /api/live/join  { token?, name? }
router.post('/join', async (req, res) => {
  cleanup();
  const config = await readConfig();
  const token = req.body?.token ? String(req.body.token) : null;
  if (!state.onAir || !(await canWatch(req, config, token))) {
    return res.status(409).json({ error: 'Aucun direct en cours.' });
  }
  const user = await authenticate(req).catch(() => null);
  const isPrivate = config.audience === 'private';
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (isPrivate && name.length < 2) return res.status(400).json({ error: 'Indiquez votre nom pour rejoindre le direct.' });

  let status = 'approved';
  if (isPrivate) {
    const members = (await getSetting(MEMBERS_KEY, [])) || [];
    const isMember = members.some(m => normalizeName(m.name) === normalizeName(name));
    status = isMember ? 'approved' : 'waiting';
    if (status === 'waiting' && [...state.viewers.values()].filter(v => v.status === 'waiting').length >= MAX_WAITING) {
      return res.status(503).json({ error: 'Trop de demandes en attente, réessayez dans quelques minutes.' });
    }
  }
  if (status === 'approved' && approvedCount() >= (config.maxViewers || DEFAULT_MAX_VIEWERS)) {
    return res.status(503).json({ error: 'Le direct est complet pour le moment, réessayez dans quelques minutes.' });
  }

  const now = Date.now();
  const viewer = {
    id: newId('viewer'),
    name: name || null,
    account: user?.username || null,
    status,
    offer: null,
    answer: null,
    answerDelivered: false,
    playing: false,
    // Entré par le lien privé (gardé si le direct passe en privé en cours de route).
    privateAccess: isPrivate,
    joinedAt: new Date(now).toISOString(),
    lastSeen: now
  };
  state.viewers.set(viewer.id, viewer);
  logAttendee(viewer, status);
  res.status(201).json({ viewerId: viewer.id, status });
});

// Le spectateur interroge régulièrement : sert aussi de signe de présence. ?playing=1
// indique que la vidéo est affichée chez lui.
router.get('/viewer/:id', (req, res) => {
  const removed = state.removed.get(req.params.id);
  if (removed) {
    const messages = {
      refused: 'Votre demande d’accès a été refusée.',
      private: 'Le direct est désormais privé : il n’est plus accessible depuis le site.',
      removed: 'Vous avez été retiré du direct.'
    };
    return res.status(403).json({ status: removed.reason, error: messages[removed.reason] || messages.removed });
  }
  const viewer = state.viewers.get(req.params.id);
  if (!viewer) return res.status(404).json({ error: 'Direct terminé.' });
  viewer.lastSeen = Date.now();
  if (req.query.playing === '1' && !viewer.playing) {
    viewer.playing = true;
    logAttendee(viewer, 'approved');
  }
  const body = { status: viewer.status, offer: viewer.status === 'approved' ? viewer.offer : null };
  if (canInteract(viewer)) {
    // ?cv = version du chat déjà reçue, ?r = dernière réaction déjà reçue.
    if (String(state.chatVersion) !== String(req.query.cv)) {
      body.chat = { version: state.chatVersion, messages: state.chat.slice(-CHAT_SENT_TO_VIEWERS).map(publicMessage) };
    }
    const lastReaction = Number(req.query.r) || 0;
    body.reactions = recentReactions()
      .filter(r => r.seq > lastReaction)
      .slice(-20)
      .map(r => ({ seq: r.seq, emoji: r.emoji }));
    body.reactionSeq = state.reactionSeq;
    body.handRaised = !!viewer.handRaised;
    body.interactive = true;
  }
  res.json(body);
});

// POST /api/live/viewer/:id/chat  { text }
router.post('/viewer/:id/chat', (req, res) => {
  const viewer = state.viewers.get(req.params.id);
  if (!canInteract(viewer)) return res.status(403).json({ error: 'Le chat est réservé aux membres du direct privé.' });
  const text = String(req.body?.text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
  if (!text) return res.status(400).json({ error: 'Message vide.' });
  const now = Date.now();
  if (viewer.lastChatAt && now - viewer.lastChatAt < CHAT_MIN_INTERVAL_MS) {
    return res.status(429).json({ error: 'Doucement : attendez un instant avant le message suivant.' });
  }
  viewer.lastChatAt = now;
  viewer.lastSeen = now;
  addChatMessage({ author: viewer.name || 'Membre', viewerId: viewer.id, text, admin: false });
  res.status(201).json({ ok: true, version: state.chatVersion });
});

// POST /api/live/viewer/:id/hand  { raised }
router.post('/viewer/:id/hand', (req, res) => {
  const viewer = state.viewers.get(req.params.id);
  if (!canInteract(viewer)) return res.status(403).json({ error: 'Réservé aux membres du direct privé.' });
  viewer.handRaised = req.body?.raised === true;
  viewer.handRaisedAt = viewer.handRaised ? new Date().toISOString() : null;
  res.json({ handRaised: viewer.handRaised });
});

// POST /api/live/viewer/:id/reaction  { emoji }
router.post('/viewer/:id/reaction', (req, res) => {
  const viewer = state.viewers.get(req.params.id);
  if (!canInteract(viewer)) return res.status(403).json({ error: 'Réservé aux membres du direct privé.' });
  const emoji = String(req.body?.emoji || '');
  if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Réaction inconnue.' });
  const now = Date.now();
  if (viewer.lastReactionAt && now - viewer.lastReactionAt < REACTION_MIN_INTERVAL_MS) return res.json({ ok: true });
  viewer.lastReactionAt = now;
  state.reactions.push({ seq: ++state.reactionSeq, emoji, atMs: now });
  res.status(201).json({ ok: true });
});

router.post('/viewer/:id/answer', (req, res) => {
  const viewer = state.viewers.get(req.params.id);
  if (!viewer) return res.status(404).json({ error: 'Direct terminé.' });
  if (!isValidSdp(req.body?.sdp)) return res.status(400).json({ error: 'Réponse invalide.' });
  viewer.answer = req.body.sdp;
  viewer.lastSeen = Date.now();
  res.json({ ok: true });
});

router.post('/viewer/:id/leave', (req, res) => {
  removeViewer(req.params.id);
  res.json({ ok: true });
});

// ---------- Admin (appareil qui filme) ----------

const adminOnly = requireTab('direct');

router.get('/config', adminOnly, async (req, res) => {
  res.json(adminConfig(await readConfig()));
});

router.put('/config', adminOnly, async (req, res) => {
  const current = await readConfig();
  const title = req.body?.title !== undefined ? String(req.body.title).trim() : current.title;
  if (!title) return res.status(400).json({ error: 'Le titre est requis.' });
  if (title.length > 120) return res.status(400).json({ error: 'Titre trop long (120 caractères max).' });
  const description = req.body?.description !== undefined ? String(req.body.description).trim() : current.description;
  if (description.length > 1000) return res.status(400).json({ error: 'Description trop longue (1000 caractères max).' });
  const visible = req.body?.visible !== undefined ? req.body.visible === true : current.visible;
  const audience = req.body?.audience !== undefined ? req.body.audience : current.audience;
  if (!AUDIENCES.includes(audience)) return res.status(400).json({ error: 'Public du direct invalide.' });
  let maxViewers = current.maxViewers || DEFAULT_MAX_VIEWERS;
  if (req.body?.maxViewers !== undefined) {
    maxViewers = Math.round(Number(req.body.maxViewers));
    if (!Number.isFinite(maxViewers) || maxViewers < 1 || maxViewers > MAX_VIEWERS_LIMIT) {
      return res.status(400).json({ error: `Nombre maximum de spectateurs : entre 1 et ${MAX_VIEWERS_LIMIT}.` });
    }
  }
  // Un lien privé est créé la première fois que le mode privé est choisi.
  const privateToken = current.privateToken || (audience === 'private' ? newToken() : null);
  const privateTokenDate = current.privateToken ? current.privateTokenDate : privateToken ? todayParis() : null;

  const config = { title, description, visible, audience, maxViewers, privateToken, privateTokenDate };
  await writeConfig(config);
  // Passage en privé pendant le direct : ceux qui regardaient depuis le site sont coupés.
  if (audience === 'private' && current.audience !== 'private') {
    for (const viewer of [...state.viewers.values()]) {
      if (!viewer.privateAccess) removeViewer(viewer.id, 'private');
    }
  }
  if (state.session) {
    state.session.audience = audience;
    state.session.title = title;
    state.sessionDirty = true;
  }
  res.json(adminConfig(config));
});

// POST /api/live/private-link - nouveau lien privé (l'ancien ne fonctionne plus ; les
// spectateurs déjà connectés restent).
router.post('/private-link', adminOnly, async (req, res) => {
  const config = { ...(await readConfig()), privateToken: newToken(), privateTokenDate: todayParis() };
  await writeConfig(config);
  res.json(adminConfig(config));
});

// Membres privés : entrent directement dans un direct privé en donnant leur nom.
router.get('/private-members', adminOnly, async (req, res) => {
  res.json((await getSetting(MEMBERS_KEY, [])) || []);
});

router.post('/private-members', adminOnly, async (req, res) => {
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name.length < 2) return res.status(400).json({ error: 'Nom trop court.' });
  const members = (await getSetting(MEMBERS_KEY, [])) || [];
  if (members.some(m => normalizeName(m.name) === normalizeName(name))) {
    return res.status(409).json({ error: `« ${name} » est déjà dans la liste.` });
  }
  const member = { id: newId('membre'), name, createdAt: new Date().toISOString() };
  await setSetting(MEMBERS_KEY, [...members, member].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
  res.status(201).json(member);
});

router.delete('/private-members/:id', adminOnly, async (req, res) => {
  const members = (await getSetting(MEMBERS_KEY, [])) || [];
  await setSetting(MEMBERS_KEY, members.filter(m => m.id !== req.params.id));
  res.status(204).end();
});

// Autoriser / refuser / retirer un spectateur.
router.post('/viewers/:id/approve', adminOnly, async (req, res) => {
  const viewer = state.viewers.get(req.params.id);
  if (!viewer) return res.status(404).json({ error: 'Cette personne a quitté le direct.' });
  const config = await readConfig();
  if (viewer.status !== 'approved' && approvedCount() >= (config.maxViewers || DEFAULT_MAX_VIEWERS)) {
    return res.status(409).json({ error: 'Le direct est complet : augmentez le nombre maximum de spectateurs.' });
  }
  viewer.status = 'approved';
  logAttendee(viewer, 'approved');
  // « Autoriser et ajouter aux membres » : entrera directement la prochaine fois.
  if (req.body?.addMember === true && viewer.name) {
    const members = (await getSetting(MEMBERS_KEY, [])) || [];
    if (!members.some(m => normalizeName(m.name) === normalizeName(viewer.name))) {
      members.push({ id: newId('membre'), name: viewer.name, createdAt: new Date().toISOString() });
      await setSetting(MEMBERS_KEY, members.sort((a, b) => a.name.localeCompare(b.name, 'fr')));
    }
  }
  res.json({ ok: true });
});

// Chat côté admin : message de l'animateur, suppression d'un message.
router.post('/chat', adminOnly, (req, res) => {
  if (!state.onAir) return res.status(409).json({ error: 'Aucun direct en cours.' });
  const text = String(req.body?.text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
  if (!text) return res.status(400).json({ error: 'Message vide.' });
  addChatMessage({ author: 'Animateur', viewerId: null, text, admin: true });
  res.status(201).json({ ok: true });
});

router.delete('/chat/:messageId', adminOnly, (req, res) => {
  const before = state.chat.length;
  state.chat = state.chat.filter(m => m.id !== req.params.messageId);
  if (state.chat.length !== before) {
    state.chatVersion++;
    state.sessionDirty = true;
  }
  res.status(204).end();
});

router.post('/viewers/:id/lower-hand', adminOnly, (req, res) => {
  const viewer = state.viewers.get(req.params.id);
  if (viewer) {
    viewer.handRaised = false;
    viewer.handRaisedAt = null;
  }
  res.json({ ok: true });
});

router.post('/viewers/:id/refuse', adminOnly, (req, res) => {
  removeViewer(req.params.id, 'refused');
  res.json({ ok: true });
});

router.post('/viewers/:id/remove', adminOnly, (req, res) => {
  removeViewer(req.params.id, 'removed');
  res.json({ ok: true });
});

// GET /api/live/history - derniers directs : date, durée, public, pic et liste des spectateurs.
router.get('/history', adminOnly, async (req, res) => {
  await saveSession();
  const list = await sessions().find({}, NO_ID).sort({ startedAt: -1 }).limit(HISTORY_SIZE).toArray();
  res.json(list);
});

router.delete('/history/:id', adminOnly, async (req, res) => {
  if (state.session?.id === req.params.id) return res.status(409).json({ error: 'Direct en cours.' });
  await sessions().deleteOne({ id: req.params.id });
  res.status(204).end();
});

router.post('/start', adminOnly, async (req, res) => {
  stopLive();
  const config = await readConfig();
  state.onAir = true;
  state.sessionId = newId('live');
  state.startedAt = new Date().toISOString();
  state.lastBroadcasterSeen = Date.now();
  state.session = {
    id: state.sessionId,
    title: config.title,
    audience: config.audience,
    startedAt: state.startedAt,
    endedAt: null,
    peakViewers: 0,
    startedBy: req.user.username,
    attendees: []
  };
  state.sessionDirty = true;
  await saveSession();
  res.json({ startedAt: state.startedAt });
});

router.post('/stop', adminOnly, (req, res) => {
  stopLive();
  res.json({ ok: true });
});

// Appelé chaque seconde par l'appareil qui filme : nouveaux spectateurs à qui envoyer
// une offre, réponses reçues, spectateurs autorisés encore présents, et le détail de
// chaque spectateur (nom, compte, état) pour l'affichage dans l'admin.
router.get('/broadcaster/poll', adminOnly, async (req, res) => {
  if (!state.onAir) return res.status(409).json({ error: 'Le direct est arrêté.' });
  state.lastBroadcasterSeen = Date.now();
  cleanup();
  const config = await readConfig();

  const pending = [];
  const answers = [];
  const active = [];
  for (const viewer of state.viewers.values()) {
    if (viewer.status !== 'approved') continue;
    active.push(viewer.id);
    if (!viewer.offer) pending.push(viewer.id);
    else if (viewer.answer && !viewer.answerDelivered) {
      answers.push({ viewerId: viewer.id, sdp: viewer.answer });
      viewer.answerDelivered = true;
    }
  }
  const viewers = [...state.viewers.values()].map(v => ({
    id: v.id,
    name: v.name,
    account: v.account,
    status: v.status === 'waiting' ? 'waiting' : v.playing ? 'connected' : 'connecting',
    joinedAt: v.joinedAt,
    handRaised: !!v.handRaised,
    handRaisedAt: v.handRaisedAt || null
  }));
  // Réactions de la dernière minute, comptées par émoji.
  const reactionCounts = {};
  for (const r of recentReactions()) reactionCounts[r.emoji] = (reactionCounts[r.emoji] || 0) + 1;
  res.json({
    pending,
    answers,
    active,
    viewers,
    maxViewers: config.maxViewers || DEFAULT_MAX_VIEWERS,
    chat: { version: state.chatVersion, messages: state.chat.slice(-CHAT_SENT_TO_VIEWERS).map(publicMessage) },
    reactionCounts
  });
});

router.post('/broadcaster/offer', adminOnly, (req, res) => {
  const viewer = state.viewers.get(req.body?.viewerId);
  if (!viewer || viewer.status !== 'approved') return res.status(404).json({ error: 'Spectateur parti.' });
  if (!isValidSdp(req.body?.sdp)) return res.status(400).json({ error: 'Offre invalide.' });
  viewer.offer = req.body.sdp;
  res.json({ ok: true });
});

module.exports = router;
// Pour l'aperçu de partage de la page /direct (server.js).
module.exports.publicShareInfo = publicShareInfo;
module.exports.privateShareInfo = privateShareInfo;
module.exports.shareImageKey = shareImageKey;
