const { createConfig } = require('./config');
const { CommandManager } = require('./discord/commandManager');
const { BotManager } = require('./discord/botManager');

async function main() {
  const config = createConfig();
  const botManager = new BotManager(config);

  // Controller runtime is created (but not logged in) before CommandManager so its
  // interactionCreate listener is attached before the client ever connects.
  botManager.createControllerRuntime();
  const commandManager = new CommandManager(botManager, config);

  let shuttingDown = false;

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[shutdown] Received ' + signal + ', shutting down gracefully...');
    try {
      await botManager.shutdown();
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

  botManager.controller.client.on('error', (error) => console.error('[discord] client error:', error));

  try {
    await botManager.loginController();
    console.log('[discord] Logged in as ' + botManager.controller.client.user.tag);

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
    await botManager.restoreControllerVoice();

    await botManager.startConfiguredWorkers();

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
