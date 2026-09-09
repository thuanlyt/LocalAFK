const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  CommandManager,
  buildCommandSchema,
  commandSchemasEqual,
  formatStats,
} = require('../src/discord/commandManager');
const { StatsProvider } = require('../src/system/statsProvider');
const { BotManagerError, STATUS } = require('../src/discord/botManager');

class FakeClient extends EventEmitter {
  constructor(remoteCommands = [], { tag = 'LocalAFK#0001', ping = 42, guildCount = 1 } = {}) {
    super();
    this.ws = { ping };
    this.user = { id: 'bot-' + tag, tag, username: tag.split('#')[0] };
    this.application = {
      commands: {
        remote: remoteCommands,
        fetchCalls: 0,
        setCalls: 0,
        async fetch() {
          this.fetchCalls += 1;
          return this.remote;
        },
        async set(commands) {
          this.setCalls += 1;
          this.remote = commands;
          return commands;
        },
      },
    };
    const guildEntries = [];
    for (let i = 0; i < guildCount; i += 1) guildEntries.push(['g' + i, { id: 'g' + i, commands: this.application.commands }]);
    if (!guildEntries.length) guildEntries.push(['g1', { id: 'g1', commands: this.application.commands }]);
    this.guilds = { cache: new Map(guildEntries) };
  }

  isReady() {
    return true;
  }
}

function makeVoiceManager(overrides = {}) {
  const calls = [];
  const status = {
    connected: true,
    state: 'connected',
    reconnectPending: false,
    guildId: 'g1',
    channelId: 'c1',
    guildName: 'Guild One',
    channelName: 'Lounge',
    connectedAt: Date.now() - 65_000,
  };
  return {
    calls,
    status: () => ({ ...status }),
    async join(guildId, channelId) {
      calls.push(['join', guildId, channelId]);
      return { ...status, state: 'connected' };
    },
    async leave() {
      calls.push(['leave']);
      return { ...status, state: 'idle', channelId: null };
    },
    async reconnect() {
      calls.push(['reconnect']);
      return { ...status, state: 'connected' };
    },
    channelMembers: () => [
      { username: 'Owner', bot: false },
      { username: 'HelperBot', bot: true },
    ],
    ...overrides,
  };
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

function makeStatsProvider(overrides = {}) {
  const calls = [];
  const stats = {
    system: {
      hostname: null,
      hostnameOmitted: true,
      platform: 'linux',
      release: '6.8.0-test',
      nodeVersion: process.version,
      uptimeSeconds: 3_600,
      cpuCount: 4,
      cpuUtilizationPercent: 12.5,
      loadAverage: [0.1, 0.2, 0.3],
      memory: { totalBytes: 2_147_483_648, usedBytes: 1_073_741_824, freeBytes: 1_073_741_824 },
      swap: { totalBytes: 0, usedBytes: 0 },
      disk: { totalBytes: 32_212_254_720, usedBytes: 10_737_418_240, availableBytes: 21_474_836_480, unavailableReason: null },
    },
    ports: {
      available: true,
      reason: null,
      entries: [{ protocol: 'tcp', localAddress: '0.0.0.0', port: '22', state: 'LISTEN', pid: 734, process: 'sshd' }],
      truncatedCount: 0,
    },
    processes: {
      available: true,
      reason: null,
      entries: [{ pid: 1, cpuPercent: 0.5, memPercent: 0.3, name: 'init' }],
      truncatedCount: 0,
      totalCount: 42,
    },
    ...overrides,
  };
  return {
    calls,
    async collect() {
      calls.push(['collect']);
      return stats;
    },
  };
}

/** Mirrors the real BotManager's public surface that CommandManager depends on. */
class FakeBotManager {
  constructor(slotOverrides = {}) {
    this.slots = new Map();
    for (let slot = 1; slot <= 5; slot += 1) {
      this.slots.set(slot, {
        slot,
        configured: false,
        status: STATUS.UNCONFIGURED,
        client: null,
        voiceManager: null,
        error: null,
        loggedInAt: Date.now() - 10_000,
        stateStore: makeMemoryStateStore(),
        ...slotOverrides[slot],
      });
    }
    this.calls = [];
  }

  get(slot) {
    return this.slots.get(slot) || null;
  }

  get controller() {
    return this.get(1);
  }

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
    if (!record.voiceManager) throw new BotManagerError('unavailable', slot, 'Bot ' + slot + ' has no active voice runtime.');
    return record.voiceManager;
  }

  async startWorker(slot) {
    this.calls.push(['startWorker', slot]);
    if (slot === 1) throw new BotManagerError('is_controller', slot, 'Bot 1 is the Controller and cannot be started through Discord.');
    const record = this.get(slot);
    if (!record.configured) throw new BotManagerError('unconfigured', slot, 'Bot ' + slot + ' is not configured.');
    if (record.status === STATUS.ONLINE) return { record, alreadyRunning: true };
    record.status = STATUS.ONLINE;
    record.error = null;
    record.client = record.client || new FakeClient([], { tag: 'Worker' + slot + '#0000' });
    record.voiceManager = record.voiceManager || makeVoiceManager();
    return { record, alreadyRunning: false };
  }

  async stopWorker(slot) {
    this.calls.push(['stopWorker', slot]);
    if (slot === 1) throw new BotManagerError('is_controller', slot, 'Bot 1 is the Controller and cannot be stopped through Discord.');
    const record = this.get(slot);
    if (!record.configured) throw new BotManagerError('unconfigured', slot, 'Bot ' + slot + ' is not configured.');
    record.status = STATUS.STOPPED;
    record.client = null;
    record.voiceManager = null;
    return record;
  }

  async restartWorker(slot) {
    this.calls.push(['restartWorker', slot]);
    if (slot === 1) throw new BotManagerError('is_controller', slot, 'Bot 1 is the Controller and cannot be restarted through Discord.');
    const record = this.get(slot);
    if (!record.configured) throw new BotManagerError('unconfigured', slot, 'Bot ' + slot + ' is not configured.');
    record.status = STATUS.ONLINE;
    record.error = null;
    record.client = new FakeClient([], { tag: 'Worker' + slot + '#0000' });
    record.voiceManager = makeVoiceManager();
    return { record, alreadyRunning: false };
  }
}

