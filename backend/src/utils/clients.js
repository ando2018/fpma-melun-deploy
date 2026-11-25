const crypto = require('crypto');
const { col, getSetting } = require('./db');
const { isSmtpConfigured, buildTransport } = require('./mailer');
const { hashPassword } = require('./auth');

// Espace client : fiches des clients (membres / donateurs), groupes (SLK, SVK,
// Fivohazana…), versements (offrandes, dons, cotisations…) et journal de tout ce qui
// est fait sur une fiche. Utilisé par l'admin (onglet Clients), par l'espace client
// public, et par le paiement en ligne (versements Stripe rattachés par l'e-mail).

const clients = () => col('clients');
const versements = () => col('client_versements');
const history = () => col('client_history');

const ADDRESS = '69 Av. du Maréchal Foch, 77190 Dammarie-les-Lys';
// Types de paiement (espèces, chèque…) : réglables dans l'admin. Un type supprimé reste
// dans la liste (removed: true) pour afficher les anciens versements, mais n'est plus
// proposé. « Paiement en ligne » (Stripe) ne peut pas être supprimé.
const ONLINE_MODE = 'en-ligne';
const MODES_SETTING = 'client-payment-modes';
const DEFAULT_MODES = [
  { key: 'especes', label: 'Espèces' },
  { key: 'cheque', label: 'Chèque' },
  { key: 'virement', label: 'Virement' },
  { key: 'carte', label: 'Carte bancaire' },
  { key: ONLINE_MODE, label: 'Paiement en ligne' },
  { key: 'autre', label: 'Autre' }
];

async function allModes() {
  return getSetting(MODES_SETTING, DEFAULT_MODES);
}

async function modeLabels() {
  return Object.fromEntries((await allModes()).map(m => [m.key, m.label]));
}
const DEFAULT_TYPES = ['Adidy', 'Rakitra', 'Offrande', 'Don', 'Cotisation', 'Autres'];

// Réglage du superadmin : afficher ou cacher les paiements en ligne (Stripe) dans les
// fiches et l'espace client. Cachés, ils restent enregistrés et réapparaissent si on
// les réaffiche.
const SHOW_STRIPE_SETTING = 'clients-show-stripe';

async function showStripe() {
  return (await getSetting(SHOW_STRIPE_SETTING, true)) !== false;
}

// Filtre MongoDB des versements visibles.
async function visibleVersements() {
  return (await showStripe()) ? {} : { source: { $ne: 'stripe' } };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

// N° client : saisi par l'admin, unique, facultatif (une personne sans n°, ex. un
// enfant, n'a pas d'espace client). Chiffres seulement, complété à 4 chiffres : 0001…
function formatNumero(numero) {
  return numero ? String(numero).padStart(4, '0') : '';
}

/** '12' -> '0012' ; '' -> null ; renvoie undefined si le n° n'est pas valide. */
function parseNumero(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^\d{1,10}$/.test(raw)) return undefined;
  if (/^0+$/.test(raw)) return undefined;
  return formatNumero(raw);
}

