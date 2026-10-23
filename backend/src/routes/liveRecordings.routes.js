const express = require('express');
const fs = require('fs');
const path = require('path');
const asyncRouter = require('../utils/asyncRouter');
const { col, NO_ID } = require('../utils/db');
const { requireTab, createSignedValue, verifySignedValue } = require('../utils/auth');

// Enregistrements des directs. L'appareil qui filme enregistre la vidéo (celle que
// reçoivent les spectateurs) et l'envoie par morceaux pendant le direct : si l'onglet
// se ferme ou si le réseau coupe, ce qui a déjà été envoyé reste disponible.
//
// Les vidéos sont rangées hors du dossier public storage/ : on ne peut les télécharger
// qu'avec un lien signé, valable quelques minutes, demandé par un compte « Direct ».
// Une vidéo publiée (bouton « Publier sur Samihafa ») est en plus lisible par tous sur la
// page Samihafa, dossier Vidéo.
const router = asyncRouter();
const recordings = () => col('live_recordings');
const canManage = requireTab('direct');

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, '..', '..', 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const MAX_CHUNK_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_LINK_TTL_MS = 5 * 60 * 1000;
const TYPES = {
  'video/webm': 'webm',
  'video/mp4': 'mp4'
};

function fileOf(recording) {
  return path.join(RECORDINGS_DIR, `${recording.id}.${recording.ext}`);
}

function publicRecording(recording) {
  const { _id, ...rest } = recording;
  return rest;
}

// Nom de fichier lisible : « 2026-10-23 Culte en direct.webm ».
function downloadName(recording) {
  const date = String(recording.startedAt || '').slice(0, 10);
  const title = String(recording.title || 'Direct').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80);
  return `${date} ${title}.${recording.ext}`.trim();
}

