// Emits the exact narration texts to bake in Vlad's voice, each with the cache
// filename the server will look for. The hash MUST match server/tts-cache.js:
//   sha1( provider.name + ":" + provider.voiceId + "|" + text )
// For the prebaked provider that's name="higgsfield", voiceId=<Vlad id>.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VOICE_NAME = "higgsfield";
const VLAD = "e5666b9c-99a2-4fac-8b4e-abee078b186d";

// Phases whose EVERY variant we bake, so a phase never mixes Vlad with browser TTS.
const PHASES = (process.argv[2] || "night_falls,day_discussion,vote_call,town_win,mafia_win").split(",");

const script = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "script.json"), "utf8"));
const hash = (t) => crypto.createHash("sha1").update(VOICE_NAME + ":" + VLAD + "|" + t).digest("hex");

const out = [];
for (const key of PHASES) {
  for (const line of (script.lines[key] || [])) {
    if (/\{[A-Z]+\}/.test(line)) continue; // dynamic — cannot prebake
    out.push({ key, text: line, file: hash(line) + ".mp3" });
  }
}
console.log(JSON.stringify(out, null, 2));
