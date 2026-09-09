const path = require('node:path');

function list(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function createConfig(env = process.env) {
  const config = {
    botToken: (env.BOT_TOKEN || '').trim(),
    ownerIds: list(env.OWNER_DISCORD_IDS),
    commandGuildId: (env.COMMAND_GUILD_ID || '').trim() || null,
    dataDir: path.resolve(
      env.DATA_DIR?.trim() || path.join(__dirname, '..', 'data')
    ),
    // Hostname can reveal an owner-chosen, potentially identifying name. Off by default;
    // the owner can opt in once they've confirmed their own host's hostname isn't sensitive.
    statsShowHostname: env.STATS_SHOW_HOSTNAME === 'true',
  };

  const missing = [];
  if (!config.botToken) missing.push('BOT_TOKEN');
  if (!config.ownerIds.length) missing.push('OWNER_DISCORD_IDS');

  if (missing.length) {
    throw new Error('[config] Missing required environment variable(s): ' + missing.join(', '));
  }

  return config;
}

module.exports = { createConfig, list };
