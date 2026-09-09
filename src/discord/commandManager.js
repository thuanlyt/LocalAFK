const os = require('node:os');
const {
  ChannelType,
  SlashCommandBuilder,
} = require('discord.js');
const { StatsProvider } = require('../system/statsProvider');
const { sampleProcessCpuPercent } = require('../system/processStats');
const { BotManagerError, STATUS, ALL_SLOTS, WORKER_SLOTS, CONTROLLER_SLOT } = require('./botManager');

const ROOT_COMMAND = 'afk';
const MAX_RESPONSE_LENGTH = 1_900;
const DEFAULT_STATS_COOLDOWN_MS = 5_000;
const DEFAULT_PORT_ROWS = 15;
const DEFAULT_PROCESS_ROWS = 10;
const DEFAULT_STATUS_CPU_SAMPLE_MS = 200;

const WORKER_BOT_CHOICES = WORKER_SLOTS.map((slot) => ({ name: String(slot), value: slot }));
const ANY_BOT_CHOICES = ALL_SLOTS.map((slot) => ({
  name: slot === CONTROLLER_SLOT ? slot + ' (Controller)' : String(slot),
  value: slot,
}));

class CommandError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.name = 'CommandError';
    this.userMessage = userMessage;
  }
}

function addBotSelectorOption(subcommand, { required = false, description, choices } = {}) {
  return subcommand.addIntegerOption((option) => {
    option
      .setName('bot')
      .setDescription(description || 'Bot slot to target (defaults to 1, the Controller)')
      .setRequired(required);
    for (const choice of choices) option.addChoices(choice);
    return option;
  });
}

