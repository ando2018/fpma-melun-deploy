const fs = require('fs');
const path = require('path');
const multer = require('multer');
const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID, isDuplicateKey } = require('../utils/db');
const { getBaseUrl } = require('../utils/baseUrl');

// Albums photo : les fichiers (images, vidéos) restent sur le disque, dans
// storage/sary/<id-album>/ ; le nom de l'album, sa date, les liens YouTube et les titres
// des fichiers sont en base (collection « sary_albums »).

const router = asyncRouter();
const albums = () => col('sary_albums');
const SARY_DIR = path.join(__dirname, '..', 'storage', 'sary');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const VIDEO_EXT = ['.mp4', '.webm'];

fs.mkdirSync(SARY_DIR, { recursive: true });

function slugify(name) {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `dossier-${Date.now()}`;
}

function titleFromFilename(filename) {
  return path.parse(filename).name.replace(/[-_]+/g, ' ').trim();
}

function albumDir(albumId) {
  return path.join(SARY_DIR, albumId);
}

// Un dossier ajouté directement sur le disque (ex. par FTP) devient un album en base.
async function syncFoldersWithDb() {
  const folders = fs
    .readdirSync(SARY_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  const known = new Set((await albums().find({}, { projection: { id: 1 } }).toArray()).map(a => a.id));
  const missing = folders.filter(name => !known.has(name));
  if (!missing.length) return;
  try {
    await albums().insertMany(
      missing.map(name => ({
        id: name,
        nom: name,
        dateCreation: fs.statSync(albumDir(name)).birthtime.toISOString().slice(0, 10),
        links: [],
        titles: []
      })),
      { ordered: false }
    );
  } catch (err) {
    // Deux requêtes simultanées peuvent créer la même fiche : la seconde est ignorée.
    if (!isDuplicateKey(err)) throw err;
  }
}

/**
 * Construit l'objet Dossier attendu par le front : fichiers lus sur le disque, liens et
 * titres lus en base. `baseUrl` rend absolues les URLs des fichiers uploadés.
 */
function toDossier(album, baseUrl) {
  const dir = albumDir(album.id);
  const titles = Object.fromEntries((album.titles || []).map(t => [t.file, t.titre]));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];

  const fileMedias = files
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      return !f.startsWith('.') && (IMAGE_EXT.includes(ext) || VIDEO_EXT.includes(ext));
    })
    .map(f => {
      const ext = path.extname(f).toLowerCase();
      return {
        id: f,
        type: IMAGE_EXT.includes(ext) ? 'image' : 'mp4',
        url: `${baseUrl}/storage/sary/${album.id}/${encodeURIComponent(f)}`,
        titre: titles[f] || titleFromFilename(f)
      };
    });

  return {
    id: album.id,
    nom: album.nom || album.id,
    dateCreation: album.dateCreation,
    medias: [...fileMedias, ...(album.links || [])]
  };
}

function findAlbum(id) {
  return albums().findOne({ id }, NO_ID);
}

// GET /api/sary - tous les albums, du plus récent au plus ancien
router.get('/', async (req, res) => {
  await syncFoldersWithDb();
  const list = await albums().find({}, NO_ID).sort({ dateCreation: -1 }).toArray();
  const baseUrl = getBaseUrl(req);
  res.json(list.map(album => toDossier(album, baseUrl)));
});

// GET /api/sary/:id
router.get('/:id', async (req, res) => {
  const album = await findAlbum(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  res.json(toDossier(album, getBaseUrl(req)));
});

// POST /api/sary  { nom } - crée un album (dossier sur le disque + fiche en base)
router.post('/', async (req, res) => {
  const { nom } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: 'nom requis' });

  const id = slugify(nom);
  if (fs.existsSync(albumDir(id)) || (await findAlbum(id))) {
    return res.status(409).json({ error: 'Un album avec ce nom existe déjà' });
  }

  fs.mkdirSync(albumDir(id));
  const album = { id, nom: nom.trim(), dateCreation: new Date().toISOString().slice(0, 10), links: [], titles: [] };
  await albums().insertOne({ ...album });
  res.status(201).json(toDossier(album, getBaseUrl(req)));
});

// PUT /api/sary/:id  { nom } - renomme l'album (affichage, sans renommer le dossier physique)
router.put('/:id', async (req, res) => {
  const nom = String(req.body?.nom || '').trim();
  const album = nom
    ? await albums().findOneAndUpdate({ id: req.params.id }, { $set: { nom } }, { returnDocument: 'after', ...NO_ID })
    : await findAlbum(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  res.json(toDossier(album, getBaseUrl(req)));
});

// DELETE /api/sary/:id - supprime l'album, son dossier et tout son contenu
router.delete('/:id', async (req, res) => {
  const { deletedCount } = await albums().deleteOne({ id: req.params.id });
  const dir = albumDir(req.params.id);
  const hadFolder = fs.existsSync(dir) && path.dirname(dir) === SARY_DIR;
  if (!deletedCount && !hadFolder) return res.status(404).json({ error: 'Album introuvable' });
  if (hadFolder) fs.rmSync(dir, { recursive: true, force: true });
  res.status(204).end();
});

// Upload de fichiers image/vidéo directement dans le dossier de l'album.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = albumDir(req.params.id);
      if (!fs.existsSync(dir)) return cb(new Error('Album introuvable'));
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const base = slugify(path.parse(file.originalname).name);
      cb(null, `${base}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!IMAGE_EXT.includes(ext) && !VIDEO_EXT.includes(ext)) {
      return cb(new Error('Type de fichier non supporté (image ou vidéo uniquement)'));
    }
    cb(null, true);
  }
});

// POST /api/sary/:id/medias
// - soit un fichier (multipart, champ "file", champ optionnel "titre") pour une image/vidéo à stocker sur le disque
// - soit un JSON { type: 'youtube', url, titre } pour un lien vidéo externe
router.post('/:id/medias', upload.single('file'), async (req, res) => {
  const album = await findAlbum(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });

  if (req.file) {
    const titre = String(req.body.titre || '').trim();
    if (titre) {
      await albums().updateOne({ id: album.id }, { $push: { titles: { file: req.file.filename, titre } } });
    }
    return res.status(201).json(toDossier(await findAlbum(album.id), getBaseUrl(req)));
  }

  const { type, url, titre } = req.body;
  if (!type || !url) return res.status(400).json({ error: 'type et url requis' });

  await albums().updateOne(
    { id: album.id },
    { $push: { links: { id: `link-${Date.now()}-${Math.floor(Math.random() * 10000)}`, type, url, titre } } }
  );
  res.status(201).json(toDossier(await findAlbum(album.id), getBaseUrl(req)));
});

// DELETE /api/sary/:id/medias/:mediaId - supprime un fichier ou un lien externe
router.delete('/:id/medias/:mediaId', async (req, res) => {
  const album = await findAlbum(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });

  const { mediaId } = req.params;
  const dir = albumDir(album.id);
  const filePath = path.join(dir, mediaId);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile() && path.dirname(filePath) === dir) {
    fs.unlinkSync(filePath);
    await albums().updateOne({ id: album.id }, { $pull: { titles: { file: mediaId } } });
    return res.status(204).end();
  }

  const { modifiedCount } = await albums().updateOne({ id: album.id }, { $pull: { links: { id: mediaId } } });
  if (modifiedCount) return res.status(204).end();

  res.status(404).json({ error: 'Média introuvable' });
});

module.exports = router;
