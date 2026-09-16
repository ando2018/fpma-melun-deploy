const { getBaseUrl } = require('./baseUrl');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

// Description texte brut (sans HTML) utilisée pour og:description / twitter:description.
function buildDescription(html, maxLength = 160) {
  return truncate(stripHtml(html), maxLength);
}

// Résout n'importe quelle valeur d'image (URL absolue, chemin /storage/..., chemin
// d'asset frontend du type "assets/images/x.jpg") en URL absolue exploitable par les
// aperçus de partage (qui exigent toujours une URL absolue pour og:image).
function resolveAbsoluteImage(req, value, fallbackPath) {
  const base = getBaseUrl(req);
  const source = value && String(value).trim() ? value : fallbackPath;
  if (/^https?:\/\//i.test(source)) {
    return source;
  }
  return `${base}/${String(source).replace(/^\/+/, '')}`;
}

// Injecte les balises Open Graph / Twitter Card dans le <head> du index.html Angular, à
// la place du <title> statique, pour que les aperçus de partage (WhatsApp, Facebook,
// Messenger, X...) affichent le titre/image propres à l'article ou au verset du jour au
// lieu de la page générique du site (ces bots ne lisent que le HTML brut, pas le rendu
// Angular côté client).
function injectSocialMeta(html, meta) {
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:type" content="${escapeHtml(meta.type || 'website')}">`,
    `<meta property="og:site_name" content="FPMA Melun">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:image" content="${escapeHtml(meta.image)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(meta.image)}">`
  ].join('\n    ');

  return html.replace(/<title>.*?<\/title>/i, tags);
}

module.exports = { injectSocialMeta, buildDescription, resolveAbsoluteImage };
