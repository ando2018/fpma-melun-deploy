function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HTML_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘',
  laquo: '«', raquo: '»', hellip: '…', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à',
  acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', icirc: 'î', iuml: 'ï', Eacute: 'É'
};

// Texte brut : retire les balises et décode les entités (&nbsp;, &amp;, &#39;…) écrites
// par l'éditeur de texte, pour ne pas les afficher telles quelles dans l'aperçu.
function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : entity;
      }
      return HTML_ENTITIES[code] ?? HTML_ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

// Description texte brut (sans HTML) utilisée pour og:description / twitter:description.
function buildDescription(html, maxLength = 160) {
  return truncate(stripHtml(html), maxLength);
}

// Injecte les balises Open Graph / Twitter Card dans le <head> du index.html Angular, à
// la place du <title> statique, pour que les aperçus de partage (WhatsApp, Facebook,
// Messenger, X...) affichent le titre et le lien propres à l'article ou au verset du
// jour au lieu de la page générique du site (ces bots ne lisent que le HTML brut, pas
// le rendu Angular côté client). Avec meta.image (URL absolue), l'aperçu affiche cette
// image en grand ; sans image, les plateformes affichent le logo du site.
function injectSocialMeta(html, meta) {
  const imageTags = meta.image
    ? [
        `<meta property="og:image" content="${escapeHtml(meta.image)}">`,
        `<meta property="og:image:alt" content="${escapeHtml(meta.title)}">`,
        `<meta name="twitter:image" content="${escapeHtml(meta.image)}">`
      ]
    : [];
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:type" content="${escapeHtml(meta.type || 'website')}">`,
    `<meta property="og:site_name" content="FPMA Melun">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
    ...imageTags,
    `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`
  ].join('\n    ');

  return html.replace(/<title>.*?<\/title>/i, tags);
}

// Image d'aperçu d'un article : sa photo, sinon la miniature de sa vidéo YouTube.
// Toujours une URL absolue (exigée par WhatsApp, Facebook…). Une photo uploadée sur le
// site passe par /api/share-image, qui en sert une version allégée : WhatsApp ignore
// les images de plus d'environ 600 Ko.
function articleImage(annonce, baseUrl) {
  const image = String(annonce.image || '').trim();
  if (image) {
    const local = image.match(/^(?:https?:\/\/[^/]+)?\/?storage\/(.+)$/i);
    if (local && (!/^https?:/i.test(image) || image.startsWith(baseUrl))) {
      return `${baseUrl}/api/share-image/${local[1]}`;
    }
    if (/^https?:\/\//i.test(image)) return image;
    return `${baseUrl}/${image.replace(/^\/+/, '')}`;
  }
  const video = String(annonce.videoUrl || '').match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i);
  return video ? `https://img.youtube.com/vi/${video[1]}/hqdefault.jpg` : undefined;
}

// Image du verset du jour publiée par saparole.com (même adresse que sur la page
// d'accueil : JJ_MM_AA.jpg). La date est celle de Paris, pas celle du serveur (souvent
// en UTC), pour changer d'image à minuit heure française.
function versetImage(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: '2-digit' })
      .formatToParts(date)
      .map(p => [p.type, p.value])
  );
  return `https://saparole.com/wp-content/uploads/${parts.day}_${parts.month}_${parts.year}.jpg`;
}

module.exports = { injectSocialMeta, buildDescription, articleImage, versetImage };
