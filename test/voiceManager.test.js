const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VoiceConnectionStatus } = require('@discordjs/voice');
const { VoiceManager } = require('../src/discord/voiceManager');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.state = { status: VoiceConnectionStatus.Signalling };
    this.destroyed = false;
  }
  subscribe() {}
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.state = { status: VoiceConnectionStatus.Destroyed };
    this.emit(VoiceConnectionStatus.Destroyed);
  }
  setReady() {
    this.state = { status: VoiceConnectionStatus.Ready };
    this.emit(VoiceConnectionStatus.Ready);
  }
  setDisconnected() {
    this.state = { status: VoiceConnectionStatus.Disconnected };
    this.emit(VoiceConnectionStatus.Disconnected);
  }
}

class FakePlayer extends EventEmitter {
  play() {}
  stop() {}
}

function makeVoiceChannel(id) {
  return { id, isVoiceBased: () => true, members: { values: () => [] } };
}

function makeGuild(id, channels) {
  return {
    id,
    name: id,
    voiceAdapterCreator: () => {},
    channels: { cache: new Map(channels.map((c) => [c.id, c])) },
  };
}

function makeClient(guilds) {
  return { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } };
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
  };
}

function makeVoiceDeps({ entersStateRejects = true } = {}) {
  const connections = [];
  return {
    connections,
    joinVoiceChannel: () => {
      const c = new FakeConnection();
      connections.push(c);
      return c;
    },
    createAudioPlayer: () => new FakePlayer(),
    createAudioResource: () => ({}),
    entersState: () =>
      entersStateRejects
        ? Promise.reject(new Error('timeout'))
        : new Promise(() => {}), // never resolves/rejects -> treated as a permanent blip in tests that don't need it
  };
}

const FAST_OPTS = { baseReconnectDelayMs: 20, maxReconnectDelayMs: 80 };

test('channel switch disposes the old connection without leaving a stale reconnect timer', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1'), makeVoiceChannel('c2')]);
  const client = makeClient([guild]);
  const stateStore = makeMemoryStateStore();
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(client, stateStore, { voiceDeps: deps, ...FAST_OPTS });

  await vm.join('g1', 'c1');
  const connA = deps.connections[0];
  connA.setReady();
  assert.equal(vm.status().connected, true);

  await vm.join('g1', 'c2');
  const connB = deps.connections[1];

  assert.equal(connA.destroyed, true, 'old connection A must be disposed');
  connB.setReady();
  assert.equal(vm.status().connected, true);
  assert.equal(vm.status().channelId, 'c2');

  // Wait well past the (test-fast) reconnect delay: no stale timer from A should fire and destroy B.
  await sleep(60);
  assert.equal(connB.destroyed, false, 'a stale timer from A must not destroy the healthy new connection B');
  assert.equal(vm.status().connected, true);
  assert.equal(deps.connections.length, 2, 'no extra spurious reconnect attempts');
});

test('an unexpected connection loss schedules exactly one reconnect', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const client = makeClient([guild]);
  const stateStore = makeMemoryStateStore();
  const deps = makeVoiceDeps({ entersStateRejects: true });
  const vm = new VoiceManager(client, stateStore, { voiceDeps: deps, ...FAST_OPTS });

  await vm.join('g1', 'c1');
  const connA = deps.connections[0];
  connA.setReady();

  connA.setDisconnected();
  await sleep(5); // let the Disconnected handler's rejected entersState() settle and call destroy()

  assert.equal(connA.destroyed, true);
  assert.equal(deps.connections.length, 1, 'no new connection yet — reconnect is still pending on the timer');
  assert.notEqual(vm.reconnectTimer, null);

  await sleep(40); // past baseReconnectDelayMs
  assert.equal(deps.connections.length, 2, 'exactly one reconnect attempt fired');
});

test('an explicit join cancels a pending reconnect timer instead of stacking another one', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const client = makeClient([guild]);
  const stateStore = makeMemoryStateStore();
  const deps = makeVoiceDeps({ entersStateRejects: true });
  const vm = new VoiceManager(client, stateStore, { voiceDeps: deps, ...FAST_OPTS });

  await vm.join('g1', 'c1');
  deps.connections[0].setReady();
  deps.connections[0].setDisconnected();
  await sleep(5);
  assert.notEqual(vm.reconnectTimer, null, 'a reconnect must be pending before we re-join');

  await vm.join('g1', 'c1'); // owner explicitly re-joins before the pending timer fires
  assert.equal(deps.connections.length, 2, 'explicit join connects immediately');

  await sleep(40); // past what would have been the cancelled timer's fire time
  assert.equal(deps.connections.length, 2, 'the cancelled timer must not have fired a second, redundant connect');
});

test('leave clears desired state, cancels timers, and never reconnects', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const client = makeClient([guild]);
  const stateStore = makeMemoryStateStore();
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(client, stateStore, { voiceDeps: deps, ...FAST_OPTS });

  await vm.join('g1', 'c1');
  deps.connections[0].setReady();

  await vm.leave();
  assert.equal(vm.desired, null);
  assert.equal(vm.reconnectTimer, null);
  assert.equal(await stateStore.get('desiredVoice'), null);
  assert.equal(deps.connections[0].destroyed, true);

  await sleep(40);
  assert.equal(deps.connections.length, 1, 'leave must never trigger a reconnect');
});

test('shutdown tears down the runtime but preserves persisted desiredVoice', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const client = makeClient([guild]);
  const stateStore = makeMemoryStateStore();
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(client, stateStore, { voiceDeps: deps, ...FAST_OPTS });

  await vm.join('g1', 'c1');
  deps.connections[0].setReady();

  await vm.shutdown();
  assert.equal(deps.connections[0].destroyed, true);
  assert.notEqual(await stateStore.get('desiredVoice'), null, 'persisted desiredVoice must survive a shutdown');
  assert.deepEqual(await stateStore.get('desiredVoice'), { guildId: 'g1', channelId: 'c1' });

  await sleep(40);
  assert.equal(deps.connections.length, 1, 'shutdown must suppress any reconnect attempt');
});

test('stale events from a superseded connection do not mutate the active connection state', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1'), makeVoiceChannel('c2')]);
  const client = makeClient([guild]);
  const stateStore = makeMemoryStateStore();
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(client, stateStore, { voiceDeps: deps, ...FAST_OPTS });

  await vm.join('g1', 'c1');
  const connA = deps.connections[0];
  connA.setReady();

  await vm.join('g1', 'c2');
  const connB = deps.connections[1];
  connB.setReady();

  const statusBefore = vm.status();
  const connectedAtBefore = vm.connectedAt;
  assert.strictEqual(vm.connection, connB);

  // Fire more stale events on the already-superseded A — none of this may affect B's tracked state.
  connA.emit(VoiceConnectionStatus.Destroyed);
  connA.setReady();

  assert.strictEqual(vm.connection, connB, 'active connection reference must still be B');
  assert.equal(vm.connectedAt, connectedAtBefore, 'stale Ready from A must not touch connectedAt');
  assert.deepEqual(vm.status(), statusBefore);
});
