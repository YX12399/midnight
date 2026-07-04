// Verify Silas's "last call" warning narration fires before a phase auto-resolves.
// Run against a short-timer server, e.g.:
//   NIGHT_SECONDS=3 DISCUSSION_SECONDS=3 VOTE_SECONDS=3 PORT=3002 node server/index.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3002;
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

  // All phases = 3s (warn ~2s in). Nobody acts/votes, so round 1 runs
  // night -> morning -> discussion -> vote(tie). Let it play through, then
  // assert Silas raised the alarm in every timed phase.
  await sleep(10000);
  const keys = narrKeys(host);
  check("Silas gives a NIGHT last-call before dawn", keys.includes("night_last_call"));
  check("Silas gives a DISCUSSION last-call before the vote", keys.includes("discussion_last_call"));
  check("Silas gives a VOTE last-call before the tally", keys.includes("vote_last_call"));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
