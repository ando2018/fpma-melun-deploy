const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// Image d'aperçu du lien de partage du direct (WhatsApp, Facebook…) : « FPMA Melun en
// direct », le titre et la description du direct, et le logo. Générée à la volée en JPEG
// (WhatsApp ignore les images trop lourdes) et gardée en mémoire tant que le texte ne
// change pas.
const WIDTH = 1200;
const HEIGHT = 630;
const LOGO_CANDIDATES = [
  process.env.FRONTEND_DIST_PATH && path.join(process.env.FRONTEND_DIST_PATH, 'assets', 'images', 'banniere-droite.png'),
  path.join(__dirname, '..', '..', '..', 'fpma-site', 'src', 'assets', 'images', 'banniere-droite.png'),
  path.join(__dirname, '..', '..', '..', 'fpma-site', 'dist', 'fpma-site', 'assets', 'images', 'banniere-droite.png')
].filter(Boolean);

// Quelques images gardées en mémoire (direct public, direct privé…).
const cache = new Map();
const CACHE_SIZE = 6;
let logoDataUri;

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Coupe un texte en lignes d'environ maxChars caractères, au plus maxLines lignes.
function wrap(text, maxChars, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[\s.,;:!?…]*$/, '').slice(0, maxChars - 1)}…`;
  }
  return lines;
}

function logo() {
  if (logoDataUri !== undefined) return logoDataUri;
  const file = LOGO_CANDIDATES.find(f => fs.existsSync(f));
  logoDataUri = file ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : null;
  return logoDataUri;
}

function shareImageKey(info) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([info.onAir, info.private, info.title, info.description]))
    .digest('hex')
    .slice(0, 12);
}

function buildSvg(info) {
  const font = "DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif";
  // Direct privé : titre et description toujours affichés (invitation envoyée avant le
  // direct), badge violet.
  const badge = info.private ? (info.onAir ? '● DIRECT PRIVÉ' : 'DIRECT PRIVÉ') : info.onAir ? '● EN DIRECT' : 'DIRECT';
  const badgeColor = info.private ? '#6a3fb5' : info.onAir ? '#d62f2f' : '#6b6f86';
  const badgeWidth = info.private ? (info.onAir ? 360 : 320) : info.onAir ? 290 : 190;
  const showDetails = info.onAir || info.private;
  const titleLines = wrap(showDetails ? info.title : 'Les directs de la FPMA Melun', 30, 2);
  const descLines = wrap(
    showDetails
      ? info.description || (info.private ? 'Accès réservé : indiquez votre nom pour rejoindre le direct.' : 'Rejoignez-nous en direct.')
      : 'Pas de direct pour le moment : vous serez notifié lors du prochain direct.',
    52,
    3
  );
  const logoUri = logo();
  const titleY = 355;
  // Première ligne de description, 62 px sous la dernière ligne du titre.
  const descY = titleY + (titleLines.length - 1) * 66 + 62;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#262b8f"/>
      <stop offset="1" stop-color="#0f1240"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect x="0" y="${HEIGHT - 14}" width="${WIDTH}" height="14" fill="${info.private ? '#6a3fb5' : '#d62f2f'}"/>
  <text x="70" y="120" font-family="${font}" font-size="64" font-weight="bold" fill="#ffffff">FPMA Melun</text>
  <rect x="70" y="160" width="${badgeWidth}" height="64" rx="12" fill="${badgeColor}"/>
  <text x="${70 + badgeWidth / 2}" y="204" text-anchor="middle" font-family="${font}" font-size="34" font-weight="bold" fill="#ffffff">${escapeXml(badge)}</text>
  ${titleLines
    .map((l, i) => `<text x="70" y="${titleY + i * 66}" font-family="${font}" font-size="54" font-weight="bold" fill="#ffffff">${escapeXml(l)}</text>`)
    .join('\n  ')}
  ${descLines
    .map((l, i) => `<text x="70" y="${descY + i * 42}" font-family="${font}" font-size="32" fill="#d9dcf5">${escapeXml(l)}</text>`)
    .join('\n  ')}
  ${
    logoUri
      ? `<rect x="900" y="60" width="240" height="240" rx="24" fill="#ffffff"/>
  <image x="912" y="72" width="216" height="216" xlink:href="${logoUri}" href="${logoUri}"/>`
      : ''
  }
</svg>`;
}

async function liveShareImage(info) {
  const key = shareImageKey(info);
  if (cache.has(key)) return cache.get(key);
  const buffer = await sharp(Buffer.from(buildSvg(info))).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  cache.set(key, buffer);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return buffer;
}

module.exports = { liveShareImage, shareImageKey };
