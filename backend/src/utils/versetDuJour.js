// Doit rester identique à buildVersetImageUrl() côté frontend
// (src/app/services/verset-du-jour.service.ts).
function pad(value) {
  return String(value).padStart(2, '0');
}

function buildVersetImageUrl(date = new Date()) {
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = String(date.getFullYear()).slice(-2);
  return `https://saparole.com/wp-content/uploads/${day}_${month}_${year}.jpg`;
}

module.exports = { buildVersetImageUrl };
