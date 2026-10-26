// Ré-importe à la main les anciens fichiers JSON (src/data) dans MongoDB :
//   npm run import-json
// Sans risque de doublons (chaque élément est inséré ou mis à jour selon son identifiant).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { connectDb, closeDb } = require('../src/utils/db');
const { importJson } = require('../src/utils/importJson');

connectDb()
  .then(importJson)
  .then(summary => {
    console.log('Import terminé :', summary);
    return closeDb();
  })
  .catch(err => {
    console.error('Import impossible :', err.message);
    process.exit(1);
  });
