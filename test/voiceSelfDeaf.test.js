const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VoiceConnectionStatus } = require('@discordjs/voice');
const { VoiceManager } = require('../src/discord/voiceManager');

/**
 * `receiver` is poisoned with a getter that throws the moment anything reads it — the
 * structural way to prove LocalAFK never touches @discordjs/voice's incoming-audio API
 * (`connection.receiver.subscribe(...)`), rather than relying on a grep that indirection
 * could defeat. `subscribe()` (the OUTGOING AudioPlayer subscription) stays a normal no-op.
 */
class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.state = { status: VoiceConnectionStatus.Signalling };
    this.destroyed = false;
    Object.defineProperty(this, 'receiver', {
      get() {
        throw new Error('connection.receiver must never be accessed — LocalAFK does not receive incoming audio');
      },
    });
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

function makeMemoryStateStore(initial = {}) {
  const store = { ...initial };
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
  const joinCalls = [];
  return {
    joinCalls,
    joinVoiceChannel: (options) => {
      joinCalls.push({ ...options });
      return new FakeConnection();
    },
    createAudioPlayer: () => new FakePlayer(),
    createAudioResource: () => ({}),
    entersState: () => (entersStateRejects ? Promise.reject(new Error('timeout')) : new Promise(() => {})),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('join() calls joinVoiceChannel with selfDeaf: false', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(makeClient([guild]), makeMemoryStateStore(), { voiceDeps: deps });

  await vm.join('g1', 'c1');

  assert.equal(deps.joinCalls.length, 1);
  assert.equal(deps.joinCalls[0].selfDeaf, false);
});

test('join() calls joinVoiceChannel with selfMute: false', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(makeClient([guild]), makeMemoryStateStore(), { voiceDeps: deps });

  await vm.join('g1', 'c1');

  assert.equal(deps.joinCalls[0].selfMute, false);
});

test('the configured connectionGroup is still passed unchanged alongside selfDeaf/selfMute', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(makeClient([guild]), makeMemoryStateStore(), {
    voiceDeps: deps,
    connectionGroup: 'localafk-bot-4',
  });

  await vm.join('g1', 'c1');

  assert.equal(deps.joinCalls[0].group, 'localafk-bot-4');
  assert.equal(deps.joinCalls[0].selfDeaf, false);
  assert.equal(deps.joinCalls[0].selfMute, false);
});

test('reconnect() re-joins with the same selfDeaf:false/selfMute:false options', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(makeClient([guild]), makeMemoryStateStore(), { voiceDeps: deps });

  await vm.join('g1', 'c1');
  vm.connection.setReady();
  await vm.reconnect();

  assert.equal(deps.joinCalls.length, 2);
  for (const call of deps.joinCalls) {
    assert.equal(call.selfDeaf, false);
    assert.equal(call.selfMute, false);
  }
});

test('restoreFromState() reconnects with the same selfDeaf:false/selfMute:false options', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const deps = makeVoiceDeps();
  const stateStore = makeMemoryStateStore({ desiredVoice: { guildId: 'g1', channelId: 'c1' } });
  const vm = new VoiceManager(makeClient([guild]), stateStore, { voiceDeps: deps });

  await vm.restoreFromState();

  assert.equal(deps.joinCalls.length, 1);
  assert.equal(deps.joinCalls[0].selfDeaf, false);
  assert.equal(deps.joinCalls[0].selfMute, false);
});

test('unexpected disconnect/reconnect cycles also always request selfDeaf:false/selfMute:false', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const deps = makeVoiceDeps({ entersStateRejects: true });
  const vm = new VoiceManager(makeClient([guild]), makeMemoryStateStore(), {
    voiceDeps: deps,
    baseReconnectDelayMs: 10,
    maxReconnectDelayMs: 40,
  });

  await vm.join('g1', 'c1');
  vm.connection.setReady();
  vm.connection.setDisconnected();
  await sleep(5); // let the rejected entersState() settle and destroy the connection
  await sleep(30); // past baseReconnectDelayMs — the automatic reconnect fires

  assert.ok(deps.joinCalls.length >= 2, 'expected at least one automatic reconnect join call');
  for (const call of deps.joinCalls) {
    assert.equal(call.selfDeaf, false);
    assert.equal(call.selfMute, false);
  }
});

test('LocalAFK never accesses connection.receiver across a full join -> ready -> leave lifecycle', async () => {
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const deps = makeVoiceDeps();
  const vm = new VoiceManager(makeClient([guild]), makeMemoryStateStore(), { voiceDeps: deps });

  await vm.join('g1', 'c1'); // would throw immediately if _connect() ever touched .receiver
  vm.connection.setReady();
  await vm.leave();

  // If we got this far without the poisoned getter throwing, no incoming-audio API was touched.
  assert.ok(true);
});
