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
    // Missing creds -> graceful fallback (spec §4: "falls back to browser TTS").
    console.warn(
      "[voice] ElevenLabs selected but ELEVENLABS_API_KEY / narrator_voice_id missing — using browser TTS fallback."
    );
    return new BrowserFallbackProvider();
  }

  // (Higgsfield provider would slot in here behind the same interface.)
  return new BrowserFallbackProvider();
}

module.exports = { createVoiceProvider, BrowserFallbackProvider };
