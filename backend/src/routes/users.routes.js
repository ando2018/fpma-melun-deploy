const asyncRouter = require('../utils/asyncRouter');
const { col, isDuplicateKey } = require('../utils/db');
const { ADMIN_TABS, hashPassword, publicUser, requireAdmin } = require('../utils/auth');

// Gestion des utilisateurs de l'administration (réservée aux administrateurs).

const router = asyncRouter();
router.use(requireAdmin);
const users = () => col('users');

const MIN_PASSWORD_LENGTH = 6;

function parseAccess(body) {
  const role = body.role === 'admin' ? 'admin' : 'user';
  const tabs = Array.isArray(body.tabs) ? [...new Set(body.tabs.filter(t => ADMIN_TABS.includes(t)))] : [];
  if (role === 'user' && !tabs.length) return { error: 'Cochez au moins un onglet.' };
  return { value: { role, tabs: role === 'admin' ? [] : tabs } };
}

function checkPassword(password) {
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    return `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  }
  return null;
}

async function countAdmins() {
  return users().countDocuments({ role: 'admin', disabled: { $ne: true } });
}

// GET /api/users
router.get('/', async (req, res) => {
  const list = await users().find({}).sort({ username: 1 }).toArray();
  res.json({ tabs: ADMIN_TABS, users: list.map(publicUser) });
});

// POST /api/users  { username, password, role, tabs }
router.post('/', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -), sans espace.' });
  }
  const passwordError = checkPassword(req.body?.password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const access = parseAccess(req.body || {});
  if (access.error) return res.status(400).json({ error: access.error });

  const user = {
    id: `user-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    username,
    passwordHash: hashPassword(String(req.body.password)),
    ...access.value,
    createdAt: new Date().toISOString(),
    createdBy: req.user.username
  };
  try {
    await users().insertOne(user);
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: `L'identifiant « ${username} » existe déjà.` });
    throw err;
  }
  res.status(201).json(publicUser(user));
});

// PUT /api/users/:username  { role, tabs, password? } - droits et/ou nouveau mot de passe
router.put('/:username', async (req, res) => {
  const current = await users().findOne({ username: req.params.username });
  if (!current) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const access = parseAccess(req.body || {});
  if (access.error) return res.status(400).json({ error: access.error });

  // Il doit toujours rester un administrateur, et on ne peut pas se retirer soi-même ce rôle.
  if (current.role === 'admin' && access.value.role !== 'admin') {
    if (current.username === req.user.username) {
      return res.status(400).json({ error: 'Vous ne pouvez pas retirer votre propre rôle d’administrateur.' });
    }
    if ((await countAdmins()) <= 1) return res.status(400).json({ error: 'Il doit rester au moins un administrateur.' });
  }

  const changes = { ...access.value, updatedAt: new Date().toISOString() };
  if (req.body?.password) {
    const passwordError = checkPassword(req.body.password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    changes.passwordHash = hashPassword(String(req.body.password));
  }

  const updated = await users().findOneAndUpdate(
    { username: current.username },
    { $set: changes },
    { returnDocument: 'after' }
  );
  res.json(publicUser(updated));
});

// DELETE /api/users/:username
router.delete('/:username', async (req, res) => {
  if (req.params.username === req.user.username) {
    return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  }
  const target = await users().findOne({ username: req.params.username });
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (target.role === 'admin' && (await countAdmins()) <= 1) {
    return res.status(400).json({ error: 'Il doit rester au moins un administrateur.' });
  }
  await users().deleteOne({ username: target.username });
  res.status(204).end();
});

module.exports = router;
