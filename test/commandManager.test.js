const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  CommandManager,
  buildCommandSchema,
  commandSchemasEqual,
} = require('../src/discord/commandManager');

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

function makeManager({ remoteCommands = [], config = {}, voiceManager } = {}) {
  const client = new FakeClient(remoteCommands);
  const manager = new CommandManager(
    client,
    voiceManager || makeVoiceManager(),
    {
      ownerIds: ['owner'],
      commandGuildId: null,
      ...config,
    },
    { logger: { error() {} } }
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
