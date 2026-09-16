const fs = require('fs');
const path = require('path');

/** Petit store fichier JSON = remplacement minimal d'une base de données. */
class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '[]', 'utf-8');
    }
  }

  readAll() {
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  writeAll(items) {
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2), 'utf-8');
  }
}

module.exports = JsonStore;
