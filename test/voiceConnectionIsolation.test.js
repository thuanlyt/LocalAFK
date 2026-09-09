const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VoiceConnectionStatus } = require('@discordjs/voice');
const { VoiceManager } = require('../src/discord/voiceManager');
const { connectionGroupForSlot } = require('../src/discord/botManager');

/**
 * Mirrors the *actual* collision mechanism found in node_modules/@discordjs/voice/dist/index.js:
 * a single process-wide `groups` Map keyed by (group, guildId) tracks every VoiceConnection.
 * joinVoiceChannel() defaults `group` to "default"; createVoiceConnection() looks up any
 * existing connection under the same (group, guildId) and, if found and not destroyed, just
 * re-sends the new channelId through that EXISTING connection's (first bot's) adapter instead
 * of creating a new one. This is exactly how LocalAFK's v1.2.0 bug happened — two VoiceManager
 * instances (different Discord Clients, same Node process) shared one @discordjs/voice module
 * instance and therefore one `groups` registry.
 */
class FakeVoiceRegistry {
  constructor() {
    this.groups = new Map();
    this.calls = [];
  }

  joinVoiceChannel(options) {
    this.calls.push({ ...options });
    const group = options.group ?? 'default';
    if (!this.groups.has(group)) this.groups.set(group, new Map());
    const groupMap = this.groups.get(group);
    const existing = groupMap.get(options.guildId);
    if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
      existing._reissueTo(options.channelId); // the real library's "wrong bot moves" step
      return existing;
    }
    const connection = new FakeConnection(options.guildId, options.channelId, group);
    groupMap.set(options.guildId, connection);
    return connection;
  }
}

class FakeConnection extends EventEmitter {
  constructor(guildId, channelId, group) {
    super();
    this.joinConfig = { guildId, channelId, group };
    this.state = { status: VoiceConnectionStatus.Signalling };
    this.destroyed = false;
  }
  subscribe() {}
  _reissueTo(channelId) {
    this.joinConfig.channelId = channelId;
  }
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

function makeVoiceDeps(registry) {
  return {
    joinVoiceChannel: (options) => registry.joinVoiceChannel(options),
    createAudioPlayer: () => new FakePlayer(),
    createAudioResource: () => ({}),
    entersState: () => new Promise(() => {}),
  };
}

function makeBotVoiceManager(slot, client, registry) {
  return new VoiceManager(client, makeMemoryStateStore(), {
    voiceDeps: makeVoiceDeps(registry),
    connectionGroup: connectionGroupForSlot(slot),
  });
}

// ---- connectionGroupForSlot: uniqueness and stability ----

test('connectionGroupForSlot produces a distinct, stable group per slot (not the username)', () => {
  const groups = [1, 2, 3, 4, 5].map(connectionGroupForSlot);
  assert.deepEqual(groups, ['localafk-bot-1', 'localafk-bot-2', 'localafk-bot-3', 'localafk-bot-4', 'localafk-bot-5']);
  assert.equal(new Set(groups).size, 5, 'all five groups must be unique');
});

// ---- VoiceManager passes its configured group to joinVoiceChannel ----

test('VoiceManager.join() passes its configured connectionGroup to joinVoiceChannel', async () => {
  const registry = new FakeVoiceRegistry();
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const client = makeClient([guild]);
  const vm = makeBotVoiceManager(2, client, registry);

  await vm.join('g1', 'c1');

  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0].group, 'localafk-bot-2');
});

test('a VoiceManager constructed without connectionGroup defaults to "default" (single-bot compatibility)', async () => {
  const registry = new FakeVoiceRegistry();
  const guild = makeGuild('g1', [makeVoiceChannel('c1')]);
  const client = makeClient([guild]);
  const vm = new VoiceManager(client, makeMemoryStateStore(), { voiceDeps: makeVoiceDeps(registry) });

  await vm.join('g1', 'c1');

  assert.equal(vm.connectionGroup, 'default');
  assert.equal(registry.calls[0].group, 'default');
});

// ---- The actual regression: two bots, same guild, must not collide ----

test('two VoiceManagers with different groups in the SAME guild produce different joinVoiceChannel group values and separate connections', async () => {
  const registry = new FakeVoiceRegistry();
  const guild = makeGuild('shared-guild', [makeVoiceChannel('room-a'), makeVoiceChannel('room-b')]);
  const client1 = makeClient([guild]);
  const client2 = makeClient([guild]);
  const bot1 = makeBotVoiceManager(1, client1, registry);
  const bot2 = makeBotVoiceManager(2, client2, registry);

  await bot1.join('shared-guild', 'room-a');
  bot1.connection.setReady();
  await bot2.join('shared-guild', 'room-b');
  bot2.connection.setReady();

  assert.equal(registry.calls[0].group, 'localafk-bot-1');
  assert.equal(registry.calls[1].group, 'localafk-bot-2');
  assert.notEqual(bot1.connection, bot2.connection, 'each bot must get its own VoiceConnection object');
  assert.equal(bot1.connection.joinConfig.channelId, 'room-a', 'Bot 1 must still be in its own requested channel');
  assert.equal(bot2.connection.joinConfig.channelId, 'room-b', 'Bot 2 must be in its own requested channel');
});

