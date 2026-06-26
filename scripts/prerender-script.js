// scripts/prerender-script.js
// Pre-render the fixed narrator lines to mp3 once (spec §7). Dynamic lines
// (with {NAME}/{ROLE}) are skipped — they cache live on first use.
// Requires ELEVENLABS_API_KEY + narrator_voice_id in config/voice.json, else no-op.

const path = require("path");
const fs = require("fs");
const { createVoiceProvider } = require("../server/voice/provider");
const TtsCache = require("../server/tts-cache");

const ROOT = path.join(__dirname, "..");
const voiceConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "voice.json"), "utf8"));
const script = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "script.json"), "utf8"));

(async function () {
  const provider = createVoiceProvider(voiceConfig);
  if (!provider.available) {
    console.log("No real voice provider configured — skipping pre-render (clients will use browser TTS).");
    return;
  }
  const cache = new TtsCache(provider);
  let done = 0, skipped = 0;
  for (const key of Object.keys(script.lines)) {
    for (const line of script.lines[key]) {
      if (/\{[A-Z]+\}/.test(line)) { skipped++; continue; } // has template slot -> dynamic
      const url = await cache.urlFor(line);
      if (url) { done++; process.stdout.write("."); }
    }
  }
  console.log("\nPre-rendered " + done + " fixed lines (" + skipped + " dynamic lines deferred).");
})();
