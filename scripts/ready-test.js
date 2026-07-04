// Verifies the "everyone ready" early-out: with a long (30s) discussion timer,
// all living players tapping Ready must open the vote almost immediately.
// Run against: NIGHT_SECONDS=1 MORNING_SECONDS=1 DISCUSSION_SECONDS=30 PORT=3405 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3405;
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
    const j = last(ws, "JOINED");
    players.push({ ws, id: j.playerId, token: j.token });
  }
  await sleep(80);
  send(host, { type: "HOST_START", hostToken });

  // NIGHT(1s) nobody acts -> nobody dies -> MORNING(1s) -> DAY_DISCUSSION(30s).
  // Wait until discussion is open.
  let disc = false;
  for (let i = 0; i < 60 && !disc; i++) { await sleep(100); const s = last(host, "STATE"); disc = s && s.phase === "DAY_DISCUSSION"; }
  check("reached DAY_DISCUSSION (30s timer)", disc);

  const tOpen = Date.now();
  // All five living players tap Ready.
  players.forEach((p) => send(p.ws, { type: "READY", token: p.token }));

  // The vote should open far faster than the 30s discussion timer.
  let voted = false;
  for (let i = 0; i < 40 && !voted; i++) { await sleep(100); voted = players.some((p) => has(p.ws, "VOTE_PROMPT")); }
  const elapsed = Date.now() - tOpen;
  check("all-Ready opened the vote", voted);
  check("vote opened early (" + elapsed + "ms « 30s timer)", voted && elapsed < 8000);
  check("host saw READY_PROGRESS reach 5/5", (last(host, "READY_PROGRESS") || {}).ready === 5);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
