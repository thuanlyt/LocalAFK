const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class StateStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.fs = options.fs || fs;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.data = {};
    this.writeQueue = Promise.resolve();
    this.ready = this._load();
  }

  async _load() {
    let raw;
    try {
      raw = await this.fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[state] Không đọc được ${this.filePath} (${err.code || err.message}), bắt đầu với state rỗng.`);
      }
      this.data = {};
      return;
    }

    try {
      this.data = JSON.parse(raw);
      if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) {
        throw new Error('state root must be a JSON object');
      }
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
    // Capture the state for this logical write before another overlapping set() can mutate it.
    const snapshot = JSON.stringify(this.data, null, 2);
    const write = this.writeQueue.then(() => this._persist(snapshot));

    // Keep the internal tail recoverable while returning the original promise to this caller,
    // so a failed write is observable without poisoning later writes.
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  async _persist(payload) {
    const dir = path.dirname(this.filePath);
    await this.fs.mkdir(dir, { recursive: true });
    // Write to a temp file in the same directory (same filesystem) then rename,
    // so a crash/power-loss mid-write can never leave state.json half-written.
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${this.randomUUID()}.tmp`);
    try {
      await this.fs.writeFile(tmpPath, payload);
      await this.fs.rename(tmpPath, this.filePath);
    } catch (err) {
      try {
        await this.fs.unlink(tmpPath);
      } catch (cleanupErr) {
        if (cleanupErr.code !== 'ENOENT') {
          console.error(`[state] Không xoá được file tạm ${tmpPath}: ${cleanupErr.message}`);
        }
      }
      throw err;
    }
  }
}

module.exports = { StateStore };
