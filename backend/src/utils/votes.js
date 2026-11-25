const crypto = require('crypto');
const { col, NO_ID, isDuplicateKey } = require('./db');

// Logique commune des votes : affichage pour un votant et enregistrement d'un vote, partagés
// par l'espace paroissien (votes « normaux », avec identifiant) et la page publique du vote
// rapide (votes « spéciaux » : code générique + nombre annoncé dans la salle + nom).

const votes = () => col('votes');
const participations = () => col('vote_participations');
const voteCodes = () => col('vote_codes');

/** Vote spécial (sans connexion) : accès par code générique. */
function isSpecial(vote) {
  return vote?.access === 'special';
}

/**
 * Vote vu par un votant : participation en direct (ex. 3/10), son droit de vote, s'il a déjà
 * voté (jamais son choix) et les résultats seulement une fois publiés. Vote spécial : pas de
 * liste de votants (total 0 : seul le nombre de votes est affiché).
 */
function voteView(vote, { eligible, votedAt }) {
  const answers = vote.answers || [];
  // Avis : pour chaque personne, le nombre de voix de chaque réponse (clé « personne:réponse »).
  const results = vote.published
    ? vote.options.map(o => ({
        id: o.id,
        label: o.label,
        count: vote.counts?.[o.id] || 0,
        ...(vote.kind === 'avis' ? { answers: answers.map(a => ({ id: a.id, label: a.label, count: vote.counts?.[`${o.id}:${a.id}`] || 0 })) } : {})
      }))
    : null;
  return {
    id: vote.id,
    title: vote.title,
    description: vote.description || '',
    groupName: vote.groupName,
    kind: vote.kind,
    maxChoices: vote.maxChoices || 1,
    options: vote.options.map(o => ({ id: o.id, label: o.label })),
    answers,
    status: vote.status,
    published: !!vote.published,
    voters: vote.voters || 0,
    total: isSpecial(vote) ? 0 : (vote.electorate || []).length,
    eligible: !!eligible,
    votedAt: votedAt || null,
    results,
    openedAt: vote.openedAt || null,
    closedAt: vote.closedAt || null
  };
}

/**
 * Enregistre un vote (une seule fois par votant) : { choices: [id d'option] } ou, pour un
 * avis, { answers: { idPersonne: idRéponse } }. Seuls les totaux sont comptés : le choix
 * n'est lié à personne. `voter` : { key (clientId ou « rapide:… »), name?, nameKey? }.
 * Renvoie { at } ou { status, error }.
 */
async function castBallot(vote, voter, body) {
  if (vote.status !== 'ouvert') return { status: 400, error: 'Ce vote est clos.' };
  const valid = new Set(vote.options.map(o => o.id));
  let keys;
  if (vote.kind === 'avis') {
    const given = body?.answers && typeof body.answers === 'object' ? body.answers : {};
    const answerIds = new Set((vote.answers || []).map(a => a.id));
    if (vote.options.some(o => !answerIds.has(String(given[o.id])))) {
      return { status: 400, error: 'Donnez une réponse pour chaque personne avant de valider.' };
    }
    keys = vote.options.map(o => `${o.id}:${given[o.id]}`);
  } else {
    const choices = [...new Set((Array.isArray(body?.choices) ? body.choices : []).map(String))].filter(id => valid.has(id));
    if (!choices.length) return { status: 400, error: 'Faites votre choix avant de valider.' };
    if (vote.kind !== 'multiple' && choices.length > 1) return { status: 400, error: 'Un seul choix possible.' };
    if (vote.kind === 'multiple' && choices.length > (vote.maxChoices || vote.options.length)) {
      return { status: 400, error: `${vote.maxChoices} choix au maximum.` };
    }
    keys = choices;
  }
  const at = new Date().toISOString();
  try {
    await participations().insertOne({
      voteId: vote.id,
      clientId: voter.key,
      at,
      ...(voter.name ? { name: voter.name, nameKey: voter.nameKey } : {})
    });
  } catch (err) {
    if (isDuplicateKey(err)) return { status: 409, error: 'Vous avez déjà voté.' };
    throw err;
  }
  const inc = { voters: 1 };
  for (const key of keys) inc[`counts.${key}`] = 1;
  const { matchedCount } = await votes().updateOne({ id: vote.id, status: 'ouvert' }, { $inc: inc });
  if (!matchedCount) {
    await participations().deleteOne({ voteId: vote.id, clientId: voter.key });
    return { status: 400, error: 'Ce vote vient d’être clos.' };
  }
  return { at };
}

// ---------- Vote spécial : nombre à annoncer dans la salle ----------

const twoDigits = () => crypto.randomInt(10, 100);

/**
 * Nouveau nombre à annoncer pour un code (et les deux autres nombres proposés avec lui, tirés
 * une fois pour toutes : redemander le choix montre toujours les mêmes trois nombres, on ne
 * peut donc pas deviner le bon en comparant).
 */
async function newMatchNumber(code) {
  const number = twoDigits();
  const set = new Set([number]);
  while (set.size < 3) set.add(twoDigits());
  const choices = [...set];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  const doc = { code, number, choices, updatedAt: new Date().toISOString() };
  await voteCodes().updateOne({ code }, { $set: doc }, { upsert: true });
  return doc;
}

async function matchNumberOf(code, create = false) {
  const doc = await voteCodes().findOne({ code }, NO_ID);
  if (doc || !create) return doc;
  return newMatchNumber(code);
}

/** Simplifie un nom pour reconnaître le même votant (« Jean RAKOTO » = « jean  rakoto »). */
function nameKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = { isSpecial, voteView, castBallot, newMatchNumber, matchNumberOf, nameKey };
