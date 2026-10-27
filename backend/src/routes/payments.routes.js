const crypto = require('crypto');
const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID, isDuplicateKey, getSetting, setSetting } = require('../utils/db');
const { requireTab, requireAdmin } = require('../utils/auth');
const { getBaseUrl } = require('../utils/baseUrl');
const stripe = require('../utils/stripe');
const { sendPaymentReceipt } = require('../utils/paymentReceipt');

// Paiement en ligne (Stripe Checkout) : choix paramétrables dans l'admin (Adidy, Don,
// Achat…), page de paiement publique qui ouvre la page sécurisée de Stripe, statut mis
// à jour par Stripe (webhook) et vérifié au retour sur le site. Chaque changement de
// statut est historisé dans le paiement ; chaque action de l'admin dans un journal.
//
// Statuts : pending (page Stripe ouverte), processing (paiement différé, ex. prélèvement),
// paid, failed, expired (session Stripe expirée), abandoned (retour sans payer).

const router = asyncRouter();
const choices = () => col('payment_choices');
const payments = () => col('payments');
const logs = () => col('payment_logs');
const canManage = requireTab('paiements');

const CURRENCY = 'eur';
const MIN_CENTS = 100;
const MAX_CENTS = 1_000_000;
const MAX_SUGGESTED = 6;
const CHECKOUT_LIMIT = 10;
const CHECKOUT_WINDOW_MS = 10 * 60 * 1000;
const STATUSES = ['pending', 'processing', 'paid', 'failed', 'expired', 'abandoned'];
// Interrupteur du superadmin : coupe le paiement en ligne sans toucher à la configuration Stripe.
const ONLINE_SETTING = 'payments-online';
const PAUSED_MESSAGE = 'Le paiement en ligne est momentanément indisponible.';

async function onlineState() {
  const state = await getSetting(ONLINE_SETTING, null);
  return { active: state?.active !== false, changedBy: state?.by || null, changedAt: state?.at || null };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function slugify(text) {
  return (
    String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'paiement'
  );
}

function toCents(euros) {
  const value = Number(String(euros ?? '').replace(',', '.'));
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
}

function publicChoice(c) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    amountType: c.amountType,
    amount: c.amount,
    minAmount: c.minAmount,
    suggestedAmounts: c.suggestedAmounts || [],
    submitType: c.submitType
  };
}

async function logAction(req, action, detail) {
  await logs().insertOne({ at: new Date().toISOString(), user: req.user?.username || null, action, detail });
}

// Ajoute une étape à l'historique d'un paiement (et change son statut si besoin).
async function addHistory(payment, entry, update = {}) {
  const at = new Date().toISOString();
  await payments().updateOne(
    { id: payment.id },
    { $set: { ...update, updatedAt: at }, $push: { history: { at, ...entry } } }
  );
}

// Statut d'un paiement d'après sa session Stripe.
function statusFromSession(session) {
  if (session.status === 'expired') return 'expired';
  if (session.status === 'complete') return session.payment_status === 'paid' || session.payment_status === 'no_payment_required' ? 'paid' : 'processing';
  return null;
}

// Change le statut (historisé). Un paiement réglé ne redevient jamais « en attente » ou
// « expiré ». force : ajoute la ligne d'historique même sans changement (évènement Stripe).
async function applyStatus(payment, status, source, extra = {}, entry = {}, force = false) {
  const changes = status && payment.status !== status && !(payment.status === 'paid' && status !== 'failed');
  const extraChanged = Object.keys(extra).some(k => payment[k] !== extra[k]);
  if (!changes && !force && !extraChanged) return payment;
  const update = { ...extra, ...(changes ? { status } : {}) };
  if (changes && status === 'paid') update.paidAt = new Date().toISOString();
  if (changes || force) {
    await addHistory(payment, { status: changes ? status : payment.status, event: source, ...entry }, update);
  } else {
    await payments().updateOne({ id: payment.id }, { $set: { ...update, updatedAt: new Date().toISOString() } });
  }
  // Paiement réglé : reçu par e-mail (en arrière-plan, envoyé une seule fois).
  if (changes && status === 'paid') {
    sendPaymentReceipt(payment.id).catch(err => console.error('Reçu de paiement non envoyé :', err.message));
  }
  return { ...payment, ...update };
}

