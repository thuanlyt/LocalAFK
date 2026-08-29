const path = require('node:path');
const config = require('./config');
const { createClient } = require('./discord/client');
const { VoiceManager } = require('./discord/voiceManager');
const { StateStore } = require('./store/stateStore');
const { createServer } = require('./web/server');

async function main() {
  const stateStore = new StateStore(path.join(__dirname, '..', 'data', 'state.json'));
  const client = createClient();
  const voiceManager = new VoiceManager(client, stateStore);

  const { httpServer } = createServer(client, voiceManager);

  client.once('clientReady', async () => {
    console.log(`[discord] Logged in as ${client.user.tag}`);
    await voiceManager.restoreFromState();
  });

  client.on('error', (err) => console.error('[discord] client error:', err));

  await client.login(config.botToken);

  httpServer.listen(config.port, () => {
    console.log(`[web] Dashboard listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
