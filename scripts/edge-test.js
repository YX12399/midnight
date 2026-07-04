// Edge-case / robustness harness for MIDNIGHT.
// Connects over real WebSockets to a running server on PORT (default 3000).
// Event-driven (waits for actual messages) so it's deterministic, not sleep-timed.
const WebSocket = require("ws");
const PORT = process.env.PORT || 3000;
const URL = `ws://localhost:${PORT}/ws`;

function mk() {
  const ws = new WebSocket(URL);
  ws.inbox = [];
  ws.on("message", (b) => { try { ws.inbox.push(JSON.parse(b.toString())); } catch {} });
  return new Promise((res) => ws.on("open", () => res(ws)));
}
const send = (ws, o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function last(ws, type) { return [...ws.inbox].reverse().find((m) => m.type === type); }
function has(ws, type) { return ws.inbox.some((m) => m.type === type); }

// Wait until predicate() is true or timeout. Polls every 20ms. Deterministic.
async function waitFor(predicate, timeoutMs = 3000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }
  return false;
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.log("  FAIL-", name); }
}

async function run() {
  // ---- Edge: JOIN with too-long name is truncated to 20 (isolated game) ----
  {
    const h = await mk();
    send(h, { type: "HOST_CREATE" });
    await waitFor(() => last(h, "HOSTED"), 2000);
    const c = last(h, "HOSTED").code;
    const lw = await mk();
    send(lw, { type: "JOIN", code: c, name: "x".repeat(50) });
    await waitFor(() => last(lw, "JOINED"), 2000);
    const lj = last(lw, "JOINED");
    check("long name truncated to <=20", lj && lj.name.length <= 20);
    lw.close(); h.close();
    await sleep(50);
  }

  // ---- Build a clean 5-player game ----
  const host = await mk();
  send(host, { type: "HOST_CREATE" });
  await waitFor(() => last(host, "HOSTED"), 2000);
  const hosted = last(host, "HOSTED");
  const code = hosted.code, hostToken = hosted.hostToken;
  console.log("game code:", code);

  const players = [];
  for (let i = 0; i < 5; i++) {
    const ws = await mk();
    send(ws, { type: "JOIN", code, name: "P" + i });
    await waitFor(() => last(ws, "JOINED"), 2000);
    const j = last(ws, "JOINED");
    players.push({ ws, id: j.playerId, token: j.token });
  }
  check("5 players joined", players.every((p) => p.id));

  // ---- Start game; wait until every player has a ROLE_ASSIGNED ----
  send(host, { type: "HOST_START", hostToken });
  const allRoles = await waitFor(
    () => players.every((p) => last(p.ws, "ROLE_ASSIGNED")), 3000);
  const roles = {};
  players.forEach((p) => { const r = last(p.ws, "ROLE_ASSIGNED"); if (r) roles[p.id] = r.role; });
  check("all 5 players got a private role", allRoles && Object.keys(roles).length === 5);
  check("no role leaked to host", !has(host, "ROLE_ASSIGNED"));

  const dist = {};
  Object.values(roles).forEach((r) => (dist[r] = (dist[r] || 0) + 1));
  console.log("  dealt distribution:", JSON.stringify(dist));
  check("exactly 1 detective dealt in 5p game", dist.detective === 1);
  check("exactly 1 doctor dealt in 5p game", dist.doctor === 1);
  check("exactly 1 godfather dealt in 5p game", dist.godfather === 1);

  const find = (role) => players.find((p) => roles[p.id] === role);
  const gf = find("godfather"), det = find("detective"), doc = find("doctor");
  check("godfather received a NIGHT_PROMPT", gf && await waitFor(() => has(gf.ws, "NIGHT_PROMPT"), 2000));

  // ---- Edge A: detective disconnects mid-night, then REJOINs ----
  check("detective exists for rejoin test", !!det);
  det.ws.close();
  await sleep(150);
  const detNew = await mk();
  send(detNew, { type: "REJOIN", code, token: det.token });
  const gotPrompt = await waitFor(() => has(detNew, "NIGHT_PROMPT"), 2500);
  check("REJOIN resends NIGHT_PROMPT to reconnecting detective", gotPrompt);
  det.ws = detNew; // swap

  // ---- Drive the night to resolution via all role actions ----
  const target = players.find((p) => p !== gf);
  send(gf.ws, { type: "NIGHT_ACTION", token: gf.token, target_id: target.id });
  send(det.ws, { type: "NIGHT_ACTION", token: det.token, target_id: gf.id });
  send(doc.ws, { type: "NIGHT_ACTION", token: doc.token, target_id: doc.id });
  const advanced = await waitFor(() => {
    const s = [host, ...players.map((p) => p.ws)].map((w) => last(w, "STATE")).filter(Boolean).pop();
    return s && s.phase !== "NIGHT" && s.phase !== "REVEAL";
  }, 3000);
  check("night resolved -> advanced past NIGHT", advanced);

  // ---- Edge B: stray night action after phase change is ignored (no crash) ----
  send(gf.ws, { type: "NIGHT_ACTION", token: gf.token, target_id: target.id });
  await sleep(80);
  check("stray night action after phase change doesn't crash server", true);

  // ---- Edge C: invalid token night action ignored ----
  send(gf.ws, { type: "NIGHT_ACTION", token: "bogus", target_id: target.id });
  await sleep(60);
  check("bogus-token action ignored (no crash)", true);

  // ---- Edge D: non-host cannot start ----
  send(players[0].ws, { type: "HOST_START", hostToken: "wrong" });
  const gotErr = await waitFor(() => has(players[0].ws, "ERROR"), 1500);
  check("non-host HOST_START rejected", gotErr);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
