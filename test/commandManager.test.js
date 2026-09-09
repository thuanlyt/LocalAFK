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
      entries: [{ protocol: 'tcp', localAddress: '0.0.0.0', port: '22', state: 'LISTEN', process: 'sshd' }],
      truncatedCount: 0,
      establishedCount: 2,
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

class FakeClient extends EventEmitter {
  constructor(remoteCommands = []) {
    super();
    this.ws = { ping: 42 };
    this.user = { id: 'bot', tag: 'LocalAFK#0001' };
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
    this.guilds = { cache: new Map([['g1', { id: 'g1', commands: this.application.commands }]]) };
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

function makeInteraction({ userId = 'owner', group = null, subcommand, channel = null } = {}) {
  const calls = [];
  const interaction = {
    commandName: 'afk',
    user: { id: userId },
    guildId: 'g1',
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => subcommand,
      getChannel: () => channel,
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

function makeManager({ remoteCommands = [], config = {}, voiceManager, managerOptions = {} } = {}) {
  const client = new FakeClient(remoteCommands);
  const manager = new CommandManager(
    client,
    voiceManager || makeVoiceManager(),
    {
      ownerIds: ['owner'],
      commandGuildId: null,
      ...config,
    },
    { logger: { error() {} }, statsProvider: makeStatsProvider(), ...managerOptions }
  );
  return { client, manager };
}

function lastResponse(interaction) {
  return interaction.calls.filter((call) => ['reply', 'editReply', 'followUp'].includes(call.method)).at(-1);
}

test('rejects unauthorized users with an ephemeral response and no side effect', async () => {
  const voiceManager = makeVoiceManager();
  const { manager } = makeManager({ voiceManager });
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

test('dispatches voice join to VoiceManager with the interaction guild and channel', async () => {
  const voiceManager = makeVoiceManager();
  const { manager } = makeManager({ voiceManager });
  const interaction = makeInteraction({
    group: 'voice',
    subcommand: 'join',
    channel: { id: 'c2', name: 'Music', guildId: 'g1', isVoiceBased: () => true },
  });

  await manager.handleInteraction(interaction);

  assert.deepEqual(voiceManager.calls, [['join', 'g1', 'c2']]);
  assert.match(lastResponse(interaction).payload.content, /Music/);
});

test('dispatches voice leave and reconnect to public VoiceManager methods', async () => {
  const voiceManager = makeVoiceManager();
  const { manager } = makeManager({ voiceManager });

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
  const { manager } = makeManager({
    config: { ownerIds: ['owner'], botToken: 'BOT_TOKEN_SECRET' },
  });
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
  const manager = new CommandManager(
    client,
    makeVoiceManager(),
    { ownerIds: ['owner'], commandGuildId: 'g1' },
    { logger: { error() {} } }
  );

  const result = await manager.syncCommands();

  assert.equal(result.scope, 'guild');
  assert.equal(result.guildId, 'g1');
  assert.equal(guildCommands.setCalls, 1);
  assert.equal(client.application.commands.setCalls, 0);
});

test('invalid voice channel is rejected without calling VoiceManager', async () => {
  const voiceManager = makeVoiceManager();
  const { manager } = makeManager({ voiceManager });
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
  const voiceManager = makeVoiceManager({
    async join() {
      throw new Error('BOT_TOKEN=secret-value');
    },
  });
  const client = new FakeClient([]);
  const manager = new CommandManager(
    client,
    voiceManager,
    { ownerIds: ['owner'], commandGuildId: null },
    { logger: { error: (message) => logs.push(message) } }
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
});

test('owner can run /afk stats and receives SYSTEM/LOCALAFK/PORTS/PROCESSES with CPU/RAM/disk', async () => {
  const statsProvider = makeStatsProvider();
  const { manager } = makeManager({ managerOptions: { statsProvider } });
  const interaction = makeInteraction({ subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.equal(statsProvider.calls.length, 1);
  assert.match(content, /\*\*SYSTEM\*\*/);
  assert.match(content, /\*\*LOCALAFK\*\*/);
  assert.match(content, /\*\*PORTS\*\*/);
  assert.match(content, /\*\*PROCESSES\*\*/);
  assert.match(content, /CPU utilization:/);
  assert.match(content, /RAM:/);
  assert.match(content, /Disk \(root\):/);
  assert.equal(interaction.calls[0].options.ephemeral, true);
});

test('non-owner is rejected for /afk stats without collecting any stats', async () => {
  const statsProvider = makeStatsProvider();
  const { manager } = makeManager({ managerOptions: { statsProvider } });
  const interaction = makeInteraction({ userId: 'intruder', subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  assert.equal(statsProvider.calls.length, 0);
  assert.match(lastResponse(interaction).payload.content, /not authorized/i);
});

test('a configured COMMAND_GUILD_ID rejects interactions from a different guild', async () => {
  const statsProvider = makeStatsProvider();
  const { manager } = makeManager({
    config: { commandGuildId: 'expected-guild' },
    managerOptions: { statsProvider },
  });
  const interaction = makeInteraction({ subcommand: 'stats' }); // guildId defaults to 'g1'

  await manager.handleInteraction(interaction);

  assert.equal(statsProvider.calls.length, 0);
  assert.match(lastResponse(interaction).payload.content, /not available in this server/i);
});

test('a configured COMMAND_GUILD_ID allows the matching guild through', async () => {
  const statsProvider = makeStatsProvider();
  const { manager } = makeManager({
    config: { commandGuildId: 'g1' },
    managerOptions: { statsProvider },
  });
  const interaction = makeInteraction({ subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  assert.equal(statsProvider.calls.length, 1);
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
  const client = new (require('node:events').EventEmitter)();
  client.ws = { ping: 1 };
  client.user = { id: 'bot' };
  client.isReady = () => true;
  client.application = { commands: { async fetch() { return []; }, async set(c) { return c; } } };
  client.guilds = { cache: new Map() };
  const manager = new CommandManager(
    client,
    makeVoiceManager(),
    { ownerIds: ['owner'], commandGuildId: null },
    { logger: { error: (m) => logs.push(m) }, statsProvider }
  );
  const interaction = makeInteraction({ subcommand: 'stats' });

  await manager.handleInteraction(interaction);

  const content = lastResponse(interaction).payload.content;
  assert.match(content, /Command failed|Failed to collect/i);
  assert.doesNotMatch(content, /secret/i);
});

test('a long port/process list truncates safely within the Discord response budget', () => {
  const manyPorts = Array.from({ length: 40 }, (_, i) => ({
    protocol: 'tcp',
    localAddress: '0.0.0.0',
    port: String(3000 + i),
    state: 'LISTEN',
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
    ports: { available: true, reason: null, entries: manyPorts, truncatedCount: 5, establishedCount: 0 },
    processes: { available: true, reason: null, entries: manyProcesses, truncatedCount: 0, totalCount: 60 },
  };
  const localafk = {
    pid: 1,
    memory: { rss: 1, heapUsed: 1 },
    uptimeSeconds: 1,
    gatewayPing: '1 ms',
    voice: { state: 'idle' },
  };

  const content = formatStats(stats, localafk);

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
