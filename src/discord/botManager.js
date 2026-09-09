const path = require('node:path');
const { once } = require('node:events');
const { createClient } = require('./client');
const { VoiceManager } = require('./voiceManager');
const { StateStore } = require('../store/stateStore');

const ALL_SLOTS = [1, 2, 3, 4, 5];
const WORKER_SLOTS = [2, 3, 4, 5];
const CONTROLLER_SLOT = 1;
const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_START_STAGGER_MS = 1_500;

const STATUS = Object.freeze({
  UNCONFIGURED: 'unconfigured',
  STOPPED: 'stopped',
  STARTING: 'starting',
  ONLINE: 'online',
  FAILED: 'failed',
});

class BotManagerError extends Error {
  constructor(code, slot, message) {
    super(message);
    this.name = 'BotManagerError';
    this.code = code;
    this.slot = slot;
  }
}

/** Strips anything token-shaped, defensively, before an error message is ever logged or shown. */
function safeErrorMessage(error) {
  const message = error?.message || String(error);
  return message.replace(/[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}/g, '[redacted]');
}

function stateFileName(slot) {
  return slot === CONTROLLER_SLOT ? 'state.json' : 'state.bot' + slot + '.json';
}

/**
 * Owns all five bot slots (1 = Controller, 2-5 = Workers) inside a single Node process/
 * single Discord.js runtime — see README "Five-bot architecture". Each configured slot gets
 * its own Client + VoiceManager (never shared), created lazily and destroyed on stop so a
 * stopped worker holds no live Gateway/voice connection and no more than a tiny state record.
 *
 * A worker's login/runtime failure is caught and recorded on that slot only; it never touches
 * the Controller or any other slot. The Controller's own login failure is intentionally NOT
 * caught here — index.js treats it as fatal, per the architecture's "Controller must come up
 * or the process exits" contract.
 */
class BotManager {
  constructor(config, options = {}) {
    this.config = config;
    this.createClient = options.createClient || createClient;
    this.createStateStore = options.createStateStore || ((filePath) => new StateStore(filePath));
    this.createVoiceManager = options.createVoiceManager || ((client, stateStore) => new VoiceManager(client, stateStore));
    this.logger = options.logger || console;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.workerStartStaggerMs = options.workerStartStaggerMs ?? DEFAULT_WORKER_START_STAGGER_MS;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    this.slots = new Map();
    for (const slot of ALL_SLOTS) {
      const token = config.tokens?.[slot] || '';
      this.slots.set(slot, {
        slot,
        token,
        configured: Boolean(token),
        status: token ? STATUS.STOPPED : STATUS.UNCONFIGURED,
        client: null,
        voiceManager: null,
        stateStore: this.createStateStore(path.join(config.dataDir, stateFileName(slot))),
        error: null,
        loggedInAt: null,
      });
    }
  }

  get(slot) {
    return this.slots.get(slot) || null;
  }

  get controller() {
    return this.get(CONTROLLER_SLOT);
  }

  // ---- Controller lifecycle (index.js drives this directly; failures are fatal) ----

  /** Creates the Controller's Client + VoiceManager without logging in yet, so the caller
   *  (index.js) can attach CommandManager's interactionCreate listener before login(). */
  createControllerRuntime() {
    const record = this.controller;
    record.client = this.createClient();
    record.voiceManager = this.createVoiceManager(record.client, record.stateStore);
    return record;
  }

  async loginController() {
    const record = this.controller;
    record.status = STATUS.STARTING;
    try {
      await this._login(record);
      record.status = STATUS.ONLINE;
      record.loggedInAt = Date.now();
    } catch (error) {
      record.status = STATUS.FAILED;
      record.error = safeErrorMessage(error);
      throw error; // Controller failure is fatal — the caller (index.js) exits the process.
    }
    return record;
  }

  async restoreControllerVoice() {
    await this.controller.voiceManager.restoreFromState();
  }

  // ---- Worker lifecycle ----

  /** Starts every configured worker whose persisted `enabled` flag isn't explicitly false. */
  async startConfiguredWorkers() {
    for (const slot of WORKER_SLOTS) {
      const record = this.get(slot);
      if (!record.configured) continue;
      const enabled = await record.stateStore.get('enabled');
      if (enabled === false) {
        record.status = STATUS.STOPPED;
        continue;
      }
      try {
        await this.startWorker(slot, { persistEnabled: false });
      } catch (error) {
        this.logger.error?.('[botManager] Worker slot ' + slot + ' failed to start: ' + safeErrorMessage(error));
      }
      if (WORKER_SLOTS.indexOf(slot) < WORKER_SLOTS.length - 1) {
        await this.sleep(this.workerStartStaggerMs);
      }
    }
  }

