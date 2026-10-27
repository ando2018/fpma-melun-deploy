const { isSmtpConfigured, buildTransport } = require('../utils/mailer');
const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID } = require('../utils/db');
const { requireTab } = require('../utils/auth');
const { getBaseUrl } = require('../utils/baseUrl');

const router = asyncRouter();
const messages = () => col('messages');
// Envoi du formulaire public ; lecture des messages réservée à l'onglet Boîte mail.
const canRead = requireTab('messages');


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Adresse du site (lien vers la Boîte mail de l'admin dans la notification).
function siteUrl(req) {
  return (process.env.SITE_URL || process.env.PUBLIC_BASE_URL || getBaseUrl(req)).replace(/\/+$/, '');
}

// E-mail de notification envoyé à MAIL_TO pour chaque message reçu. Le texte du visiteur
// est échappé : il ne peut pas injecter de HTML ou de liens piégés dans l'e-mail.
function notificationMail(entry, adminUrl) {
  const date = new Date(entry.receivedAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'short' });
  const subject = `Nouveau message de contact — ${entry.name}`;
  const html = `<!doctype html><html lang="fr"><body style="margin:0;padding:0;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;padding:24px 0;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:12px;overflow:hidden;">
  <tr><td style="background:#202578;color:#fff;padding:18px 24px;font-size:18px;font-weight:bold;">✉️ Nouveau message — site FPMA Melun</td></tr>
  <tr><td style="padding:22px 24px;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:16px;">
      <tr><td style="color:#555;padding:3px 12px 3px 0;">De</td><td style="font-weight:bold;">${escapeHtml(entry.name)}</td></tr>
      <tr><td style="color:#555;padding:3px 12px 3px 0;">E-mail</td><td><a href="mailto:${encodeURIComponent(entry.email)}" style="color:#202578;">${escapeHtml(entry.email)}</a></td></tr>
      <tr><td style="color:#555;padding:3px 12px 3px 0;">Reçu le</td><td>${escapeHtml(date)}</td></tr>
    </table>
    <div style="padding:14px 16px;background:#f6f7fc;border-left:4px solid #202578;border-radius:6px;font-size:15px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(entry.message)}</div>
    <p style="margin:20px 0 0;">
      <a href="mailto:${encodeURIComponent(entry.email)}?subject=${encodeURIComponent('Re : votre message à la FPMA Melun')}" style="display:inline-block;padding:10px 18px;background:#202578;color:#fff;text-decoration:none;border-radius:999px;font-weight:bold;">Répondre à ${escapeHtml(entry.name)}</a>
      <a href="${escapeHtml(adminUrl)}" style="display:inline-block;margin-left:8px;padding:10px 18px;background:#eef0fb;color:#202578;text-decoration:none;border-radius:999px;font-weight:bold;">Ouvrir la Boîte mail de l'admin</a>
    </p>
  </td></tr>
  <tr><td style="padding:14px 24px;font-size:12px;color:#888;border-top:1px solid #eceef5;">Message envoyé depuis le formulaire de contact du site. Il est aussi enregistré dans l'admin (onglet Boîte mail).</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Nouveau message de contact — site FPMA Melun`, '', `De : ${entry.name} <${entry.email}>`, `Reçu le : ${date}`, '', entry.message, '', `Boîte mail de l'admin : ${adminUrl}`].join('\n');
  return { subject, html, text };
}

// POST /api/contact  { name, email, message } - enregistre le message, puis prévient
// l'adresse MAIL_TO par e-mail (si l'e-mail du serveur est configuré dans le .env).
router.post('/', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !name.trim() || !email || !email.trim() || !message || !message.trim()) {
    return res.status(400).json({ error: 'name, email et message sont requis' });
  }

  const entry = {
    id: `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    name: String(name).trim().slice(0, 120),
    email: String(email).trim().slice(0, 200),
    message: String(message).trim().slice(0, 5000),
    receivedAt: new Date().toISOString(),
    mailSent: false,
    mailError: null,
    lu: false
  };
  // Enregistré d'abord : le message n'est jamais perdu, même si l'e-mail échoue.
  await messages().insertOne({ ...entry });

  if (!isSmtpConfigured()) {
    console.warn('SMTP non configuré (voir .env.example) — message enregistré mais pas de notification par e-mail.');
    await messages().updateOne({ id: entry.id }, { $set: { mailError: 'E-mail du serveur non configuré' } });
    return res.status(201).json({ success: true, mailSent: false });
  }

  try {
    const mail = notificationMail(entry, `${siteUrl(req)}/admin?tab=messages`);
    await buildTransport().sendMail({
      from: `"Site FPMA Melun" <${process.env.SMTP_USER}>`,
      to: process.env.MAIL_TO || process.env.SMTP_USER,
      // « Répondre » dans la messagerie écrit directement au visiteur.
      replyTo: `"${entry.name.replace(/"/g, '')}" <${entry.email}>`,
      ...mail
    });
    entry.mailSent = true;
    await messages().updateOne({ id: entry.id }, { $set: { mailSent: true, mailError: null } });
  } catch (err) {
    console.error('Échec de l\'envoi du mail de contact :', err.message);
    await messages().updateOne({ id: entry.id }, { $set: { mailError: err.message } });
  }
  res.status(201).json({ success: true, mailSent: entry.mailSent });
});

// GET /api/contact - liste des messages reçus (admin), du plus récent au plus ancien
router.get('/', canRead, async (req, res) => {
  res.json(await messages().find({}, NO_ID).sort({ receivedAt: -1, _id: -1 }).toArray());
});

// PATCH /api/contact/:id/lu - marque un message comme lu
router.patch('/:id/lu', canRead, async (req, res) => {
  const updated = await messages().findOneAndUpdate(
    { id: req.params.id },
    { $set: { lu: true } },
    { returnDocument: 'after', ...NO_ID }
  );
  if (!updated) return res.status(404).json({ error: 'Message introuvable' });
  res.json(updated);
});

// DELETE /api/contact/:id - supprime un message
router.delete('/:id', canRead, async (req, res) => {
  const { deletedCount } = await messages().deleteOne({ id: req.params.id });
  if (!deletedCount) return res.status(404).json({ error: 'Message introuvable' });
  res.status(204).end();
});

module.exports = router;