function makeInteraction({ userId = 'owner', group = null, subcommand, channel = null, botSlot, guildId = 'g1' } = {}) {
  const calls = [];
  const interaction = {
    commandName: 'afk',
    user: { id: userId },
    guildId,
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => subcommand,
      getChannel: () => channel,
      getInteger: (name) => (name === 'bot' ? (botSlot === undefined ? null : botSlot) : null),
    },
    deferred: false,
    replied: false,
    calls,
    async deferReply(options) {
      this.deferred = true;
      calls.push({ method: 'deferReply', options });
    },
    async editReply(payload) {
      this.replied = true;
      calls.push({ method: 'editReply', payload });
      return payload;
    },
    async reply(payload) {
      this.replied = true;
      calls.push({ method: 'reply', payload });
      return payload;
    },
    async followUp(payload) {
      calls.push({ method: 'followUp', payload });
      return payload;
    },
    isChatInputCommand: () => true,
  };
  return interaction;
}

function makeManager({ remoteCommands = [], config = {}, slotsInit = {}, managerOptions = {} } = {}) {
  const controllerClient = new FakeClient(remoteCommands);
  const controllerVoiceManager = slotsInit[1]?.voiceManager || makeVoiceManager();
  const botManager = new FakeBotManager({
    1: {
      configured: true,
      status: STATUS.ONLINE,
      client: controllerClient,
      voiceManager: controllerVoiceManager,
    },
    ...slotsInit,
  });
  const manager = new CommandManager(
    botManager,
    { ownerIds: ['owner'], commandGuildId: null, ...config },
    {
      logger: { error() {} },
      statsProvider: makeStatsProvider(),
      sampleProcessCpuPercent: async () => 2.4,
      getCpuCount: () => 4,
      getTotalMemBytes: () => 2_147_483_648,
      ...managerOptions,
    }
  );
  return { client: controllerClient, botManager, manager, voiceManager: controllerVoiceManager };
}

function lastResponse(interaction) {
  return interaction.calls.filter((call) => ['reply', 'editReply', 'followUp'].includes(call.method)).at(-1);
}

// ---- Backward-compatible Controller behavior ----

