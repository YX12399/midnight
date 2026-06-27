// Timer auto-resolve test: proves an AFK player can't stall the game.
// Run the server with short timers, e.g.:
//   NIGHT_SECONDS=1 VOTE_SECONDS=1 DISCUSSION_SECONDS=1 PORT=3001 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3001;
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
    await sleep(50);
    const j = last(ws, "JOINED");
    players.push({ ws, id: j.playerId, token: j.token });
  }
  await sleep(80);

  send(host, { type: "HOST_START", hostToken });
  await sleep(300);
  const roles = {};
  players.forEach((p) => { const r = last(p.ws, "ROLE_ASSIGNED"); if (r) roles[p.id] = r.role; });

  // STATE should carry a deadline during NIGHT (timer armed).
  const nightState = last(host, "STATE");
  check("NIGHT state includes a timer deadline", nightState && nightState.phase === "NIGHT" && typeof nightState.deadline === "number");

  // Nobody acts. With NIGHT_SECONDS=1 the timer must auto-resolve the night.
  await sleep(1500);
  const afterNight = last(host, "STATE");
  check("night auto-resolved despite ZERO actions (no stall)", afterNight && afterNight.phase !== "NIGHT");

  // Should now be in DAY_DISCUSSION; with DISCUSSION_SECONDS=1 it auto-opens vote.
  await sleep(1500);
  const afterDisc = last(host, "STATE");
  check("discussion auto-advanced (to vote or beyond)", afterDisc && afterDisc.phase !== "DAY_DISCUSSION");

  // With VOTE_SECONDS=1 and no votes, the vote auto-resolves (tie -> next night or end).
  await sleep(1500);
  const afterVote = last(host, "STATE");
  check("vote auto-resolved despite ZERO votes", afterVote && afterVote.phase !== "DAY_VOTE");

  // Game must not be wedged: either it's progressed rounds or ended.
  check("game still progressing / not frozen", afterVote && ["NIGHT","MORNING","DAY_DISCUSSION","DAY_VOTE","END"].includes(afterVote.phase));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