  async startWorker(slot, { persistEnabled = true } = {}) {
    this._assertWorkerSlot(slot);
    const record = this.get(slot);
    if (!record.configured) throw new BotManagerError('unconfigured', slot, 'Bot ' + slot + ' is not configured.');
    if (record.status === STATUS.ONLINE || record.status === STATUS.STARTING) {
      return { record, alreadyRunning: true };
    }

    if (persistEnabled) await record.stateStore.set('enabled', true);
    record.status = STATUS.STARTING;
    record.error = null;
    record.client = this.createClient();
    record.voiceManager = this.createVoiceManager(record.client, record.stateStore);

    try {
      await this._login(record);
      record.status = STATUS.ONLINE;
      record.loggedInAt = Date.now();
      await record.voiceManager.restoreFromState();
      return { record, alreadyRunning: false };
    } catch (error) {
      record.status = STATUS.FAILED;
      record.error = safeErrorMessage(error);
      this._releaseRuntime(record);
      return { record, alreadyRunning: false, failed: true };
    }
  }

  async stopWorker(slot) {
    this._assertWorkerSlot(slot);
    const record = this.get(slot);
    if (!record.configured) throw new BotManagerError('unconfigured', slot, 'Bot ' + slot + ' is not configured.');

    await record.stateStore.set('enabled', false);
    if (record.voiceManager) {
      await record.voiceManager.shutdown(); // preserves desiredVoice
    }
    this._releaseRuntime(record);
    record.status = STATUS.STOPPED;
    record.error = null;
    return record;
  }

  async restartWorker(slot) {
    this._assertWorkerSlot(slot);
    const record = this.get(slot);
    if (!record.configured) throw new BotManagerError('unconfigured', slot, 'Bot ' + slot + ' is not configured.');

    if (record.voiceManager) await record.voiceManager.shutdown();
    this._releaseRuntime(record);
    return this.startWorker(slot, { persistEnabled: true });
  }

  /** Resolves the live VoiceManager for a slot, or throws a safe, user-facing BotManagerError. */
  resolveVoiceManager(slot) {
    const record = this.get(slot);
    if (!record) throw new BotManagerError('invalid_slot', slot, 'Bot ' + slot + ' is not a valid bot slot.');
    if (!record.configured) throw new BotManagerError('unconfigured', slot, 'Bot ' + slot + ' is not configured.');
    if (record.status === STATUS.STOPPED) {
      throw new BotManagerError('stopped', slot, 'Bot ' + slot + ' is stopped. Start it with /afk bot start first.');
    }
    if (record.status === STATUS.STARTING) {
      throw new BotManagerError('starting', slot, 'Bot ' + slot + ' is still starting. Try again shortly.');
    }
    if (record.status === STATUS.FAILED) {
      throw new BotManagerError('failed', slot, 'Bot ' + slot + ' failed to log in (' + (record.error || 'unknown error') + ').');
    }
    if (!record.voiceManager) {
      throw new BotManagerError('unavailable', slot, 'Bot ' + slot + ' has no active voice runtime.');
    }
    return record.voiceManager;
  }

  async shutdown() {
    for (const slot of WORKER_SLOTS) {
      const record = this.get(slot);
      if (record.voiceManager) {
        try {
          await record.voiceManager.shutdown();
        } catch (error) {
          this.logger.error?.('[botManager] Worker slot ' + slot + ' shutdown error: ' + safeErrorMessage(error));
        }
      }
      this._releaseRuntime(record);
    }

    const controller = this.controller;
    if (controller.voiceManager) await controller.voiceManager.shutdown();
    if (controller.client) {
      try {
        controller.client.destroy();
      } catch {
        /* already destroyed */
      }
    }
  }

  _assertWorkerSlot(slot) {
    if (slot === CONTROLLER_SLOT) {
      throw new BotManagerError('is_controller', slot, 'Bot 1 is the Controller and cannot be started, stopped, or restarted through Discord.');
    }
    if (!WORKER_SLOTS.includes(slot)) {
      throw new BotManagerError('invalid_slot', slot, 'Bot ' + slot + ' is not a valid worker slot.');
    }
  }

  _releaseRuntime(record) {
    if (record.client) {
      try {
        record.client.destroy();
      } catch {
        /* already destroyed */
      }
    }
    record.client = null;
    record.voiceManager = null;
  }

  async _login(record) {
    const ready = once(record.client, 'clientReady');
    const timeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('Login timed out after ' + this.loginTimeoutMs + 'ms.')), this.loginTimeoutMs).unref?.();
    });
    await record.client.login(record.token);
    await Promise.race([ready, timeout]);
  }
}

module.exports = { BotManager, BotManagerError, STATUS, ALL_SLOTS, WORKER_SLOTS, CONTROLLER_SLOT, safeErrorMessage };
