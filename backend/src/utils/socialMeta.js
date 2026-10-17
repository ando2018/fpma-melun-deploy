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
// Toujours une URL absolue (exigée par WhatsApp, Facebook…).
function articleImage(annonce, baseUrl) {
  const image = String(annonce.image || '').trim();
  if (image) {
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
