const asyncRouter = require('../utils/asyncRouter');
const { col } = require('../utils/db');
const { verifyPassword, createToken } = require('../utils/auth');

const router = asyncRouter();

// POST /api/auth/login - { username, password } -> { token, username, role }
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await col('users').findOne({ username: String(username || '').trim() });
  if (!user || !verifyPassword(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }
  res.json({ token: createToken(user), username: user.username, role: user.role });
});

module.exports = router;
