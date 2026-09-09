const {
  ChannelType,
  SlashCommandBuilder,
} = require('discord.js');
const { StatsProvider } = require('../system/statsProvider');

const ROOT_COMMAND = 'afk';
const MAX_RESPONSE_LENGTH = 1_900;
const DEFAULT_STATS_COOLDOWN_MS = 5_000;
const DEFAULT_PORT_ROWS = 15;
const DEFAULT_PROCESS_ROWS = 10;

class CommandError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.name = 'CommandError';
    this.userMessage = userMessage;
  }
}

function buildCommandSchema() {
  return [new SlashCommandBuilder()
    .setName(ROOT_COMMAND)
    .setDescription('Control the LocalAFK Discord bot')
    .addSubcommandGroup((group) =>
      group
        .setName('voice')
        .setDescription('Manage the persistent voice connection')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('join')
            .setDescription('Join and persist a voice channel')
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Voice channel to join')
                .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
                .setRequired(true)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('leave').setDescription('Leave voice and clear the saved target')
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('reconnect').setDescription('Reconnect to the saved voice target')
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('status').setDescription('Show voice connection status')
        )
        .addSubcommand((subcommand) =>
          subcommand.setName('members').setDescription('List members in the current voice channel')
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
    .addSubcommand((subcommand) =>
      subcommand.setName('ping').setDescription('Show gateway latency and process uptime')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('Show compact bot and voice status')
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('diagnostics').setDescription('Show a safe operational diagnostics snapshot')
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
  const ping = Number(client.ws?.ping);
  return Number.isFinite(ping) && ping >= 0 ? ping + ' ms' : 'unavailable';
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
  lines.push('Node: ' + system.nodeVersion);
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

function formatLocalafkSection(localafk) {
  const voice = localafk.voice || {};
  const voiceTarget = voice.channelId
    ? (voice.guildName || voice.guildId || 'unknown guild') + ' / ' + (voice.channelName || voice.channelId)
    : 'none';
  return [
    '**LOCALAFK**',
    'PID: ' + localafk.pid,
    'RSS: ' + formatBytes(localafk.memory.rss),
    'Heap used: ' + formatBytes(localafk.memory.heapUsed),
    'Process uptime: ' + formatDuration(localafk.uptimeSeconds * 1_000),
    'Gateway ping: ' + localafk.gatewayPing,
    'Voice: ' + (voice.state || 'idle') + ' (' + voiceTarget + ')',
  ].join('\n');
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
    lines.push('PROTO  BIND             PORT   STATE   PROCESS');
    for (const entry of shown) {
      lines.push(
        padRight(entry.protocol, 7) +
          padRight(entry.localAddress, 17) +
          padRight(entry.port, 7) +
          padRight(entry.state, 8) +
          entry.process
      );
    }
    lines.push('```');
  }
  const remaining = ports.entries.length - shown.length + ports.truncatedCount;
  if (remaining > 0) lines.push('… and ' + remaining + ' more.');
  if (ports.establishedCount !== null && ports.establishedCount !== undefined) {
    lines.push('Established connections: ' + ports.establishedCount);
  }
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
 * Renders the full /afk stats response within MAX_RESPONSE_LENGTH. Priority order when the
 * content doesn't fit: system summary, then LocalAFK, then listening ports, then top
 * processes — so rows are trimmed from processes first, then ports, never silently
 * mid-cutting a section.
 */
function formatStats(stats, localafk) {
  const system = formatSystemSection(stats.system);
  const localafkSection = formatLocalafkSection(localafk);
  const fixedLength = system.length + localafkSection.length + 16;

  let portRows = Math.min(stats.ports.entries.length, DEFAULT_PORT_ROWS);
  let processRows = Math.min(stats.processes.entries.length, DEFAULT_PROCESS_ROWS);
  let ports = formatPortsSection(stats.ports, portRows);
  let processes = formatProcessesSection(stats.processes, processRows);

  const budget = MAX_RESPONSE_LENGTH - fixedLength - 16;
  while (ports.length + processes.length > Math.max(budget, 0) && (processRows > 0 || portRows > 0)) {
    if (processRows > 0) {
      processRows -= 1;
      processes = formatProcessesSection(stats.processes, processRows);
    } else {
      portRows -= 1;
      ports = formatPortsSection(stats.ports, portRows);
    }
  }

  return truncateResponse([system, localafkSection, ports, processes].join('\n\n'));
}

class CommandManager {
  constructor(client, voiceManager, config, options = {}) {
    this.client = client;
    this.voiceManager = voiceManager;
    this.config = config;
    this.logger = options.logger || console;
    this.commandSchema = options.commandSchema || buildCommandSchema();
    this.statsProvider = options.statsProvider || new StatsProvider({ showHostname: config.statsShowHostname });
    this.statsCooldownMs = options.statsCooldownMs ?? DEFAULT_STATS_COOLDOWN_MS;
    this.statsCooldowns = new Map();
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

    if (subcommand === 'ping') {
      return 'Gateway ping: ' + gatewayPing(this.client) + '\nUptime: ' + formatDuration(process.uptime() * 1_000);
    }
    if (subcommand === 'status') return this.formatOverallStatus();
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

    const voice = this.voiceManager.status();
    const localafk = {
      pid: process.pid,
      memory: process.memoryUsage(),
      uptimeSeconds: process.uptime(),
      gatewayPing: gatewayPing(this.client),
      voice,
    };
    return formatStats(stats, localafk);
  }

  async dispatchVoice(interaction, subcommand) {
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
      const status = await this.voiceManager.join(interaction.guildId, channel.id);
      return '✅ Voice target set to ' + (channel.name || channel.id) + '. State: ' + status.state + '.';
    }

    if (subcommand === 'leave') {
      await this.voiceManager.leave();
      return '✅ Voice target cleared and connection stopped.';
    }

    if (subcommand === 'reconnect') {
      const status = await this.voiceManager.reconnect();
      return '✅ Reconnect requested. State: ' + status.state + '.';
    }

    if (subcommand === 'status') {
      return formatVoiceStatus(this.voiceManager.status());
    }

    if (subcommand === 'members') {
      const status = this.voiceManager.status();
      if (!status.channelId) throw new CommandError('The bot has no current voice target.');
      return formatMembers(this.voiceManager.channelMembers(status.channelId));
    }

    throw new CommandError('Unknown voice subcommand.');
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

  formatOverallStatus() {
    const voice = this.voiceManager.status();
    const online =
      typeof this.client.isReady === 'function' ? this.client.isReady() : Boolean(this.client.user);
    return [
      'Bot: ' + (online ? 'online' : 'offline'),
      'Uptime: ' + formatDuration(process.uptime() * 1_000),
      'Gateway ping: ' + gatewayPing(this.client),
      'Voice: ' + (voice.state || 'idle'),
      'Target: ' + (voice.channelName || voice.channelId || 'none'),
      'Command scope: ' + this.getScope(),
    ].join('\n');
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
