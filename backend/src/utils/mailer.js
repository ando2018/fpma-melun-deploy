const nodemailer = require('nodemailer');

// Envoi d'e-mails (formulaire de contact, reçus de paiement) avec le compte SMTP du .env :
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (et MAIL_TO pour les réponses).

function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function buildTransport() {
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

module.exports = { isSmtpConfigured, buildTransport };
