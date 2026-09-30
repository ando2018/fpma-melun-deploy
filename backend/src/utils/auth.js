const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// Sans AUTH_SECRET, un secret aléatoire est généré au démarrage : les sessions ne
// survivent alors pas à un redémarrage du serveur.
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');

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

function createToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ username: user.username, role: user.role, exp: Date.now() + TOKEN_TTL_MS })
  ).toString('base64url');
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

function requireRole(...roles) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const user = verifyToken(header.replace(/^Bearer\s+/i, ''));
    if (!user) return res.status(401).json({ error: 'Authentification requise' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Accès refusé' });
    req.user = user;
    next();
  };
}

module.exports = { hashPassword, verifyPassword, createToken, requireRole };
