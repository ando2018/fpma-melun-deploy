// Doit rester identique à annonceSlug() côté frontend (src/app/models/annonce.model.ts)
// pour que les liens /vaovao/article/:slug générés par Angular soient bien retrouvés ici.
function annonceSlug(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = { annonceSlug };
