const express = require('express');
const path = require('path');
const JsonStore = require('../utils/jsonStore');

const router = express.Router();
const pageviewsStore = new JsonStore(path.join(__dirname, '..', 'data', 'pageviews.json'));
const locationsStore = new JsonStore(path.join(__dirname, '..', 'data', 'ip-locations.json'));

const VISITOR_LIMIT = 100;
const DAILY_RANGE = 14;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  return (raw || '').replace('::ffff:', '');
}

function isPrivateIp(ip) {
  if (!ip) return true;
  return (
    ip === '::1' ||
    ip === '127.0.0.1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip === 'localhost'
  );
}

function upsertLocation(ip, loc) {
  const all = locationsStore.readAll();
  const idx = all.findIndex(l => l.ip === ip);
  const entry = { ip, ...loc, resolvedAt: new Date().toISOString() };
  if (idx === -1) {
    all.push(entry);
  } else {
    all[idx] = entry;
  }
  locationsStore.writeAll(all);
}

// Résout pays/région/ville pour une IP via une API de géolocalisation gratuite, sans clé.
// Ne bloque jamais la requête appelante : toujours utilisée en fire-and-forget.
async function resolveLocationAsync(ip) {
  if (!ip || isPrivateIp(ip)) {
    if (!locationsStore.readAll().some(l => l.ip === ip)) {
      upsertLocation(ip, { country: 'Local', region: '', city: '' });
    }
    return;
  }

  if (locationsStore.readAll().some(l => l.ip === ip)) {
    return;
  }

  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`);
    const data = await response.json();
    if (data.status === 'success') {
      upsertLocation(ip, { country: data.country || 'Inconnu', region: data.regionName || '', city: data.city || '' });
    } else {
      upsertLocation(ip, { country: 'Inconnu', region: '', city: '' });
    }
  } catch (err) {
    console.warn('Géolocalisation IP échouée pour', ip, ':', err.message);
    upsertLocation(ip, { country: 'Inconnu', region: '', city: '' });
  }
}

function locationFor(ip, locByIp) {
  return locByIp[ip] || { country: 'En cours…', region: '', city: '' };
}

// POST /api/stats/pageview  { path, sessionId, referrer } - enregistre une navigation de page.
router.post('/pageview', (req, res) => {
  const { path: pagePath, sessionId, referrer } = req.body || {};
  if (!pagePath || !sessionId) {
    return res.status(400).json({ error: 'path et sessionId sont requis' });
  }

  const ip = getClientIp(req);
  const entry = {
    id: `pv-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    path: pagePath,
    sessionId,
    referrer: referrer || '',
    ip,
    userAgent: req.get('user-agent') || '',
    timestamp: new Date().toISOString()
  };

  const all = pageviewsStore.readAll();
  all.push(entry);
  pageviewsStore.writeAll(all);

  res.status(201).json({ success: true });

  resolveLocationAsync(ip).catch(() => {});
});

// GET /api/stats/summary - statistiques agrégées pour le tableau de bord admin.
router.get('/summary', (req, res) => {
  const all = pageviewsStore.readAll();
  const locations = locationsStore.readAll();
  const locByIp = Object.fromEntries(locations.map(l => [l.ip, l]));

  const totalPageviews = all.length;
  const totalSessions = new Set(all.map(v => v.sessionId)).size;

  const pageCounts = {};
  all.forEach(v => {
    pageCounts[v.path] = (pageCounts[v.path] || 0) + 1;
  });
  const topPages = Object.entries(pageCounts)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const countryCounts = {};
  all.forEach(v => {
    const country = locationFor(v.ip, locByIp).country;
    countryCounts[country] = (countryCounts[country] || 0) + 1;
  });
  const topCountries = Object.entries(countryCounts)
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const today = new Date();
  const days = [];
  for (let i = DAILY_RANGE - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const viewsByDay = {};
  const sessionsByDay = {};
  all.forEach(v => {
    const day = v.timestamp.slice(0, 10);
    viewsByDay[day] = (viewsByDay[day] || 0) + 1;
    if (!sessionsByDay[day]) sessionsByDay[day] = new Set();
    sessionsByDay[day].add(v.sessionId);
  });

  const daily = days.map(date => ({
    date,
    views: viewsByDay[date] || 0,
    sessions: sessionsByDay[date] ? sessionsByDay[date].size : 0
  }));

  res.json({ totalPageviews, totalSessions, topPages, topCountries, daily });
});

// GET /api/stats/visitors - détail des sessions récentes (parcours + localisation).
router.get('/visitors', (req, res) => {
  const all = pageviewsStore.readAll();
  const locations = locationsStore.readAll();
  const locByIp = Object.fromEntries(locations.map(l => [l.ip, l]));

  const bySession = {};
  all.forEach(v => {
    if (!bySession[v.sessionId]) {
      bySession[v.sessionId] = {
        sessionId: v.sessionId,
        ip: v.ip,
        userAgent: v.userAgent,
        location: locationFor(v.ip, locByIp),
        firstSeen: v.timestamp,
        lastSeen: v.timestamp,
        pages: []
      };
    }
    const session = bySession[v.sessionId];
    if (v.timestamp > session.lastSeen) session.lastSeen = v.timestamp;
    if (v.timestamp < session.firstSeen) session.firstSeen = v.timestamp;
    session.pages.push({ path: v.path, timestamp: v.timestamp });
  });

  const visitors = Object.values(bySession)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, VISITOR_LIMIT)
    .map(v => ({ ...v, pages: v.pages.sort((a, b) => a.timestamp.localeCompare(b.timestamp)) }));

  res.json(visitors);
});

module.exports = router;
