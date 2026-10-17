const asyncRouter = require('../utils/asyncRouter');
const { col } = require('../utils/db');
const { requireTab } = require('../utils/auth');

const router = asyncRouter();
const pageviews = () => col('pageviews');
const locations = () => col('ip_locations');
// Comptage des visites public ; consultation réservée à l'onglet Statistiques.
const canRead = requireTab('stats');

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

async function upsertLocation(ip, loc) {
  await locations().updateOne(
    { ip },
    { $set: { ip, ...loc, resolvedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

// Résout pays/région/ville pour une IP via une API de géolocalisation gratuite, sans clé.
// Ne bloque jamais la requête appelante : toujours utilisée en fire-and-forget.
async function resolveLocationAsync(ip) {
  if (await locations().findOne({ ip })) return;

  if (!ip || isPrivateIp(ip)) {
    await upsertLocation(ip, { country: 'Local', region: '', city: '' });
    return;
  }

  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`);
    const data = await response.json();
    if (data.status === 'success') {
      await upsertLocation(ip, { country: data.country || 'Inconnu', region: data.regionName || '', city: data.city || '' });
    } else {
      await upsertLocation(ip, { country: 'Inconnu', region: '', city: '' });
    }
  } catch (err) {
    console.warn('Géolocalisation IP échouée pour', ip, ':', err.message);
    await upsertLocation(ip, { country: 'Inconnu', region: '', city: '' });
  }
}

async function locationsByIp(ips) {
  const list = await locations().find({ ip: { $in: ips } }, { projection: { _id: 0 } }).toArray();
  return Object.fromEntries(list.map(l => [l.ip, l]));
}

function locationFor(ip, locByIp) {
  return locByIp[ip] || { country: 'En cours…', region: '', city: '' };
}

// POST /api/stats/pageview  { path, sessionId, referrer } - enregistre une navigation de page.
router.post('/pageview', async (req, res) => {
  const { path: pagePath, sessionId, referrer } = req.body || {};
  if (!pagePath || !sessionId) {
    return res.status(400).json({ error: 'path et sessionId sont requis' });
  }

  const ip = getClientIp(req);
  await pageviews().insertOne({
    id: `pv-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    path: pagePath,
    sessionId,
    referrer: referrer || '',
    ip,
    userAgent: req.get('user-agent') || '',
    timestamp: new Date().toISOString()
  });

  res.status(201).json({ success: true });

  resolveLocationAsync(ip).catch(() => {});
});

// GET /api/stats/summary - statistiques agrégées pour le tableau de bord admin.
// Les comptages sont faits par la base, sans recharger toutes les pages vues.
router.get('/summary', canRead, async (req, res) => {
  const today = new Date();
  const days = [];
  for (let i = DAILY_RANGE - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const [totalPageviews, sessionsAgg, topPagesAgg, byIp, dailyAgg] = await Promise.all([
    pageviews().countDocuments(),
    pageviews().aggregate([{ $group: { _id: '$sessionId' } }, { $count: 'n' }]).toArray(),
    pageviews()
      .aggregate([{ $group: { _id: '$path', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 8 }])
      .toArray(),
    pageviews().aggregate([{ $group: { _id: '$ip', count: { $sum: 1 } } }]).toArray(),
    pageviews()
      .aggregate([
        { $match: { timestamp: { $gte: days[0] } } },
        {
          $group: {
            _id: { $substrBytes: ['$timestamp', 0, 10] },
            views: { $sum: 1 },
            sessions: { $addToSet: '$sessionId' }
          }
        }
      ])
      .toArray()
  ]);

  const locByIp = await locationsByIp(byIp.map(b => b._id));
  const countryCounts = {};
  byIp.forEach(({ _id: ip, count }) => {
    const country = locationFor(ip, locByIp).country;
    countryCounts[country] = (countryCounts[country] || 0) + count;
  });
  const topCountries = Object.entries(countryCounts)
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const dailyByDate = Object.fromEntries(dailyAgg.map(d => [d._id, d]));
  const daily = days.map(date => ({
    date,
    views: dailyByDate[date]?.views || 0,
    sessions: dailyByDate[date]?.sessions.length || 0
  }));

  res.json({
    totalPageviews,
    totalSessions: sessionsAgg[0]?.n || 0,
    topPages: topPagesAgg.map(p => ({ path: p._id, count: p.count })),
    topCountries,
    daily
  });
});

// GET /api/stats/visitors - détail des sessions récentes (parcours + localisation).
router.get('/visitors', canRead, async (req, res) => {
  const sessions = await pageviews()
    .aggregate([
      { $sort: { timestamp: 1 } },
      {
        $group: {
          _id: '$sessionId',
          ip: { $first: '$ip' },
          userAgent: { $first: '$userAgent' },
          firstSeen: { $first: '$timestamp' },
          lastSeen: { $last: '$timestamp' },
          pages: { $push: { path: '$path', timestamp: '$timestamp' } }
        }
      },
      { $sort: { lastSeen: -1 } },
      { $limit: VISITOR_LIMIT }
    ], { allowDiskUse: true })
    .toArray();

  const locByIp = await locationsByIp(sessions.map(s => s.ip));
  res.json(
    sessions.map(s => ({
      sessionId: s._id,
      ip: s.ip,
      userAgent: s.userAgent,
      location: locationFor(s.ip, locByIp),
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      pages: s.pages
    }))
  );
});

module.exports = router;
