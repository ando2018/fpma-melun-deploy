const crypto = require('crypto');
const { col } = require('./db');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// Sans AUTH_SECRET, un secret aléatoire est généré au démarrage : les sessions ne
// survivent alors pas à un redémarrage du serveur.
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');

// Onglets de l'administration auxquels on peut donner accès. Un administrateur les a
// tous, plus la gestion des utilisateurs.
const ADMIN_TABS = ['vaovao', 'direct', 'evenements', 'banniere', 'sary', 'diaporama', 'notifications', 'messages', 'stats', 'tombola'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

// Le jeton ne contient que l'identifiant : les droits sont relus en base à chaque
// requête, pour qu'une modification (ou suppression) d'utilisateur s'applique aussitôt.
function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ username: user.username, exp: Date.now() + TOKEN_TTL_MS })).toString(
    'base64url'
  );
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

// Lien signé à durée limitée (ex. téléchargement d'une vidéo : un simple lien ne peut pas
// transmettre le jeton de connexion).
function createSignedValue(data, ttlMs) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

const verifySignedValue = verifyToken;

// Onglets réellement accessibles. L'ancien rôle « tombola » (avant la gestion des
// utilisateurs) équivaut à l'onglet Tombola seul.
function accessOf(user) {
  if (user.role === 'admin') return { role: 'admin', tabs: [...ADMIN_TABS] };
  const tabs = Array.isArray(user.tabs) ? user.tabs : user.role === 'tombola' ? ['tombola'] : [];
  return { role: 'user', tabs: tabs.filter(t => ADMIN_TABS.includes(t)) };
}

// Profil renvoyé au site (jamais le mot de passe).
function publicUser(user) {
  return {
    id: user.id || user.username,
    username: user.username,
    ...accessOf(user),
    createdAt: user.createdAt || null
  };
}

async function authenticate(req) {
  const header = req.get('authorization') || '';
  const token = verifyToken(header.replace(/^Bearer\s+/i, ''));
  if (!token) return null;
  const user = await col('users').findOne({ username: token.username });
  if (!user || user.disabled) return null;
  return { ...user, ...accessOf(user) };
}

function guard(isAllowed) {
  return (req, res, next) => {
    authenticate(req)
      .then(user => {
        if (!user) return res.status(401).json({ error: 'Authentification requise' });
        if (!isAllowed(user)) return res.status(403).json({ error: 'Accès refusé' });
        req.user = user;
        next();
      })
      .catch(next);
  };
}

// Accès si l'utilisateur a au moins un des onglets indiqués (un administrateur les a tous).
function requireTab(...tabs) {
  return guard(user => user.role === 'admin' || tabs.some(tab => user.tabs.includes(tab)));
}

const requireAdmin = guard(user => user.role === 'admin');
const requireAuth = guard(() => true);

module.exports = {
  ADMIN_TABS,
  createSignedValue,
  verifySignedValue,
  authenticate,
  hashPassword,
  verifyPassword,
  createToken,
  accessOf,
  publicUser,
  requireTab,
  requireAdmin,
  requireAuth
};