test('rejects unauthorized users with an ephemeral response and no side effect', async () => {
  const { manager, voiceManager } = makeManager();
  const interaction = makeInteraction({ userId: 'intruder', subcommand: 'status' });

  await manager.handleInteraction(interaction);

  const response = lastResponse(interaction);
  assert.equal(response.method, 'reply');
  assert.equal(response.payload.ephemeral, true);
  assert.match(response.payload.content, /not authorized/i);
  assert.deepEqual(voiceManager.calls, []);
});

test('allows an owner to run ping with an ephemeral response', async () => {
  const { manager } = makeManager();
  const interaction = makeInteraction({ subcommand: 'ping' });

  await manager.handleInteraction(interaction);

  const response = lastResponse(interaction);
  assert.equal(response.method, 'editReply');
  assert.equal(interaction.calls[0].options.ephemeral, true);
  assert.match(response.payload.content, /Gateway ping: 42 ms/);
});

test('voice join with no bot option targets Bot 1 (the Controller) by default', async () => {
  const { manager, voiceManager } = makeManager();
  const interaction = makeInteraction({
    group: 'voice',
    subcommand: 'join',
    channel: { id: 'c2', name: 'Music', guildId: 'g1', isVoiceBased: () => true },
  });

  await manager.handleInteraction(interaction);

  assert.deepEqual(voiceManager.calls, [['join', 'g1', 'c2']]);
  assert.match(lastResponse(interaction).payload.content, /Music/);
});

test('voice leave and reconnect dispatch to the Controller VoiceManager by default', async () => {
  const { manager, voiceManager } = makeManager();

  await manager.handleInteraction(makeInteraction({ group: 'voice', subcommand: 'leave' }));
  await manager.handleInteraction(makeInteraction({ group: 'voice', subcommand: 'reconnect' }));

  assert.deepEqual(voiceManager.calls, [['leave'], ['reconnect']]);
});

