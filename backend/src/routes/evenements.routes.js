const fs = require('fs');
const path = require('path');
const multer = require('multer');
const asyncRouter = require('../utils/asyncRouter');
const { optimizeUpload } = require('../utils/optimizeImage');
const { col, NO_ID } = require('../utils/db');
const { toAbsoluteUrl } = require('../utils/baseUrl');
const { requireTab } = require('../utils/auth');

const router = asyncRouter();
const evenements = () => col('evenements');
// Lecture publique ; modifications réservées à l'onglet Évènements de l'admin.
const canEdit = requireTab('evenements');

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

function editableFields(body) {
  const { id, _id, ...fields } = body || {};
  return fields;
}

// Résout le champ "image" (chemin relatif /storage/... stocké) en URL absolue selon
// la requête en cours — évite de figer un host/port dans les données stockées.
function withAbsoluteImage(evenement, req) {
  return { ...evenement, image: toAbsoluteUrl(req, evenement.image) };
}

// POST /api/evenements/upload-image - envoie une image sur le serveur, renvoie son URL
// (chemin relatif, résolu dynamiquement à la lecture — voir withAbsoluteImage) à
// réutiliser comme champ "image" lors de la création/modification d'un évènement.
router.post('/upload-image', canEdit, upload.single('file'), optimizeUpload, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ "file")' });
  const relativeUrl = `/storage/evenements/${encodeURIComponent(req.file.filename)}`;
  res.status(201).json({ url: relativeUrl });
});

// Ordre d'origine conservé (le plus récemment ajouté en premier), comme avant la base.
const NEWEST_FIRST = { _id: -1 };

// GET /api/evenements - liste publique (sans les évènements masqués)
router.get('/', async (req, res) => {
  const list = await evenements().find({ masque: { $ne: true } }, NO_ID).sort(NEWEST_FIRST).toArray();
  res.json(list.map(e => withAbsoluteImage(e, req)));
});

// GET /api/evenements/all - liste complète (admin), y compris masqués
router.get('/all', canEdit, async (req, res) => {
  const list = await evenements().find({}, NO_ID).sort(NEWEST_FIRST).toArray();
  res.json(list.map(e => withAbsoluteImage(e, req)));
});

// GET /api/evenements/:id
router.get('/:id', async (req, res) => {
  const evenement = await evenements().findOne({ id: req.params.id }, NO_ID);
  if (!evenement) return res.status(404).json({ error: 'Évènement introuvable' });
  res.json(withAbsoluteImage(evenement, req));
});

// POST /api/evenements
router.post('/', canEdit, async (req, res) => {
  const evenement = { ...editableFields(req.body), id: generateId() };
  await evenements().insertOne({ ...evenement });
  res.status(201).json(evenement);
});

// PUT /api/evenements/:id
router.put('/:id', canEdit, async (req, res) => {
  const updated = await evenements().findOneAndUpdate(
    { id: req.params.id },
    { $set: editableFields(req.body) },
    { returnDocument: 'after', ...NO_ID }
  );
  if (!updated) return res.status(404).json({ error: 'Évènement introuvable' });
  res.json(updated);
});

// DELETE /api/evenements/:id
router.delete('/:id', canEdit, async (req, res) => {
  const { deletedCount } = await evenements().deleteOne({ id: req.params.id });
  if (!deletedCount) return res.status(404).json({ error: 'Évènement introuvable' });
  res.status(204).end();
});

// PATCH /api/evenements/:id/masque - bascule masqué/visible
router.patch('/:id/masque', canEdit, async (req, res) => {
  const updated = await evenements().findOneAndUpdate(
    { id: req.params.id },
    [{ $set: { masque: { $not: [{ $eq: ['$masque', true] }] } } }],
    { returnDocument: 'after', ...NO_ID }
  );
  if (!updated) return res.status(404).json({ error: 'Évènement introuvable' });
  res.json(updated);
});

module.exports = router;
