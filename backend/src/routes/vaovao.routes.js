const fs = require('fs');
const path = require('path');
const multer = require('multer');
const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID } = require('../utils/db');
const { toAbsoluteUrl } = require('../utils/baseUrl');
const { requireTab } = require('../utils/auth');

const router = asyncRouter();
const annonces = () => col('annonces');
// Lecture publique ; modifications réservées à l'onglet Vaovao de l'admin.
const canEdit = requireTab('vaovao');

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

// Champs envoyés par le site, sans les identifiants (jamais modifiables).
function editableFields(body) {
  const { id, _id, ...fields } = body || {};
  return fields;
}

function sortByPublishedAtDesc(list) {
  // Compare de vraies dates (pas juste les chaînes) pour rester correct même si une
  // date est mal formée dans les données (ex: "206-03-01") — elle est alors reléguée
  // en fin de liste au lieu de fausser l'ordre des autres.
  const dateValue = a => {
    const t = Date.parse(a.publishedAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...list].sort((a, b) => dateValue(b) - dateValue(a));
}

// Résout le champ "image" (chemin relatif /storage/... stocké) en URL absolue selon
// la requête en cours — évite de figer un host/port dans les données stockées.
function withAbsoluteImage(annonce, req) {
  return { ...annonce, image: toAbsoluteUrl(req, annonce.image) };
}

// POST /api/vaovao/upload-image - envoie une image sur le serveur, renvoie son URL
// (chemin relatif, résolu dynamiquement à la lecture — voir withAbsoluteImage) à
// réutiliser comme champ "image" lors de la création/modification d'une annonce.
router.post('/upload-image', canEdit, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ "file")' });
  const relativeUrl = `/storage/vaovao/${encodeURIComponent(req.file.filename)}`;
  res.status(201).json({ url: relativeUrl });
});

// GET /api/vaovao - liste publique (sans les annonces masquées), triée par date décroissante
router.get('/', async (req, res) => {
  const list = await annonces().find({ masque: { $ne: true } }, NO_ID).toArray();
  res.json(sortByPublishedAtDesc(list).map(a => withAbsoluteImage(a, req)));
});

// GET /api/vaovao/all - liste complète (admin), y compris masquées, triée par date décroissante
router.get('/all', canEdit, async (req, res) => {
  const list = await annonces().find({}, NO_ID).toArray();
  res.json(sortByPublishedAtDesc(list).map(a => withAbsoluteImage(a, req)));
});

// GET /api/vaovao/:id
router.get('/:id', async (req, res) => {
  const annonce = await annonces().findOne({ id: req.params.id }, NO_ID);
  if (!annonce) return res.status(404).json({ error: 'Annonce introuvable' });
  res.json(withAbsoluteImage(annonce, req));
});

// POST /api/vaovao
router.post('/', canEdit, async (req, res) => {
  const annonce = { ...editableFields(req.body), id: generateId() };
  await annonces().insertOne({ ...annonce });
  res.status(201).json(annonce);
});

// PUT /api/vaovao/:id
router.put('/:id', canEdit, async (req, res) => {
  const updated = await annonces().findOneAndUpdate(
    { id: req.params.id },
    { $set: editableFields(req.body) },
    { returnDocument: 'after', ...NO_ID }
  );
  if (!updated) return res.status(404).json({ error: 'Annonce introuvable' });
  res.json(updated);
});

// DELETE /api/vaovao/:id
router.delete('/:id', canEdit, async (req, res) => {
  const { deletedCount } = await annonces().deleteOne({ id: req.params.id });
  if (!deletedCount) return res.status(404).json({ error: 'Annonce introuvable' });
  res.status(204).end();
});

// PATCH /api/vaovao/:id/masque - bascule masqué/visible
router.patch('/:id/masque', canEdit, async (req, res) => {
  const updated = await annonces().findOneAndUpdate(
    { id: req.params.id },
    [{ $set: { masque: { $not: [{ $eq: ['$masque', true] }] } } }],
    { returnDocument: 'after', ...NO_ID }
  );
  if (!updated) return res.status(404).json({ error: 'Annonce introuvable' });
  res.json(updated);
});

module.exports = router;
