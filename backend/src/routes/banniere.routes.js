const fs = require('fs');
const path = require('path');
const multer = require('multer');
const asyncRouter = require('../utils/asyncRouter');
const { optimizeUpload } = require('../utils/optimizeImage');
const { col, NO_ID } = require('../utils/db');
const { toAbsoluteUrl } = require('../utils/baseUrl');
const { requireTab } = require('../utils/auth');

// Partie droite de la bannière du site, changeable selon les évènements (la partie
// gauche, Église Protestante Malgache en France, reste fixe). Chaque image a une période d'affichage facultative ;
// en dehors de toute période, le site affiche l'image par défaut.
const router = asyncRouter();
const bannieres = () => col('bannieres');
const canEdit = requireTab('banniere');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const UPLOAD_DIR = path.join(__dirname, '..', 'storage', 'banniere');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `banniere-${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!IMAGE_EXT.includes(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('Type de fichier non supporté (image uniquement)'));
    }
    cb(null, true);
  }
});

// Date du jour à Paris (AAAA-MM-JJ), pour changer de bannière à minuit heure française.
function todayParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

function withAbsoluteImage(banniere, req) {
  return { ...banniere, image: toAbsoluteUrl(req, banniere.image) };
}

// Valide et normalise les champs envoyés par l'admin.
function readFields(body, partial) {
  const fields = {};
  const errors = [];
  if (!partial || body.titre !== undefined) {
    fields.titre = String(body.titre || '').trim();
    if (!fields.titre) errors.push('Le nom est obligatoire.');
  }
  if (!partial || body.image !== undefined) {
    fields.image = String(body.image || '').trim();
    if (!fields.image) errors.push('L\'image est obligatoire.');
  }
  for (const key of ['debut', 'fin']) {
    if (!partial || body[key] !== undefined) {
      const value = body[key] ? String(body[key]) : null;
      if (value && !DATE_RE.test(value)) errors.push('Date invalide.');
      fields[key] = value;
    }
  }
  if (!partial || body.actif !== undefined) fields.actif = body.actif !== false;
  return { fields, errors };
}

// GET /api/banniere/actuelle - public : image à afficher aujourd'hui (null = image par défaut).
// Si plusieurs périodes se chevauchent, celle qui a commencé le plus récemment l'emporte.
router.get('/actuelle', async (req, res) => {
  const today = todayParis();
  const list = await bannieres()
    .find(
      {
        actif: true,
        $and: [
          { $or: [{ debut: null }, { debut: { $lte: today } }] },
          { $or: [{ fin: null }, { fin: { $gte: today } }] }
        ]
      },
      NO_ID
    )
    .sort({ debut: -1, _id: -1 })
    .limit(1)
    .toArray();
  const current = list[0];
  res.set('Cache-Control', 'no-cache');
  res.json(current ? { titre: current.titre, image: toAbsoluteUrl(req, current.image) } : { titre: null, image: null });
});

// POST /api/banniere/upload-image
router.post('/upload-image', canEdit, upload.single('file'), optimizeUpload, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ "file")' });
  res.status(201).json({ url: `/storage/banniere/${encodeURIComponent(req.file.filename)}` });
});

// GET /api/banniere - liste pour l'admin (période la plus récente en premier)
router.get('/', canEdit, async (req, res) => {
  const list = await bannieres().find({}, NO_ID).sort({ debut: -1, _id: -1 }).toArray();
  res.json(list.map(b => withAbsoluteImage(b, req)));
});

router.post('/', canEdit, async (req, res) => {
  const { fields, errors } = readFields(req.body || {}, false);
  if (fields.debut && fields.fin && fields.fin < fields.debut) errors.push('La date de fin est avant la date de début.');
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const banniere = {
    id: `banniere-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    ...fields,
    createdAt: new Date().toISOString()
  };
  await bannieres().insertOne({ ...banniere });
  res.status(201).json(withAbsoluteImage(banniere, req));
});

router.put('/:id', canEdit, async (req, res) => {
  const current = await bannieres().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Bannière introuvable' });
  const { fields, errors } = readFields(req.body || {}, true);
  const debut = fields.debut !== undefined ? fields.debut : current.debut;
  const fin = fields.fin !== undefined ? fields.fin : current.fin;
  if (debut && fin && fin < debut) errors.push('La date de fin est avant la date de début.');
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  await bannieres().updateOne({ id: current.id }, { $set: fields });
  res.json(withAbsoluteImage({ ...current, ...fields }, req));
});

router.delete('/:id', canEdit, async (req, res) => {
  const current = await bannieres().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Bannière introuvable' });
  await bannieres().deleteOne({ id: current.id });
  // Supprime le fichier s'il n'est plus utilisé par une autre bannière.
  const file = (current.image || '').match(/^\/storage\/banniere\/([^/]+)$/);
  if (file && !(await bannieres().findOne({ image: current.image }))) {
    fs.promises.unlink(path.join(UPLOAD_DIR, decodeURIComponent(file[1]))).catch(() => undefined);
  }
  res.status(204).end();
});

module.exports = router;