test('reproduces the v1.2.0 bug when two VoiceManagers share the same group: the second join silently redirects the first bot', async () => {
  // This documents exactly the production bug report: with no/identical group, the registry
  // finds bot 1's existing connection for the guild and reissues bot 2's channel through it.
  const registry = new FakeVoiceRegistry();
  const guild = makeGuild('shared-guild', [makeVoiceChannel('room-a'), makeVoiceChannel('room-b')]);
  const client1 = makeClient([guild]);
  const client2 = makeClient([guild]);
  const bot1 = new VoiceManager(client1, makeMemoryStateStore(), { voiceDeps: makeVoiceDeps(registry) });
  const bot2 = new VoiceManager(client2, makeMemoryStateStore(), { voiceDeps: makeVoiceDeps(registry) });

  await bot1.join('shared-guild', 'room-a');
  bot1.connection.setReady();
  await bot2.join('shared-guild', 'room-b');

  // Bot 2's VoiceManager receives back BOT 1's connection object (the collision) — and that
  // object's channelId is now room-b, i.e. bot 1 got moved, not bot 2.
  assert.equal(bot1.connection, bot2.connection);
  assert.equal(bot1.connection.joinConfig.channelId, 'room-b');
});

test('Bot 2 joining its channel does not mutate or destroy Bot 1\'s VoiceManager runtime', async () => {
  const registry = new FakeVoiceRegistry();
  const guild = makeGuild('g1', [makeVoiceChannel('a'), makeVoiceChannel('b')]);
  const bot1 = makeBotVoiceManager(1, makeClient([guild]), registry);
  const bot2 = makeBotVoiceManager(2, makeClient([guild]), registry);

  await bot1.join('g1', 'a');
  bot1.connection.setReady();
  const bot1ConnectionBefore = bot1.connection;
  const bot1GenerationBefore = bot1.generation;

  await bot2.join('g1', 'b');

  assert.equal(bot1.connection, bot1ConnectionBefore, 'Bot 1 connection object must be untouched');
  assert.equal(bot1.generation, bot1GenerationBefore, 'Bot 1 generation must not bump from Bot 2 activity');
  assert.equal(bot1ConnectionBefore.destroyed, false);
  assert.equal(bot1.status().channelId, 'a');
});

test('Bot 3 joining its channel does not mutate or destroy Bot 1 or Bot 2 runtime', async () => {
  const registry = new FakeVoiceRegistry();
  const guild = makeGuild('g1', [makeVoiceChannel('a'), makeVoiceChannel('b'), makeVoiceChannel('c')]);
  const bot1 = makeBotVoiceManager(1, makeClient([guild]), registry);
  const bot2 = makeBotVoiceManager(2, makeClient([guild]), registry);
  const bot3 = makeBotVoiceManager(3, makeClient([guild]), registry);

  await bot1.join('g1', 'a');
  bot1.connection.setReady();
  await bot2.join('g1', 'b');
  bot2.connection.setReady();
  const bot1Connection = bot1.connection;
  const bot2Connection = bot2.connection;

  await bot3.join('g1', 'c');
  bot3.connection.setReady();

  assert.equal(bot1.connection, bot1Connection);
  assert.equal(bot2.connection, bot2Connection);
  assert.equal(bot1.status().channelId, 'a');
  assert.equal(bot2.status().channelId, 'b');
  assert.equal(bot3.status().channelId, 'c');
});

test('Bot 2 leave() destroys only Bot 2\'s connection, never Bot 1\'s', async () => {
  const registry = new FakeVoiceRegistry();
  const guild = makeGuild('g1', [makeVoiceChannel('a'), makeVoiceChannel('b')]);
  const bot1 = makeBotVoiceManager(1, makeClient([guild]), registry);
  const bot2 = makeBotVoiceManager(2, makeClient([guild]), registry);

  await bot1.join('g1', 'a');
  bot1.connection.setReady();
  await bot2.join('g1', 'b');
  bot2.connection.setReady();
  const bot2Connection = bot2.connection;

  await bot2.leave();

  assert.equal(bot2Connection.destroyed, true);
  assert.equal(bot1.connection.destroyed, false);
  assert.equal(bot1.status().channelId, 'a');
});

test("Bot 3 reconnect() reuses Bot 3's own stable group across the new connection", async () => {
  const registry = new FakeVoiceRegistry();
  const guild = makeGuild('g1', [makeVoiceChannel('c')]);
  const bot3 = makeBotVoiceManager(3, makeClient([guild]), registry);

  await bot3.join('g1', 'c');
  bot3.connection.setReady();
  await bot3.reconnect();

  assert.equal(registry.calls.length, 2);
  assert.equal(registry.calls[0].group, 'localafk-bot-3');
  assert.equal(registry.calls[1].group, 'localafk-bot-3');
});
