// Verifies the server's rule-enforcement guards against hostile/duplicated input:
//  · HOST_START is LOBBY-only (a double-tap can't re-deal roles mid-game)
//  · NIGHT_ACTION targets are validated server-side (a forged godfather message
//    can't mark family/self; bogus ids are rejected)
//  · VOTE targets are validated (a bogus ballot is never counted as cast)
// Run against: REVEAL_SECONDS=0 NIGHT_SECONDS=60 DISCUSSION_SECONDS=60 VOTE_SECONDS=60 RESOLVE_DELAY_MS=0 PORT=3408 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3408;
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
const count = (ws, t) => ws.inbox.filter((m) => m.type === t).length;
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
    players.push({ ws, id: j.playerId, token: j.token, name: "P" + i });
  }
  await sleep(80);

  // --- HOST_START twice, back to back (the double-tap) ---
  send(host, { type: "HOST_START", hostToken });
  send(host, { type: "HOST_START", hostToken });
  for (let i = 0; i < 60 && players.some((p) => !last(p.ws, "ROLE_ASSIGNED")); i++) await sleep(50);
  players.forEach((p) => { p.role = (last(p.ws, "ROLE_ASSIGNED") || {}).role; });
  await sleep(400); // give a hypothetical second deal time to land
  check("double HOST_START deals each player exactly ONE role",
    players.every((p) => count(p.ws, "ROLE_ASSIGNED") === 1));
  check("second HOST_START was rejected with an ERROR",
    host.inbox.some((m) => m.type === "ERROR" && /already started/i.test(m.message)));

  // --- forged NIGHT_ACTION: the godfather tries to mark HIMSELF (mafia) ---
  const gf = players.find((p) => p.role === "godfather");
  const det = players.find((p) => p.role === "detective");
  const doc = players.find((p) => p.role === "doctor");
  const cits = players.filter((p) => p.role === "citizen");
  for (let i = 0; i < 60 && !last(gf.ws, "NIGHT_PROMPT"); i++) await sleep(50);

  send(gf.ws, { type: "NIGHT_ACTION", token: gf.token, target_id: gf.id }); // illegal: self/mafia
  send(det.ws, { type: "NIGHT_ACTION", token: det.token, target_id: gf.id });
  send(doc.ws, { type: "NIGHT_ACTION", token: doc.token, target_id: doc.id });
  await sleep(500);
  const st1 = last(host, "STATE");
  check("illegal godfather target rejected — night NOT resolved", st1 && st1.phase === "NIGHT");

  send(gf.ws, { type: "NIGHT_ACTION", token: gf.token, target_id: "not-a-real-id" }); // bogus id
  await sleep(400);
  const st2 = last(host, "STATE");
  check("bogus godfather target rejected — night still open", st2 && st2.phase === "NIGHT");

  send(gf.ws, { type: "NIGHT_ACTION", token: gf.token, target_id: cits[0].id }); // legal town mark
  let morning = false;
  for (let i = 0; i < 60 && !morning; i++) { await sleep(100); const s = last(host, "STATE"); morning = s && s.phase !== "NIGHT"; }
  check("legal town mark accepted — night resolved", morning);
  check("the mark (a citizen) is dead", (last(host, "STATE").dead || []).some((d) => d.id === cits[0].id));

  // --- bogus VOTE: never counted as cast ---
  let voting = false;
  for (let i = 0; i < 80 && !voting; i++) { await sleep(100); const s = last(host, "STATE"); voting = s && s.phase === "DAY_VOTE"; }
  if (!voting) { send(host, { type: "HOST_OPEN_VOTE", hostToken }); await sleep(300); }
  const living = players.filter((p) => p.id !== cits[0].id);
  // 4 living: 3 vote legally, 1 votes a DEAD player (illegal)
  send(living[0].ws, { type: "VOTE", token: living[0].token, target_id: cits[0].id }); // dead target
  send(living[1].ws, { type: "VOTE", token: living[1].token, target_id: gf.id });
  send(living[2].ws, { type: "VOTE", token: living[2].token, target_id: gf.id });
  send(living[3].ws, { type: "VOTE", token: living[3].token, target_id: gf.id });
  await sleep(500);
  const st3 = last(host, "STATE");
  check("vote for a dead player rejected — vote NOT resolved on 3/4 legal ballots", st3 && st3.phase === "DAY_VOTE");
  const vp = last(host, "VOTE_PROGRESS");
  check("rejected ballot never counted as cast (progress 3/4)", vp && vp.cast === 3 && vp.total === 4);

  send(living[0].ws, { type: "VOTE", token: living[0].token, target_id: "skip" }); // legal abstain
  let done = false;
  for (let i = 0; i < 60 && !done; i++) { await sleep(100); done = !!last(host, "GAME_OVER"); }
  check("legal abstain completes the vote — godfather lynched, town wins",
    done && last(host, "GAME_OVER").winner === "town");
  const tallyEvt = last(host, "VOTE_TALLY");
  check("VOTE_TALLY carries named results for the room",
    tallyEvt && Array.isArray(tallyEvt.results) && tallyEvt.results.length > 0 && typeof tallyEvt.results[0].name === "string");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
