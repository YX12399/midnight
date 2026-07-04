// scripts/run-sockets.js
// Orchestrates the WebSocket integration tests: for each config it boots a fresh
// server child (with the right phase-timer env + an isolated port), waits until
// the port is accepting connections, runs the matching test child against it, and
// tears the server down. Exits non-zero if any suite fails — so a single
// `npm test` now covers the engine, the full-game smoke, AND every flow test.

const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Each suite gets its own port so a lingering socket can't bleed across runs.
const FAST = { RESOLVE_DELAY_MS: "0" }; // no anti-timing-leak jitter under test
const SUITES = [
  { name: "timer-test",  file: "timer-test.js",  port: 3401, env: { ...FAST, NIGHT_SECONDS: "1", DISCUSSION_SECONDS: "1", VOTE_SECONDS: "1", MORNING_SECONDS: "1", REVEAL_SECONDS: "0" } },
  { name: "edge-test",   file: "edge-test.js",   port: 3402, env: { ...FAST, NIGHT_SECONDS: "1", DISCUSSION_SECONDS: "1", VOTE_SECONDS: "1", MORNING_SECONDS: "1", REVEAL_SECONDS: "0" } },
  { name: "warn-test",   file: "warn-test.js",   port: 3403, env: { ...FAST, NIGHT_SECONDS: "3", DISCUSSION_SECONDS: "3", VOTE_SECONDS: "3", MORNING_SECONDS: "1", REVEAL_SECONDS: "0" } },
  { name: "extend-test", file: "extend-test.js", port: 3404, env: { ...FAST, MORNING_SECONDS: "1", REVEAL_SECONDS: "0" } }, // needs real (long) NIGHT
  { name: "ready-test",  file: "ready-test.js",  port: 3405, env: { ...FAST, NIGHT_SECONDS: "1", MORNING_SECONDS: "1", DISCUSSION_SECONDS: "30", VOTE_SECONDS: "45", REVEAL_SECONDS: "0" } },
  { name: "reveal-test", file: "reveal-test.js", port: 3406, env: { ...FAST, REVEAL_SECONDS: "2", NIGHT_SECONDS: "60" } },
  { name: "mafia-test",  file: "mafia-test.js",  port: 3407, env: { ...FAST, REVEAL_SECONDS: "0", NIGHT_SECONDS: "60" } },
  { name: "guard-test",  file: "guard-test.js",  port: 3408, env: { ...FAST, REVEAL_SECONDS: "0", NIGHT_SECONDS: "60", DISCUSSION_SECONDS: "60", VOTE_SECONDS: "60", MORNING_SECONDS: "1" } },
  { name: "rejoin-test", file: "rejoin-test.js", port: 3409, env: { ...FAST, REVEAL_SECONDS: "0", NIGHT_SECONDS: "60", DISCUSSION_SECONDS: "60", VOTE_SECONDS: "60", MORNING_SECONDS: "1" } },
];

function waitForPort(port, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.end(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error("server on :" + port + " never came up"));
        else setTimeout(attempt, 100);
      });
    })();
  });
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: Object.assign({}, process.env, env), stdio: "inherit" });
    child.on("exit", (code) => resolve(code == null ? 1 : code));
  });
}

async function runSuite(suite) {
  const serverEnv = Object.assign({ PORT: String(suite.port) }, suite.env);
  const server = spawn("node", ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, serverEnv),
    stdio: "ignore",
  });
  let code = 1;
  try {
    await waitForPort(suite.port);
    console.log("\n=== " + suite.name + " (server :" + suite.port + ") ===");
    code = await run("node", ["scripts/" + suite.file], { PORT: String(suite.port) });
  } catch (e) {
    console.error(suite.name + " ERROR:", e.message);
    code = 1;
  } finally {
    server.kill();
  }
  return { name: suite.name, ok: code === 0 };
}

(async () => {
  const results = [];
  for (const suite of SUITES) results.push(await runSuite(suite));

  console.log("\n──────── socket suites ────────");
  results.forEach((r) => console.log("  " + (r.ok ? "PASS" : "FAIL") + "  " + r.name));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error("\n" + failed.length + " socket suite(s) failed.");
    process.exit(1);
  }
  console.log("\nALL SOCKET SUITES PASSED");
})();