// Informations utiles renvoyées par Stripe (référence du paiement, nom et e-mail saisis).
function sessionExtras(payment, session) {
  const extra = {};
  if (session.payment_intent) extra.stripePaymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
  if (!payment.email && session.customer_details?.email) extra.email = session.customer_details.email;
  if (!payment.name && session.customer_details?.name) extra.name = session.customer_details.name;
  return extra;
}

async function syncFromSession(payment, session, source) {
  return applyStatus(payment, statusFromSession(session), source, sessionExtras(payment, session));
}

async function findBySession(session) {
  const id = session.client_reference_id || session.metadata?.paymentId;
  return (
    (id && (await payments().findOne({ id }, NO_ID))) ||
    (session.id && (await payments().findOne({ stripeSessionId: session.id }, NO_ID)))
  );
}

// Validation d'un choix saisi dans l'admin (montants en euros côté admin, en centimes ici).
function readChoice(body) {
  const errors = [];
  const name = String(body.name || '').trim().slice(0, 60);
  if (name.length < 2) errors.push('Le nom est obligatoire.');
  const description = String(body.description || '').trim().slice(0, 500);
  const amountType = body.amountType === 'fixed' ? 'fixed' : 'free';
  let amount = null;
  let minAmount = MIN_CENTS;
  let suggestedAmounts = [];
  if (amountType === 'fixed') {
    amount = toCents(body.amount);
    if (!(amount >= MIN_CENTS && amount <= MAX_CENTS)) errors.push('Montant fixe : entre 1 € et 10 000 €.');
  } else {
    minAmount = body.minAmount === undefined || body.minAmount === '' ? MIN_CENTS : toCents(body.minAmount);
    if (!(minAmount >= MIN_CENTS && minAmount <= MAX_CENTS)) errors.push('Montant minimum : entre 1 € et 10 000 €.');
    suggestedAmounts = (Array.isArray(body.suggestedAmounts) ? body.suggestedAmounts : String(body.suggestedAmounts || '').split(/[;\s]+/))
      .map(toCents)
      .filter(v => Number.isFinite(v) && v > 0);
    if (suggestedAmounts.some(v => v < minAmount || v > MAX_CENTS)) errors.push('Les montants proposés doivent être au moins égaux au minimum.');
    suggestedAmounts = [...new Set(suggestedAmounts)].sort((a, b) => a - b).slice(0, MAX_SUGGESTED);
  }
  return {
    errors,
    fields: {
      name,
      description,
      amountType,
      amount,
      minAmount,
      suggestedAmounts,
      submitType: body.submitType === 'donate' ? 'donate' : 'pay',
      active: body.active !== false,
      order: Number.isFinite(Number(body.order)) ? Number(body.order) : 0
    }
  };
}

async function uniqueSlug(name, exceptId) {
  const base = slugify(name);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const existing = await choices().findOne({ slug });
    if (!existing || existing.id === exceptId) return slug;
  }
}

// Adresse du site pour les retours de Stripe (« merci », « annulé ») : celle de la page où
// la personne a cliqué « Payer » (en-tête Origin envoyé par le navigateur). Elle peut
// différer de celle du backend (site sur un autre port en développement). SITE_URL dans
// le .env l'impose si besoin.
function siteBase(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const origin = req.get('origin');
  if (origin && /^https?:\/\/[^/\s]+$/i.test(origin)) return origin;
  return getBaseUrl(req);
}

// Limite le nombre de paiements lancés par adresse IP (évite les abus).
const checkoutHits = new Map();
function tooManyCheckouts(ip) {
  const now = Date.now();
  const hits = (checkoutHits.get(ip) || []).filter(t => now - t < CHECKOUT_WINDOW_MS);
  hits.push(now);
  checkoutHits.set(ip, hits);
  return hits.length > CHECKOUT_LIMIT;
}

// ---------- Public ----------

router.get('/config', async (req, res) => {
  const { active } = await onlineState();
  const configured = stripe.isConfigured();
  res.json({ enabled: configured && active, paused: !active, mode: configured ? stripe.mode() : null });
});

