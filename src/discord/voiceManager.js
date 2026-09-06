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

const DEFAULT_BASE_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;

const defaultVoiceDeps = { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState };

/**
 * Lifecycle model: every call to `_connect()` bumps `this.generation` and closes every
 * listener it registers over that new number. A listener only acts if its captured
 * generation still matches `this.generation` at the time it fires — so once a connection
 * is superseded (channel switch, explicit leave, shutdown), every event still in flight
 * from it becomes a no-op, and it can never schedule a reconnect or mutate state for
 * whatever replaced it. This holds regardless of whether @discordjs/voice emits its
 * state-change events synchronously or on a later tick.
 */
class VoiceManager extends EventEmitter {
  constructor(client, stateStore, options = {}) {
    super();
    this.client = client;
    this.stateStore = stateStore;
    this.voice = options.voiceDeps || defaultVoiceDeps;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;

    this.connection = null;
    this.player = null;
    this.desired = null; // { guildId, channelId }
    this.connectedAt = null;
    this.reconnectTimer = null;
    this.reconnectDelay = this.baseReconnectDelayMs;
    this.generation = 0;
    this.shuttingDown = false;
  }

  status() {
    const guild = this.desired ? this.client.guilds.cache.get(this.desired.guildId) : null;
    const channel = guild && this.desired ? guild.channels.cache.get(this.desired.channelId) : null;
    const connected = Boolean(this.connection && this.connection.state.status === VoiceConnectionStatus.Ready);
    const reconnectPending = Boolean(this.reconnectTimer);
    return {
      connected,
      state: connected
        ? 'connected'
        : reconnectPending
          ? 'reconnecting'
          : this.desired
            ? 'disconnected'
            : 'idle',
      reconnectPending,
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

    this.reconnectDelay = this.baseReconnectDelayMs;
    this.desired = { guildId, channelId };
    await this.stateStore.set('desiredVoice', this.desired);
    this._connect();
    return this.status();
  }

  /** Owner-initiated leave: clears the desired target and persisted state, never reconnects. */
  async leave() {
    this._cancelReconnect();
    this.desired = null;
    this.connectedAt = null;
    await this.stateStore.set('desiredVoice', null);
    this._disposeConnection();
    const status = this.status();
    this.emit('status', status);
    return status;
  }

  /** Owner-initiated reconnect: preserve the desired target and persisted state. */
  async reconnect() {
    if (!this.desired) throw new Error('Chưa có voice target để kết nối lại.');
    if (this.shuttingDown) throw new Error('Voice manager đang tắt.');
    this.reconnectDelay = this.baseReconnectDelayMs;
    this._cancelReconnect();
    this._connect();
    return this.status();
  }

  /**
   * Process-lifecycle shutdown. Unlike leave(), this deliberately preserves the persisted
   * `desiredVoice` so a restart can restore it via restoreFromState(). It just tears down
   * the live connection/player and makes sure nothing tries to reconnect afterwards.
   */
  async shutdown() {
    this.shuttingDown = true;
    this._cancelReconnect();
    this._disposeConnection();
  }

  async restoreFromState() {
    const saved = await this.stateStore.get('desiredVoice');
    if (saved?.guildId && saved?.channelId) {
      this.desired = saved;
      this._connect();
      this.emit('log', `Đang khôi phục kết nối voice trước đó: ${saved.channelId}`);
    }
  }

  _cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Bumps the generation (invalidating any in-flight events from the old connection) and tears it down. */
  _disposeConnection() {
    this.generation += 1;
    if (this.player) {
      try {
        this.player.stop(true);
      } catch {
        /* already stopped */
      }
      this.player = null;
    }
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        /* already destroyed */
      }
      this.connection = null;
    }
    this.connectedAt = null;
  }

  /**
   * Re-validates `this.desired` against live guild/channel state. Used for reconnect and
   * restore paths (unlike join(), which is called with fresh user input and validates
   * before this method is ever reached) since the bot may have been removed from the
   * guild, or the channel deleted/changed type, while disconnected.
   */
  _validateTarget() {
    if (!this.desired) return null;
    const { guildId, channelId } = this.desired;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      this.emit('log', `Không thể vào voice: bot không còn trong guild ${guildId}. Dừng thử lại.`);
      return null;
    }
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) {
      this.emit('log', `Không thể vào voice: kênh ${channelId} không còn tồn tại hoặc không phải kênh voice. Dừng thử lại.`);
      return null;
    }
    return { guild, channel };
  }

  _connect() {
    if (this.shuttingDown || !this.desired) return;
    const target = this._validateTarget();
    // Invalid target (deleted channel/guild left): stop retrying rather than looping forever.
    // `desired`/the persisted state are intentionally left alone — see README "Giới hạn hiện tại".
    if (!target) return;
    const { guild, channel } = target;

    this._cancelReconnect();
    this._disposeConnection();
    const gen = this.generation;

    const connection = this.voice.joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection = connection;

    const player = this.voice.createAudioPlayer();
    this.player = player;
    const resource = this.voice.createAudioResource(new SilenceStream(), { inputType: StreamType.Opus });
    player.play(resource);
    connection.subscribe(player);
    player.on('error', (err) => {
      if (gen !== this.generation) return;
      this.emit('log', `Voice player error: ${err.message}`);
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      if (gen !== this.generation) return; // stale connection, already superseded
      this.connectedAt = Date.now();
      this.reconnectDelay = this.baseReconnectDelayMs;
      this.emit('log', `Đã kết nối voice: ${channel.id}`);
      this.emit('status', this.status());
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (gen !== this.generation) return;
      try {
        await Promise.race([
          this.voice.entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          this.voice.entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Temporary blip (e.g. Discord moving/reconnecting us) — it will recover on its own.
      } catch {
        if (gen !== this.generation) return; // superseded/left/shut down while we were waiting
        try {
          connection.destroy();
        } catch {
          /* already destroyed */
        }
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (gen !== this.generation) return; // this connection was intentionally replaced — not our concern anymore
      this.connection = null;
      this.connectedAt = null;
      this.emit('status', this.status());
      if (this.shuttingDown || !this.desired) return;
      this.emit('log', `Mất kết nối voice, thử kết nối lại sau ${this.reconnectDelay / 1000}s...`);
      this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelayMs);
    });

    connection.on('error', (err) => {
      if (gen !== this.generation) return;
      this.emit('log', `Voice connection error: ${err.message}`);
    });
  }

  channelMembers(channelId) {
    for (const guild of this.client.guilds.cache.values()) {
      const channel = guild.channels.cache.get(channelId);
      if (channel && channel.isVoiceBased()) {
        return [...channel.members.values()].map((m) => ({
          id: m.id,
          username: m.displayName || m.user?.globalName || m.user?.username || 'Unknown member',
          bot: Boolean(m.user?.bot),
        }));
      }
    }
    return [];
  }
}

module.exports = { VoiceManager };
