const path = require('node:path');

const BOT_SLOTS = [1, 2, 3, 4, 5];

function list(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenEnvKey(slot) {
  return slot === 1 ? 'BOT_TOKEN' : 'TOKEN_' + slot;
}

function readTokens(env) {
  const tokens = {};
  for (const slot of BOT_SLOTS) {
    tokens[slot] = (env[tokenEnvKey(slot)] || '').trim();
  }
  return tokens;
}

/** Throws (without ever including a token value) if two slots share the same token. */
function assertNoDuplicateTokens(tokens) {
  const seenBySlot = new Map();
  for (const slot of BOT_SLOTS) {
    const token = tokens[slot];
    if (!token) continue;
    for (const [otherSlot, otherToken] of seenBySlot) {
      if (otherToken === token) {
        throw new Error(
          '[config] Duplicate bot token configured for slots ' + otherSlot + ' and ' + slot + '.'
        );
      }
    }
    seenBySlot.set(slot, token);
  }
}

function createConfig(env = process.env) {
  const tokens = readTokens(env);
  assertNoDuplicateTokens(tokens);

  const config = {
    botToken: tokens[1],
    tokens,
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

module.exports = { createConfig, list, BOT_SLOTS };
