// scripts/voice-test.js — verifies the voice GM's server seam: HOST_SAY makes
// Silas speak an ad-hoc line (by prebaked key or arbitrary text) to the room,
// marked ephemeral, without corrupting the reconnect narration snapshot.
// Run against: REVEAL_SECONDS=0 NIGHT_SECONDS=60 PORT=3410 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3410;
const URL = `ws://localhost:${PORT}/ws`;
function mk() {
  const ws = new WebSocket(URL);
  ws.inbox = [];
  ws.on("message", (b) => { try { ws.inbox.push(JSON.parse(b.toString())); } catch {} });
  return new Promise((res) => ws.on("open", () => res(ws)));
}
const send = (ws, o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (ws, t) => [...ws.inbox].reverse().find((m) => m.type === t);
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.log("  FAIL-", n)); };

async function run() {
  const host = await mk();
  send(host, { type: "HOST_CREATE" });
  await sleep(150);
  const { code, hostToken } = last(host, "HOSTED");
  const table = await mk();
  send(table, { type: "TABLE_JOIN", code });
  await sleep(120);

  // HOST_SAY by prebaked key -> a NARRATE to the room, ephemeral flagged
  send(host, { type: "HOST_SAY", hostToken, key: "vg_didnt_catch" });
  await sleep(300);
  const n1 = last(table, "NARRATE");
  check("HOST_SAY{key} reaches the room as NARRATE", !!n1 && n1.ephemeral === true);
  check("prebaked ack carries real text", n1 && typeof n1.text === "string" && n1.text.length > 5);

  // HOST_SAY by arbitrary text -> spoken literally
  send(host, { type: "HOST_SAY", hostToken, text: "Still standing: Rosa and Sal." });
  await sleep(300);
  const n2 = last(table, "NARRATE");
  check("HOST_SAY{text} speaks the literal line", n2 && /Rosa and Sal/.test(n2.text) && n2.ephemeral === true);

  // non-host cannot make Silas talk
  const imposter = await mk();
  send(imposter, { type: "HOST_SAY", hostToken: "bogus", text: "chaos" });
  await sleep(200);
  check("HOST_SAY rejected without the host token", !last(imposter, "NARRATE"));

  // /healthz advertises the LAN address for the voice host's QR
  const http = require("http");
  const health = await new Promise((res) => http.get(`http://localhost:${PORT}/healthz`, (r) => {
    let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d)));
  }));
  check("/healthz reports a port for the LAN QR", health && health.port);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
