const { ChannelType } = require('discord.js');

function serializeMessage(message) {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    author: {
      id: message.author.id,
      username: message.author.username,
      avatar: message.author.displayAvatarURL({ size: 64 }),
      bot: message.author.bot,
    },
    content: message.content,
    timestamp: message.createdTimestamp,
    attachments: [...message.attachments.values()].map((a) => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType,
    })),
  };
}

function listGuilds(client) {
  return [...client.guilds.cache.values()].map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.iconURL({ size: 64 }),
    memberCount: g.memberCount,
  }));
}

function listChannels(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const channels = [...guild.channels.cache.values()].sort((a, b) => a.rawPosition - b.rawPosition);
  return {
    text: channels
      .filter((c) => c.type === ChannelType.GuildText)
      .map((c) => ({ id: c.id, name: c.name })),
    voice: channels
      .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
      .map((c) => ({ id: c.id, name: c.name, memberCount: c.members.size })),
  };
}

async function fetchRecentMessages(client, channelId, limit = 50) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) throw new Error('Không tìm thấy kênh chat này.');
  const messages = await channel.messages.fetch({ limit });
  return [...messages.values()].reverse().map(serializeMessage);
}

async function sendMessage(client, channelId, content) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) throw new Error('Không tìm thấy kênh chat này.');
  const message = await channel.send(content);
  return serializeMessage(message);
}

module.exports = { serializeMessage, listGuilds, listChannels, fetchRecentMessages, sendMessage };
