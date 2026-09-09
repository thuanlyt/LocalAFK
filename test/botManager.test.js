const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BotManager, BotManagerError, STATUS } = require('../src/discord/botManager');

class FakeClient extends EventEmitter {
  constructor({ shouldFail = false, failMessage = 'invalid token' } = {}) {
    super();
    this.shouldFail = shouldFail;
    this.failMessage = failMessage;
    this.destroyed = false;
    this.user = null;
    this.guilds = { cache: new Map() };
  }
  async login(token) {
    this.token = token;
    if (this.shouldFail) throw new Error(this.failMessage);
    this.user = { id: 'bot', tag: 'Bot#0001', username: 'Bot' };
    // Simulate discord.js emitting clientReady asynchronously after a successful login.
    queueMicrotask(() => this.emit('clientReady'));
    return token;
  }
  destroy() {
    this.destroyed = true;
  }
}

function makeMemoryStateStore() {
  const store = {};
  return {
    async get(key) {
      return store[key];
    },
    async set(key, value) {
      store[key] = value;
    },
    __store: store,
  };
}

function makeVoiceManager(client, stateStore) {
  return {
    client,
    stateStore,
    shutdownCalls: 0,
    restoreCalls: 0,
    async shutdown() {
      this.shutdownCalls += 1;
    },
    async restoreFromState() {
      this.restoreCalls += 1;
    },
    status() {
      return { connected: false, state: 'idle', reconnectPending: false, channelId: null };
    },
  };
}

function makeConfig(tokens) {
  return {
    tokens: { 1: 'controller-token', 2: '', 3: '', 4: '', 5: '', ...tokens },
    dataDir: '/tmp/localafk-test-data',
  };
}

function makeManager(tokens, options = {}) {
  const config = makeConfig(tokens);
  const stateStores = new Map();
  const clients = new Map();
  const botManager = new BotManager(config, {
    createStateStore: (filePath) => {
      const store = makeMemoryStateStore();
      stateStores.set(filePath, store);
      return store;
    },
    createClient: () => {
      const client = new FakeClient(options.clientOptionsFor ? options.clientOptionsFor() : {});
      return client;
    },
    createVoiceManager: makeVoiceManager,
    sleep: async () => {},
    logger: { error() {} },
    ...options,
  });
  return { botManager, config, stateStores };
}

test('Controller is represented as slot 1 and can be created/logged in', async () => {
  const { botManager } = makeManager();
  botManager.createControllerRuntime();
  assert.equal(botManager.controller.slot, 1);
  assert.equal(botManager.controller.configured, true);

  await botManager.loginController();
  assert.equal(botManager.controller.status, STATUS.ONLINE);
  assert.equal(botManager.controller.client.user.tag, 'Bot#0001');
});

test('a configured, enabled worker starts automatically on startConfiguredWorkers()', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  await botManager.startConfiguredWorkers();
  const record = botManager.get(2);
  assert.equal(record.status, STATUS.ONLINE);
  assert.equal(record.voiceManager.restoreCalls, 1);
});

test('an unconfigured worker does not start and stays UNCONFIGURED', async () => {
  const { botManager } = makeManager();
  await botManager.startConfiguredWorkers();
  const record = botManager.get(3);
  assert.equal(record.configured, false);
  assert.equal(record.status, STATUS.UNCONFIGURED);
  assert.equal(record.client, null);
});

test('stopping a worker persists enabled=false', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  await botManager.startWorker(2);
  await botManager.stopWorker(2);
  assert.equal(await botManager.get(2).stateStore.get('enabled'), false);
  assert.equal(botManager.get(2).status, STATUS.STOPPED);
});

test('a worker stopped before a simulated restart stays stopped after startConfiguredWorkers()', async () => {
  const { botManager, config, stateStores } = makeManager({ 2: 'worker-2-token' });
  await botManager.startWorker(2);
  await botManager.stopWorker(2);

  // Simulate a process restart: a fresh BotManager reusing the same (persisted) state stores.
  const path = require('node:path');
  const reused = stateStores.get(path.join(config.dataDir, 'state.bot2.json'));
  const secondManager = new BotManager(config, {
    createStateStore: (filePath) => (filePath.endsWith('state.bot2.json') ? reused : makeMemoryStateStore()),
    createClient: () => new FakeClient(),
    createVoiceManager: makeVoiceManager,
    sleep: async () => {},
    logger: { error() {} },
  });

  await secondManager.startConfiguredWorkers();
  assert.equal(secondManager.get(2).status, STATUS.STOPPED);
  assert.equal(secondManager.get(2).client, null);
});

test('starting a worker persists enabled=true', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  await botManager.startWorker(2);
  assert.equal(await botManager.get(2).stateStore.get('enabled'), true);
});

test('stop calls VoiceManager.shutdown() and destroys the Client', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  await botManager.startWorker(2);
  const voiceManager = botManager.get(2).voiceManager;
  const client = botManager.get(2).client;

  await botManager.stopWorker(2);
  assert.equal(voiceManager.shutdownCalls, 1);
  assert.equal(client.destroyed, true);
});

test('stop preserves desiredVoice even though it clears enabled', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  await botManager.startWorker(2);
  await botManager.get(2).stateStore.set('desiredVoice', { guildId: 'g1', channelId: 'c1' });

  await botManager.stopWorker(2);
  assert.deepEqual(await botManager.get(2).stateStore.get('desiredVoice'), { guildId: 'g1', channelId: 'c1' });
});

