const express = require('express');
const chat = require('../discord/chat');

function createApiRouter(client, voiceManager) {
  const router = express.Router();
  router.use(express.json());

  router.get('/me', (req, res) => {
    res.json({
      user: req.session.user,
      bot: client.user
        ? { id: client.user.id, username: client.user.username, avatar: client.user.displayAvatarURL({ size: 64 }) }
        : null,
    });
  });

  router.get('/guilds', (req, res) => {
    res.json(chat.listGuilds(client));
  });

  router.get('/guilds/:guildId/channels', (req, res) => {
    const channels = chat.listChannels(client, req.params.guildId);
    if (!channels) return res.status(404).json({ error: 'guild_not_found' });
    res.json(channels);
  });

  router.get('/channels/:channelId/messages', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
      const messages = await chat.fetchRecentMessages(client, req.params.channelId, limit);
      res.json(messages);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/channels/:channelId/messages', async (req, res) => {
    try {
      const content = (req.body?.content || '').trim();
      if (!content) return res.status(400).json({ error: 'empty_message' });
      if (content.length > 2000) return res.status(400).json({ error: 'message_too_long' });
      const message = await chat.sendMessage(client, req.params.channelId, content);
      res.json(message);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/voice/status', (req, res) => {
    res.json(voiceManager.status());
  });

  router.post('/voice/join', async (req, res) => {
    try {
      const { guildId, channelId } = req.body || {};
      if (!guildId || !channelId) return res.status(400).json({ error: 'missing_guild_or_channel' });
      const status = await voiceManager.join(guildId, channelId);
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/voice/leave', async (req, res) => {
    const status = await voiceManager.leave();
    res.json(status);
  });

  router.get('/voice/channel-members/:channelId', (req, res) => {
    res.json(voiceManager.channelMembers(req.params.channelId));
  });

  return router;
}

module.exports = { createApiRouter };
