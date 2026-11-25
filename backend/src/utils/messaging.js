const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { col, NO_ID, getSetting, setSetting } = require('./db');
const { isSmtpConfigured, buildTransport } = require('./mailer');
const { getBaseUrl } = require('./baseUrl');

// Messagerie de l'espace paroissien. Un message est un fil de discussion :
// - « individuel » : entre l'Église (admin) et un paroissien ;
// - « groupe » : du bureau d'un groupe (paroissien qui a un poste) à tous les membres.
// Le contenu reste dans l'espace paroissien : les e-mails ne servent qu'à prévenir qu'un
// message est arrivé. Chaque message peut porter des pièces jointes, et on peut y répondre.

const threads = () => col('message_threads');
const posts = () => col('message_posts');
const reads = () => col('message_reads');

const EGLISE = 'Le bureau de l’Église FPMA Melun';
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAIL_BATCH = 40;

// Pièces jointes : hors du dossier public, servies seulement après contrôle des droits.
const ATTACH_DIR = process.env.ATTACHMENTS_DIR || path.join(__dirname, '..', '..', 'attachments');
fs.mkdirSync(ATTACH_DIR, { recursive: true });

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

const multerUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ATTACH_DIR),
    filename: (req, file, cb) => cb(null, newId('pj'))
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES }
}).array('files', MAX_FILES);

/** Middleware : champs du formulaire + pièces jointes (5 fichiers de 10 Mo au maximum). */
function upload(req, res, next) {
  multerUpload(req, res, err => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Pièce jointe trop lourde (10 Mo au maximum).'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `${MAX_FILES} pièces jointes au maximum.`
          : 'Envoi des pièces jointes impossible.';
    removeUploaded(req);
    res.status(400).json({ error: message });
  });
}

/** Fichiers reçus → pièces jointes enregistrées avec le message. */
function attachmentsOf(req) {
  return (req.files || []).map(f => ({
    id: f.filename,
    // Nom d'origine (multer le donne en latin1).
    name: Buffer.from(f.originalname, 'latin1').toString('utf8').replace(/[\\/\0]/g, '_').slice(0, 150) || 'fichier',
    size: f.size,
    type: f.mimetype || 'application/octet-stream'
  }));
}

function removeUploaded(req) {
  for (const f of req.files || []) fs.promises.unlink(f.path).catch(() => {});
}

function filePath(id) {
  return path.join(ATTACH_DIR, path.basename(String(id)));
}

/** Envoie une pièce jointe d'un fil (après contrôle des droits par l'appelant). */
async function sendAttachment(res, threadId, fileId) {
  const post = await posts().findOne({ threadId, 'attachments.id': String(fileId) }, NO_ID);
  const file = post?.attachments.find(a => a.id === String(fileId));
  if (!file || !fs.existsSync(filePath(file.id))) return res.status(404).json({ error: 'Pièce jointe introuvable.' });
  res.download(filePath(file.id), file.name, { headers: { 'Content-Type': file.type } });
}

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Contenu d'un message (objet facultatif selon le cas) ; erreur si vide. */
function parseContent(body, { withSubject }) {
  const subject = text(body?.subject, 120);
  const content = String(body?.body ?? '').trim().slice(0, 5000);
  if (withSubject && !subject) return { error: 'Indiquez l’objet du message.' };
  return { subject, body: content };
}

async function addPost(thread, author, body, attachments) {
  if (!body && !attachments.length) throw Object.assign(new Error('Écrivez un message ou joignez un fichier.'), { status: 400 });
  const at = new Date().toISOString();
  const post = { id: newId('post'), threadId: thread.id, author, body, attachments, at };
  await posts().insertOne({ ...post });
  await threads().updateOne(
    { id: thread.id },
    // Réponse d'un paroissien à l'Église : à lire dans l'admin.
    { $set: { lastAt: at, lastBy: author.type, lastClientId: author.type === 'client' ? author.id : null, ...(thread.kind === 'individuel' ? { adminUnread: author.type === 'client' } : {}) }, $inc: { postCount: 1 } }
  );
  if (author.type === 'client') await markRead(thread.id, author.id, at);
  return post;
}

/** Nouveau fil : premier message. */
async function createThread({ kind, clientId = null, group = null, subject, author, body, attachments }) {
  const at = new Date().toISOString();
  const thread = {
    id: newId('fil'),
    kind,
    clientId,
    groupId: group?.id || null,
    groupName: group?.name || null,
    subject,
    createdAt: at,
    createdBy: author,
    lastAt: at,
    lastBy: author.type,
    postCount: 0,
    adminUnread: false
  };
  await threads().insertOne({ ...thread });
  const post = await addPost(thread, author, body, attachments);
  return { thread: { ...thread, postCount: 1, lastAt: post.at }, post };
}

async function deleteThread(thread) {
  const list = await posts().find({ threadId: thread.id }, NO_ID).toArray();
  for (const p of list) for (const a of p.attachments || []) fs.promises.unlink(filePath(a.id)).catch(() => {});
  await posts().deleteMany({ threadId: thread.id });
  await reads().deleteMany({ threadId: thread.id });
  await threads().deleteOne({ id: thread.id });
}

