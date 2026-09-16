/**
 * URL publique de base du backend, utilisée pour transformer les chemins relatifs
 * (ex: /storage/vaovao/xxx.jpg) en URLs absolues dans les réponses de l'API.
 *
 * Par défaut, déduite dynamiquement de chaque requête (protocole + host) — s'adapte
 * donc automatiquement à l'environnement (dev/prod, changement de port) sans jamais
 * avoir besoin de migrer les données stockées.
 *
 * Peut être forcée via la variable d'environnement PUBLIC_BASE_URL (ex:
 * "https://fpma-melun.org") si l'auto-détection ne convient pas dans un cas précis
 * (ex: reverse-proxy mal configuré).
 */
function getBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

/**
 * Transforme un chemin relatif servi par ce backend (commençant par /storage) en URL
 * absolue. Laisse inchangée toute valeur déjà absolue (http(s)://...), vide, ou un
 * chemin d'asset du front (ex: "assets/images/...").
 */
function toAbsoluteUrl(req, value) {
  if (!value || !value.startsWith('/storage')) {
    return value;
  }
  return `${getBaseUrl(req)}${value}`;
}

module.exports = { getBaseUrl, toAbsoluteUrl };
