const path = require('node:path');
const config = require('./config');
const { createClient } = require('./discord/client');
const { VoiceManager } = require('./discord/voiceManager');
const { StateStore } = require('./store/stateStore');
const { createServer } = require('./web/server');

async function main() {
  const stateStore = new StateStore(path.join(config.dataDir, 'state.json'));
  const client = createClient();
  const voiceManager = new VoiceManager(client, stateStore);

  const { httpServer, io } = createServer(client, voiceManager);

  client.once('clientReady', async () => {
    console.log(`[discord] Logged in as ${client.user.tag}`);
    await voiceManager.restoreFromState();
  });

  client.on('error', (err) => console.error('[discord] client error:', err));

  await client.login(config.botToken);

  httpServer.listen(config.port, config.host, () => {
    console.log(`[web] Dashboard listening on http://${config.host}:${config.port}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
    try {
      await voiceManager.shutdown();
      io.close();
      await new Promise((resolve) => httpServer.close(resolve));
      await client.destroy();
      console.log('[shutdown] Clean exit.');
      process.exit(0);
    } catch (err) {
      console.error('[shutdown] Error during shutdown:', err);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
