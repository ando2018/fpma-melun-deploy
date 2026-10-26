const { col } = require('./db');
const { isSmtpConfigured, buildTransport } = require('./mailer');

// Reçu de paiement envoyé par e-mail quand un paiement passe à « Payé », si la personne a
// indiqué son adresse. Le contenu exact de l'e-mail (objet, HTML, texte) est gardé dans le
// paiement : l'admin le revoit tel quel dans l'historique.
//
// Ce reçu confirme un paiement ; ce n'est pas un reçu fiscal (Cerfa).

const payments = () => col('payments');
const ADDRESS = '69 Av. du Maréchal Foch, 77190 Dammarie-les-Lys';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(cents) {
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }).replace(/ /g, ' ');
}

function dateFr(iso) {
  return new Date(iso).toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Numéro de reçu unique et croissant : FPMA-2026-00001.
async function nextReceiptNumber() {
  const year = new Date().getFullYear();
  const doc = await col('settings').findOneAndUpdate(
    { _id: `payment-receipt-counter-${year}` },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `FPMA-${year}-${String(doc.value).padStart(5, '0')}`;
}

function buildReceipt(payment, number) {
  const paidAt = payment.paidAt || payment.updatedAt;
  const reference = payment.stripePaymentIntent || payment.stripeSessionId || '—';
  const test = payment.mode === 'test';
  const subject = `${test ? '[TEST] ' : ''}Reçu de paiement ${number} — ${payment.choiceName} — FPMA Melun`;
  const rows = [
    ['Reçu n°', number],
    ['Date du paiement', dateFr(paidAt)],
    ['Objet', payment.choiceName],
    ['Montant', money(payment.amount)],
    ['Moyen de paiement', 'Paiement en ligne sécurisé (Stripe)'],
    ['Référence', reference]
  ];
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
  <tr><td style="background:#202578;color:#ffffff;padding:22px 28px;">
    <div style="font-size:22px;font-weight:bold;">FPMA Melun</div>
    <div style="font-size:14px;opacity:.85;">Église Protestante Malgache en France</div>
  </td></tr>
  ${test ? '<tr><td style="background:#f1ecfb;color:#4b2a85;padding:8px 28px;font-size:13px;font-weight:bold;">Paiement de test : aucun montant réel n’a été prélevé.</td></tr>' : ''}
  <tr><td style="padding:26px 28px 8px;">
    <h1 style="margin:0 0 12px;font-size:20px;color:#202578;">Reçu de paiement</h1>
    <p style="margin:0 0 10px;font-size:15px;line-height:1.5;">Bonjour ${escapeHtml(payment.name)},</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.5;">Nous avons bien reçu votre paiement « ${escapeHtml(payment.choiceName)} ». Merci pour votre soutien et votre fidélité. Que Dieu vous bénisse.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
      ${rows
        .map(
          ([label, value], i) =>
            `<tr style="background:${i % 2 ? '#ffffff' : '#f6f7fc'};"><td style="padding:9px 12px;color:#555;width:42%;">${escapeHtml(label)}</td><td style="padding:9px 12px;font-weight:bold;${label === 'Montant' ? 'color:#1e7a34;font-size:16px;' : ''}">${escapeHtml(value)}</td></tr>`
        )
        .join('\n      ')}
    </table>
    ${payment.message ? `<p style="margin:18px 0 0;font-size:14px;color:#555;">Votre message : « ${escapeHtml(payment.message)} »</p>` : ''}
  </td></tr>
  <tr><td style="padding:22px 28px 26px;font-size:12px;color:#777;line-height:1.5;border-top:1px solid #eceef5;">
    Église FPMA Melun — ${escapeHtml(ADDRESS)}<br>
    Ce reçu confirme votre paiement ; il ne constitue pas un reçu fiscal.<br>
    Merci de ne pas répondre à cet e-mail : pour toute question, adressez-vous directement à l’Église FPMA Melun.
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  const text = [
    'FPMA Melun — Reçu de paiement',
    test ? '(Paiement de test : aucun montant réel n’a été prélevé.)' : null,
    '',
    `Bonjour ${payment.name},`,
    '',
    `Nous avons bien reçu votre paiement « ${payment.choiceName} ». Merci pour votre soutien.`,
    '',
    ...rows.map(([label, value]) => `${label} : ${value}`),
    payment.message ? `Votre message : « ${payment.message} »` : null,
    '',
    `Église FPMA Melun — ${ADDRESS}`,
    'Ce reçu confirme votre paiement ; il ne constitue pas un reçu fiscal.',
    'Merci de ne pas répondre à cet e-mail : pour toute question, adressez-vous directement à l’Église FPMA Melun.'
  ]
    .filter(line => line !== null)
    .join('\n');
  return { subject, html, text };
}

async function addHistory(paymentId, status, event, detail) {
  await payments().updateOne(
    { id: paymentId },
    { $push: { history: { at: new Date().toISOString(), status, event, ...(detail ? { detail } : {}) } } }
  );
}

/**
 * Prépare et envoie le reçu d'un paiement payé. Sans force, ne fait rien si un reçu a
 * déjà été envoyé ou est en cours d'envoi (le webhook de Stripe et la page « merci »
 * peuvent signaler le paiement presque en même temps). by : qui a demandé un renvoi.
 */
async function sendPaymentReceipt(paymentId, { force = false, by = null } = {}) {
  const claimFilter = { id: paymentId, status: 'paid' };
  if (!force) claimFilter['receipt.status'] = { $nin: ['sent', 'sending'] };
  const payment = await payments().findOneAndUpdate(
    claimFilter,
    { $set: { 'receipt.status': 'sending' } },
    { returnDocument: 'after', projection: { _id: 0 } }
  );
  if (!payment) return null;

  if (!payment.email) {
    const receipt = { status: 'no-email', at: new Date().toISOString() };
    await payments().updateOne({ id: paymentId }, { $set: { receipt } });
    await addHistory(paymentId, payment.status, 'Pas d’adresse e-mail : aucun reçu envoyé');
    return receipt;
  }

  const number = payment.receipt?.number || (await nextReceiptNumber());
  const content = buildReceipt(payment, number);
  const receipt = { number, to: payment.email, ...content, preparedAt: new Date().toISOString() };

  if (!isSmtpConfigured()) {
    Object.assign(receipt, { status: 'not-configured', error: 'SMTP non configuré dans le .env' });
    await payments().updateOne({ id: paymentId }, { $set: { receipt } });
    await addHistory(paymentId, payment.status, `Reçu ${number} préparé mais non envoyé (SMTP non configuré)`);
    return receipt;
  }

  try {
    const info = await buildTransport().sendMail({
      from: `"FPMA Melun" <${process.env.SMTP_USER}>`,
      to: payment.email,
      subject: content.subject,
      html: content.html,
      text: content.text
    });
    Object.assign(receipt, { status: 'sent', sentAt: new Date().toISOString(), messageId: info.messageId || null, error: null });
    await payments().updateOne({ id: paymentId }, { $set: { receipt } });
    await addHistory(
      paymentId,
      payment.status,
      `${by ? `Reçu ${number} renvoyé par ${by}` : `Reçu ${number} envoyé par e-mail`} à ${payment.email}`
    );
  } catch (err) {
    Object.assign(receipt, { status: 'failed', error: err.message });
    await payments().updateOne({ id: paymentId }, { $set: { receipt } });
    await addHistory(paymentId, payment.status, `Échec de l’envoi du reçu ${number} à ${payment.email}`, err.message);
  }
  return receipt;
}

module.exports = { sendPaymentReceipt, buildReceipt };
