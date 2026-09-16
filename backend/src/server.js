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

const JsonStore = require('./utils/jsonStore');
const { getBaseUrl } = require('./utils/baseUrl');
const { annonceSlug } = require('./utils/annonceSlug');
const { injectSocialMeta, buildDescription } = require('./utils/socialMeta');

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

  const annonceStore = new JsonStore(path.join(__dirname, 'data', 'annonces.json'));

  // Envoie index.html en y injectant des balises Open Graph / Twitter Card dynamiques,
  // pour que le lien partagé (WhatsApp, Facebook, Messenger...) affiche le bon titre et
  // le bon lien au lieu de la page générique du site (sans image, volontairement).
  function sendIndexWithMeta(req, res, meta) {
    const html = fs.readFileSync(FRONTEND_INDEX, 'utf-8');
    res.send(injectSocialMeta(html, meta));
  }

  // Fallback SPA : toute route qui n'est ni une API ni un fichier existant renvoie
  // index.html, pour laisser le Router Angular gérer l'URL côté client.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/storage')) {
      return next();
    }

    const articleMatch = req.path.match(/^\/vaovao\/article\/([^/]+)\/?$/);
    if (articleMatch) {
      const annonce = annonceStore.readAll().find(a => annonceSlug(a.title) === articleMatch[1]);
      if (annonce) {
        return sendIndexWithMeta(req, res, {
          title: `${annonce.title} — FPMA Melun`,
          description: buildDescription(annonce.description) || 'Actualités de la FPMA Melun.',
          url: `${getBaseUrl(req)}${req.originalUrl}`,
          type: 'article'
        });
      }
    }

    if (req.path === '/verset-du-jour') {
      return sendIndexWithMeta(req, res, {
        title: 'Verset du jour — FPMA Melun',
        description: 'Découvrez le verset du jour de la FPMA Melun.',
        url: `${getBaseUrl(req)}${req.originalUrl}`
      });
    }

    res.sendFile(FRONTEND_INDEX);
  });

  console.log(`Frontend Angular servi depuis ${FRONTEND_DIST_PATH}`);
} else {
  console.log(`Frontend Angular introuvable (${FRONTEND_DIST_PATH}) — le backend sert uniquement l'API.`);
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Erreur interne du serveur' });
});

app.listen(PORT, () => {
  console.log(`FPMA backend à l'écoute sur http://localhost:${PORT}`);
});