test('restart creates a fresh Client/VoiceManager runtime', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  await botManager.startWorker(2);
  const firstClient = botManager.get(2).client;
  const firstVoiceManager = botManager.get(2).voiceManager;

  await botManager.restartWorker(2);
  assert.notEqual(botManager.get(2).client, firstClient);
  assert.notEqual(botManager.get(2).voiceManager, firstVoiceManager);
  assert.equal(firstClient.destroyed, true);
  assert.equal(botManager.get(2).status, STATUS.ONLINE);
  // Not just "not the old reference" — an actual new runtime must be attached, not null.
  assert.notEqual(botManager.get(2).client, null);
  assert.notEqual(botManager.get(2).voiceManager, null);
});

test('restarting an already-ONLINE worker does not leave it reporting ONLINE with no runtime attached', async () => {
  const { botManager } = makeManager({ 4: 'worker-4-token' });
  await botManager.startWorker(4);
  assert.equal(botManager.get(4).status, STATUS.ONLINE);

  await botManager.restartWorker(4);

  assert.equal(botManager.get(4).status, STATUS.ONLINE);
  assert.notEqual(botManager.get(4).client, null, 'a restarted worker must have a real Client attached');
  assert.notEqual(botManager.get(4).voiceManager, null, 'a restarted worker must have a real VoiceManager attached');
  assert.doesNotThrow(() => botManager.resolveVoiceManager(4));
});

test('a worker login failure does not affect other bots', async () => {
  const { botManager } = makeManager(
    { 2: 'worker-2-token', 3: 'worker-3-token' },
    { clientOptionsFor: () => ({}) }
  );
  // Make only slot 3's client fail by overriding createClient per-call.
  let call = 0;
  botManager.createClient = () => {
    call += 1;
    return new FakeClient({ shouldFail: call === 2, failMessage: 'login failed for slot 3' });
  };

  await botManager.startWorker(2);
  const result3 = await botManager.startWorker(3);

  assert.equal(botManager.get(2).status, STATUS.ONLINE);
  assert.equal(botManager.get(3).status, STATUS.FAILED);
  assert.equal(result3.failed, true);
  assert.match(botManager.get(3).error, /login failed for slot 3/);
});

test('the Controller cannot be started, stopped, or restarted through the worker API', async () => {
  const { botManager } = makeManager();
  await assert.rejects(botManager.startWorker(1), BotManagerError);
  await assert.rejects(botManager.stopWorker(1), BotManagerError);
  await assert.rejects(botManager.restartWorker(1), BotManagerError);
});

test('shutdown() tears down every active worker and the Controller cleanly', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token', 3: 'worker-3-token' });
  botManager.createControllerRuntime();
  await botManager.loginController();
  await botManager.startWorker(2);
  await botManager.startWorker(3);

  const controllerClient = botManager.controller.client;
  const worker2Client = botManager.get(2).client;
  const worker2Voice = botManager.get(2).voiceManager;

  await botManager.shutdown();

  assert.equal(controllerClient.destroyed, true);
  assert.equal(worker2Client.destroyed, true);
  assert.equal(worker2Voice.shutdownCalls, 1);
});

test('no stale client/voiceManager references remain on a slot after stop', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  await botManager.startWorker(2);
  await botManager.stopWorker(2);
  assert.equal(botManager.get(2).client, null);
  assert.equal(botManager.get(2).voiceManager, null);
});

test('worker state files are isolated from each other and from the Controller', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token', 3: 'worker-3-token' });
  await botManager.startWorker(2);
  await botManager.startWorker(3);
  await botManager.get(2).stateStore.set('desiredVoice', { guildId: 'g2', channelId: 'c2' });
  await botManager.get(3).stateStore.set('desiredVoice', { guildId: 'g3', channelId: 'c3' });

  assert.deepEqual(await botManager.get(2).stateStore.get('desiredVoice'), { guildId: 'g2', channelId: 'c2' });
  assert.deepEqual(await botManager.get(3).stateStore.get('desiredVoice'), { guildId: 'g3', channelId: 'c3' });
  assert.notEqual(botManager.get(2).stateStore, botManager.get(3).stateStore);
  assert.notEqual(botManager.get(2).stateStore, botManager.controller.stateStore);
});

test('resolveVoiceManager throws safe, distinguishable errors for each non-running state', () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  // slot 5 unconfigured
  assert.throws(() => botManager.resolveVoiceManager(5), (err) => err instanceof BotManagerError && err.code === 'unconfigured');
  // slot 2 configured but not started yet -> stopped
  assert.throws(() => botManager.resolveVoiceManager(2), (err) => err instanceof BotManagerError && err.code === 'stopped');
});

test('resolveVoiceManager returns the live VoiceManager once a worker is online', async () => {
  const { botManager } = makeManager({ 2: 'worker-2-token' });
  await botManager.startWorker(2);
  const voiceManager = botManager.resolveVoiceManager(2);
  assert.equal(voiceManager, botManager.get(2).voiceManager);
});

test('a worker restart recreates its VoiceManager using the same stable slot-derived connection group', async () => {
  // Uses the REAL default VoiceManager factory (not the fake) so connectionGroup is inspectable.
  const { botManager } = makeManager({ 3: 'worker-3-token' }, { createVoiceManager: undefined });
  await botManager.startWorker(3);
  assert.equal(botManager.get(3).voiceManager.connectionGroup, 'localafk-bot-3');

  await botManager.restartWorker(3);

  assert.equal(botManager.get(3).voiceManager.connectionGroup, 'localafk-bot-3');
});

test("the Controller's runtime always uses Bot 1's own connection group, including after re-creation", async () => {
  const { botManager } = makeManager({}, { createVoiceManager: undefined });
  botManager.createControllerRuntime();
  assert.equal(botManager.controller.voiceManager.connectionGroup, 'localafk-bot-1');

  // Simulate a re-created Controller runtime (e.g. a fresh BotManager after a process restart).
  botManager.createControllerRuntime();
  assert.equal(botManager.controller.voiceManager.connectionGroup, 'localafk-bot-1');
});
