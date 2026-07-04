// Verifies reconnect resilience: the detective's private verdict is replayed,
// vote/ready state is restored, and the GAME_OVER reveal reaches anyone who
// reconnects at the END (host included).
// Run against: REVEAL_SECONDS=0 NIGHT_SECONDS=60 DISCUSSION_SECONDS=60 VOTE_SECONDS=60 MORNING_SECONDS=1 RESOLVE_DELAY_MS=0 PORT=3409 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3409;
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
  for (let i = 0; i < 60 && players.some((p) => !last(p.ws, "ROLE_ASSIGNED")); i++) await sleep(50);
  players.forEach((p) => { p.role = (last(p.ws, "ROLE_ASSIGNED") || {}).role; });

  const gf = players.find((p) => p.role === "godfather");
  const det = players.find((p) => p.role === "detective");
  const doc = players.find((p) => p.role === "doctor");
  const cits = players.filter((p) => p.role === "citizen");
  for (let i = 0; i < 60 && !last(gf.ws, "NIGHT_PROMPT"); i++) await sleep(50);

  // Night 1: GF kills a citizen, doctor saves the other, detective checks GF.
  send(det.ws, { type: "NIGHT_ACTION", token: det.token, target_id: gf.id });
  send(doc.ws, { type: "NIGHT_ACTION", token: doc.token, target_id: cits[1].id });
  send(gf.ws, { type: "NIGHT_ACTION", token: gf.token, target_id: cits[0].id });
  let day = false;
  for (let i = 0; i < 80 && !day; i++) { await sleep(100); const s = last(host, "STATE"); day = s && s.phase === "DAY_DISCUSSION"; }
  check("night resolved into day", day);
  const verdict = last(det.ws, "NIGHT_RESULT");
  check("detective got the live verdict", !!verdict);

  // --- detective's phone dies and comes back: verdict must be REPLAYED ---
  det.ws.terminate();
  await sleep(200);
  det.ws = await mk();
  send(det.ws, { type: "REJOIN", code, token: det.token });
  await sleep(400);
  const replayed = last(det.ws, "NIGHT_RESULT");
  check("verdict replayed on rejoin (same round)", !!replayed && replayed.text === verdict.text);
  check("ready state snapshot arrives on rejoin", !!last(det.ws, "READY_PROGRESS"));

  // --- vote state restored mid-vote ---
  send(host, { type: "HOST_OPEN_VOTE", hostToken });
  await sleep(300);
  send(gf.ws, { type: "VOTE", token: gf.token, target_id: "skip" });
  await sleep(200);
  gf.ws.terminate();
  await sleep(200);
  gf.ws = await mk();
  send(gf.ws, { type: "REJOIN", code, token: gf.token });
  await sleep(400);
  const ack = last(gf.ws, "VOTE_ACK");
  check("cast ballot restored on rejoin (VOTE_ACK skip)", !!ack && ack.target_id === "skip");
  check("vote progress snapshot arrives on rejoin", !!last(gf.ws, "VOTE_PROGRESS"));

  // --- everyone lynches the godfather -> END; reconnects must see GAME_OVER ---
  const living = [det, doc, cits[1]];
  living.forEach((p) => send(p.ws, { type: "VOTE", token: p.token, target_id: gf.id }));
  let over = false;
  for (let i = 0; i < 80 && !over; i++) { await sleep(100); over = !!last(host, "GAME_OVER"); }
  check("town win reached", over && last(host, "GAME_OVER").winner === "town");

  doc.ws.terminate();
  await sleep(200);
  doc.ws = await mk();
  send(doc.ws, { type: "REJOIN", code, token: doc.token });
  await sleep(400);
  check("player reconnecting at END receives GAME_OVER", !!last(doc.ws, "GAME_OVER"));

  const host2 = await mk();
  send(host2, { type: "HOST_RECONNECT", code, hostToken });
  await sleep(400);
  check("host reconnecting at END receives GAME_OVER", !!last(host2, "GAME_OVER"));
  check("host reconnect replays the current narration", !!last(host2, "NARRATE") && last(host2, "NARRATE").replay === true);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