test('voice status returns connection, target, duration, and reconnect state', async () => {
  const { manager } = makeManager();
  const interaction = makeInteraction({ group: 'voice', subcommand: 'status' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /Voice: connected/);
  assert.match(content, /Guild One \/ Lounge/);
  assert.match(content, /Connected duration:/);
  assert.match(content, /Reconnect pending: no/);
});

test('diagnostics does not leak the bot token or owner IDs', async () => {
  const { manager } = makeManager({ config: { ownerIds: ['owner'], botToken: 'BOT_TOKEN_SECRET' } });
  const interaction = makeInteraction({ subcommand: 'diagnostics' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.doesNotMatch(content, /BOT_TOKEN_SECRET|owner-secret/);
  assert.match(content, /Node:/);
  assert.match(content, /RSS:/);
});

test('sync updates remote commands when the schema differs', async () => {
  const { client, manager } = makeManager({ remoteCommands: [] });

  const first = await manager.syncCommands();
  const second = await manager.syncCommands();

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(client.application.commands.setCalls, 1);
  assert.equal(first.localCount, buildCommandSchema().length);
});

test('startup sync is a no-op when the remote schema already matches', async () => {
  const schema = buildCommandSchema();
  const { client, manager } = makeManager({ remoteCommands: schema });

  const result = await manager.syncOnStartup();

  assert.equal(result.changed, false);
  assert.equal(result.inSync, true);
  assert.equal(client.application.commands.setCalls, 0);
});

test('schema comparison ignores Discord-generated command identity fields', () => {
  const local = buildCommandSchema();
  const remote = local.map((command) => ({
    ...command,
    id: 'generated-command-id',
    application_id: 'generated-application-id',
    guild_id: 'generated-guild-id',
    version: 'generated-version',
  }));

  assert.equal(commandSchemasEqual(local, remote), true);
});

test('uses guild-scoped command registration when COMMAND_GUILD_ID is configured', async () => {
  const client = new FakeClient([]);
  const guildCommands = {
    remote: [],
    setCalls: 0,
    async fetch() {
      return this.remote;
    },
    async set(commands) {
      this.setCalls += 1;
      this.remote = commands;
      return commands;
    },
  };
  client.guilds.cache.set('g1', { id: 'g1', commands: guildCommands });
  const botManager = new FakeBotManager({ 1: { configured: true, status: STATUS.ONLINE, client, voiceManager: makeVoiceManager() } });
  const manager = new CommandManager(
    botManager,
    { ownerIds: ['owner'], commandGuildId: 'g1' },
    { logger: { error() {} }, statsProvider: makeStatsProvider() }
  );

  const result = await manager.syncCommands();

  assert.equal(result.scope, 'guild');
  assert.equal(result.guildId, 'g1');
  assert.equal(guildCommands.setCalls, 1);
  assert.equal(client.application.commands.setCalls, 0);
});

test('invalid voice channel is rejected without calling VoiceManager', async () => {
  const { manager, voiceManager } = makeManager();
  const interaction = makeInteraction({
    group: 'voice',
    subcommand: 'join',
    channel: { id: 'text', guildId: 'g1', isVoiceBased: () => false },
  });

  await manager.handleInteraction(interaction);

  assert.deepEqual(voiceManager.calls, []);
  assert.match(lastResponse(interaction).payload.content, /voice channel/i);
});

test('unexpected handler errors become safe ephemeral responses', async () => {
  const logs = [];
  const badVoiceManager = makeVoiceManager({
    async join() {
      throw new Error('BOT_TOKEN=secret-value');
    },
  });
  const client = new FakeClient([]);
  const botManager = new FakeBotManager({ 1: { configured: true, status: STATUS.ONLINE, client, voiceManager: badVoiceManager } });
  const manager = new CommandManager(
    botManager,
    { ownerIds: ['owner'], commandGuildId: null },
    { logger: { error: (message) => logs.push(message) }, statsProvider: makeStatsProvider() }
  );
  const interaction = makeInteraction({
    group: 'voice',
    subcommand: 'join',
    channel: { id: 'c1', name: 'Lounge', guildId: 'g1', isVoiceBased: () => true },
  });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /Command failed/i);
  assert.doesNotMatch(content, /secret-value/);
  assert.match(logs[0], /secret-value/);
  assert.equal(interaction.calls[0].options.ephemeral, true);
});

test('schema includes /afk stats alongside the existing subcommands', () => {
  const schema = buildCommandSchema()[0];
  const topLevelNames = schema.options.filter((o) => o.type === 1).map((o) => o.name);
  assert.ok(topLevelNames.includes('stats'));
  assert.ok(topLevelNames.includes('status'));
  const groupNames = schema.options.filter((o) => o.type === 2).map((o) => o.name);
  assert.deepEqual(groupNames.sort(), ['bot', 'commands', 'voice']);
});

// ---- /afk stats (VPS-only) ----

test('owner can run /afk stats and receives SYSTEM/PORTS/PROCESSES, with no dedicated LOCALAFK section', async () => {
  const statsProvider = makeStatsProvider();
  const { manager } = makeManager({ managerOptions: { statsProvider } });
  const interaction = makeInteraction({ subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.equal(statsProvider.calls.length, 1);
  assert.match(content, /\*\*SYSTEM\*\*/);
  assert.match(content, /\*\*PORTS\*\*/);
  assert.match(content, /\*\*PROCESSES\*\*/);
  assert.doesNotMatch(content, /\*\*LOCALAFK\*\*/);
  assert.match(content, /CPU utilization:/);
  assert.match(content, /RAM:/);
  assert.match(content, /Disk \(root\):/);
});

test('/afk stats port output includes the PID column when available', async () => {
  const statsProvider = makeStatsProvider();
  const { manager } = makeManager({ managerOptions: { statsProvider } });
  const interaction = makeInteraction({ subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /PID\s+PROCESS/);
  assert.match(content, /734\s+sshd/);
});

test('/afk stats is cooled down per owner for a few seconds', async () => {
  const statsProvider = makeStatsProvider();
  const { manager } = makeManager({ managerOptions: { statsProvider, statsCooldownMs: 5_000 } });

  await manager.handleInteraction(makeInteraction({ subcommand: 'stats' }));
  const second = makeInteraction({ subcommand: 'stats' });
  await manager.handleInteraction(second);

  assert.equal(statsProvider.calls.length, 1);
  assert.match(lastResponse(second).payload.content, /wait/i);
});

test('/afk stats never leaks the bot token or owner IDs', async () => {
  const statsProvider = makeStatsProvider();
  const { manager } = makeManager({
    config: { ownerIds: ['owner'], botToken: 'BOT_TOKEN_SECRET' },
    managerOptions: { statsProvider },
  });
  const interaction = makeInteraction({ subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  assert.doesNotMatch(lastResponse(interaction).payload.content, /BOT_TOKEN_SECRET/);
});

test('a stats-provider failure becomes a safe ephemeral error, not a raw stack trace', async () => {
  const statsProvider = { async collect() { throw new Error('disk read exploded: /secret/path'); } };
  const logs = [];
  const client = new FakeClient([]);
  const botManager = new FakeBotManager({ 1: { configured: true, status: STATUS.ONLINE, client, voiceManager: makeVoiceManager() } });
  const manager = new CommandManager(
    botManager,
    { ownerIds: ['owner'], commandGuildId: null },
    { logger: { error: (m) => logs.push(m) }, statsProvider }
  );
  const interaction = makeInteraction({ subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /Command failed|Failed to collect/i);
  assert.doesNotMatch(content, /secret/i);
});

test('formatStats truncates safely within the Discord response budget on a long port/process list', () => {
  const manyPorts = Array.from({ length: 40 }, (_, i) => ({
    protocol: 'tcp',
    localAddress: '0.0.0.0',
    port: String(3000 + i),
    state: 'LISTEN',
    pid: 1000 + i,
    process: 'node',
  }));
  const manyProcesses = Array.from({ length: 60 }, (_, i) => ({
    pid: i + 1,
    cpuPercent: 1.2,
    memPercent: 0.8,
    name: 'proc' + i,
  }));
  const stats = {
    system: {
      hostname: null,
      hostnameOmitted: true,
      platform: 'linux',
      release: 'test',
      nodeVersion: process.version,
      uptimeSeconds: 10,
      cpuCount: 4,
      cpuUtilizationPercent: 1,
      loadAverage: [0, 0, 0],
      memory: { totalBytes: 1, usedBytes: 1, freeBytes: 0 },
      swap: null,
      disk: { totalBytes: 1, usedBytes: 1, availableBytes: 0, unavailableReason: null },
    },
    ports: { available: true, reason: null, entries: manyPorts, truncatedCount: 5 },
    processes: { available: true, reason: null, entries: manyProcesses, truncatedCount: 0, totalCount: 60 },
  };

  const content = formatStats(stats);

  assert.ok(content.length <= 1_900);
  assert.match(content, /more\./);
});

test('/afk stats does not crash on a non-Linux platform and reports sections as unavailable', async () => {
  const statsProvider = new StatsProvider({ platform: 'win32', sleep: async () => {} });
  const { manager } = makeManager({ managerOptions: { statsProvider } });
  const interaction = makeInteraction({ subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /\*\*SYSTEM\*\*/);
  assert.match(content, /Unavailable on this platform/);
});

// ---- /afk bot (worker lifecycle) ----

test('/afk bot list shows a compact overview of all five slots', async () => {
  const { manager } = makeManager({
    slotsInit: {
      2: { configured: true, status: STATUS.ONLINE, client: new FakeClient([], { tag: 'Worker2#1111' }), voiceManager: makeVoiceManager() },
      3: { configured: true, status: STATUS.STOPPED, stateStore: makeMemoryStateStore({ desiredVoice: { guildId: 'g1', channelId: 'c9' } }) },
      4: { configured: true, status: STATUS.FAILED, error: 'login failed' },
      5: { configured: false, status: STATUS.UNCONFIGURED },
    },
  });
  const interaction = makeInteraction({ group: 'bot', subcommand: 'list' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /BOTS — 2\/5 ONLINE/);
  assert.match(content, /1 •/);
  assert.match(content, /Worker2#1111/);
  assert.match(content, /STOPPED • Saved target:/);
  assert.match(content, /FAILED • login failed/);
  assert.match(content, /5 • unconfigured/);
  assert.doesNotMatch(content, /BOT_TOKEN|token/i);
});

test('/afk bot start dispatches to BotManager.startWorker', async () => {
  const { manager, botManager } = makeManager({
    slotsInit: { 3: { configured: true, status: STATUS.STOPPED } },
  });
  const interaction = makeInteraction({ group: 'bot', subcommand: 'start', botSlot: 3 });

  await manager.handleInteraction(interaction);

  assert.deepEqual(botManager.calls, [['startWorker', 3]]);
  assert.match(lastResponse(interaction).payload.content, /Bot 3 started/);
});

test('/afk bot stop dispatches to BotManager.stopWorker', async () => {
  const { manager, botManager } = makeManager({
    slotsInit: { 4: { configured: true, status: STATUS.ONLINE, client: new FakeClient(), voiceManager: makeVoiceManager() } },
  });
  const interaction = makeInteraction({ group: 'bot', subcommand: 'stop', botSlot: 4 });

  await manager.handleInteraction(interaction);

  assert.deepEqual(botManager.calls, [['stopWorker', 4]]);
  assert.match(lastResponse(interaction).payload.content, /Bot 4 stopped/);
  assert.match(lastResponse(interaction).payload.content, /preserved/i);
});

test('/afk bot restart dispatches to BotManager.restartWorker', async () => {
  const { manager, botManager } = makeManager({
    slotsInit: { 2: { configured: true, status: STATUS.ONLINE, client: new FakeClient(), voiceManager: makeVoiceManager() } },
  });
  const interaction = makeInteraction({ group: 'bot', subcommand: 'restart', botSlot: 2 });

  await manager.handleInteraction(interaction);

  assert.deepEqual(botManager.calls, [['restartWorker', 2]]);
  assert.match(lastResponse(interaction).payload.content, /Bot 2 restarted/);
});

test('unauthorized users cannot control bot start/stop/restart', async () => {
  const { manager, botManager } = makeManager({ slotsInit: { 2: { configured: true, status: STATUS.STOPPED } } });
  const interaction = makeInteraction({ userId: 'intruder', group: 'bot', subcommand: 'start', botSlot: 2 });

  await manager.handleInteraction(interaction);

  assert.deepEqual(botManager.calls, []);
  assert.match(lastResponse(interaction).payload.content, /not authorized/i);
});

test('an interaction from a different guild than COMMAND_GUILD_ID is rejected', async () => {
  const { manager, botManager } = makeManager({
    config: { commandGuildId: 'expected-guild' },
    slotsInit: { 2: { configured: true, status: STATUS.STOPPED } },
  });
  const interaction = makeInteraction({ group: 'bot', subcommand: 'start', botSlot: 2 }); // guildId defaults to 'g1'

  await manager.handleInteraction(interaction);

  assert.deepEqual(botManager.calls, []);
  assert.match(lastResponse(interaction).payload.content, /not available in this server/i);
});

// ---- Voice bot selector ----

test('voice join targets Bot 3 when bot:3 is supplied', async () => {
  const bot3VoiceManager = makeVoiceManager();
  const { manager, voiceManager: controllerVoiceManager } = makeManager({
    slotsInit: { 3: { configured: true, status: STATUS.ONLINE, client: new FakeClient(), voiceManager: bot3VoiceManager } },
  });
  const interaction = makeInteraction({
    group: 'voice',
    subcommand: 'join',
    botSlot: 3,
    channel: { id: 'c9', name: 'AFK Room', guildId: 'g1', isVoiceBased: () => true },
  });

  await manager.handleInteraction(interaction);

  assert.deepEqual(bot3VoiceManager.calls, [['join', 'g1', 'c9']]);
  assert.deepEqual(controllerVoiceManager.calls, []);
  assert.match(lastResponse(interaction).payload.content, /Bot 3/);
});

test('voice leave targets Bot 4 when bot:4 is supplied', async () => {
  const bot4VoiceManager = makeVoiceManager();
  const { manager, voiceManager: controllerVoiceManager } = makeManager({
    slotsInit: { 4: { configured: true, status: STATUS.ONLINE, client: new FakeClient(), voiceManager: bot4VoiceManager } },
  });
  const interaction = makeInteraction({ group: 'voice', subcommand: 'leave', botSlot: 4 });

  await manager.handleInteraction(interaction);

  assert.deepEqual(bot4VoiceManager.calls, [['leave']]);
  assert.deepEqual(controllerVoiceManager.calls, []);
});

test('a voice command against a stopped worker is rejected with guidance to start it', async () => {
  const { manager } = makeManager({ slotsInit: { 2: { configured: true, status: STATUS.STOPPED } } });
  const interaction = makeInteraction({ group: 'voice', subcommand: 'status', botSlot: 2 });

  await manager.handleInteraction(interaction);

  assert.match(lastResponse(interaction).payload.content, /stopped.*start/i);
});

test('a voice command against an unconfigured worker is rejected', async () => {
  const { manager } = makeManager(); // slot 5 defaults to unconfigured
  const interaction = makeInteraction({ group: 'voice', subcommand: 'status', botSlot: 5 });

  await manager.handleInteraction(interaction);

  assert.match(lastResponse(interaction).payload.content, /not configured/i);
});

test('a voice command against a failed worker reports the failure safely', async () => {
  const { manager } = makeManager({ slotsInit: { 3: { configured: true, status: STATUS.FAILED, error: 'invalid token' } } });
  const interaction = makeInteraction({ group: 'voice', subcommand: 'status', botSlot: 3 });

  await manager.handleInteraction(interaction);

  assert.match(lastResponse(interaction).payload.content, /failed to log in/i);
});

// ---- /afk status (LocalAFK process + five-bot-slot status) ----

test('/afk status reports LocalAFK process CPU/RSS/heap/uptime', async () => {
  const { manager } = makeManager();
  const interaction = makeInteraction({ subcommand: 'status' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /PID: \d+/);
  assert.match(content, /Process CPU: 2\.4%/);
  assert.match(content, /RSS: [\d.]+ MB/);
  assert.match(content, /Heap used: [\d.]+ MB/);
  assert.match(content, /Uptime:/);
});

test('/afk status reports LocalAFK RSS as a percentage of total VPS RAM', async () => {
  const { manager } = makeManager({ managerOptions: { getTotalMemBytes: () => process.memoryUsage().rss * 10 } });
  const interaction = makeInteraction({ subcommand: 'status' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /% of VPS RAM/);
});

test('/afk status reports all five bot slots with their real state', async () => {
  const { manager } = makeManager({
    slotsInit: {
      2: { configured: true, status: STATUS.ONLINE, client: new FakeClient([], { tag: 'Worker2#1' }), voiceManager: makeVoiceManager() },
      3: { configured: true, status: STATUS.STOPPED },
      4: { configured: true, status: STATUS.FAILED, error: 'bad token' },
      5: { configured: false, status: STATUS.UNCONFIGURED },
    },
  });
  const interaction = makeInteraction({ subcommand: 'status' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /1 • Controller — ONLINE/);
  assert.match(content, /2 • Worker — ONLINE \(Worker2#1\)/);
  assert.match(content, /3 • Worker — STOPPED/);
  assert.match(content, /4 • Worker — FAILED \(bad token\)/);
  assert.match(content, /5 • Worker — UNCONFIGURED/);
});

test('/afk status never fabricates per-bot CPU/RAM and states the shared-runtime limitation once', async () => {
  const { manager } = makeManager({
    slotsInit: {
      2: { configured: true, status: STATUS.ONLINE, client: new FakeClient(), voiceManager: makeVoiceManager() },
    },
  });
  const interaction = makeInteraction({ subcommand: 'status' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  const disclaimerMatches = content.match(/exact attribution is unavailable by design/gi) || [];
  assert.equal(disclaimerMatches.length, 1);
  assert.doesNotMatch(content, /Bot 2 RAM|Bot 2 CPU/i);
});

test('/afk status counts bots online and voice-connected correctly', async () => {
  const onlineVoiceManager = makeVoiceManager(); // status().connected defaults to true
  const idleVoiceManager = makeVoiceManager({ status: () => ({ connected: false, state: 'idle', reconnectPending: false, channelId: null }) });
  const { manager } = makeManager({
    slotsInit: {
      2: { configured: true, status: STATUS.ONLINE, client: new FakeClient(), voiceManager: onlineVoiceManager },
      3: { configured: true, status: STATUS.ONLINE, client: new FakeClient(), voiceManager: idleVoiceManager },
    },
  });
  const interaction = makeInteraction({ subcommand: 'status' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /Bots: 3 configured • 3 online/); // Controller (1) + slots 2 and 3
  assert.match(content, /Voice connected: 2/); // controller + slot 2, both default-connected
});

test('/afk status output fits the Discord response budget even with all five bots configured', async () => {
  const slotsInit = {};
  for (const slot of [2, 3, 4, 5]) {
    slotsInit[slot] = {
      configured: true,
      status: STATUS.ONLINE,
      client: new FakeClient([], { tag: 'Worker' + slot + '#0000', guildCount: 3 }),
      voiceManager: makeVoiceManager(),
    };
  }
  const { manager } = makeManager({ slotsInit });
  const interaction = makeInteraction({ subcommand: 'status' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.ok(content.length <= 1_900);
  for (const slot of [1, 2, 3, 4, 5]) {
    assert.match(content, new RegExp('^' + slot + ' •', 'm'));
  }
});
