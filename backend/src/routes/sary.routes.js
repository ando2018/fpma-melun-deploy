const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { getBaseUrl } = require('../utils/baseUrl');

const router = express.Router();
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

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function readLinks(albumDir) {
  const links = readJsonSafe(path.join(albumDir, 'links.json'), []);
  return Array.isArray(links) ? links : [];
}

function writeLinks(albumDir, links) {
  writeJson(path.join(albumDir, 'links.json'), links);
}

/** Titres personnalisés des fichiers uploadés, tenus à part car un nom de fichier ne les porte pas. */
function readTitles(albumDir) {
  const titles = readJsonSafe(path.join(albumDir, 'titles.json'), {});
  return titles && typeof titles === 'object' ? titles : {};
}

function writeTitles(albumDir, titles) {
  writeJson(path.join(albumDir, 'titles.json'), titles);
}

/**
 * Lit un dossier d'album sur le disque et construit l'objet Dossier attendu par le front.
 * `baseUrl` (ex: http://localhost:3001) sert à rendre absolues les URLs des fichiers
 * uploadés, car le front (autre origine) ne peut pas résoudre un chemin relatif "/storage/...".
 */
function scanAlbum(albumId, baseUrl) {
  const albumDir = path.join(SARY_DIR, albumId);
  const stat = fs.statSync(albumDir);
  const meta = readJsonSafe(path.join(albumDir, 'meta.json'), {});
  const titles = readTitles(albumDir);

  const files = fs
    .readdirSync(albumDir)
    .filter(f => f !== 'links.json' && f !== 'meta.json' && f !== 'titles.json' && !f.startsWith('.'));

  const fileMedias = files
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      return IMAGE_EXT.includes(ext) || VIDEO_EXT.includes(ext);
    })
    .map(f => {
      const ext = path.extname(f).toLowerCase();
      return {
        id: f,
        type: IMAGE_EXT.includes(ext) ? 'image' : 'mp4',
        url: `${baseUrl}/storage/sary/${albumId}/${encodeURIComponent(f)}`,
        titre: titles[f] || titleFromFilename(f)
      };
    });

  const linkMedias = readLinks(albumDir);

  return {
    id: albumId,
    nom: meta.nom || albumId,
    dateCreation: meta.dateCreation || stat.birthtime.toISOString().slice(0, 10),
    medias: [...fileMedias, ...linkMedias]
  };
}

function listAlbums(baseUrl) {
  return fs
    .readdirSync(SARY_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => scanAlbum(entry.name, baseUrl))
    .sort((a, b) => b.dateCreation.localeCompare(a.dateCreation));
}

// GET /api/sary - scanne le dossier storage/sary et renvoie tous les albums
router.get('/', (req, res) => {
  res.json(listAlbums(getBaseUrl(req)));
});

// GET /api/sary/:id
router.get('/:id', (req, res) => {
  const albumDir = path.join(SARY_DIR, req.params.id);
  if (!fs.existsSync(albumDir)) return res.status(404).json({ error: 'Album introuvable' });
  res.json(scanAlbum(req.params.id, getBaseUrl(req)));
});

// POST /api/sary  { nom } - crée un nouveau dossier sur le disque
router.post('/', (req, res) => {
  const { nom } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: 'nom requis' });

  const id = slugify(nom);
  const albumDir = path.join(SARY_DIR, id);
  if (fs.existsSync(albumDir)) {
    return res.status(409).json({ error: 'Un album avec ce nom existe déjà' });
  }

  fs.mkdirSync(albumDir);
  writeJson(path.join(albumDir, 'meta.json'), {
    nom: nom.trim(),
    dateCreation: new Date().toISOString().slice(0, 10)
  });

  res.status(201).json(scanAlbum(id, getBaseUrl(req)));
});

// PUT /api/sary/:id  { nom } - renomme l'album (affichage, sans renommer le dossier physique)
router.put('/:id', (req, res) => {
  const albumDir = path.join(SARY_DIR, req.params.id);
  if (!fs.existsSync(albumDir)) return res.status(404).json({ error: 'Album introuvable' });

  const { nom } = req.body;
  const meta = readJsonSafe(path.join(albumDir, 'meta.json'), {});
  if (nom && nom.trim()) {
    meta.nom = nom.trim();
  }
  writeJson(path.join(albumDir, 'meta.json'), meta);

  res.json(scanAlbum(req.params.id, getBaseUrl(req)));
});

// DELETE /api/sary/:id - supprime le dossier et tout son contenu
router.delete('/:id', (req, res) => {
  const albumDir = path.join(SARY_DIR, req.params.id);
  if (!fs.existsSync(albumDir)) return res.status(404).json({ error: 'Album introuvable' });
  fs.rmSync(albumDir, { recursive: true, force: true });
  res.status(204).end();
});

// Upload de fichiers image/vidéo directement dans le dossier de l'album.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const albumDir = path.join(SARY_DIR, req.params.id);
      if (!fs.existsSync(albumDir)) return cb(new Error('Album introuvable'));
      cb(null, albumDir);
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
router.post('/:id/medias', upload.single('file'), (req, res) => {
  const albumDir = path.join(SARY_DIR, req.params.id);
  if (!fs.existsSync(albumDir)) return res.status(404).json({ error: 'Album introuvable' });

  if (req.file) {
    if (req.body.titre && req.body.titre.trim()) {
      const titles = readTitles(albumDir);
      titles[req.file.filename] = req.body.titre.trim();
      writeTitles(albumDir, titles);
    }
    return res.status(201).json(scanAlbum(req.params.id, getBaseUrl(req)));
  }

  const { type, url, titre } = req.body;
  if (!type || !url) return res.status(400).json({ error: 'type et url requis' });

  const links = readLinks(albumDir);
  links.push({
    id: `link-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    type,
    url,
    titre
  });
  writeLinks(albumDir, links);

  res.status(201).json(scanAlbum(req.params.id, getBaseUrl(req)));
});

// DELETE /api/sary/:id/medias/:mediaId - supprime un fichier ou une entrée de lien externe
router.delete('/:id/medias/:mediaId', (req, res) => {
  const albumDir = path.join(SARY_DIR, req.params.id);
  if (!fs.existsSync(albumDir)) return res.status(404).json({ error: 'Album introuvable' });

  const { mediaId } = req.params;
  const filePath = path.join(albumDir, mediaId);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile() && path.dirname(filePath) === albumDir) {
    fs.unlinkSync(filePath);
    const titles = readTitles(albumDir);
    if (titles[mediaId]) {
      delete titles[mediaId];
      writeTitles(albumDir, titles);
    }
    return res.status(204).end();
  }

  const links = readLinks(albumDir);
  const filtered = links.filter(l => l.id !== mediaId);
  if (filtered.length !== links.length) {
    writeLinks(albumDir, filtered);
    return res.status(204).end();
  }

  res.status(404).json({ error: 'Média introuvable' });
});

module.exports = router;
