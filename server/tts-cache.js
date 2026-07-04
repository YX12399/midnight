// server/tts-cache.js
// Latency & cost trick (spec §7): hash the resolved line -> serve cached mp3
// if present, else synthesize once, cache to disk, serve. Fixed lines get
// pre-rendered (scripts/prerender-script.js); dynamic lines cache on first use.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class TtsCache {
  constructor(provider, cacheDir, prebakedDir) {
    this.provider = provider;
    this.cacheDir = cacheDir || path.join(__dirname, "..", ".cache", "tts");
    // Committed, read-only layer: pre-rendered lines that must ship with the
    // repo (e.g. Vlad via Higgsfield). Runtime synthesis still lands in cacheDir.
    this.prebakedDir = prebakedDir || path.join(__dirname, "..", "content", "audio", "tts");
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
    const name = this.keyFor(text) + ".mp3";
    // 1) shipped prebaked audio, 2) runtime cache, 3) synthesize on demand.
    const prebaked = path.join(this.prebakedDir, name);
    if (fs.existsSync(prebaked) && fs.statSync(prebaked).size > 0) return "/tts/" + name;
    const file = this.filePathFor(text);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return "/tts/" + name;
    const buf = await this.provider.synthesize(text);
    if (!buf || buf.length === 0) return null;
    fs.writeFileSync(file, buf);
    return "/tts/" + name;
  }

  // Resolve a /tts/<hash>.mp3 request from either the runtime cache or the
  // shipped prebaked layer (checked in that order).
  resolve(basename) {
    const safe = path.basename(basename); // prevent traversal
    const inCache = path.join(this.cacheDir, safe);
    if (fs.existsSync(inCache)) return inCache;
    const inPrebaked = path.join(this.prebakedDir, safe);
    return fs.existsSync(inPrebaked) ? inPrebaked : null;
  }
}

module.exports = TtsCache;
