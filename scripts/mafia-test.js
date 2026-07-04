// Verifies multi-mafia coordination in a larger game (8 players → 2 Godfathers):
// the family learn each other, and a godfather can't mark his own.
// Run against: REVEAL_SECONDS=0 NIGHT_SECONDS=60 PORT=3407 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3407;
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
  for (let i = 0; i < 8; i++) {
    const ws = await mk();
    send(ws, { type: "JOIN", code, name: "P" + i });
    await sleep(35);
    const j = last(ws, "JOINED");
    players.push({ ws, id: j.playerId, token: j.token, name: "P" + i });
  }
  await sleep(80);
  send(host, { type: "HOST_START", hostToken });

  // wait for role reveals
  for (let i = 0; i < 60 && players.some((p) => !last(p.ws, "ROLE_ASSIGNED")); i++) await sleep(50);
  players.forEach((p) => { p.reveal = last(p.ws, "ROLE_ASSIGNED"); p.role = p.reveal && p.reveal.role; });

  const gfs = players.filter((p) => p.role === "godfather");
  check("8-player game dealt 2 Godfathers", gfs.length === 2);

  // each godfather's reveal lists the OTHER godfather as ally (and only them)
  const [a, b] = gfs;
  check("Godfather A knows the family (ally = B)", a && a.reveal.allies && a.reveal.allies.includes(b.name) && a.reveal.allies.length === 1);
  check("Godfather B knows the family (ally = A)", b && b.reveal.allies && b.reveal.allies.includes(a.name) && b.reveal.allies.length === 1);

  // a citizen learns no allies
  const cit = players.find((p) => p.role === "citizen");
  check("a townsperson gets no ally list", cit && (!cit.reveal.allies || cit.reveal.allies.length === 0));

  // wait for the night prompt, then confirm a godfather can't target family
  for (let i = 0; i < 60 && !last(a.ws, "NIGHT_PROMPT"); i++) await sleep(50);
  const np = last(a.ws, "NIGHT_PROMPT");
  check("Godfather received a NIGHT_PROMPT", !!np);
  const targetIds = (np && np.valid_targets || []).map((t) => t.id);
  const gfIds = new Set(gfs.map((g) => g.id));
  check("no fellow-mafia among the marks", np && targetIds.every((id) => !gfIds.has(id)));
  check("self is not a mark either", np && !targetIds.includes(a.id));
  check("town players ARE valid marks", np && targetIds.length === players.length - gfs.length);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
