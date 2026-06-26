// scripts/smoke-game.js
// End-to-end smoke test: boots the real server, plays a full 5-player game over
// WebSockets, and asserts (a) the game reaches a win and (b) NO role/secret ever
// leaks to a player who shouldn't see it (spec §8 hard rule).

process.env.PORT = process.env.PORT || "4577";
const assert = require("assert");
const WebSocket = require("ws");
const { server } = require("../server/index.js");

const PORT = process.env.PORT;
const URL = "ws://127.0.0.1:" + PORT + "/ws";

function conn() {
  const ws = new WebSocket(URL);
  ws.inbox = [];
  ws.handlers = {};
  ws.on("message", (b) => {
    const m = JSON.parse(b.toString());
    ws.inbox.push(m);
    (ws.handlers[m.type] || []).forEach((fn) => fn(m));
  });
  ws.send = ((orig) => (obj) => orig.call(ws, JSON.stringify(obj)))(ws.send);
  ws.on_ = (type, fn) => { (ws.handlers[type] = ws.handlers[type] || []).push(fn); };
  ws.once_ = (type) => new Promise((res) => ws.on_(type, function f(m) { res(m); }));
  return ws;
}
const open = (ws) => new Promise((r) => ws.on("open", r));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  await new Promise((r) => setTimeout(r, 300)); // let server bind

  // --- host ---
  const host = conn();
  await open(host);
  host.send({ type: "HOST_CREATE" });
  const hosted = await host.once_("HOSTED");
  const code = hosted.code;
  const hostToken = hosted.hostToken;
  assert.ok(code && hostToken, "host created game");

  // --- 5 players ---
  const NAMES = ["Yash", "Rosa", "Vic", "Sam", "Hank"];
  const players = [];
  for (const name of NAMES) {
    const ws = conn();
    await open(ws);
    ws.send({ type: "JOIN", code, name });
    const j = await ws.once_("JOINED");
    players.push({ ws, name, id: j.playerId, token: j.token, role: null });
  }
  await delay(100);

  // Each player only ever learns its OWN role.
  const roleOf = {};
  let detResult = null;
  players.forEach((p) => {
    p.ws.on_("ROLE_ASSIGNED", (m) => { p.role = m.role; roleOf[p.id] = m.role; });
    p.ws.on_("NIGHT_RESULT", (m) => { detResult = m.text; });
  });

  // --- start ---
  host.send({ type: "HOST_START", hostToken });

  // Wait until every player has been privately told their role.
  for (let i = 0; i < 50 && players.some((p) => !p.role); i++) await delay(20);
  players.forEach((p) => assert.ok(p.role, p.name + " got a role"));

  const gf = players.find((p) => p.role === "godfather");
  const det = players.find((p) => p.role === "detective");
  const doc = players.find((p) => p.role === "doctor");
  const citizens = players.filter((p) => p.role === "citizen");
  assert.ok(gf && det && doc && citizens.length === 2, "5p role split correct");

  // Wait until the night prompts have actually arrived — this guarantees the
  // server is in the NIGHT phase before we submit actions (avoids a race with
  // the opening narration).
  const hasPrompt = (p) => p.ws.inbox.some((m) => m.type === "NIGHT_PROMPT");
  for (let i = 0; i < 100 && !(hasPrompt(gf) && hasPrompt(det) && hasPrompt(doc)); i++) await delay(20);
  assert.ok(hasPrompt(gf) && hasPrompt(det) && hasPrompt(doc), "night prompts delivered");

  // --- night: GF kills citizen[0], doctor saves citizen[1], detective checks GF ---
  gf.ws.send({ type: "NIGHT_ACTION", token: gf.token, target_id: citizens[0].id });
  doc.ws.send({ type: "NIGHT_ACTION", token: doc.token, target_id: citizens[1].id });
  det.ws.send({ type: "NIGHT_ACTION", token: det.token, target_id: gf.id });

  for (let i = 0; i < 150 && !detResult; i++) await delay(20); // wait up to 3s
  // A "dirty" verdict uses one of several flavor lines; what matters is it is NOT the clean one.
  assert.ok(detResult, "detective received a private result");
  assert.ok(!/\bclean\b/i.test(detResult), "GF must NOT read clean — got: " + detResult);

  // citizen[0] should now be dead -> wait for DAY_DISCUSSION state
  await new Promise((res) => {
    host.on_("STATE", (m) => { if (m.phase === "DAY_DISCUSSION") res(); });
    setTimeout(res, 1500);
  });

  // --- day: open vote, everyone living lynches the godfather ---
  host.send({ type: "HOST_OPEN_VOTE", hostToken });
  await delay(150);
  const overP = new Promise((res) => host.on_("GAME_OVER", res));
  players.forEach((p) => {
    p.ws.on_("VOTE_PROMPT", () => p.ws.send({ type: "VOTE", token: p.token, target_id: gf.id }));
  });
  // trigger for already-living players who got the prompt
  players.filter((p) => p.alive !== false).forEach((p) => {
    const vp = p.ws.inbox.find((x) => x.type === "VOTE_PROMPT");
    if (vp) p.ws.send({ type: "VOTE", token: p.token, target_id: gf.id });
  });

  const over = await Promise.race([overP, delay(3000).then(() => null)]);
  assert.ok(over, "game reached GAME_OVER");
  assert.strictEqual(over.winner, "town", "town wins after lynching the lone GF");

  // --- ANTI-LEAK ASSERTIONS ---
  players.forEach((p) => {
    const roleEvents = p.ws.inbox.filter((m) => m.type === "ROLE_ASSIGNED");
    assert.strictEqual(roleEvents.length, 1, p.name + " received exactly one ROLE_ASSIGNED (their own)");
    const nr = p.ws.inbox.filter((m) => m.type === "NIGHT_RESULT");
    if (p.role !== "detective") assert.strictEqual(nr.length, 0, p.name + " (non-detective) got no NIGHT_RESULT");
  });
  // host (room channel) must NEVER receive a private role/result event
  const hostLeak = host.inbox.find((m) => ["ROLE_ASSIGNED", "NIGHT_PROMPT", "NIGHT_RESULT", "GHOST"].includes(m.type));
  assert.ok(!hostLeak, "room/host channel never received a private event");

  console.log("SMOKE TEST PASSED — full game, town win, zero leaks");
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e.message);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
