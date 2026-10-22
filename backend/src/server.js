require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const vaovaoRoutes = require('./routes/vaovao.routes');
const evenementsRoutes = require('./routes/evenements.routes');
const saryRoutes = require('./routes/sary.routes');
const contactRoutes = require('./routes/contact.routes');
const statsRoutes = require('./routes/stats.routes');
const tombolaRoutes = require('./routes/tombola.routes');
const authRoutes = require('./routes/auth.routes');
const pushRoutes = require('./routes/push.routes');
const liveRoutes = require('./routes/live.routes');
const usersRoutes = require('./routes/users.routes');
const shareImageRoutes = require('./routes/shareImage.routes');
const banniereRoutes = require('./routes/banniere.routes');

const { connectDb, col } = require('./utils/db');
const { importJsonOnce } = require('./utils/importJson');
const { isHealthy, markExistingData, restoreLatest, startBackups, log: backupLog } = require('./utils/backup');
const { initPush } = require('./utils/push');
const { getBaseUrl } = require('./utils/baseUrl');
const { annonceSlug } = require('./utils/annonceSlug');
const { injectSocialMeta, buildDescription, articleImage, versetImage } = require('./utils/socialMeta');

const app = express();
const PORT = process.env.PORT || 3000;

// Nécessaire derrière un reverse-proxy (Apache/Nginx) pour que req.protocol reflète
// bien "https" via l'en-tête X-Forwarded-Proto (sinon les URLs générées, ex: images
// uploadées, seraient construites en http:// même en production).
app.set('trust proxy', true);

// CORS ouvert pour l'instant (dev). En production, restreindre à l'origine du site :
// app.use(cors({ origin: 'https://fpma-melun.org' }));
app.use(cors());
app.use(express.json());

// Sert les fichiers uploadés (images/vidéos des albums Sary) de façon statique.
app.use('/storage', express.static(path.join(__dirname, 'storage')));