function buildCommandSchema() {
  return [new SlashCommandBuilder()
    .setName(ROOT_COMMAND)
    .setDescription('Control the LocalAFK Discord bots')
    .addSubcommandGroup((group) =>
      group
        .setName('voice')
        .setDescription('Manage a bot\'s persistent voice connection')
        .addSubcommand((subcommand) =>
          addBotSelectorOption(
            subcommand
              .setName('join')
              .setDescription('Join and persist a voice channel')
              .addChannelOption((option) =>
                option
                  .setName('channel')
                  .setDescription('Voice channel to join')
                  .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
                  .setRequired(true)
              ),
            { choices: ANY_BOT_CHOICES }
          )
        )
        .addSubcommand((subcommand) =>
          addBotSelectorOption(
            subcommand.setName('leave').setDescription('Leave voice and clear the saved target'),
            { choices: ANY_BOT_CHOICES }
          )
        )
        .addSubcommand((subcommand) =>
          addBotSelectorOption(
            subcommand.setName('reconnect').setDescription('Reconnect to the saved voice target'),
            { choices: ANY_BOT_CHOICES }
          )
        )
        .addSubcommand((subcommand) =>
          addBotSelectorOption(
            subcommand.setName('status').setDescription('Show voice connection status'),
            { choices: ANY_BOT_CHOICES }
          )
        )
        .addSubcommand((subcommand) =>
          addBotSelectorOption(
            subcommand.setName('members').setDescription('List members in the current voice channel'),
            { choices: ANY_BOT_CHOICES }
          )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('commands')
        .setDescription('Manage slash-command registration')
        .addSubcommand((subcommand) =>
          subcommand.setName('sync').setDescription('Force slash-command registration sync')
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('status').setDescription('Show slash-command registration status')
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('bot')
        .setDescription('Manage worker bot slots (2-5)')
        .addSubcommand((subcommand) =>
          subcommand.setName('list').setDescription('List all five bot slots')
        )
        .addSubcommand((subcommand) =>
          addBotSelectorOption(
            subcommand.setName('start').setDescription('Start a worker bot'),
            { required: true, description: 'Worker slot to start', choices: WORKER_BOT_CHOICES }
          )
        )
        .addSubcommand((subcommand) =>
          addBotSelectorOption(
            subcommand.setName('stop').setDescription('Stop a worker bot'),
            { required: true, description: 'Worker slot to stop', choices: WORKER_BOT_CHOICES }
          )
        )
        .addSubcommand((subcommand) =>
          addBotSelectorOption(
            subcommand.setName('restart').setDescription('Restart a worker bot'),
            { required: true, description: 'Worker slot to restart', choices: WORKER_BOT_CHOICES }
          )
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('ping').setDescription('Show gateway latency and process uptime')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('Show LocalAFK process resource usage and all five bot slots')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('diagnostics').setDescription('Show a safe Controller operational diagnostics snapshot')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('stats').setDescription('Show read-only VPS/host system statistics')
    )
    .toJSON()];
}

function normalizeOption(option) {
  const normalized = {
    type: option.type,
    name: option.name,
    description: option.description || '',
  };

  if (option.required === true) normalized.required = true;
  if (Array.isArray(option.channel_types) && option.channel_types.length) {
    normalized.channel_types = [...option.channel_types].sort((a, b) => a - b);
  }
  if (Array.isArray(option.choices) && option.choices.length) {
    normalized.choices = option.choices.map((choice) => ({
      name: choice.name,
      value: choice.value,
    }));
  }
  if (Array.isArray(option.options) && option.options.length) {
    normalized.options = option.options.map(normalizeOption);
  }

  return normalized;
}

function normalizeCommand(command) {
  const normalized = {
    type: command.type || 1,
    name: command.name,
    description: command.description || '',
  };

  if (Array.isArray(command.options) && command.options.length) {
    normalized.options = command.options.map(normalizeOption);
  }

  return normalized;
}

function normalizeCommands(commands) {
  return commands
    .map(normalizeCommand)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function commandSchemasEqual(left, right) {
  return JSON.stringify(normalizeCommands(left)) === JSON.stringify(normalizeCommands(right));
}

function valuesOf(collection) {
  if (Array.isArray(collection)) return collection;
  if (collection && typeof collection.values === 'function') return [...collection.values()];
  return [];
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'n/a';
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(days + 'd');
  if (hours || days) parts.push(hours + 'h');
  if (minutes || hours || days) parts.push(minutes + 'm');
  parts.push(seconds + 's');
  return parts.join(' ');
}

function formatBytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatScaledBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return value.toFixed(1) + ' ' + units[unitIndex];
}

function formatUsageLine(usage) {
  if (!usage || usage.totalBytes === null || usage.totalBytes === undefined) return 'n/a';
  const percent = usage.totalBytes ? ((usage.usedBytes / usage.totalBytes) * 100).toFixed(1) : '0.0';
  return formatScaledBytes(usage.usedBytes) + ' / ' + formatScaledBytes(usage.totalBytes) + ' (' + percent + '%)';
}

function padRight(value, width) {
  const str = String(value);
  return str.length >= width ? str + ' ' : str + ' '.repeat(width - str.length);
}

function truncateResponse(content) {
  if (content.length <= MAX_RESPONSE_LENGTH) return content;
  return content.slice(0, MAX_RESPONSE_LENGTH - 30) + '\n… response truncated';
}

function gatewayPing(client) {
  const ping = Number(client?.ws?.ping);
  return Number.isFinite(ping) && ping >= 0 ? ping + ' ms' : 'unavailable';
}

function voiceDescription(voice) {
  if (!voice) return 'idle';
  if (voice.connected) return 'connected (' + (voice.channelName || voice.channelId) + ')';
  if (voice.reconnectPending) return 'reconnecting';
  if (voice.channelId) return 'disconnected';
  return 'idle';
}

function formatVoiceStatus(status) {
  const target = status.channelId
    ? (status.guildName || status.guildId || 'unknown guild') +
      ' / ' +
      (status.channelName || status.channelId)
    : 'none';
  const duration = status.connectedAt ? formatDuration(Date.now() - status.connectedAt) : 'n/a';
  return [
    'Voice: ' + (status.state || (status.connected ? 'connected' : 'idle')),
    'Target: ' + target,
    'Connected duration: ' + duration,
    'Reconnect pending: ' + (status.reconnectPending ? 'yes' : 'no'),
  ].join('\n');
}

function formatMembers(members) {
  if (!members.length) return 'Voice members: 0';
  const lines = members.map((member) => {
    const marker = member.bot ? ' [bot]' : '';
    return '• ' + (member.username || 'Unknown member') + marker;
  });
  const header = 'Voice members (' + members.length + '):\n';
  let output = header;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const candidate = output + (output === header ? '' : '\n') + line;
    if (candidate.length > MAX_RESPONSE_LENGTH - 40) {
      const remaining = lines.length - index;
      return output + '\n… and ' + remaining + ' more.';
    }
    output = candidate;
  }
  return output;
}

function formatSystemSection(system) {
  const lines = ['**SYSTEM**'];
  if (system.hostname) lines.push('Hostname: ' + system.hostname);
  else if (system.hostnameOmitted) lines.push('Hostname: (omitted)');
  lines.push('Platform: ' + system.platform + ' ' + system.release);
  lines.push('Uptime: ' + formatDuration(system.uptimeSeconds * 1_000));
  lines.push('CPU cores: ' + system.cpuCount);
  lines.push(
    'CPU utilization: ' +
      (system.cpuUtilizationPercent === null || system.cpuUtilizationPercent === undefined
        ? 'n/a'
        : system.cpuUtilizationPercent.toFixed(1) + '%')
  );
  lines.push(
    'Load average (1/5/15): ' +
      (system.loadAverage ? system.loadAverage.map((n) => n.toFixed(2)).join(' / ') : 'n/a')
  );
  lines.push('RAM: ' + formatUsageLine(system.memory));
  lines.push('Swap: ' + (system.swap ? formatUsageLine(system.swap) : 'n/a'));
  lines.push(
    'Disk (root): ' +
      (system.disk && system.disk.totalBytes !== null
        ? formatUsageLine(system.disk)
        : 'unavailable (' + (system.disk?.unavailableReason || 'unknown') + ')')
  );
  return lines.join('\n');
}

function formatPortsSection(ports, maxRows) {
  const lines = ['**PORTS**'];
  if (!ports.available) {
    lines.push(ports.reason || 'Unavailable on this platform.');
    return lines.join('\n');
  }
  const shown = ports.entries.slice(0, Math.max(0, maxRows));
  if (!shown.length) {
    lines.push(maxRows <= 0 ? '(rows omitted to fit response size)' : 'No listening ports detected.');
  } else {
    lines.push('```');
    lines.push('PROTO  BIND             PORT   STATE   PID     PROCESS');
    for (const entry of shown) {
      lines.push(
        padRight(entry.protocol, 7) +
          padRight(entry.localAddress, 17) +
          padRight(entry.port, 7) +
          padRight(entry.state, 8) +
          padRight(entry.pid ?? 'unknown', 8) +
          entry.process
      );
    }
    lines.push('```');
  }
  const remaining = ports.entries.length - shown.length + ports.truncatedCount;
  if (remaining > 0) lines.push('… and ' + remaining + ' more.');
  return lines.join('\n');
}

function formatProcessesSection(processes, maxRows) {
  const lines = ['**PROCESSES**'];
  if (!processes.available) {
    lines.push(processes.reason || 'Unavailable on this platform.');
    return lines.join('\n');
  }
  const shown = processes.entries.slice(0, Math.max(0, maxRows));
  if (!shown.length) {
    lines.push(maxRows <= 0 ? '(rows omitted to fit response size)' : 'No process data available.');
  } else {
    lines.push('```');
    lines.push('PID     CPU%   MEM%   NAME');
    for (const proc of shown) {
      lines.push(
        padRight(proc.pid, 8) + padRight(proc.cpuPercent.toFixed(1), 7) + padRight(proc.memPercent.toFixed(1), 7) + proc.name
      );
    }
    lines.push('```');
  }
  const shownTotal = processes.entries.length - shown.length + processes.truncatedCount;
  if (shownTotal > 0) lines.push('… and ' + shownTotal + ' more.');
  if (processes.totalCount !== null && processes.totalCount !== undefined) {
    lines.push('Total processes: ' + processes.totalCount);
  }
  return lines.join('\n');
}

/**
 * Renders /afk stats — strictly VPS/host statistics, no bot-specific data (that lives in
 * /afk status). Priority order when the content doesn't fit: system summary, then listening
 * ports, then top processes — rows are trimmed from processes first, then ports.
 */
function formatStats(stats) {
  const system = formatSystemSection(stats.system);

  let portRows = Math.min(stats.ports.entries.length, DEFAULT_PORT_ROWS);
  let processRows = Math.min(stats.processes.entries.length, DEFAULT_PROCESS_ROWS);
  let ports = formatPortsSection(stats.ports, portRows);
  let processes = formatProcessesSection(stats.processes, processRows);

  const budget = MAX_RESPONSE_LENGTH - system.length - 16;
  while (ports.length + processes.length > Math.max(budget, 0) && (processRows > 0 || portRows > 0)) {
    if (processRows > 0) {
      processRows -= 1;
      processes = formatProcessesSection(stats.processes, processRows);
    } else {
      portRows -= 1;
      ports = formatPortsSection(stats.ports, portRows);
    }
  }

  return truncateResponse([system, ports, processes].join('\n\n'));
}

class CommandManager {
  constructor(botManager, config, options = {}) {
    this.botManager = botManager;
    this.config = config;
    this.logger = options.logger || console;
    this.commandSchema = options.commandSchema || buildCommandSchema();
    this.statsProvider = options.statsProvider || new StatsProvider({ showHostname: config.statsShowHostname });
    this.statsCooldownMs = options.statsCooldownMs ?? DEFAULT_STATS_COOLDOWN_MS;
    this.statsCooldowns = new Map();
    this.sampleProcessCpuPercent = options.sampleProcessCpuPercent || sampleProcessCpuPercent;
    this.getCpuCount = options.getCpuCount || (() => os.cpus()?.length || 1);
    this.getTotalMemBytes = options.getTotalMemBytes || (() => os.totalmem());
    this.statusCpuSampleMs = options.statusCpuSampleMs ?? DEFAULT_STATUS_CPU_SAMPLE_MS;
    this.lastSync = null;
    this.boundInteractionHandler = (interaction) => {
      if (typeof interaction.isChatInputCommand === 'function' && !interaction.isChatInputCommand()) {
        return;
      }
      if (interaction.commandName !== ROOT_COMMAND) return;
      this.handleInteraction(interaction).catch((error) => {
        this.logError(error);
      });
    };
    this.client.on('interactionCreate', this.boundInteractionHandler);
  }

  get client() {
    return this.botManager.controller.client;
  }

  get voiceManager() {
    return this.botManager.controller.voiceManager;
  }

  getLocalCommands() {
    return this.commandSchema.map((command) => ({ ...command }));
  }

  isOwner(userId) {
    return Boolean(userId && this.config.ownerIds.includes(userId));
  }

  getScope() {
    return this.config.commandGuildId ? 'guild' : 'global';
  }

  async getRegistrationManager() {
    if (!this.config.commandGuildId) {
      if (!this.client.application?.commands) {
        throw new Error('Discord application command manager is not ready.');
      }
      return this.client.application.commands;
    }

    let guild = this.client.guilds?.cache?.get(this.config.commandGuildId);
    if (!guild && typeof this.client.guilds?.fetch === 'function') {
      guild = await this.client.guilds.fetch(this.config.commandGuildId);
    }
    if (!guild?.commands) {
      throw new CommandError('The configured command guild is not available to this bot.');
    }
    return guild.commands;
  }

  async fetchRemoteCommands() {
    const manager = await this.getRegistrationManager();
    if (typeof manager.fetch !== 'function') {
      throw new Error('Discord command manager does not support fetch().');
    }
    return valuesOf(await manager.fetch());
  }

  async getCommandStatus() {
    const remoteCommands = await this.fetchRemoteCommands();
    const localCommands = this.getLocalCommands();
    return {
      scope: this.getScope(),
      guildId: this.config.commandGuildId,
      localCount: localCommands.length,
      remoteCount: remoteCommands.length,
      inSync: commandSchemasEqual(localCommands, remoteCommands),
    };
  }

  async syncOnStartup() {
    return this.syncCommands();
  }

  async syncCommands({ force = false } = {}) {
    const manager = await this.getRegistrationManager();
    const localCommands = this.getLocalCommands();
    const remoteCommands = await this.fetchRemoteCommands();
    const inSync = commandSchemasEqual(localCommands, remoteCommands);

    if (!force && inSync) {
      const result = {
        scope: this.getScope(),
        guildId: this.config.commandGuildId,
        localCount: localCommands.length,
        remoteCount: remoteCommands.length,
        inSync: true,
        changed: false,
      };
      this.lastSync = result;
      return result;
    }

    if (typeof manager.set !== 'function') {
      throw new Error('Discord command manager does not support set().');
    }

    const registered = await manager.set(localCommands);
    const registeredCount = valuesOf(registered).length || localCommands.length;
    const result = {
      scope: this.getScope(),
      guildId: this.config.commandGuildId,
      localCount: localCommands.length,
      remoteCount: registeredCount,
      inSync: true,
      changed: true,
    };
    this.lastSync = result;
    return result;
  }

  async handleInteraction(interaction) {
    if (interaction.commandName !== ROOT_COMMAND) return;
    if (!this.isOwner(interaction.user?.id)) {
      return this.replyEphemeral(interaction, '❌ You are not authorized to control this bot.');
    }
    if (this.config.commandGuildId && interaction.guildId !== this.config.commandGuildId) {
      return this.replyEphemeral(interaction, '❌ This command is not available in this server.');
    }

    try {
      if (
        typeof interaction.deferReply === 'function' &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction.deferReply({ ephemeral: true });
      }
      const response = await this.dispatch(interaction);
      return this.finishReply(interaction, response);
    } catch (error) {
      this.logError(error);
      const message = error instanceof CommandError
        ? '❌ ' + error.userMessage
        : error instanceof BotManagerError
          ? '❌ ' + error.message
          : '❌ Command failed. Check the bot logs for details.';
      return this.finishReply(
        interaction,
        message
      );
    }
  }

  async dispatch(interaction) {
    const group =
      typeof interaction.options?.getSubcommandGroup === 'function'
        ? interaction.options.getSubcommandGroup(false)
        : null;
    const subcommand = interaction.options?.getSubcommand?.();

    if (group === 'voice') return this.dispatchVoice(interaction, subcommand);
    if (group === 'commands') return this.dispatchCommands(subcommand);
    if (group === 'bot') return this.dispatchBot(interaction, subcommand);

    if (subcommand === 'ping') {
      return 'Gateway ping: ' + gatewayPing(this.client) + '\nUptime: ' + formatDuration(process.uptime() * 1_000);
    }
    if (subcommand === 'status') return this.formatStatus();
    if (subcommand === 'diagnostics') return this.formatDiagnostics();
    if (subcommand === 'stats') return this.dispatchStats(interaction);

    throw new CommandError('Unknown /afk command.');
  }

  async dispatchStats(interaction) {
    const ownerId = interaction.user?.id;
    const now = Date.now();
    const lastRun = this.statsCooldowns.get(ownerId);
    if (lastRun !== undefined && now - lastRun < this.statsCooldownMs) {
      const remainingMs = this.statsCooldownMs - (now - lastRun);
      return '⏳ Please wait ' + Math.ceil(remainingMs / 1_000) + 's before running /afk stats again.';
    }
    this.statsCooldowns.set(ownerId, now);

    let stats;
    try {
      stats = await this.statsProvider.collect();
    } catch (error) {
      this.logError(error);
      throw new CommandError('Failed to collect host statistics.');
    }
    return formatStats(stats);
  }

  async dispatchVoice(interaction, subcommand) {
    const slot = interaction.options.getInteger?.('bot', false) ?? CONTROLLER_SLOT;

    if (subcommand === 'join') {
      if (!interaction.guildId) {
        throw new CommandError('Voice commands must be used inside a server.');
      }
      const channel = interaction.options.getChannel('channel', true);
      if (
        !channel ||
        typeof channel.isVoiceBased !== 'function' ||
        !channel.isVoiceBased() ||
        (channel.guildId && channel.guildId !== interaction.guildId)
      ) {
        throw new CommandError('Please choose a voice channel from this server.');
      }
      const voiceManager = this.botManager.resolveVoiceManager(slot);
      const status = await voiceManager.join(interaction.guildId, channel.id);
      return '✅ Bot ' + slot + ' voice target set to ' + (channel.name || channel.id) + '. State: ' + status.state + '.';
    }

    if (subcommand === 'leave') {
      const voiceManager = this.botManager.resolveVoiceManager(slot);
      await voiceManager.leave();
      return '✅ Bot ' + slot + ' voice target cleared and connection stopped.';
    }

    if (subcommand === 'reconnect') {
      const voiceManager = this.botManager.resolveVoiceManager(slot);
      const status = await voiceManager.reconnect();
      return '✅ Bot ' + slot + ' reconnect requested. State: ' + status.state + '.';
    }

    if (subcommand === 'status') {
      const voiceManager = this.botManager.resolveVoiceManager(slot);
      return formatVoiceStatus(voiceManager.status());
    }

    if (subcommand === 'members') {
      const voiceManager = this.botManager.resolveVoiceManager(slot);
      const status = voiceManager.status();
      if (!status.channelId) throw new CommandError('Bot ' + slot + ' has no current voice target.');
      return formatMembers(voiceManager.channelMembers(status.channelId));
    }

    throw new CommandError('Unknown voice subcommand.');
  }

  async dispatchBot(interaction, subcommand) {
    if (subcommand === 'list') return this.formatBotList();

    const slot = interaction.options.getInteger('bot', true);

    if (subcommand === 'start') {
      const result = await this.botManager.startWorker(slot);
      if (result.alreadyRunning) return 'ℹ️ Bot ' + slot + ' is already running.';
      if (result.failed) return '❌ Bot ' + slot + ' failed to start: ' + result.record.error;
      return '✅ Bot ' + slot + ' started.';
    }

    if (subcommand === 'stop') {
      await this.botManager.stopWorker(slot);
      return '✅ Bot ' + slot + ' stopped. Saved voice target preserved.';
    }

    if (subcommand === 'restart') {
      const result = await this.botManager.restartWorker(slot);
      if (result.failed) return '❌ Bot ' + slot + ' restart failed: ' + result.record.error;
      return '✅ Bot ' + slot + ' restarted.';
    }

    throw new CommandError('Unknown bot subcommand.');
  }

  async dispatchCommands(subcommand) {
    if (subcommand === 'sync') {
      const result = await this.syncCommands({ force: true });
      return [
        '✅ Slash commands synchronized.',
        'Scope: ' + result.scope,
        'Registered: ' + result.remoteCount,
      ].join('\n');
    }

    if (subcommand === 'status') {
      const result = await this.getCommandStatus();
      return [
        'Command scope: ' + result.scope,
        'Target guild: ' + (result.guildId || 'global'),
        'Local commands: ' + result.localCount,
        'Remote commands: ' + result.remoteCount,
        'In sync: ' + (result.inSync ? 'yes' : 'no'),
      ].join('\n');
    }

    throw new CommandError('Unknown commands subcommand.');
  }

  /** /afk status — the complete LocalAFK process + five-bot-slot status. Never VPS-wide. */
  async formatStatus() {
    const cpuCount = this.getCpuCount();
    const cpuPercent = await this.sampleProcessCpuPercent({ cpuCount, sampleMs: this.statusCpuSampleMs });
    const memory = process.memoryUsage();
    const totalMemBytes = this.getTotalMemBytes();
    const ramPercent = totalMemBytes ? (memory.rss / totalMemBytes) * 100 : null;

    let configuredCount = 0;
    let onlineCount = 0;
    let voiceConnectedCount = 0;
    for (const slot of ALL_SLOTS) {
      const record = this.botManager.get(slot);
      if (record.configured) configuredCount += 1;
      if (record.status === STATUS.ONLINE) {
        onlineCount += 1;
        if (record.voiceManager?.status()?.connected) voiceConnectedCount += 1;
      }
    }

    const header = [
      '**LOCALAFK**',
      'PID: ' + process.pid,
      'Process CPU: ' + (cpuPercent === null ? 'n/a' : cpuPercent.toFixed(1) + '%') + ' (of total VPS capacity)',
      'RSS: ' + formatBytes(memory.rss) + (ramPercent === null ? '' : ' (' + ramPercent.toFixed(1) + '% of VPS RAM)'),
      'Heap used: ' + formatBytes(memory.heapUsed),
      'Uptime: ' + formatDuration(process.uptime() * 1_000),
      'Bots: ' + configuredCount + ' configured • ' + onlineCount + ' online',
      'Voice connected: ' + voiceConnectedCount,
    ].join('\n');

    const disclaimer = 'Per-bot CPU/RAM: shared single-process runtime; exact attribution is unavailable by design.';
    const botsHeader = ['**BOTS**', disclaimer, ''].join('\n');

    let botsSection = this._formatBotStatusLines(false);
    let full = [header, botsHeader + botsSection].join('\n\n');
    if (full.length > MAX_RESPONSE_LENGTH) {
      botsSection = this._formatBotStatusLines(true);
      full = [header, botsHeader + botsSection].join('\n\n');
    }
    return truncateResponse(full);
  }

  _formatBotStatusLines(compact) {
    const lines = [];
    for (const slot of ALL_SLOTS) {
      const record = this.botManager.get(slot);
      const role = slot === CONTROLLER_SLOT ? 'Controller' : 'Worker';

      if (!record.configured) {
        lines.push(slot + ' • ' + role + ' — UNCONFIGURED');
        continue;
      }
      if (record.status === STATUS.STOPPED) {
        lines.push(slot + ' • ' + role + ' — STOPPED');
        continue;
      }
      if (record.status === STATUS.STARTING) {
        lines.push(slot + ' • ' + role + ' — STARTING');
        continue;
      }
      if (record.status === STATUS.FAILED) {
        lines.push(slot + ' • ' + role + ' — FAILED (' + (record.error || 'unknown') + ')');
        continue;
      }

      const tag = record.client?.user?.tag || record.client?.user?.username || 'unknown';
      const voice = record.voiceManager?.status();
      const desc = voiceDescription(voice);
      const uptime = record.loggedInAt ? formatDuration(Date.now() - record.loggedInAt) : 'n/a';
      const guildCount = record.client?.guilds?.cache?.size ?? 0;

      if (compact) {
        lines.push(
          slot + ' • ' + role + ' — ONLINE (' + tag + ') • Voice: ' + desc + ' • Ping: ' + gatewayPing(record.client)
        );
      } else {
        lines.push(slot + ' • ' + role + ' — ONLINE (' + tag + ')');
        lines.push('  Uptime: ' + uptime + ' • Ping: ' + gatewayPing(record.client) + ' • Guilds: ' + guildCount);
        lines.push('  Voice: ' + desc);
      }
    }
    return lines.join('\n');
  }

  /** /afk bot list — compact per-slot overview, does not require live login for stopped slots. */
  async formatBotList() {
    const lines = [];
    let online = 0;
    for (const slot of ALL_SLOTS) {
      if (this.botManager.get(slot).status === STATUS.ONLINE) online += 1;
    }
    lines.push('**BOTS — ' + online + '/5 ONLINE**');
    lines.push('');

    for (const slot of ALL_SLOTS) {
      const record = this.botManager.get(slot);
      if (!record.configured) {
        lines.push(slot + ' • unconfigured');
        lines.push('');
        continue;
      }

      if (record.status === STATUS.ONLINE) {
        const name = record.client?.user?.tag || record.client?.user?.username || 'online';
        const voice = record.voiceManager?.status();
        lines.push(slot + ' • ' + name);
        lines.push('ONLINE • Voice: ' + voiceDescription(voice) + ' • Ping: ' + gatewayPing(record.client));
      } else if (record.status === STATUS.STARTING) {
        lines.push(slot + ' • configured');
        lines.push('STARTING');
      } else if (record.status === STATUS.FAILED) {
        lines.push(slot + ' • configured');
        lines.push('FAILED • ' + (record.error || 'login failed'));
      } else {
        const saved = await record.stateStore.get('desiredVoice');
        const target = saved?.channelId ? this._resolveChannelLabel(saved) : 'none';
        lines.push(slot + ' • configured');
        lines.push('STOPPED • Saved target: ' + target);
      }
      lines.push('');
    }

    return truncateResponse(lines.join('\n').trimEnd());
  }

  /** Best-effort channel name lookup via the Controller's cache; falls back to the raw ID. */
  _resolveChannelLabel(saved) {
    const controllerClient = this.botManager.controller.client;
    const guild = controllerClient?.guilds?.cache?.get(saved.guildId);
    const channel = guild?.channels?.cache?.get(saved.channelId);
    return channel?.name || saved.channelId;
  }

  async formatDiagnostics() {
    const memory = process.memoryUsage();
    const voice = this.voiceManager.status();
    const commandStatus = await this.getCommandStatus();
    return [
      'Node: ' + process.version,
      'Uptime: ' + formatDuration(process.uptime() * 1_000),
      'RSS: ' + formatBytes(memory.rss),
      'Heap used: ' + formatBytes(memory.heapUsed),
      'Gateway ping: ' + gatewayPing(this.client),
      'Guilds: ' + (this.client.guilds?.cache?.size || 0),
      'Voice: ' + (voice.state || 'idle'),
      'Voice target: ' + (voice.channelName || voice.channelId || 'none'),
      'Reconnect pending: ' + (voice.reconnectPending ? 'yes' : 'no'),
      'Command scope: ' + commandStatus.scope,
      'Commands in sync: ' + (commandStatus.inSync ? 'yes' : 'no'),
    ].join('\n');
  }

  async replyEphemeral(interaction, content) {
    const payload = { content: truncateResponse(content), ephemeral: true };
    if (interaction.deferred && typeof interaction.editReply === 'function') {
      return interaction.editReply({ content: payload.content });
    }
    if (interaction.replied && typeof interaction.followUp === 'function') {
      return interaction.followUp(payload);
    }
    return interaction.reply(payload);
  }

  async finishReply(interaction, content) {
    return this.replyEphemeral(interaction, content);
  }

  logError(error) {
    const message = error?.stack || error?.message || String(error);
    if (typeof this.logger.error === 'function') {
      this.logger.error('[commands] ' + message);
    } else {
      console.error('[commands] ' + message);
    }
  }
}

module.exports = {
  CommandError,
  CommandManager,
  buildCommandSchema,
  commandSchemasEqual,
  formatDuration,
  formatMembers,
  formatStats,
  formatPortsSection,
  formatProcessesSection,
  normalizeCommand,
  normalizeCommands,
};
