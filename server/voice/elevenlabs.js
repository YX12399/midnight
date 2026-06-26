// server/voice/elevenlabs.js
// ElevenLabs TTS provider (spec §4 Option A). Uses global fetch (Node 18+).
// Verify current model names at build time — see config/voice.json _notes.

class ElevenLabsProvider {
  constructor({ apiKey, voiceId, model }) {
    this.name = "elevenlabs";
    this.available = true;
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.model = model || "eleven_flash_v2_5";
  }

  // Returns an mp3 Buffer, or null on failure (caller falls back to browser TTS).
  async synthesize(text) {
    const url =
      "https://api.elevenlabs.io/v1/text-to-speech/" +
      encodeURIComponent(this.voiceId);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: text,
          model_id: this.model,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.8,
            style: 0.35,
            use_speaker_boost: true,
          },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error("[elevenlabs] HTTP " + res.status + " " + detail.slice(0, 200));
        return null;
      }
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err) {
      console.error("[elevenlabs] synth error:", err.message);
      return null;
    }
  }
}

module.exports = ElevenLabsProvider;
