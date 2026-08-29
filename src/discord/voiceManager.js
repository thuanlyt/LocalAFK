const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { EventEmitter } = require('node:events');
const { SilenceStream } = require('./silenceStream');

const BASE_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

class VoiceManager extends EventEmitter {
  constructor(client, stateStore) {
    super();
    this.client = client;
    this.stateStore = stateStore;
    this.connection = null;
    this.player = null;
    this.desired = null; // { guildId, channelId }
    this.connectedAt = null;
    this.reconnectTimer = null;
    this.reconnectDelay = BASE_RECONNECT_DELAY_MS;
  }

  status() {
    const guild = this.desired ? this.client.guilds.cache.get(this.desired.guildId) : null;
    const channel = guild && this.desired ? guild.channels.cache.get(this.desired.channelId) : null;
    return {
      connected: Boolean(this.connection && this.connection.state.status === VoiceConnectionStatus.Ready),
      guildId: this.desired?.guildId ?? null,
      channelId: this.desired?.channelId ?? null,
      guildName: guild?.name ?? null,
      channelName: channel?.name ?? null,
      connectedAt: this.connectedAt,
    };
  }

  async join(guildId, channelId) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Bot không có mặt trong server này.');
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) throw new Error('Không tìm thấy kênh voice này.');

    this.reconnectDelay = BASE_RECONNECT_DELAY_MS;
    this.desired = { guildId, channelId };
    await this.stateStore.set('desiredVoice', this.desired);
    this._connect();
    return this.status();
  }

  async leave() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.desired = null;
    this.connectedAt = null;
    await this.stateStore.set('desiredVoice', null);
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    const status = this.status();
    this.emit('status', status);
    return status;
  }

  async restoreFromState() {
    const saved = await this.stateStore.get('desiredVoice');
    if (saved?.guildId && saved?.channelId) {
      this.desired = saved;
      this._connect();
      this.emit('log', `Đang khôi phục kết nối voice trước đó: ${saved.channelId}`);
    }
  }

  _connect() {
    if (!this.desired) return;
    const { guildId, channelId } = this.desired;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      this.emit('log', `Không thể vào voice: bot không còn trong guild ${guildId}`);
      return;
    }

    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        /* already destroyed */
      }
    }

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection = connection;

    this.player = createAudioPlayer();
    const resource = createAudioResource(new SilenceStream(), { inputType: StreamType.Opus });
    this.player.play(resource);
    connection.subscribe(this.player);
    this.player.on('error', (err) => this.emit('log', `Voice player error: ${err.message}`));

    connection.on(VoiceConnectionStatus.Ready, () => {
      this.connectedAt = Date.now();
      this.reconnectDelay = BASE_RECONNECT_DELAY_MS;
      this.emit('log', `Đã kết nối voice: ${channelId}`);
      this.emit('status', this.status());
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Temporary blip (e.g. Discord moving/reconnecting us) — it will recover on its own.
      } catch {
        connection.destroy();
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.connection === connection) {
        this.connection = null;
        this.connectedAt = null;
      }
      this.emit('status', this.status());
      if (this.desired) {
        this.emit('log', `Mất kết nối voice, thử kết nối lại sau ${this.reconnectDelay / 1000}s...`);
        this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    });

    connection.on('error', (err) => this.emit('log', `Voice connection error: ${err.message}`));
  }

  channelMembers(channelId) {
    for (const guild of this.client.guilds.cache.values()) {
      const channel = guild.channels.cache.get(channelId);
      if (channel && channel.isVoiceBased()) {
        return [...channel.members.values()].map((m) => ({
          id: m.id,
          username: m.user.username,
          avatar: m.user.displayAvatarURL({ size: 64 }),
          bot: m.user.bot,
        }));
      }
    }
    return [];
  }
}

module.exports = { VoiceManager };
