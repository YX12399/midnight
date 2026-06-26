// server/tts-cache.js
// Latency & cost trick (spec §7): hash the resolved line -> serve cached mp3
// if present, else synthesize once, cache to disk, serve. Fixed lines get
// pre-rendered (scripts/prerender-script.js); dynamic lines cache on first use.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class TtsCache {
  constructor(provider, cacheDir) {
    this.provider = provider;
    this.cacheDir = cacheDir || path.join(__dirname, "..", ".cache", "tts");
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  keyFor(text) {
    const voice = this.provider.name + ":" + (this.provider.voiceId || "n/a");
    return crypto
      .createHash("sha1")
      .update(voice + "|" + text)
      .digest("hex");
  }

  filePathFor(text) {
    return path.join(this.cacheDir, this.keyFor(text) + ".mp3");
  }

  // Returns a relative URL path ("/tts/<hash>.mp3") if audio is available,
  // or null if the client should fall back to browser TTS.
  async urlFor(text) {
    if (!this.provider.available) return null;
    const file = this.filePathFor(text);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      return "/tts/" + path.basename(file);
    }
    const buf = await this.provider.synthesize(text);
    if (!buf || buf.length === 0) return null;
    fs.writeFileSync(file, buf);
    return "/tts/" + path.basename(file);
  }

  // Resolve a cache file from a /tts/<hash>.mp3 request path.
  resolve(basename) {
    const safe = path.basename(basename); // prevent traversal
    const file = path.join(this.cacheDir, safe);
    return fs.existsSync(file) ? file : null;
  }
}

module.exports = TtsCache;
