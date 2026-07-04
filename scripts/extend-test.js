// Verify the host "+30s" control pushes the live deadline out and re-narrates.
// Run against a normal-timer server, e.g.:  PORT=3003 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3003;
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
const narrKeys = (ws) => ws.inbox.filter((m) => m.type === "NARRATE").map((m) => m.key);
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log("  ok  -", n)) : (fail++, console.log("  FAIL-", n)); };

async function run() {
  const host = await mk();
  send(host, { type: "HOST_CREATE" });
  await sleep(150);
  const { code, hostToken } = last(host, "HOSTED");
  for (let i = 0; i < 5; i++) {
    const ws = await mk();
    send(ws, { type: "JOIN", code, name: "P" + i });
    await sleep(40);
  }
  await sleep(80);
  send(host, { type: "HOST_START", hostToken });
  await sleep(300);

  const nightState = last(host, "STATE");
  check("in NIGHT with a live deadline", nightState && nightState.phase === "NIGHT" && typeof nightState.deadline === "number");
  const before = nightState.deadline;

  host.inbox.length = 0; // clear so we catch the post-extend STATE + NARRATE
  send(host, { type: "HOST_EXTEND", hostToken, seconds: 30 });
  await sleep(250);

  const afterState = last(host, "STATE");
  check("extend pushed a fresh STATE", !!afterState && typeof afterState.deadline === "number");
  const delta = afterState.deadline - before;
  check("deadline moved out by ~30s (got " + Math.round(delta / 1000) + "s)", delta > 27000 && delta < 31000);
  check("still in NIGHT (extend didn't change phase)", afterState.phase === "NIGHT");
  check("Silas acknowledges the extra time", narrKeys(host).includes("time_extended"));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