router.get('/choices', async (req, res) => {
  const list = await choices().find({ active: true }, NO_ID).sort({ order: 1, name: 1 }).toArray();
  res.json(list.map(publicChoice));
});

router.get('/choices/:slug', async (req, res) => {
  const choice = await choices().findOne({ slug: req.params.slug, active: true }, NO_ID);
  if (!choice) return res.status(404).json({ error: 'Ce choix de paiement n’existe pas ou n’est plus disponible.' });
  res.json(publicChoice(choice));
});

// POST /api/payments/checkout  { slug, amount (euros, montant libre), name, email, message }
router.post('/checkout', async (req, res) => {
  if (!stripe.isConfigured()) return res.status(503).json({ error: 'Le paiement en ligne n’est pas encore disponible.' });
  if (!(await onlineState()).active) return res.status(503).json({ error: PAUSED_MESSAGE });
  if (tooManyCheckouts(req.ip)) return res.status(429).json({ error: 'Trop de tentatives : réessayez dans quelques minutes.' });
  const choice = await choices().findOne({ slug: String(req.body?.slug || ''), active: true }, NO_ID);
  if (!choice) return res.status(404).json({ error: 'Ce choix de paiement n’est plus disponible.' });

  const amount = choice.amountType === 'fixed' ? choice.amount : toCents(req.body?.amount);
  if (!(amount >= (choice.minAmount || MIN_CENTS) && amount <= MAX_CENTS)) {
    return res.status(400).json({ error: `Montant : entre ${((choice.minAmount || MIN_CENTS) / 100).toLocaleString('fr-FR')} € et 10 000 €.` });
  }
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Indiquez votre nom.' });
  const email = String(req.body?.email || '').trim().slice(0, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  const message = String(req.body?.message || '').trim().slice(0, 300);

  const now = new Date().toISOString();
  const payment = {
    id: newId('paiement'),
    // Jeton du lien de retour « annuler » (seule la personne qui paie le connaît).
    returnToken: crypto.randomBytes(12).toString('hex'),
    choiceId: choice.id,
    choiceSlug: choice.slug,
    choiceName: choice.name,
    amount,
    currency: CURRENCY,
    name,
    email: email || null,
    message: message || null,
    status: 'pending',
    stripeSessionId: null,
    stripePaymentIntent: null,
    mode: stripe.mode(),
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    history: [{ at: now, status: 'pending', event: 'Paiement créé sur le site' }]
  };
  await payments().insertOne({ ...payment });

  const base = siteBase(req);
  try {
    const session = await stripe.createCheckoutSession({
      mode: 'payment',
      client_reference_id: payment.id,
      customer_email: payment.email || undefined,
      submit_type: choice.submitType === 'donate' ? 'donate' : 'pay',
      success_url: `${base}/paiement/merci?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/paiement/${choice.slug}?annule=${payment.id}&t=${payment.returnToken}`,
      locale: 'fr',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: amount,
            product_data: { name: `${choice.name} — FPMA Melun`, description: choice.description || undefined }
          }
        }
      ],
      metadata: { paymentId: payment.id, choice: choice.name, name },
      payment_intent_data: { description: `${choice.name} — ${name}`, metadata: { paymentId: payment.id } }
    });
    await addHistory(payment, { status: 'pending', event: 'Page de paiement Stripe ouverte', detail: session.id }, { stripeSessionId: session.id });
    res.status(201).json({ url: session.url, paymentId: payment.id });
  } catch (err) {
    await addHistory(payment, { status: 'failed', event: 'Création du paiement Stripe impossible', detail: err.message }, { status: 'failed' });
    res.status(err.status || 502).json({ error: 'Le paiement n’a pas pu être lancé. Réessayez dans un instant.' });
  }
});

// POST /api/payments/:id/abandon  { t } - retour sur le site sans avoir payé.
router.post('/:id/abandon', async (req, res) => {
  const payment = await payments().findOne({ id: req.params.id }, NO_ID);
  if (!payment || payment.returnToken !== String(req.body?.t || '')) return res.status(404).json({ error: 'Paiement introuvable.' });
  if (payment.status === 'pending') await applyStatus(payment, 'abandoned', 'Retour sur le site sans payer');
  res.json({ ok: true });
});