async function markRead(threadId, clientId, at = new Date().toISOString()) {
  await reads().updateOne({ threadId, clientId }, { $set: { at } }, { upsert: true });
}

/** Fils visibles par un paroissien : les siens et ceux de ses groupes. */
function clientThreadsQuery(client) {
  return { $or: [{ kind: 'individuel', clientId: client.id }, { kind: 'groupe', groupId: { $in: client.groupes || [] } }] };
}

function canClientSee(thread, client) {
  return thread.kind === 'individuel' ? thread.clientId === client.id : (client.groupes || []).includes(thread.groupId);
}

/** Non lu : dernier message écrit par quelqu'un d'autre, après la dernière lecture. */
function isUnread(thread, client, readAt) {
  if (thread.lastBy === 'client' && thread.lastClientId === client.id) return false;
  const since = [readAt, thread.baseline].filter(Boolean).sort().pop() || '';
  return thread.lastAt > since;
}

async function clientThreads(client) {
  const list = await threads().find(clientThreadsQuery(client), NO_ID).sort({ lastAt: -1 }).limit(200).toArray();
  const mine = await reads().find({ clientId: client.id, threadId: { $in: list.map(t => t.id) } }, NO_ID).toArray();
  const readAt = new Map(mine.map(r => [r.threadId, r.at]));
  return list.map(t => ({ ...summary(t), unread: isUnread(t, client, readAt.get(t.id)) }));
}

function summary(t) {
  return {
    id: t.id,
    kind: t.kind,
    subject: t.subject,
    groupId: t.groupId,
    groupName: t.groupName,
    from: t.createdBy?.label || EGLISE,
    createdAt: t.createdAt,
    lastAt: t.lastAt,
    lastBy: t.lastBy,
    postCount: t.postCount || 0,
    adminUnread: !!t.adminUnread
  };
}

async function threadWithPosts(thread) {
  const list = await posts().find({ threadId: thread.id }, NO_ID).sort({ at: 1 }).toArray();
  return { ...summary(thread), posts: list };
}

// ---------- E-mails de notification (jamais le contenu du message) ----------

