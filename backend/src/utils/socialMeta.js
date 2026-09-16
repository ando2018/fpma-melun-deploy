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

// Injecte les balises Open Graph / Twitter Card dans le <head> du index.html Angular, à
// la place du <title> statique, pour que les aperçus de partage (WhatsApp, Facebook,
// Messenger, X...) affichent le titre et le lien propres à l'article ou au verset du
// jour au lieu de la page générique du site (ces bots ne lisent que le HTML brut, pas
// le rendu Angular côté client). Pas d'image dans l'aperçu, volontairement.
function injectSocialMeta(html, meta) {
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:type" content="${escapeHtml(meta.type || 'website')}">`,
    `<meta property="og:site_name" content="FPMA Melun">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.url)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`
  ].join('\n    ');

  return html.replace(/<title>.*?<\/title>/i, tags);
}

module.exports = { injectSocialMeta, buildDescription };
