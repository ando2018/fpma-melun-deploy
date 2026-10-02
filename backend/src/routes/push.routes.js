const express = require('express');
const path = require('path');
const JsonStore = require('../utils/jsonStore');
const { requireRole } = require('../utils/auth');
const { annonceSlug } = require('../utils/annonceSlug');
const { toAbsoluteUrl } = require('../utils/baseUrl');
const push = require('../utils/push');

const router = express.Router();
const annoncesStore = new JsonStore(path.join(__dirname, '..', 'data', 'annonces.json'));

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

// ---------- Public (visiteurs) ----------

router.get('/public-key', (req, res) => {
  res.json({ publicKey: push.getPublicKey() });
});

router.post('/subscribe', (req, res) => {
  const sub = req.body?.subscription;
  if (!push.isValidSubscription(sub)) return res.status(400).json({ error: 'Abonnement invalide.' });
  push.addSubscription(sub);
  res.status(201).json({ ok: true });
});

router.post('/unsubscribe', (req, res) => {
  if (typeof req.body?.endpoint === 'string') push.removeSubscription(req.body.endpoint);
  res.json({ ok: true });
});

// ---------- Admin ----------

const adminOnly = requireRole('admin');

router.get('/stats', adminOnly, (req, res) => {
  res.json({ abonnes: push.countSubscriptions(), historique: push.getHistory() });
});

// POST /api/push/article/:id - notifie les abonnés de la publication d'un article
router.post('/article/:id', adminOnly, async (req, res) => {
  const annonce = annoncesStore.readAll().find(a => a.id === req.params.id);
  if (!annonce) return res.status(404).json({ error: 'Article introuvable' });
  if (annonce.masque) return res.status(400).json({ error: 'Article masqué : aucune notification envoyée.' });

  const image = toAbsoluteUrl(req, annonce.image);
  const entry = await push.sendToAll(
    {
      title: annonce.title,
      body: truncate(stripHtml(annonce.description), 140) || 'Nouvel article sur le site de la FPMA Melun.',
      url: `/vaovao/article/${annonceSlug(annonce.title)}`,
      action: "📖 Lire l'article",
      image: /^https?:\/\//.test(image || '') ? image : undefined
    },
    { type: 'article', utilisateur: req.user.username }
  );
  res.json(entry);
});

// POST /api/push/send - notification d'information libre ({ title, body, url? })
router.post('/send', adminOnly, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  // Sans lien explicite, une adresse écrite dans la description sert de lien au clic.
  // « Https:// » (majuscule tapée sur téléphone) est accepté et remis en minuscules.
  const rawUrl = String(req.body?.url || '').trim() || (body.match(/https?:\/\/[^\s<>"]+/i) || [''])[0].replace(/[.,;:!?)]+$/, '');
  const url = rawUrl.replace(/^https?:\/\//i, scheme => scheme.toLowerCase());
  if (!title) return res.status(400).json({ error: 'Le titre est requis.' });
  if (!body) return res.status(400).json({ error: 'La description est requise.' });
  if (title.length > 100) return res.status(400).json({ error: 'Titre trop long (100 caractères max).' });
  if (body.length > 300) return res.status(400).json({ error: 'Description trop longue (300 caractères max).' });
  // Lien interne (« /contact ») ou adresse web complète uniquement.
  if (url && !/^\/(?!\/)/.test(url) && !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'Le lien doit commencer par / ou http(s)://' });
  }

  const entry = await push.sendToAll(
    { title, body, url: url || '/', action: url ? '🔗 Ouvrir le lien' : undefined },
    { type: 'information', utilisateur: req.user.username }
  );
  res.json(entry);
});

module.exports = router;
