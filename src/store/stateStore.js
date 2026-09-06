const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this.writeQueue = Promise.resolve();
    this.ready = this._load();
  }

  async _load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[state] Không đọc được ${this.filePath} (${err.code || err.message}), bắt đầu với state rỗng.`);
      }
      this.data = {};
      return;
    }

    try {
      this.data = JSON.parse(raw);
    } catch (err) {
      console.error(`[state] ${this.filePath} chứa JSON không hợp lệ, bắt đầu với state rỗng: ${err.message}`);
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
    // Chain onto the queue so overlapping set() calls persist to disk in the order they were issued.
    this.writeQueue = this.writeQueue.then(() => this._persist());
    return this.writeQueue;
  }

  async _persist() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    // Write to a temp file in the same directory (same filesystem) then rename,
    // so a crash/power-loss mid-write can never leave state.json half-written.
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const payload = JSON.stringify(this.data, null, 2);
    await fs.writeFile(tmpPath, payload);
    await fs.rename(tmpPath, this.filePath);
  }
}

module.exports = { StateStore };
