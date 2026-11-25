const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID } = require('../utils/db');
const { requireTab, requireClientsSub } = require('../utils/auth');
const { logClient } = require('../utils/clients');
const m = require('../utils/messaging');

// Messages individuels de l'Église à un paroissien (fiche du paroissien, onglet
// « Messages »). Le message reste dans l'espace paroissien ; le paroissien est prévenu par
// e-mail et peut répondre. Droit « Paroissiens » de « Paroissiens et dons ».

const router = asyncRouter();
router.use(requireTab('clients'), requireClientsSub('paroissiens'));
const clients = () => col('clients');

function adminAuthor(req) {
  return { type: 'eglise', id: req.user.username, name: req.user.username, label: m.EGLISE };
}

async function individualThread(id) {
  const thread = await m.threads().findOne({ id, kind: 'individuel' }, NO_ID);
  return thread || null;
}

// GET /api/messages/client/:clientId - fils du paroissien, avec leurs messages.
router.get('/client/:clientId', async (req, res) => {
  const list = await m.threads().find({ kind: 'individuel', clientId: req.params.clientId }, NO_ID).sort({ lastAt: -1 }).toArray();
  res.json(await Promise.all(list.map(t => m.threadWithPosts(t))));
});

// POST /api/messages/client/:clientId  (multipart : subject, body, files) - nouveau message.
router.post('/client/:clientId', m.upload, async (req, res) => {
  const client = await clients().findOne({ id: req.params.clientId }, NO_ID);
  if (!client) {
    m.removeUploaded(req);
    return res.status(404).json({ error: 'Paroissien introuvable.' });
  }
  if (!client.numero) {
    m.removeUploaded(req);
    return res.status(400).json({ error: 'Cette personne n’a pas d’espace paroissien (pas de n°) : elle ne pourrait pas lire le message.' });
  }
  const content = m.parseContent(req.body, { withSubject: true });
  if (content.error) {
    m.removeUploaded(req);
    return res.status(400).json({ error: content.error });
  }
  try {
    const { thread } = await m.createThread({
      kind: 'individuel',
      clientId: client.id,
      subject: content.subject,
      author: adminAuthor(req),
      body: content.body,
      attachments: m.attachmentsOf(req)
    });
    const notified = await m.notifyClient(req, client, m.EGLISE, content.subject);
    await logClient(client, req.user.username, 'Message envoyé', `« ${content.subject} »${notified ? ' — prévenu par e-mail' : ''}`);
    res.status(201).json({ thread: await m.threadWithPosts({ ...thread }), notified: !!notified });
  } catch (err) {
    m.removeUploaded(req);
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// POST /api/messages/:id/reponses  (multipart : body, files) - réponse de l'Église.
router.post('/:id/reponses', m.upload, async (req, res) => {
  const thread = await individualThread(req.params.id);
  if (!thread) {
    m.removeUploaded(req);
    return res.status(404).json({ error: 'Message introuvable.' });
  }
  const content = m.parseContent(req.body, { withSubject: false });
  try {
    await m.addPost(thread, adminAuthor(req), content.body, m.attachmentsOf(req));
  } catch (err) {
    m.removeUploaded(req);
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  await m.threads().updateOne({ id: thread.id }, { $set: { adminUnread: false } });
  const client = await clients().findOne({ id: thread.clientId }, NO_ID);
  const notified = await m.notifyClient(req, client, m.EGLISE, thread.subject);
  await logClient(client, req.user.username, 'Réponse envoyée', `« ${thread.subject} »`);
  res.status(201).json({ thread: await m.threadWithPosts(await individualThread(thread.id)), notified: !!notified });
});

// POST /api/messages/:id/lu - réponse du paroissien lue dans l'admin.
router.post('/:id/lu', async (req, res) => {
  await m.threads().updateOne({ id: req.params.id, kind: 'individuel' }, { $set: { adminUnread: false } });
  res.status(204).end();
});

// GET /api/messages/:id/fichiers/:fileId - pièce jointe.
router.get('/:id/fichiers/:fileId', async (req, res) => {
  const thread = await individualThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Message introuvable.' });
  await m.sendAttachment(res, thread.id, req.params.fileId);
});

// DELETE /api/messages/:id - supprime le fil, ses réponses et ses pièces jointes.
router.delete('/:id', async (req, res) => {
  const thread = await individualThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Message introuvable.' });
  await m.deleteThread(thread);
  const client = await clients().findOne({ id: thread.clientId }, NO_ID);
  await logClient(client, req.user.username, 'Message supprimé', `« ${thread.subject} »`);
  res.status(204).end();
});

module.exports = router;
