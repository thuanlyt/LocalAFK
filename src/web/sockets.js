function initSockets(io, sessionMiddleware, client, voiceManager) {
  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    const session = socket.request.session;
    if (session?.user) return next();
    next(new Error('unauthenticated'));
  });

  io.on('connection', (socket) => {
    socket.emit('voice:status', voiceManager.status());
  });

  client.on('messageCreate', (message) => {
    if (!message.guildId) return;
    io.emit('message:new', require('../discord/chat').serializeMessage(message));
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    const status = voiceManager.status();
    if (!status.channelId) return;
    const touchedChannel = [oldState.channelId, newState.channelId].includes(status.channelId);
    if (touchedChannel) {
      io.emit('voice:members', {
        channelId: status.channelId,
        members: voiceManager.channelMembers(status.channelId),
      });
    }
  });

  voiceManager.on('status', (status) => io.emit('voice:status', status));
  voiceManager.on('log', (line) => io.emit('log', line));
}

module.exports = { initSockets };
