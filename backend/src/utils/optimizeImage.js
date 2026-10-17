const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Économise la mémoire sur un petit serveur : pas de cache d'images, un seul fil de
// calcul par image (une photo de 24 Mpx peut sinon occuper plusieurs centaines de Mo).
sharp.cache(false);
sharp.concurrency(1);

// Allège les images envoyées depuis l'admin, sans perte de qualité visible :
// - les photos plus grandes que 2560 px (côté le plus long) sont ramenées à 2560 px,
//   déjà plus que la résolution d'un écran ou d'un vidéoprojecteur ;
// - JPEG/WebP recompressés en qualité 85 (mozjpeg), indiscernable de l'original ;
// - PNG recompressé sans perte ;
// - l'orientation de la photo est appliquée, et les métadonnées (position GPS de
//   l'appareil, etc.) retirées, en gardant le profil couleur.
// Le fichier garde son nom et son extension. Si le résultat n'est pas plus léger,
// l'original est conservé. Les GIF (animés) et les vidéos ne sont pas touchés.
const MAX_SIZE = 2560;

async function optimizeImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return;

  const tmp = `${filePath}.optim.tmp`;
  try {
    let image = sharp(filePath, { sequentialRead: true })
      .rotate()
      .resize(MAX_SIZE, MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
      .keepIccProfile();
    if (ext === '.png') image = image.png({ compressionLevel: 9, adaptiveFiltering: true });
    else if (ext === '.webp') image = image.webp({ quality: 85 });
    else image = image.jpeg({ quality: 85, mozjpeg: true });
    await image.toFile(tmp);

    const [before, after] = await Promise.all([fs.promises.stat(filePath), fs.promises.stat(tmp)]);
    if (after.size < before.size) await fs.promises.rename(tmp, filePath);
    else await fs.promises.unlink(tmp);
  } catch (err) {
    // Image illisible par sharp : on garde le fichier tel qu'envoyé.
    console.warn(`Optimisation d'image ignorée (${path.basename(filePath)}) : ${err.message}`);
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

// Middleware à placer juste après multer (upload.single).
async function optimizeUpload(req, res, next) {
  if (req.file?.path) {
    await optimizeImage(req.file.path);
    req.file.size = (await fs.promises.stat(req.file.path)).size;
  }
  next();
}

module.exports = { optimizeImage, optimizeUpload };