// ID provisoire des fiches sans n° définitif : P0001, P0002… (compteur, jamais réattribué).
// Il ne donne aucun droit (pas d'espace, pas de vote, pas de poste) : c'est un repère.
async function nextProvisoire() {
  const doc = await col('settings').findOneAndUpdate(
    { _id: 'client-provisoire-counter' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const value = doc?.value?.value ?? doc?.value;
  return `P${String(value).padStart(4, '0')}`;
}

// Proposition pour l'admin : le plus grand n° utilisé + 1.
async function freeNumero() {
  const list = await clients().find({ numero: { $type: 'string' } }, { projection: { numero: 1 } }).toArray();
  const max = list.reduce((m, c) => Math.max(m, parseInt(c.numero, 10) || 0), 0);
  return formatNumero(max + 1);
}

// Comparaison tolérante des noms : sans accents, majuscules, tirets ni espaces doublés.
function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Date du jour à Paris, au format AAAA-MM-JJ.
function parisDate(iso) {
  return new Date(iso || Date.now()).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

async function logClient(clientOrNull, user, action, detail = '') {
  await history().insertOne({
    at: new Date().toISOString(),
    clientId: clientOrNull?.id || null,
    numero: clientOrNull?.numero ? formatNumero(clientOrNull.numero) : clientOrNull?.provisoire || null,
    clientName: clientOrNull ? `${clientOrNull.prenom} ${clientOrNull.nom}` : null,
    user: user || null,
    action,
    detail: detail || ''
  });
}

// Identifiant de connexion : 8 chiffres au hasard, différent du n° paroissien (qui ne se
// devine pas à partir de lui). Il permet aussi de se connecter sans adresse e-mail.
async function newIdentifiant() {
  for (;;) {
    const value = String(crypto.randomInt(10000000, 100000000));
    if (!(await clients().findOne({ identifiant: value }, { projection: { _id: 1 } }))) return value;
  }
}

/** Donne un identifiant à un paroissien qui a un n° et n'en a pas encore (renvoie le sien). */
async function ensureIdentifiant(client) {
  if (!client.numero) return client.identifiant || null;
  if (client.identifiant) return client.identifiant;
  const value = await newIdentifiant();
  await clients().updateOne({ id: client.id }, { $set: { identifiant: value } });
  return value;
}

// Mot de passe provisoire lisible (sans 0/O, 1/l/I).
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

// Le n° client n'est jamais écrit dans l'e-mail : l'identifiant de connexion (8 chiffres)
// et le mot de passe y figurent (l'adresse peut être partagée par plusieurs paroissiens).
function passwordMail(client, password, loginUrl, reset) {
  const subject = reset ? 'Réinitialisation de votre mot de passe — FPMA Melun' : 'Votre accès à l’espace paroissien — FPMA Melun';
  const intro = reset
    ? 'Votre mot de passe de l’espace paroissien a été réinitialisé. Voici votre nouveau mot de passe provisoire :'
    : 'Votre espace paroissien est prêt : vous y retrouvez vos groupes et l’historique de vos quêtes. Voici votre mot de passe provisoire :';
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
  <tr><td style="background:#202578;color:#ffffff;padding:22px 28px;">
    <div style="font-size:22px;font-weight:bold;">FPMA Melun</div>
    <div style="font-size:14px;opacity:.85;">Espace paroissien</div>
  </td></tr>
  <tr><td style="padding:26px 28px 8px;">
    <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">Bonjour ${escapeHtml(client.prenom)} ${escapeHtml(client.nom)},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${intro}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px;">
      <tr><td style="padding:12px;color:#555;width:45%;">Identifiant</td><td style="padding:10px 12px;font-weight:bold;font-family:Consolas,monospace;font-size:18px;letter-spacing:1px;">${escapeHtml(client.identifiant || '')}</td></tr>
      <tr style="background:#f6f7fc;"><td style="padding:12px;color:#555;width:45%;">Mot de passe provisoire</td><td style="padding:10px 12px;font-weight:bold;font-family:Consolas,monospace;font-size:18px;letter-spacing:1px;">${escapeHtml(password)}</td></tr>
    </table>
    <p style="margin:22px 0;text-align:center;"><a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:12px 22px;background:#202578;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">Ouvrir mon espace paroissien</a></p>
    <p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#555;">Connectez-vous avec votre identifiant (ou votre adresse e-mail) et ce mot de passe provisoire : il vous sera demandé de choisir votre propre mot de passe.</p>
    <p style="margin:0;font-size:13px;line-height:1.5;color:#777;">${reset ? 'Votre ancien mot de passe ne fonctionne plus.' : 'Ce mot de passe est personnel : ne le communiquez à personne.'}</p>
  </td></tr>
  <tr><td style="padding:22px 28px 26px;font-size:12px;color:#777;line-height:1.5;border-top:1px solid #eceef5;">
    Église FPMA Melun — ${escapeHtml(ADDRESS)}<br>
    Merci de ne pas répondre à cet e-mail : pour toute question, adressez-vous directement à l’Église FPMA Melun.
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  const text = [
    'FPMA Melun — Espace paroissien',
    '',
    `Bonjour ${client.prenom} ${client.nom},`,
    '',
    intro,
    `Identifiant : ${client.identifiant || ''}`,
    `Mot de passe provisoire : ${password}`,
    '',
    `Connexion : ${loginUrl}`,
    'Connectez-vous avec votre identifiant (ou votre adresse e-mail) et ce mot de passe provisoire : il vous sera demandé de choisir votre propre mot de passe.',
    '',
    `Église FPMA Melun — ${ADDRESS}`,
    'Merci de ne pas répondre à cet e-mail.'
  ].join('\n');
  return { subject, html, text };
}

/**
 * Génère un mot de passe provisoire, l'enregistre (l'ancien ne marche plus, les sessions
 * ouvertes sont fermées) et l'envoie à l'e-mail de la fiche. Envoyé seulement depuis
 * l'admin : premier envoi, ou réinitialisation si le client avait déjà un mot de passe.
 * Renvoie { sent: true } ou { sent: false, error }.
 */
async function sendTemporaryPassword(client, loginUrl, by) {
  if (!isSmtpConfigured()) return { sent: false, error: 'E-mail du serveur non configuré (SMTP dans le .env).' };
  const reset = !!client.passwordHash;
  const password = temporaryPassword();
  const identifiant = await ensureIdentifiant(client);
  const content = passwordMail({ ...client, identifiant }, password, loginUrl, reset);
  try {
    await buildTransport().sendMail({
      from: `"FPMA Melun" <${process.env.SMTP_USER}>`,
      to: client.email,
      subject: content.subject,
      html: content.html,
      text: content.text
    });
  } catch (err) {
    await logClient(client, by, reset ? 'Échec de la réinitialisation du mot de passe' : 'Échec d’envoi du mot de passe provisoire', err.message);
    return { sent: false, error: 'L’e-mail n’a pas pu être envoyé. Réessayez plus tard.' };
  }
  await clients().updateOne(
    { id: client.id },
    {
      $set: { passwordHash: hashPassword(password), mustChangePassword: true, passwordSentAt: new Date().toISOString() },
      $inc: { passwordVersion: 1 }
    }
  );
  await logClient(client, by, reset ? 'Mot de passe réinitialisé' : 'Mot de passe provisoire envoyé', `à ${client.email}`);
  return { sent: true, reset };
}

/**
 * Mot de passe provisoire remis à la main (paroissien sans e-mail) : il est enregistré
 * (l'ancien ne marche plus, les sessions ouvertes sont fermées) et renvoyé à l'admin, qui
 * le copie pour le transmettre avec l'identifiant. Il n'est jamais envoyé par e-mail.
 */
async function manualTemporaryPassword(client, by) {
  const reset = !!client.passwordHash;
  const password = temporaryPassword();
  const identifiant = await ensureIdentifiant(client);
  await clients().updateOne(
    { id: client.id },
    {
      $set: { passwordHash: hashPassword(password), mustChangePassword: true, passwordSentAt: new Date().toISOString() },
      $inc: { passwordVersion: 1 }
    }
  );
  await logClient(client, by, reset ? 'Mot de passe réinitialisé (remis à la main)' : 'Mot de passe provisoire créé (remis à la main)', `identifiant ${identifiant}`);
  return { password, identifiant, reset };
}

// ---------- Paiements en ligne rattachés aux clients ----------

async function addStripeVersement(client, payment) {
  if (await versements().findOne({ paymentId: payment.id })) return false;
  const now = new Date().toISOString();
  await versements().insertOne({
    id: newId('versement'),
    clientId: client.id,
    date: parisDate(payment.paidAt || payment.updatedAt),
    amount: payment.amount,
    type: payment.choiceName,
    mode: ONLINE_MODE,
    groupId: null,
    note: payment.message || '',
    source: 'stripe',
    paymentId: payment.id,
    test: payment.mode === 'test',
    createdAt: now,
    createdBy: null
  });
  await logClient(
    client,
    null,
    'Paiement en ligne rattaché',
    `${payment.choiceName} — ${(payment.amount / 100).toLocaleString('fr-FR')} €${payment.mode === 'test' ? ' (test)' : ''}`
  );
  return true;
}

// Paiement Stripe réglé : ajouté aux versements du client qui a la même adresse e-mail.
// Adresse partagée par plusieurs fiches : on ne devine pas, le paiement reste à rattacher
// à la main (quête ajoutée dans la bonne fiche).
async function linkStripePayment(paymentId) {
  const payment = await col('payments').findOne({ id: paymentId, status: 'paid' });
  if (!payment?.email) return false;
  const owners = await clients().find({ email: normalizeEmail(payment.email) }, { projection: { _id: 0 } }).limit(2).toArray();
  if (owners.length !== 1) return false;
  return addStripeVersement(owners[0], payment);
}

// Nouvelle fiche ou e-mail modifié : on rattache aussi les paiements en ligne déjà faits
// (pas si l'adresse est partagée avec une autre fiche).
async function linkPastPayments(client) {
  if (!client.email) return 0;
  if (await clients().findOne({ email: client.email, id: { $ne: client.id } }, { projection: { _id: 1 } })) return 0;
  const list = await col('payments')
    .find({ status: 'paid', email: { $regex: `^${escapeRegex(client.email)}$`, $options: 'i' } })
    .toArray();
  let linked = 0;
  for (const payment of list) {
    if (await addStripeVersement(client, payment)) linked++;
  }
  return linked;
}

module.exports = {
  ONLINE_MODE,
  MODES_SETTING,
  allModes,
  modeLabels,
  DEFAULT_TYPES,
  SHOW_STRIPE_SETTING,
  showStripe,
  visibleVersements,
  newId,
  formatNumero,
  parseNumero,
  freeNumero,
  nextProvisoire,
  normalizeName,
  normalizeEmail,
  parisDate,
  logClient,
  sendTemporaryPassword,
  manualTemporaryPassword,
  ensureIdentifiant,
  newIdentifiant,
  linkStripePayment,
  linkPastPayments
};
