const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const JsonStore = require('../utils/jsonStore');

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

// POST /api/vaovao/upload-image - envoie une image sur le serveur, renvoie son URL
// à réutiliser comme champ "image" lors de la création/modification d'une annonce.
router.post('/upload-image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ "file")' });
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ url: `${baseUrl}/storage/vaovao/${encodeURIComponent(req.file.filename)}` });
});

// GET /api/vaovao - liste publique (sans les annonces masquées), triée par date décroissante
router.get('/', (req, res) => {
  res.json(sortByPublishedAtDesc(store.readAll().filter(a => !a.masque)));
});

// GET /api/vaovao/all - liste complète (admin), y compris masquées, triée par date décroissante
router.get('/all', (req, res) => {
  res.json(sortByPublishedAtDesc(store.readAll()));
});

// GET /api/vaovao/:id
router.get('/:id', (req, res) => {
  const annonce = store.readAll().find(a => a.id === req.params.id);
  if (!annonce) return res.status(404).json({ error: 'Annonce introuvable' });
  res.json(annonce);
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
