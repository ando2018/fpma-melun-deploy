const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const JsonStore = require('../utils/jsonStore');

const router = express.Router();
const store = new JsonStore(path.join(__dirname, '..', 'data', 'messages.json'));

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

// POST /api/contact  { name, email, message } - envoie le mail (si SMTP configuré) et garde une trace.
router.post('/', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !name.trim() || !email || !email.trim() || !message || !message.trim()) {
    return res.status(400).json({ error: 'name, email et message sont requis' });
  }

  const entry = {
    id: `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    name: name.trim(),
    email: email.trim(),
    message: message.trim(),
    receivedAt: new Date().toISOString(),
    mailSent: false,
    lu: false
  };

  if (isSmtpConfigured()) {
    try {
      const transport = buildTransport();
      await transport.sendMail({
        from: `"Site FPMA Melun" <${process.env.SMTP_USER}>`,
        to: process.env.MAIL_TO || process.env.SMTP_USER,
        replyTo: entry.email,
        subject: `Nouveau message de contact — ${entry.name}`,
        text: entry.message,
        html: `<p><strong>De :</strong> ${entry.name} (${entry.email})</p><p>${entry.message.replace(/\n/g, '<br>')}</p>`
      });
      entry.mailSent = true;
    } catch (err) {
      console.error('Échec de l\'envoi du mail de contact :', err.message);
    }
  } else {
    console.warn('SMTP non configuré (voir .env.example) — message enregistré mais pas envoyé par mail.');
  }

  const all = store.readAll();
  all.unshift(entry);
  store.writeAll(all);

  res.status(201).json({ success: true, mailSent: entry.mailSent });
});

// GET /api/contact - liste des messages reçus (admin)
router.get('/', (req, res) => {
  res.json(store.readAll());
});

// PATCH /api/contact/:id/lu - marque un message comme lu
router.patch('/:id/lu', (req, res) => {
  const all = store.readAll();
  const index = all.findIndex(m => m.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Message introuvable' });
  all[index].lu = true;
  store.writeAll(all);
  res.json(all[index]);
});

// DELETE /api/contact/:id - supprime un message
router.delete('/:id', (req, res) => {
  const all = store.readAll();
  const filtered = all.filter(m => m.id !== req.params.id);
  if (filtered.length === all.length) return res.status(404).json({ error: 'Message introuvable' });
  store.writeAll(filtered);
  res.status(204).end();
});

module.exports = router;
