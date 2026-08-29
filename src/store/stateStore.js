const fs = require('node:fs/promises');
const path = require('node:path');

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this.ready = this._load();
  }

  async _load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = {};
    }
  }

  async get(key) {
    await this.ready;
    return this.data[key];
  }

  async set(key, value) {
    await this.ready;
    this.data[key] = value;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { StateStore };
