const asyncRouter = require('../utils/asyncRouter');
const { col } = require('../utils/db');
const { verifyPassword, createToken, publicUser, requireAuth } = require('../utils/auth');

const router = asyncRouter();

// POST /api/auth/login - { username, password } -> { token, username, role, tabs }
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await col('users').findOne({ username: String(username || '').trim() });
  if (!user || user.disabled || !verifyPassword(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }
  res.json({ token: createToken(user), ...publicUser(user) });
});

// GET /api/auth/me - droits actuels (relus à chaque ouverture de l'admin, pour appliquer
// tout de suite une modification faite par un administrateur).
router.get('/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

module.exports = router;
