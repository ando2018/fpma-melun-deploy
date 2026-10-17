const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
require('../utils/optimizeImage'); // applique les réglages mémoire de sharp

// Version allégée des images uploadées, utilisée uniquement pour les aperçus de partage
// (og:image). WhatsApp n'affiche pas l'image d'un aperçu au-delà d'environ 600 Ko, or les
// photos prises au téléphone font souvent plusieurs Mo. L'image réduite est générée une
// seule fois puis gardée dans storage/.share-cache.
const router = express.Router();

const STORAGE_DIR = path.join(__dirname, '..', 'storage');
const CACHE_DIR = path.join(STORAGE_DIR, '.share-cache');
const MAX_WIDTH = 1200;
const MAX_HEIGHT = 1200;

router.get('/*', async (req, res, next) => {
  const relative = path.normalize(req.params[0] || '');
  const source = path.join(STORAGE_DIR, relative);
  // Refuse tout chemin qui sortirait du dossier storage (../) ou viserait le cache.
  if (!source.startsWith(STORAGE_DIR + path.sep) || source.startsWith(CACHE_DIR)) {
    return res.status(404).end();
  }

  try {
    const stat = await fs.promises.stat(source);
    if (!stat.isFile()) return res.status(404).end();

    const cacheFile = path.join(CACHE_DIR, `${relative.replace(/[\\/]/g, '__')}-${stat.mtimeMs}.jpg`);
    if (!fs.existsSync(cacheFile)) {
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      await sharp(source, { sequentialRead: true })
        .rotate() // applique l'orientation EXIF des photos de téléphone
        .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }) // PNG transparent -> fond blanc en JPEG
        .jpeg({ quality: 78, mozjpeg: true })
        .toFile(tmp);
      await fs.promises.rename(tmp, cacheFile);
    }

    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/jpeg').sendFile(cacheFile);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).end();
    // Format non reconnu (vidéo, fichier corrompu…) : on renvoie l'original.
    if (/unsupported image format|Input file/i.test(err.message)) return res.sendFile(source);
    next(err);
  }
});

module.exports = router;