app.use('/api/vaovao', vaovaoRoutes);
app.use('/api/evenements', evenementsRoutes);
app.use('/api/sary', saryRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/tombola', tombolaRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/share-image', shareImageRoutes);
app.use('/api/banniere', banniereRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Sert le build Angular (fpma-site) directement depuis ce serveur : ouvrir l'URL du
// backend affiche le site (utile en dev, ou en déploiement sans Apache/Nginx devant).
// Chemin configurable via FRONTEND_DIST_PATH (utile si les deux projets ne sont pas
// des dossiers frères) ; par défaut on suppose fpma-site/ à côté de fpma-backend/.
const FRONTEND_DIST_PATH =
  process.env.FRONTEND_DIST_PATH || path.join(__dirname, '..', '..', 'frontend');
const FRONTEND_INDEX = path.join(FRONTEND_DIST_PATH, 'index.html');

if (fs.existsSync(FRONTEND_INDEX)) {
  app.use(express.static(FRONTEND_DIST_PATH));

  // Envoie index.html en y injectant des balises Open Graph / Twitter Card dynamiques,
  // pour que le lien partagé (WhatsApp, Facebook, Messenger...) affiche le bon titre et
  // le bon lien au lieu de la page générique du site (sans image, volontairement).
  function sendIndexWithMeta(req, res, meta) {
    const html = fs.readFileSync(FRONTEND_INDEX, 'utf-8');
    res.send(injectSocialMeta(html, meta));
  }

  // Fallback SPA : toute route qui n'est ni une API ni un fichier existant renvoie
  // index.html, pour laisser le Router Angular gérer l'URL côté client.
  app.get('*', async (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/storage')) {
      return next();
    }
    try {
      await sendPage(req, res);
    } catch (err) {
      next(err);
    }
  });

  // Image d'aperçu d'un album : sa première photo (dans l'ordre affiché sur la page de
  // l'album), en version allégée via /api/share-image ; sinon la miniature de sa
  // première vidéo YouTube.
  const SARY_DIR = path.join(__dirname, 'storage', 'sary');
  // encodeURIComponent laisse passer l'apostrophe, mal reconnue par certains robots d'aperçu.
  const encodeUrlPart = value => encodeURIComponent(value).replace(/'/g, '%27');
  function albumImage(album, baseUrl) {
    const dir = path.join(SARY_DIR, album.id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const photo = files.find(f => !f.startsWith('.') && /\.(jpe?g|png|webp|gif)$/i.test(f));
    if (photo) return `${baseUrl}/api/share-image/sary/${encodeUrlPart(album.id)}/${encodeUrlPart(photo)}`;
    for (const link of album.links || []) {
      const image = articleImage({ videoUrl: link.url }, baseUrl);
      if (image) return image;
    }
    return undefined;
  }

  async function sendPage(req, res) {
    const articleMatch = req.path.match(/^\/vaovao\/article\/([^/]+)\/?$/);
    if (articleMatch) {
      const annonces = await col('annonces').find({}, { projection: { _id: 0, title: 1, description: 1, image: 1, videoUrl: 1 } }).toArray();
      const annonce = annonces.find(a => annonceSlug(a.title) === articleMatch[1]);
      if (annonce) {
        return sendIndexWithMeta(req, res, {
          title: `${annonce.title} — FPMA Melun`,
          description: buildDescription(annonce.description) || 'Actualités de la FPMA Melun.',
          url: `${getBaseUrl(req)}${req.originalUrl}`,
          image: articleImage(annonce, getBaseUrl(req)),
          type: 'article'
        });
      }
    }

    // Aperçu de partage d'un album Sary : le lien est construit à partir du nom affiché.
    const albumMatch = req.path.match(/^\/sary\/album\/([^/]+)\/?$/);
    if (albumMatch) {
      const albums = await col('sary_albums').find({}, { projection: { _id: 0, id: 1, nom: 1, links: 1 } }).toArray();
      const album = albums.find(a => annonceSlug(a.nom || a.id) === albumMatch[1] || a.id === albumMatch[1]);
      if (album) {
        const nom = album.nom || album.id;
        return sendIndexWithMeta(req, res, {
          title: `${nom} — Sary FPMA Melun`,
          description: `Album photos « ${nom} » de la FPMA Melun.`,
          url: `${getBaseUrl(req)}${req.originalUrl}`,
          image: albumImage(album, getBaseUrl(req))
        });
      }
    }

    if (req.path === '/verset-du-jour') {
      return sendIndexWithMeta(req, res, {
        title: 'Verset du jour — FPMA Melun',
        description: 'Découvrez le verset du jour de la FPMA Melun.',
        url: `${getBaseUrl(req)}${req.originalUrl}`,
        image: versetImage()
      });
    }

    res.sendFile(FRONTEND_INDEX);
  }

  console.log(`Frontend Angular servi depuis ${FRONTEND_DIST_PATH}`);
} else {
  console.log(`Frontend Angular introuvable (${FRONTEND_DIST_PATH}) — le backend sert uniquement l'API.`);
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Erreur interne du serveur' });
});

// La base doit être prête avant d'accepter des requêtes.
async function start() {
  await connectDb();
  console.log(`MongoDB connecté (base « ${process.env.MONGODB_DB || 'fpma'} »)`);

  // Base vide (première installation, ou base vidée) : on restaure la dernière sauvegarde
  // automatique si elle existe ; les anciens fichiers JSON ne servent qu'en dernier recours,
  // car ils ramènent le site à son état du jour du passage à MongoDB.
  //
  // L'import des fichiers JSON (seed) est désactivé par défaut : il ne se fait que si
  // IMPORT_JSON_ON_START=true dans le .env, ou à la main avec `npm run import-json`.
  if (!(await isHealthy())) {
    const restored = await restoreLatest();
    if (restored) {
      backupLog(`Base vide au démarrage : restaurée depuis la sauvegarde ${restored.file} : ${JSON.stringify(restored.counts)}`);
    } else if (/^(true|1|oui|yes|on)$/i.test(String(process.env.IMPORT_JSON_ON_START ?? '').trim())) {
      const imported = await importJsonOnce();
      if (imported) console.log('Anciennes données JSON importées dans MongoDB :', imported);
    } else if (await markExistingData()) {
      console.log('Base existante reconnue (aucun import des fichiers JSON).');
    } else {
      console.warn('Base vide et import des fichiers JSON désactivé : lancez « npm run import-json » si besoin.');
    }
  }

  await initPush();
  startBackups();

  app.listen(PORT, () => {
    console.log(`FPMA backend à l'écoute sur http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Démarrage impossible :', err.message);
  console.error('Vérifiez que MongoDB est lancé et que MONGODB_URI (fichier .env) est correct.');
  process.exit(1);
});