// POST /api/live-recordings  { title, mimeType } - début d'un enregistrement
router.post('/', canManage, async (req, res) => {
  const mimeType = String(req.body?.mimeType || '').toLowerCase();
  const base = mimeType.split(';')[0].trim();
  const ext = TYPES[base];
  if (!ext) return res.status(400).json({ error: 'Format vidéo non pris en charge.' });
  const recording = {
    id: `direct-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    title: String(req.body?.title || 'Direct').trim().slice(0, 120) || 'Direct',
    mimeType: base,
    ext,
    startedAt: new Date().toISOString(),
    endedAt: null,
    size: 0,
    chunks: 0,
    status: 'recording',
    published: false,
    createdBy: req.user.username
  };
  fs.writeFileSync(fileOf(recording), Buffer.alloc(0));
  await recordings().insertOne({ ...recording });
  res.status(201).json(recording);
});

// POST /api/live-recordings/:id/chunk?seq=N - corps brut : morceau suivant de la vidéo.
// Les morceaux doivent arriver dans l'ordre (seq = nombre de morceaux déjà reçus).
router.post(
  '/:id/chunk',
  canManage,
  express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }),
  async (req, res) => {
    const recording = await recordings().findOne({ id: req.params.id }, NO_ID);
    if (!recording) return res.status(404).json({ error: 'Enregistrement introuvable.' });
    if (recording.status !== 'recording') return res.status(409).json({ error: 'Enregistrement terminé.' });
    const seq = Number(req.query.seq);
    if (seq !== recording.chunks) {
      return res.status(409).json({ error: 'Morceau hors séquence.', expected: recording.chunks });
    }
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    await fs.promises.appendFile(fileOf(recording), data);
    await recordings().updateOne(
      { id: recording.id },
      { $inc: { chunks: 1, size: data.length }, $set: { endedAt: new Date().toISOString() } }
    );
    res.json({ ok: true, size: recording.size + data.length });
  }
);

// POST /api/live-recordings/:id/finish - fin de l'enregistrement
router.post('/:id/finish', canManage, async (req, res) => {
  const recording = await recordings().findOne({ id: req.params.id }, NO_ID);
  if (!recording) return res.status(404).json({ error: 'Enregistrement introuvable.' });
  const size = fs.existsSync(fileOf(recording)) ? fs.statSync(fileOf(recording)).size : 0;
  const update = { status: 'done', endedAt: new Date().toISOString(), size };
  await recordings().updateOne({ id: recording.id }, { $set: update });
  res.json(publicRecording({ ...recording, ...update }));
});

// GET /api/live-recordings - liste (plus récent en premier). Un enregistrement resté
// « en cours » depuis plus de 2 minutes sans nouveau morceau est marqué interrompu.
router.get('/', canManage, async (req, res) => {
  const list = await recordings().find({}, NO_ID).sort({ startedAt: -1 }).toArray();
  const staleBefore = Date.now() - 2 * 60 * 1000;
  res.json(
    list.map(r => ({
      ...r,
      status: r.status === 'recording' && new Date(r.endedAt || r.startedAt).getTime() < staleBefore ? 'interrupted' : r.status
    }))
  );
});

// GET /api/live-recordings/public - public : vidéos publiées sur la page Samihafa.
router.get('/public', async (req, res) => {
  const list = await recordings()
    .find({ published: true, size: { $gt: 0 } }, NO_ID)
    .sort({ startedAt: -1 })
    .toArray();
  res.json(
    list.map(r => ({
      id: r.id,
      title: r.title,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      mimeType: r.mimeType,
      url: `/api/live-recordings/${encodeURIComponent(r.id)}/video`
    }))
  );
});

// GET /api/live-recordings/:id/video - public si la vidéo est publiée. Lecture en
// continu (le navigateur ne charge que le passage regardé).
router.get('/:id/video', async (req, res) => {
  const recording = await recordings().findOne({ id: req.params.id, published: true }, NO_ID);
  if (!recording || !fs.existsSync(fileOf(recording))) return res.status(404).json({ error: 'Vidéo introuvable.' });
  res.sendFile(fileOf(recording), { headers: { 'Content-Type': recording.mimeType, 'Cache-Control': 'public, max-age=3600' } });
});

// PUT /api/live-recordings/:id  { published?, title? } - publication sur Samihafa, titre
router.put('/:id', canManage, async (req, res) => {
  const recording = await recordings().findOne({ id: req.params.id }, NO_ID);
  if (!recording) return res.status(404).json({ error: 'Enregistrement introuvable.' });
  const update = {};
  if (req.body?.published !== undefined) {
    if (req.body.published === true && recording.status === 'recording' && Date.now() - new Date(recording.endedAt || recording.startedAt).getTime() < 2 * 60 * 1000) {
      return res.status(409).json({ error: 'Attendez la fin de l’enregistrement pour le publier.' });
    }
    update.published = req.body.published === true;
  }
  if (req.body?.title !== undefined) {
    const title = String(req.body.title).trim().slice(0, 120);
    if (!title) return res.status(400).json({ error: 'Le titre est obligatoire.' });
    update.title = title;
  }
  await recordings().updateOne({ id: recording.id }, { $set: update });
  res.json(publicRecording({ ...recording, ...update }));
});

// GET /api/live-recordings/:id/download-link - lien de téléchargement signé (5 min)
router.get('/:id/download-link', canManage, async (req, res) => {
  const recording = await recordings().findOne({ id: req.params.id }, NO_ID);
  if (!recording) return res.status(404).json({ error: 'Enregistrement introuvable.' });
  const token = createSignedValue({ recording: recording.id }, DOWNLOAD_LINK_TTL_MS);
  res.json({ url: `/api/live-recordings/${encodeURIComponent(recording.id)}/download?t=${encodeURIComponent(token)}` });
});

// GET /api/live-recordings/:id/download?t=... - téléchargement (lien signé, sans connexion)
router.get('/:id/download', async (req, res) => {
  const data = verifySignedValue(String(req.query.t || ''));
  if (!data || data.recording !== req.params.id) {
    return res.status(403).json({ error: 'Lien de téléchargement invalide ou expiré.' });
  }
  const recording = await recordings().findOne({ id: req.params.id }, NO_ID);
  if (!recording || !fs.existsSync(fileOf(recording))) {
    return res.status(404).json({ error: 'Enregistrement introuvable.' });
  }
  res.download(fileOf(recording), downloadName(recording), { headers: { 'Content-Type': recording.mimeType } });
});

// DELETE /api/live-recordings/:id - suppression de la vidéo et de sa fiche
router.delete('/:id', canManage, async (req, res) => {
  const recording = await recordings().findOne({ id: req.params.id }, NO_ID);
  if (!recording) return res.status(404).json({ error: 'Enregistrement introuvable.' });
  await recordings().deleteOne({ id: recording.id });
  await fs.promises.unlink(fileOf(recording)).catch(() => undefined);
  res.status(204).end();
});

module.exports = router;
