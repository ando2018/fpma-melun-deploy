const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const JsonStore = require('../utils/jsonStore');
const { toAbsoluteUrl } = require('../utils/baseUrl');

const router = express.Router();
const store = new JsonStore(path.join(__dirname, '..', 'data', 'annonces.json'));

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const UPLOAD_DIR = path.join(__dirname, '..', 'storage', 'vaovao');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function slugify(name) {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'image';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const base = slugify(path.parse(file.originalname).name);
      cb(null, `${base}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!IMAGE_EXT.includes(ext)) {
      return cb(new Error('Type de fichier non supporté (image uniquement)'));
    }
    cb(null, true);
  }
});

function generateId() {
  return `annonce-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function sortByPublishedAtDesc(annonces) {
  // Compare de vraies dates (pas juste les chaînes) pour rester correct même si une
  // date est mal formée dans les données (ex: "206-03-01") — elle est alors reléguée
  // en fin de liste au lieu de fausser l'ordre des autres.
  const dateValue = a => {
    const t = Date.parse(a.publishedAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...annonces].sort((a, b) => dateValue(b) - dateValue(a));
}

// Résout le champ "image" (chemin relatif /storage/... stocké) en URL absolue selon
// la requête en cours — évite de figer un host/port dans les données stockées.
function withAbsoluteImage(annonce, req) {
  return { ...annonce, image: toAbsoluteUrl(req, annonce.image) };
}

// POST /api/vaovao/upload-image - envoie une image sur le serveur, renvoie son URL
// (chemin relatif, résolu dynamiquement à la lecture — voir withAbsoluteImage) à
// réutiliser comme champ "image" lors de la création/modification d'une annonce.
router.post('/upload-image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ "file")' });
  const relativeUrl = `/storage/vaovao/${encodeURIComponent(req.file.filename)}`;
  res.status(201).json({ url: relativeUrl });
});

// GET /api/vaovao - liste publique (sans les annonces masquées), triée par date décroissante
router.get('/', (req, res) => {
  const annonces = sortByPublishedAtDesc(store.readAll().filter(a => !a.masque));
  res.json(annonces.map(a => withAbsoluteImage(a, req)));
});

// GET /api/vaovao/all - liste complète (admin), y compris masquées, triée par date décroissante
router.get('/all', (req, res) => {
  const annonces = sortByPublishedAtDesc(store.readAll());
  res.json(annonces.map(a => withAbsoluteImage(a, req)));
});

// GET /api/vaovao/:id
router.get('/:id', (req, res) => {
  const annonce = store.readAll().find(a => a.id === req.params.id);
  if (!annonce) return res.status(404).json({ error: 'Annonce introuvable' });
  res.json(withAbsoluteImage(annonce, req));
});

// POST /api/vaovao
router.post('/', (req, res) => {
  const all = store.readAll();
  const annonce = { ...req.body, id: generateId() };
  all.unshift(annonce);
  store.writeAll(all);
  res.status(201).json(annonce);
});

// PUT /api/vaovao/:id
router.put('/:id', (req, res) => {
  const all = store.readAll();
  const index = all.findIndex(a => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Annonce introuvable' });
  all[index] = { ...all[index], ...req.body, id: all[index].id };
  store.writeAll(all);
  res.json(all[index]);
});

// DELETE /api/vaovao/:id
router.delete('/:id', (req, res) => {
  const all = store.readAll();
  const filtered = all.filter(a => a.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ error: 'Annonce introuvable' });
  store.writeAll(filtered);
  res.status(204).end();
});

// PATCH /api/vaovao/:id/masque - bascule masqué/visible
router.patch('/:id/masque', (req, res) => {
  const all = store.readAll();
  const index = all.findIndex(a => a.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Annonce introuvable' });
  all[index].masque = !all[index].masque;
  store.writeAll(all);
  res.json(all[index]);
});

module.exports = router;
