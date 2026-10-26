const crypto = require('crypto');

// Client Stripe minimal (API HTTP officielle, sans dépendance) : création et lecture
// d'une session de paiement Stripe Checkout, et vérification de la signature des
// notifications (webhook).
//
// .env :
//   STRIPE_SECRET_KEY      clé secrète (sk_test_… pour les essais, sk_live_… en vrai)
//   STRIPE_WEBHOOK_SECRET  secret de signature du webhook (whsec_…)
//   STRIPE_API_BASE        (tests uniquement) autre adresse que https://api.stripe.com

const API_BASE = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const WEBHOOK_TOLERANCE_S = 5 * 60;

function secretKey() {
  return process.env.STRIPE_SECRET_KEY || '';
}

function isConfigured() {
  return /^sk_(test|live)_/.test(secretKey()) || (!!process.env.STRIPE_API_BASE && !!secretKey());
}

function mode() {
  return secretKey().startsWith('sk_live_') ? 'live' : 'test';
}

// Encodage « formulaire » de Stripe : { a: { b: 1 } } -> a[b]=1 ; tableaux indexés.
function encodeForm(data, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') encodeForm(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

async function call(method, path, body) {
  if (!isConfigured()) {
    const err = new Error('Le paiement en ligne n’est pas configuré (clé Stripe manquante).');
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      'Stripe-Version': '2024-06-20'
    },
    body: body ? encodeForm(body).toString() : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Erreur Stripe (${res.status}).`);
    err.status = 502;
    err.stripe = data?.error;
    throw err;
  }
  return data;
}

function createCheckoutSession(params) {
  return call('POST', '/v1/checkout/sessions', params);
}

function retrieveCheckoutSession(id) {
  return call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
}

// En-tête Stripe-Signature : « t=horodatage,v1=signature[,v1=…] ». La signature est un
// HMAC-SHA256 de « horodatage.corps brut » avec le secret du webhook.
function verifyWebhook(rawBody, header, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET manquant.');
  const parts = String(header || '').split(',').map(p => p.split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || !signatures.length) throw new Error('Signature absente.');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) throw new Error('Signature trop ancienne.');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const ok = signatures.some(sig => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) throw new Error('Signature invalide.');
  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = { isConfigured, mode, createCheckoutSession, retrieveCheckoutSession, verifyWebhook };
