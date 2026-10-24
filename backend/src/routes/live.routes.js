const asyncRouter = require('../utils/asyncRouter');
const { getSetting, setSetting } = require('../utils/db');
const { authenticate, requireTab } = require('../utils/auth');
const { liveShareImage, shareImageKey } = require('../utils/liveShareImage');

// Direct vidéo en pair-à-pair (WebRTC) : la vidéo va directement de l'appareil qui filme
// (admin) à chaque spectateur. Ce serveur ne fait que la mise en relation (échange des
// descriptions de connexion) : aucune vidéo ne transite par lui et rien n'est enregistré.

const router = asyncRouter();

const MAX_VIEWERS = Number(process.env.LIVE_MAX_VIEWERS) || 25;
const VIEWER_TIMEOUT_MS = 20000;
const BROADCASTER_TIMEOUT_MS = 20000;
const MAX_SDP_LENGTH = 30000;

// audience : 'public' = tout le monde voit le direct ; 'test' = seulement les comptes
// connectés qui ont l'onglet Direct (pour vérifier image et son avant de publier).
const DEFAULT_CONFIG = { title: 'Culte en direct', description: '', visible: false, audience: 'public' };
const AUDIENCES = ['public', 'test'];

async function readConfig() {
  return { ...DEFAULT_CONFIG, ...(await getSetting('live-config', {})) };
}

function writeConfig(config) {
  return setSetting('live-config', config);
}

// État du direct en mémoire : une session est éphémère et n'a pas à survivre à un
// redémarrage du serveur.
const state = {
  onAir: false,
  sessionId: null,
  startedAt: null,
  lastBroadcasterSeen: 0,
  // viewerId -> { id, offer, answer, answerDelivered, lastSeen }
  viewers: new Map()
};

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function stopLive() {
  state.onAir = false;
  state.sessionId = null;
  state.startedAt = null;
  state.viewers.clear();
}

// Coupe le direct si l'appareil qui filme ne donne plus signe de vie (onglet fermé,
// réseau coupé) et oublie les spectateurs partis.
function cleanup() {
  const now = Date.now();
  if (state.onAir && now - state.lastBroadcasterSeen > BROADCASTER_TIMEOUT_MS) stopLive();
  for (const [id, viewer] of state.viewers) {
    if (now - viewer.lastSeen > VIEWER_TIMEOUT_MS) state.viewers.delete(id);
  }
}
setInterval(cleanup, 5000).unref();

// Le direct est-il visible pour ce visiteur ? En mode test, il faut être connecté avec
// l'onglet Direct (le jeton de connexion est envoyé automatiquement par le site).
async function canWatch(req, config) {
  if (!config.visible) return false;
  if (config.audience !== 'test') return true;
  const user = await authenticate(req).catch(() => null);
  return !!user && (user.role === 'admin' || user.tabs.includes('direct'));
}

function isValidSdp(sdp) {
  return typeof sdp === 'string' && sdp.length > 0 && sdp.length < MAX_SDP_LENGTH;
}

// Ce que voit le public du direct (lien de partage, aperçu) : un direct en mode test
// n'est jamais annoncé.
async function publicShareInfo() {
  cleanup();
  const config = await readConfig();
  const onAir = state.onAir && config.visible && config.audience !== 'test';
  return { onAir, title: config.title, description: config.description };
}

// ---------- Public (spectateurs) ----------

// GET /api/live/share-image.jpg - image d'aperçu du lien /direct (WhatsApp, Facebook…)
router.get('/share-image.jpg', async (req, res) => {
  const image = await liveShareImage(await publicShareInfo());
  res.set('Cache-Control', 'public, max-age=300');
  res.type('image/jpeg').send(image);
});

router.get('/status', async (req, res) => {
  cleanup();
  const config = await readConfig();
  const visible = await canWatch(req, config);
  // Réponse propre à chaque visiteur (mode test) : ne pas la mettre en cache.
  res.set('Cache-Control', 'no-store');
  res.json({
    title: config.title,
    description: config.description,
    visible,
    test: visible && config.audience === 'test',
    onAir: state.onAir,
    startedAt: state.startedAt,
    viewers: state.viewers.size,
    full: state.viewers.size >= MAX_VIEWERS
  });
});

router.post('/join', async (req, res) => {
  cleanup();
  if (!state.onAir || !(await canWatch(req, await readConfig()))) return res.status(409).json({ error: 'Aucun direct en cours.' });
  if (state.viewers.size >= MAX_VIEWERS) {
    return res.status(503).json({ error: 'Le direct est complet pour le moment, réessayez dans quelques minutes.' });
  }
  const viewer = { id: newId('viewer'), offer: null, answer: null, answerDelivered: false, lastSeen: Date.now() };
  state.viewers.set(viewer.id, viewer);
  res.status(201).json({ viewerId: viewer.id });
});

// Le spectateur interroge régulièrement : sert aussi de signe de présence.
router.get('/viewer/:id', (req, res) => {
  const viewer = state.viewers.get(req.params.id);
  if (!viewer) return res.status(404).json({ error: 'Direct terminé.' });
  viewer.lastSeen = Date.now();
  res.json({ offer: viewer.offer });
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
  state.viewers.delete(req.params.id);
  res.json({ ok: true });
});

// ---------- Admin (appareil qui filme) ----------

const adminOnly = requireTab('direct');

router.get('/config', adminOnly, async (req, res) => {
  res.json({ ...(await readConfig()), maxViewers: MAX_VIEWERS });
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

  const config = { title, description, visible, audience };
  await writeConfig(config);
  res.json({ ...config, maxViewers: MAX_VIEWERS });
});

router.post('/start', adminOnly, (req, res) => {
  stopLive();
  state.onAir = true;
  state.sessionId = newId('live');
  state.startedAt = new Date().toISOString();
  state.lastBroadcasterSeen = Date.now();
  res.json({ startedAt: state.startedAt });
});

router.post('/stop', adminOnly, (req, res) => {
  stopLive();
  res.json({ ok: true });
});

// Appelé chaque seconde par l'appareil qui filme : nouveaux spectateurs à qui envoyer
// une offre, réponses reçues, et liste des spectateurs encore présents.
router.get('/broadcaster/poll', adminOnly, (req, res) => {
  if (!state.onAir) return res.status(409).json({ error: 'Le direct est arrêté.' });
  state.lastBroadcasterSeen = Date.now();
  cleanup();

  const pending = [];
  const answers = [];
  for (const viewer of state.viewers.values()) {
    if (!viewer.offer) pending.push(viewer.id);
    else if (viewer.answer && !viewer.answerDelivered) {
      answers.push({ viewerId: viewer.id, sdp: viewer.answer });
      viewer.answerDelivered = true;
    }
  }
  res.json({ pending, answers, active: [...state.viewers.keys()], maxViewers: MAX_VIEWERS });
});

router.post('/broadcaster/offer', adminOnly, (req, res) => {
  const viewer = state.viewers.get(req.body?.viewerId);
  if (!viewer) return res.status(404).json({ error: 'Spectateur parti.' });
  if (!isValidSdp(req.body?.sdp)) return res.status(400).json({ error: 'Offre invalide.' });
  viewer.offer = req.body.sdp;
  res.json({ ok: true });
});

module.exports = router;
// Pour l'aperçu de partage de la page /direct (server.js).
module.exports.publicShareInfo = publicShareInfo;
module.exports.shareImageKey = shareImageKey;
