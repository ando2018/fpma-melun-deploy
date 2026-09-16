const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const JsonStore = require('../utils/jsonStore');

const router = express.Router();
const store = new JsonStore(path.join(__dirname, '..', 'data', 'evenements.json'));

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const UPLOAD_DIR = path.join(__dirname, '..', 'storage', 'evenements');
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
  return `evenement-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// POST /api/evenements/upload-image - envoie une image sur le serveur, renvoie son URL
// à réutiliser comme champ "image" lors de la création/modification d'un évènement.
router.post('/upload-image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ "file")' });
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ url: `${baseUrl}/storage/evenements/${encodeURIComponent(req.file.filename)}` });
});

// GET /api/evenements - liste publique (sans les évènements masqués)
router.get('/', (req, res) => {
  res.json(store.readAll().filter(e => !e.masque));
});

// GET /api/evenements/all - liste complète (admin), y compris masqués
router.get('/all', (req, res) => {
  res.json(store.readAll());
});

// GET /api/evenements/:id
router.get('/:id', (req, res) => {
  const evenement = store.readAll().find(e => e.id === req.params.id);
  if (!evenement) return res.status(404).json({ error: 'Évènement introuvable' });
  res.json(evenement);
});

// POST /api/evenements
router.post('/', (req, res) => {
  const all = store.readAll();
  const evenement = { ...req.body, id: generateId() };
  all.unshift(evenement);
  store.writeAll(all);
  res.status(201).json(evenement);
});

// PUT /api/evenements/:id
router.put('/:id', (req, res) => {
  const all = store.readAll();
  const index = all.findIndex(e => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Évènement introuvable' });
  all[index] = { ...all[index], ...req.body, id: all[index].id };
  store.writeAll(all);
  res.json(all[index]);
});

// DELETE /api/evenements/:id
router.delete('/:id', (req, res) => {
  const all = store.readAll();
  const filtered = all.filter(e => e.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ error: 'Évènement introuvable' });
  store.writeAll(filtered);
  res.status(204).end();
});

// PATCH /api/evenements/:id/masque - bascule masqué/visible
router.patch('/:id/masque', (req, res) => {
  const all = store.readAll();
  const index = all.findIndex(e => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Évènement introuvable' });
  all[index].masque = !all[index].masque;
  store.writeAll(all);
  res.json(all[index]);
});

module.exports = router;
