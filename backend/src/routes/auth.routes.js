const express = require('express');
const path = require('path');
const JsonStore = require('../utils/jsonStore');
const { verifyPassword, createToken } = require('../utils/auth');

const router = express.Router();
const usersStore = new JsonStore(path.join(__dirname, '..', 'data', 'users.json'));

// POST /api/auth/login - { username, password } -> { token, username, role }
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = usersStore.readAll().find(u => u.username === String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }
  res.json({ token: createToken(user), username: user.username, role: user.role });
});

module.exports = router;
