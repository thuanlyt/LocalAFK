require('dotenv').config();
const path = require('node:path');

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '127.0.0.1',
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data'),
  botToken: process.env.BOT_TOKEN || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  oauth: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || '',
  },
  ownerIds: list(process.env.OWNER_DISCORD_IDS),
};

config.oauthEnabled = Boolean(
  config.oauth.clientId && config.oauth.clientSecret && config.oauth.redirectUri && config.ownerIds.length
);
config.passwordEnabled = Boolean(config.dashboardPassword);

if (!config.botToken) {
  console.error('[config] Missing BOT_TOKEN in .env — cannot start.');
  process.exit(1);
}

if (!config.sessionSecret) {
  console.error('[config] Missing SESSION_SECRET in .env — cannot start.');
  process.exit(1);
}

if (!config.oauthEnabled && !config.passwordEnabled) {
  console.error(
    '[config] No login method configured. Set DASHBOARD_PASSWORD, or DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET/DISCORD_REDIRECT_URI + OWNER_DISCORD_IDS in .env.'
  );
  process.exit(1);
}

module.exports = config;
