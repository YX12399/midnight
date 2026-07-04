// Downloads Higgsfield-generated art into web/assets/ (committed + served locally
// by the app, so nothing depends on an external CDN staying up) and writes the
// local paths into config/assets.json. Input: a JSON map of
//   { "roles": { "godfather": "<url>", ... }, "cards": { "victory_town": "<url>" } }
// matching the assets.json shape. Only listed keys are touched; the rest is kept.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = JSON.parse(fs.readFileSync(process.argv[2] || path.join(ROOT, ".cache", "asset-urls.json"), "utf8"));
const assetsPath = path.join(ROOT, "config", "assets.json");
const assets = JSON.parse(fs.readFileSync(assetsPath, "utf8"));

const EXT_BY_TYPE = { "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg" };

let ok = 0, fail = 0;
for (const [category, entries] of Object.entries(src)) {
  const dir = path.join(ROOT, "web", "assets", category);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(entries)) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const ext = EXT_BY_TYPE[(res.headers.get("content-type") || "").split(";")[0]] ||
        (path.extname(new URL(url).pathname) || ".png");
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("empty body");
      const file = path.join(dir, name + ext);
      fs.writeFileSync(file, buf);
      assets[category] = assets[category] || {};
      assets[category][name] = "/assets/" + category + "/" + name + ext;
      ok++;
      console.log("  saved", category + "/" + name + ext, "(" + Math.round(buf.length / 1024) + "kb)");
    } catch (e) {
      fail++;
      console.error("  FAIL", category + "/" + name, "-", e.message);
    }
  }
}
fs.writeFileSync(assetsPath, JSON.stringify(assets, null, 2) + "\n");
console.log("\nSaved " + ok + " asset(s)" + (fail ? ", " + fail + " failed" : "") + "; updated config/assets.json");
process.exit(fail ? 1 : 0);
