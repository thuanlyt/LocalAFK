const { Readable } = require('node:stream');

// A minimal valid Opus packet that decodes to silence. Sending this on a
// steady 20ms cadence (Discord's frame size) keeps the voice UDP connection
// alive and stops the server's "AFK channel" timeout (if configured) from
// treating the bot as idle and moving it out of the channel.
const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
const FRAME_INTERVAL_MS = 20;

class SilenceStream extends Readable {
  constructor() {
    super();
    this._timer = null;
  }

  _read() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (!this.push(OPUS_SILENCE_FRAME)) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }, FRAME_INTERVAL_MS);
  }

  _destroy(err, callback) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    callback(err);
  }
}

module.exports = { SilenceStream };