// GET /api/payments/result?session_id=... - page « merci » : statut vérifié auprès de Stripe.
router.get('/result', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  let payment = sessionId && (await payments().findOne({ stripeSessionId: sessionId }, NO_ID));
  if (!payment) return res.status(404).json({ error: 'Paiement introuvable.' });
  try {
    const session = await stripe.retrieveCheckoutSession(sessionId);
    payment = await syncFromSession(payment, session, 'Vérifié auprès de Stripe au retour sur le site');
  } catch {
    // Stripe injoignable : on affiche le dernier statut connu (le webhook complétera).
  }
  res.json({ status: payment.status, amount: payment.amount, currency: payment.currency, choiceName: payment.choiceName, name: payment.name });
});

// POST /api/payments/webhook - notifications de Stripe (corps brut, signature vérifiée).
// Monté dans server.js avant express.json() : la signature porte sur le corps exact.
async function webhookHandler(req, res) {
  let event;
  try {
    event = stripe.verifyWebhook(req.body, req.get('stripe-signature'));
  } catch (err) {
    return res.status(400).json({ error: `Webhook refusé : ${err.message}` });
  }
  const session = event.data?.object || {};
  const payment = await findBySession(session);
  if (!payment) return res.json({ received: true, ignored: 'paiement inconnu' });
  // Une même notification peut arriver plusieurs fois : on ne la traite qu'une fois.
  if ((payment.history || []).some(h => h.stripeEvent === event.id)) return res.json({ received: true, duplicate: true });

  const label = {
    'checkout.session.completed': 'Stripe : paiement terminé',
    'checkout.session.async_payment_succeeded': 'Stripe : paiement différé réussi',
    'checkout.session.async_payment_failed': 'Stripe : paiement différé échoué',
    'checkout.session.expired': 'Stripe : session expirée'
  }[event.type];
  if (!label) return res.json({ received: true, ignored: event.type });

  let status = statusFromSession(session);
  if (event.type === 'checkout.session.async_payment_succeeded') status = 'paid';
  if (event.type === 'checkout.session.async_payment_failed') status = 'failed';
  if (event.type === 'checkout.session.expired') status = 'expired';

  // Une ligne d'historique par évènement Stripe, même s'il ne change pas le statut.
  await applyStatus(payment, status, label, sessionExtras(payment, session), { stripeEvent: event.id, detail: event.type }, true);
  res.json({ received: true });
}

// ---------- Admin (onglet Paiements) ----------

router.get('/admin/choices', canManage, async (req, res) => {
  res.json(await choices().find({}, NO_ID).sort({ order: 1, name: 1 }).toArray());
});

router.post('/admin/choices', canManage, async (req, res) => {
  const { errors, fields } = readChoice(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const now = new Date().toISOString();
  const choice = { id: newId('choix'), slug: await uniqueSlug(fields.name), ...fields, createdAt: now, updatedAt: now };
  try {
    await choices().insertOne({ ...choice });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Un choix porte déjà ce nom.' });
    throw err;
  }
  await logAction(req, 'Choix créé', `${choice.name} (${choice.slug})`);
  res.status(201).json(choice);
});

router.put('/admin/choices/:id', canManage, async (req, res) => {
  const current = await choices().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Choix introuvable.' });
  const { errors, fields } = readChoice({ ...current, ...req.body, amount: req.body?.amount ?? (current.amount ?? 0) / 100 });
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  const update = { ...fields, updatedAt: new Date().toISOString() };
  await choices().updateOne({ id: current.id }, { $set: update });
  const changes = Object.keys(fields).filter(k => JSON.stringify(fields[k]) !== JSON.stringify(current[k]));
  await logAction(req, 'Choix modifié', `${fields.name} : ${changes.join(', ') || 'aucun changement'}`);
  res.json({ ...current, ...update });
});

router.delete('/admin/choices/:id', canManage, async (req, res) => {
  const current = await choices().findOne({ id: req.params.id }, NO_ID);
  if (!current) return res.status(404).json({ error: 'Choix introuvable.' });
  await choices().deleteOne({ id: current.id });
  await logAction(req, 'Choix supprimé', current.name);
  res.status(204).end();
});

// GET /api/payments/admin/payments?status=&choice=&from=AAAA-MM-JJ&to=AAAA-MM-JJ
router.get('/admin/payments', canManage, async (req, res) => {
  const filter = {};
  if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
  if (req.query.choice) filter.choiceId = String(req.query.choice);
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = `${req.query.from}T00:00:00`;
    if (req.query.to) filter.createdAt.$lte = `${req.query.to}T23:59:59.999Z`;
  }
  const list = await payments()
    .find(filter, { projection: { _id: 0, returnToken: 0, 'receipt.html': 0, 'receipt.text': 0 } })
    .sort({ createdAt: -1 })
    .limit(1000)
    .toArray();
  res.json(list);
});

