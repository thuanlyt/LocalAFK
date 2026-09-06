const { once } = require('node:events');
const path = require('node:path');
const { createConfig } = require('./config');
const { createClient } = require('./discord/client');
const { CommandManager } = require('./discord/commandManager');
const { VoiceManager } = require('./discord/voiceManager');
const { StateStore } = require('./store/stateStore');

async function main() {
  const config = createConfig();
  const stateStore = new StateStore(path.join(config.dataDir, 'state.json'));
  const client = createClient();
  const voiceManager = new VoiceManager(client, stateStore);
  const commandManager = new CommandManager(client, voiceManager, config);

  let shuttingDown = false;

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[shutdown] Received ' + signal + ', shutting down gracefully...');
    try {
      await voiceManager.shutdown();
      client.destroy();
      console.log('[shutdown] Clean exit.');
    } catch (error) {
      console.error('[shutdown] Error during shutdown:', error);
      exitCode = 1;
    }
    if (exitCode !== null) process.exit(exitCode);
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      console.error('[shutdown] Unhandled shutdown error:', error);
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      console.error('[shutdown] Unhandled shutdown error:', error);
      process.exit(1);
    });
  });

  client.on('error', (error) => console.error('[discord] client error:', error));

  try {
    const ready = once(client, 'clientReady');
    await client.login(config.botToken);
    await ready;

    console.log('[discord] Logged in as ' + client.user.tag);
    const sync = await commandManager.syncOnStartup();
    console.log(
      '[commands] ' +
        (sync.changed ? 'Synchronized' : 'Already synchronized') +
        ' ' +
        sync.localCount +
        ' command(s) (' +
        sync.scope +
        ').'
    );
    await voiceManager.restoreFromState();
    console.log('[discord] LocalAFK is ready.');
  } catch (error) {
    console.error('[startup] Fatal startup error:', error);
    await shutdown('startup failure', 1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[startup] Fatal startup error:', error);
    process.exit(1);
  });
}

module.exports = { main };
