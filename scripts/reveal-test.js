// Verifies the reveal beat: after the deal, the game holds in REVEAL long enough
// for players to study their role BEFORE night falls and the phone swaps screens.
// Run against: REVEAL_SECONDS=2 NIGHT_SECONDS=60 PORT=3406 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3406;
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
const has = (ws, t) => ws.inbox.some((m) => m.type === t);
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.log("  FAIL-", n)); };

async function run() {
  const host = await mk();
  send(host, { type: "HOST_CREATE" });
  await sleep(150);
  const { code, hostToken } = last(host, "HOSTED");
  const players = [];
  for (let i = 0; i < 5; i++) {
    const ws = await mk();
    send(ws, { type: "JOIN", code, name: "P" + i });
    await sleep(40);
    players.push({ ws });
  }
  await sleep(80);
  send(host, { type: "HOST_START", hostToken });
  await sleep(400); // well within the 2s reveal hold

  check("all 5 received their role card", players.every((p) => has(p.ws, "ROLE_ASSIGNED")));
  const s1 = last(host, "STATE");
  check("still in REVEAL during the study window (not yanked to NIGHT)", s1 && s1.phase === "REVEAL");
  check("no night prompt has fired yet", players.every((p) => !has(p.ws, "NIGHT_PROMPT")));

  await sleep(2200); // let the 2s reveal hold elapse
  const s2 = last(host, "STATE");
  check("NIGHT falls after the reveal hold", s2 && s2.phase === "NIGHT");
  check("night prompts now delivered", players.some((p) => has(p.ws, "NIGHT_PROMPT")));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