// GET /api/payments/admin/payments/:id - détail complet (avec le contenu du reçu envoyé).
router.get('/admin/payments/:id', canManage, async (req, res) => {
  const payment = await payments().findOne({ id: req.params.id }, { projection: { _id: 0, returnToken: 0 } });
  if (!payment) return res.status(404).json({ error: 'Paiement introuvable.' });
  res.json(payment);
});

// POST /api/payments/admin/payments/:id/sync - revérifier le statut auprès de Stripe.
router.post('/admin/payments/:id/sync', canManage, async (req, res) => {
  const payment = await payments().findOne({ id: req.params.id }, NO_ID);
  if (!payment) return res.status(404).json({ error: 'Paiement introuvable.' });
  if (!payment.stripeSessionId) return res.status(409).json({ error: 'Ce paiement n’a pas de session Stripe.' });
  const session = await stripe.retrieveCheckoutSession(payment.stripeSessionId);
  await syncFromSession(payment, session, `Revérifié auprès de Stripe par ${req.user.username}`);
  await logAction(req, 'Paiement revérifié', `${payment.id} (${payment.choiceName}, ${payment.amount / 100} €)`);
  const { returnToken, ...rest } = await payments().findOne({ id: payment.id }, NO_ID);
  res.json(rest);
});

// POST /api/payments/admin/payments/:id/receipt - renvoyer le reçu par e-mail.
router.post('/admin/payments/:id/receipt', canManage, async (req, res) => {
  const payment = await payments().findOne({ id: req.params.id }, NO_ID);
  if (!payment) return res.status(404).json({ error: 'Paiement introuvable.' });
  if (payment.status !== 'paid') return res.status(409).json({ error: 'Seul un paiement réglé a un reçu.' });
  if (!payment.email) return res.status(409).json({ error: 'Aucune adresse e-mail pour ce paiement.' });
  const receipt = await sendPaymentReceipt(payment.id, { force: true, by: req.user.username });
  await logAction(req, 'Reçu renvoyé', `${payment.id} à ${payment.email} (${receipt?.status})`);
  const { returnToken, ...rest } = await payments().findOne({ id: payment.id }, NO_ID);
  res.json(rest);
});

// GET /api/payments/admin/status - état de la configuration Stripe et e-mail (sans les clés).
router.get('/admin/status', canManage, async (req, res) => {
  res.json({ ...stripe.diagnose(), smtp: require('../utils/mailer').isSmtpConfigured(), online: await onlineState() });
});

// PUT /api/payments/admin/online  { active } - superadmin uniquement.
router.put('/admin/online', requireAdmin, async (req, res) => {
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'Valeur « active » manquante.' });
  const active = req.body.active;
  await setSetting(ONLINE_SETTING, { active, by: req.user.username, at: new Date().toISOString() });
  await logAction(req, active ? 'Paiement en ligne activé' : 'Paiement en ligne désactivé', active ? 'Les pages de paiement sont de nouveau ouvertes.' : PAUSED_MESSAGE);
  res.json(await onlineState());
});

router.get('/admin/logs', canManage, async (req, res) => {
  res.json(await logs().find({}, NO_ID).sort({ at: -1 }).limit(300).toArray());
});

module.exports = router;
module.exports.webhookHandler = webhookHandler;
