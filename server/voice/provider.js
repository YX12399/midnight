// server/voice/provider.js
// VoiceProvider interface + factory (spec §4, §9b).
// A provider exposes: async synthesize(text) -> Buffer (mp3) | null
//   returning null means "no audio available, client should fall back to browser TTS".

const ElevenLabs = require("./elevenlabs");

// Null provider: never produces audio. Clients speak text with browser TTS.
class BrowserFallbackProvider {
  constructor() {
    this.name = "browser";
    this.available = false; // no server-side audio
  }
  async synthesize(_text) {
    return null;
  }
}

// Prebaked provider: serves narrator lines that were rendered ahead of time
// (e.g. Vlad via Higgsfield) and dropped into .cache/tts/. It never synthesizes
// at runtime — synthesize() returns null, so any line WITHOUT a prebaked file
// (the dynamic {NAME}/{ROLE} lines) cleanly falls back to browser TTS. It is
// `available`, and its name/voiceId must match what the files were hashed under
// (see scripts/bake-audio.mjs), so tts-cache finds them.
class PrebakedProvider {
  constructor({ name, voiceId }) {
    this.name = name || "prebaked";
    this.voiceId = voiceId || "n/a";
    this.available = true;
  }
  async synthesize(_text) {
    return null; // only pre-rendered lines are served; the rest use browser TTS
  }
}

function createVoiceProvider(voiceConfig) {
  const provider = (voiceConfig && voiceConfig.provider) || "browser";

  if (provider === "elevenlabs") {
    const key = process.env.ELEVENLABS_API_KEY;
    const voiceId = voiceConfig.narrator_voice_id;
    if (key && voiceId) {
      return new ElevenLabs({
        apiKey: key,
        voiceId: voiceId,
        model: voiceConfig.tts_model || "eleven_flash_v2_5",
      });
    }
    // No runtime key — but if fixed lines were prebaked (Vlad via Higgsfield),
    // serve those and let dynamic lines fall back to browser TTS.
    if (voiceConfig.prebaked && voiceConfig.prebaked.voice_id) {
      console.warn(
        "[voice] No ELEVENLABS_API_KEY — serving prebaked '" +
          (voiceConfig.prebaked.name || "prebaked") +
          "' lines; dynamic lines use browser TTS. Add the key for full runtime voice."
      );
      return new PrebakedProvider({
        name: voiceConfig.prebaked.name,
        voiceId: voiceConfig.prebaked.voice_id,
      });
    }
    console.warn(
      "[voice] ElevenLabs selected but ELEVENLABS_API_KEY / narrator_voice_id missing — using browser TTS fallback."
    );
    return new BrowserFallbackProvider();
  }

  // Prebaked-only mode (no runtime provider configured at all).
  if (provider === "prebaked" && voiceConfig.prebaked && voiceConfig.prebaked.voice_id) {
    return new PrebakedProvider({
      name: voiceConfig.prebaked.name,
      voiceId: voiceConfig.prebaked.voice_id,
    });
  }

  return new BrowserFallbackProvider();
}

module.exports = { createVoiceProvider, BrowserFallbackProvider, PrebakedProvider };