function siteUrl(req) {
  return (process.env.SITE_URL || process.env.PUBLIC_BASE_URL || getBaseUrl(req)).replace(/\/+$/, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notificationMail({ hello, from, subject, link, buttonLabel, footer }) {
  const intro = `Vous avez reçu un nouveau message de ${from}${subject ? ` : « ${subject} »` : ''}.`;
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Nouveau message</title></head>
<body style="margin:0;padding:0;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
  <tr><td style="background:#202578;color:#ffffff;padding:20px 28px;">
    <div style="font-size:22px;font-weight:bold;">FPMA Melun</div>
    <div style="font-size:14px;opacity:.85;">✉️ Nouveau message</div>
  </td></tr>
  <tr><td style="padding:24px 28px 8px;">
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${escapeHtml(hello)}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${escapeHtml(intro)}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Pour le lire, voir les pièces jointes éventuelles et y répondre, ouvrez votre espace.</p>
    <p style="margin:22px 0;text-align:center;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;background:#202578;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">${escapeHtml(buttonLabel)}</a></p>
  </td></tr>
  <tr><td style="padding:20px 28px 24px;font-size:12px;color:#777;line-height:1.5;border-top:1px solid #eceef5;">
    ${escapeHtml(footer)}<br>Merci de ne pas répondre à cet e-mail : répondez depuis l’espace.
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  const plain = [hello, '', intro, 'Pour le lire et y répondre, ouvrez votre espace :', link, '', footer, 'Merci de ne pas répondre à cet e-mail.'].join('\n');
  return { subject: `Nouveau message de ${from} — FPMA Melun`, html, text: plain };
}

async function sendMails(mail, list, { bcc }) {
  // Une adresse partagée par plusieurs paroissiens ne reçoit qu'un e-mail.
  const recipients = [...new Set(list.map(r => String(r).toLowerCase()))];
  if (!isSmtpConfigured() || !recipients.length) return 0;
  const transport = buildTransport();
  const common = {
    from: `"Église FPMA Melun" <${process.env.SMTP_USER}>`,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' }
  };
  try {
    if (bcc) {
      for (let i = 0; i < recipients.length; i += MAIL_BATCH) {
        await transport.sendMail({ ...common, to: process.env.SMTP_USER, bcc: recipients.slice(i, i + MAIL_BATCH) });
      }
    } else {
      await transport.sendMail({ ...common, to: recipients[0] });
    }
    return recipients.length;
  } catch (err) {
    console.error('Notification de message non envoyée :', err.message);
    return 0;
  }
}

/** Prévient un paroissien qu'un message l'attend dans son espace. */
async function notifyClient(req, client, from, subject) {
  if (!client?.email) return 0;
  const mail = notificationMail({
    hello: `Bonjour ${client.prenom} ${client.nom},`,
    from,
    subject,
    link: `${siteUrl(req)}/espace-client?onglet=messages`,
    buttonLabel: 'Ouvrir mon espace paroissien',
    footer: 'Église FPMA Melun — espace paroissien.'
  });
  return sendMails(mail, [client.email], { bcc: false });
}

/** Prévient plusieurs paroissiens (copie cachée : personne ne voit les adresses des autres). */
async function notifyClients(req, list, from, subject) {
  const emails = [...new Set(list.map(c => c.email).filter(Boolean))];
  const mail = notificationMail({
    hello: 'Bonjour,',
    from,
    subject,
    link: `${siteUrl(req)}/espace-client?onglet=messages`,
    buttonLabel: 'Ouvrir mon espace paroissien',
    footer: 'Église FPMA Melun — espace paroissien.'
  });
  return sendMails(mail, emails, { bcc: true });
}

/**
 * Un paroissien a écrit ou répondu à l'Église : sont prévenus par e-mail les paroissiens
 * qui ont le label « Admin » (avec le nom et le n° de celui qui écrit). S'il n'y en a
 * aucun, l'adresse de l'Église (MAIL_TO) est prévenue, pour ne pas perdre le message.
 */
async function notifyAdmins(req, client, subject) {
  const admins = await col('clients')
    .find({ admin: true, active: { $ne: false }, email: { $type: 'string' }, id: { $ne: client.id } }, NO_ID)
    .toArray();
  const fallback = process.env.MAIL_TO || process.env.SMTP_USER;
  const to = admins.length ? admins.map(a => a.email) : fallback ? [fallback] : [];
  if (!to.length) return 0;
  const mail = notificationMail({
    hello: 'Bonjour,',
    from: `${client.prenom} ${client.nom} (n° ${client.numero || '—'})`,
    subject,
    link: `${siteUrl(req)}/admin`,
    buttonLabel: 'Ouvrir l’administration',
    footer: `Message de ${client.prenom} ${client.nom}, n° paroissien ${client.numero || '—'}, écrit dans son espace : il se lit dans sa fiche, onglet « Messages ». Vous recevez cet e-mail car vous avez le label Admin.`
  });
  return sendMails(mail, to, { bcc: true });
}

/**
 * Messages de l'Église pas encore lus par le paroissien, par paroissien (icône 📩 de la
 * liste dans l'admin).
 */
async function waitingByClient() {
  const list = await threads().find({ kind: 'individuel', lastBy: 'eglise' }, { projection: { _id: 0, id: 1, clientId: 1, lastAt: 1, baseline: 1 } }).toArray();
  if (!list.length) return new Map();
  const seen = await reads().find({ threadId: { $in: list.map(t => t.id) } }, NO_ID).toArray();
  const readAt = new Map(seen.map(r => [`${r.threadId}|${r.clientId}`, r.at]));
  const result = new Map();
  for (const t of list) {
    const since = [readAt.get(`${t.id}|${t.clientId}`), t.baseline].filter(Boolean).sort().pop() || '';
    if (t.lastAt > since) result.set(t.clientId, (result.get(t.clientId) || 0) + 1);
  }
  return result;
}

// ---------- Reprise des anciens e-mails (une seule fois) ----------

async function migrateMessages() {
  if (await getSetting('migration-messagerie', null)) return;
  // E-mails individuels déjà envoyés → fils « individuel » (déjà lus).
  for (const e of await col('client_emails').find({}, NO_ID).toArray()) {
    const author = { type: 'eglise', id: e.sentBy, name: e.sentBy, label: EGLISE };
    await threads().insertOne({
      id: newId('fil'), kind: 'individuel', clientId: e.clientId, groupId: null, groupName: null, subject: e.subject,
      createdAt: e.sentAt, createdBy: author, lastAt: e.sentAt, lastBy: 'eglise', postCount: 1, adminUnread: false, baseline: e.sentAt
    }).then(async r => {
      const t = await threads().findOne({ _id: r.insertedId });
      await posts().insertOne({ id: newId('post'), threadId: t.id, author, body: e.body, attachments: [], at: e.sentAt });
    });
  }
  // Informations des groupes déjà envoyées → fils « groupe » (déjà lus).
  for (const m of await col('group_messages').find({}, NO_ID).toArray()) {
    const author = { type: 'bureau', id: m.senderId, name: m.senderName, label: `Le bureau du groupe ${m.groupName}` };
    const id = newId('fil');
    await threads().insertOne({
      id, kind: 'groupe', clientId: null, groupId: m.groupId, groupName: m.groupName, subject: m.subject,
      createdAt: m.sentAt, createdBy: author, lastAt: m.sentAt, lastBy: 'bureau', postCount: 1, adminUnread: false, baseline: m.sentAt
    });
    await posts().insertOne({ id: newId('post'), threadId: id, author, body: m.body, attachments: [], at: m.sentAt });
  }
  await setSetting('migration-messagerie', new Date().toISOString());
}

module.exports = {
  EGLISE,
  MAX_FILES,
  threads,
  posts,
  upload,
  attachmentsOf,
  removeUploaded,
  sendAttachment,
  parseContent,
  createThread,
  addPost,
  deleteThread,
  markRead,
  clientThreads,
  canClientSee,
  threadWithPosts,
  summary,
  notifyClient,
  notifyClients,
  notifyAdmins,
  waitingByClient,
  migrateMessages
};
