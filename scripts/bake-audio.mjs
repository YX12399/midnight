// Downloads pre-rendered narrator audio and files it into .cache/tts/ under the
// exact hash the server looks up, so the prebaked provider serves it with zero
// runtime cost. Input: a JSON array of { prompt, url } (prompt must match the
// narration line verbatim). Hash recipe mirrors server/tts-cache.js:
//   sha1( prebaked.name + ":" + prebaked.voice_id + "|" + prompt )
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const voice = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "voice.json"), "utf8")).prebaked;
if (!voice || !voice.voice_id) { console.error("config/voice.json has no prebaked.voice_id"); process.exit(1); }

const pairsPath = process.argv[2] || path.join(ROOT, ".cache", "audio-urls.json");
const pairs = JSON.parse(fs.readFileSync(pairsPath, "utf8"));
const script = JSON.parse(fs.readFileSync(path.join(ROOT, "content", "script.json"), "utf8"));
// Bake into the committed, shipped layer (content/audio/tts) — NOT .cache/ which
// is gitignored — so the prebaked voice deploys with the repo.
const cacheDir = path.join(ROOT, "content", "audio", "tts");
fs.mkdirSync(cacheDir, { recursive: true });
const hash = (t) => crypto.createHash("sha1").update(voice.name + ":" + voice.voice_id + "|" + t).digest("hex");

let ok = 0, fail = 0;
for (const entry of pairs) {
  const { url } = entry;
  // Prefer resolving the exact line from script.json via {key,index} so the
  // hash is guaranteed byte-identical to what the server computes at runtime.
  const prompt = entry.prompt != null
    ? entry.prompt
    : (script.lines[entry.key] || [])[entry.index];
  try {
    if (prompt == null) throw new Error("no line at " + entry.key + "[" + entry.index + "]");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("empty body");
    const file = path.join(cacheDir, hash(prompt) + ".mp3");
    fs.writeFileSync(file, buf);
    ok++;
    console.log("  baked", JSON.stringify(prompt.slice(0, 46)) + (prompt.length > 46 ? "…" : ""), "→", path.basename(file), "(" + buf.length + "b)");
  } catch (e) {
    fail++;
    console.error("  FAIL", JSON.stringify(prompt.slice(0, 46)), "-", e.message);
  }
}
console.log("\nBaked " + ok + " line(s)" + (fail ? ", " + fail + " failed" : "") + " into content/audio/tts/");
process.exit(fail ? 1 : 0);
