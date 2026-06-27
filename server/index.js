// server/index.js
// MIDNIGHT — voice game-master server (spec §3-§10).
// HTTP static serving + WebSocket transport + phase orchestration.
// The pure rules live in core/logic.js; this file is the I/O layer.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const logic = require("../core/logic");
const { createVoiceProvider } = require("./voice/provider");
const TtsCache = require("./tts-cache");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 3000;

// ---- phase turn-timers (auto-resolve so one AFK player can't stall the table) ----
// Durations in seconds; override per-deploy via env. 0 disables that phase's timer.
const PHASE_SECONDS = {
  NIGHT: Number(process.env.NIGHT_SECONDS || 60),
  DAY_DISCUSSION: Number(process.env.DISCUSSION_SECONDS || 120),
  DAY_VOTE: Number(process.env.VOTE_SECONDS || 45),
};

// ---- config + content ------------------------------------------------------
function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return fallback;
  }
}
const voiceConfig = readJSON(path.join(ROOT, "config", "voice.json"), {
  provider: "browser",
});
const assets = readJSON(path.join(ROOT, "config", "assets.json"), {});
const script = readJSON(path.join(ROOT, "content", "script.json"), { lines: {} });

const voiceProvider = createVoiceProvider(voiceConfig);
const ttsCache = new TtsCache(voiceProvider);

// ---- narration helpers -----------------------------------------------------
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function fillTemplate(text, slots) {
  return text.replace(/\{(\w+)\}/g, (_, k) =>
    slots && slots[k] != null ? slots[k] : ""
  );
}
// Resolve a phase key + slots -> { text, audio_url }
async function narration(phaseKey, slots) {
  const variants = (script.lines && script.lines[phaseKey]) || [phaseKey];
  const raw = pick(variants);
  const text = fillTemplate(raw, slots).trim();
  let audio_url = null;
  try {
    audio_url = await ttsCache.urlFor(text); // null => clients use browser TTS
  } catch (e) {
    audio_url = null;
  }
  return { text, audio_url, key: phaseKey };
}

// ---- games -----------------------------------------------------------------
/** @type {Map<string, Game>} */
const games = new Map();

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++)
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (games.has(code));
  return code;
}
const newToken = () => crypto.randomBytes(16).toString("hex");
const newId = () => crypto.randomBytes(6).toString("hex");

function createGame() {
  const code = newCode();
  const game = {
    code,
    hostToken: newToken(),
    hostSockets: new Set(),
    tableSockets: new Set(),
    players: [], // {id,name,role,alive,revealed,token,socket}
    phase: "LOBBY",
    round: 0,
    recording: false, // opt-in (spec §6)
    nightActions: { gf: {}, detective: undefined, doctor: undefined },
    votes: {}, // voterId -> targetId | 'skip'
    timer: null, // active phase timer handle (setTimeout)
    deadline: null, // epoch ms when current phase auto-resolves (null = no timer)
    createdAt: Date.now(),
  };
  games.set(code, game);
  return game;
}

// ---- transport helpers -----------------------------------------------------
function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// THE ANTI-LEAK CHOKEPOINT (spec §8 "Hard rule").
// These event types carry hidden roles / night results and may travel ONLY on a
// player's private channel. Any attempt to broadcast them throws — leaks become
// impossible by construction, not by discipline.
const PRIVATE_ONLY = new Set([
  "ROLE_ASSIGNED",
  "NIGHT_PROMPT",
  "NIGHT_RESULT",
  "GHOST",
]);
function assertBroadcastSafe(event) {
  if (PRIVATE_ONLY.has(event.type)) {
    throw new Error(
      "ANTI-LEAK VIOLATION: tried to broadcast private event " + event.type
    );
  }
}

function sendPrivate(game, playerId, event) {
  const p = logic.byId(game.players, playerId);
  if (p && p.socket) send(p.socket, event);
}
// Room = host device speaker + optional table view. Full theater (audio).
function broadcastRoom(game, event) {
  assertBroadcastSafe(event);
  game.hostSockets.forEach((ws) => send(ws, event));
  game.tableSockets.forEach((ws) => send(ws, event));
}
// Everyone (host, table, all phones). Used for public STATE + captions.
function broadcastAll(game, event) {
  assertBroadcastSafe(event);
  broadcastRoom(game, event);
  game.players.forEach((p) => p.socket && send(p.socket, event));
}

// ---- phase timers (auto-resolve on expiry; spec robustness) ----------------
// Arms a server-side timeout that calls onExpire() if the host/players haven't
// already advanced the phase. Re-arming or clearing always cancels the prior one,
// so timers can never stack or fire against a stale phase.
function clearTimer(game) {
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
  game.deadline = null;
}
function armTimer(game, phase, onExpire) {
  clearTimer(game);
  const secs = PHASE_SECONDS[phase] || 0;
  if (secs <= 0) return; // disabled for this phase
  const armedPhase = phase;
  game.deadline = Date.now() + secs * 1000;
  game.timer = setTimeout(() => {
    game.timer = null;
    game.deadline = null;
    // Guard: only fire if we're still in the very phase this timer was armed for.
    if (game.phase !== armedPhase) return;
    Promise.resolve(onExpire()).catch((e) => console.error("timer expiry error:", e));
  }, secs * 1000);
}

function publicState(game) {
  return {
    type: "STATE",
    phase: game.phase,
    round: game.round,
    recording: game.recording,
    deadline: game.deadline, // epoch ms for the active phase timer (null if none)
    alive: game.players
      .filter((p) => p.alive)
      .map((p) => ({ id: p.id, name: p.name })),
    // Night-killed players stay face-down (role hidden); lynched players are revealed.
    dead: game.players
      .filter((p) => !p.alive)
      .map((p) => ({
        id: p.id,
        name: p.name,
        role: p.revealed ? p.role : null,
      })),
  };
}
function pushState(game) {
  broadcastAll(game, publicState(game));
}

// Public narration -> room gets audio+text, phones get captions only.
async function narrate(game, phaseKey, slots) {
  const n = await narration(phaseKey, slots);
  broadcastRoom(game, {
    type: "NARRATE",
    key: n.key,
    text: n.text,
    audio_url: n.audio_url,
  });
  game.players.forEach(
    (p) => p.socket && send(p.socket, { type: "CAPTION", text: n.text })
  );
  return n;
}

// ---- role flavor -----------------------------------------------------------
const ROLE_BLURB = {
  godfather:
    "You run the family. Each night, you and yours choose who disappears. Stay cold. Stay quiet.",
  detective:
    "You read people for a living. Each night you can check one name against the ledger — clean or dirty.",
  doctor:
    "You patch up this town. Each night you can shield one soul from the family's bullet.",
  citizen:
    "You're an honest regular at Midnight. No powers — just your gut and your vote. Find the rats.",
};
function roleArt(role) {
  return (assets.roles && assets.roles[role]) || "";
}

// ---- night helpers ---------------------------------------------------------
function livingByRole(game, role) {
  return game.players.filter((p) => p.alive && p.role === role);
}
function targetsExcluding(game, excludeId) {
  return game.players
    .filter((p) => p.alive && p.id !== excludeId)
    .map((p) => ({ id: p.id, name: p.name }));
}
function allLivingTargets(game) {
  return game.players
    .filter((p) => p.alive)
    .map((p) => ({ id: p.id, name: p.name }));
}

// ---- bots (solo testing) ---------------------------------------------------
const BOT_NAMES = ["Bugsy", "Lucky", "Dutch", "Vera", "Mickey", "Sal", "Rita", "Knuckles", "Dot", "Moe", "Gloria", "Ace"];
function addBots(game, count) {
  let added = 0;
  for (let i = 0; i < count && game.players.length < 12; i++) {
    const used = new Set(game.players.map((p) => p.name.replace(/^🤖 /, "")));
    const base = BOT_NAMES.find((n) => !used.has(n)) || "Bot" + (game.players.length + 1);
    game.players.push({
      id: newId(), name: base, role: undefined, alive: true, revealed: false,
      token: newToken(), socket: null, bot: true,
    });
    added++;
  }
  return added;
}
const hasLivingHumans = (game) => game.players.some((p) => p.alive && !p.bot);

// Bots pick their night actions (random, role-appropriate), then resolve if done.
function botNight(game) {
  if (game.phase !== "NIGHT") return;
  livingByRole(game, "godfather").filter((p) => p.bot).forEach((gf) => {
    if (game.nightActions.gf[gf.id] === undefined) {
      const town = game.players.filter((p) => p.alive && p.id !== gf.id && logic.TEAM[p.role] !== "mafia");
      const any = game.players.filter((p) => p.alive && p.id !== gf.id);
      const t = pick(town.length ? town : any);
      game.nightActions.gf[gf.id] = t ? t.id : null;
    }
  });
  const det = livingByRole(game, "detective").find((p) => p.bot);
  if (det && game.nightActions.detective === undefined) {
    const targets = game.players.filter((p) => p.alive && p.id !== det.id);
    if (targets.length) game.nightActions.detective = pick(targets).id;
  }
  const doc = livingByRole(game, "doctor").find((p) => p.bot);
  if (doc && game.nightActions.doctor === undefined) {
    const targets = game.players.filter((p) => p.alive);
    if (targets.length) game.nightActions.doctor = pick(targets).id;
  }
  if (nightComplete(game)) resolveNight(game);
}
// Bots cast random votes (never themselves), then resolve if done.
function botVote(game) {
  if (game.phase !== "DAY_VOTE") return;
  game.players.filter((p) => p.alive && p.bot).forEach((b) => {
    if (game.votes[b.id] === undefined) {
      const targets = game.players.filter((p) => p.alive && p.id !== b.id);
      game.votes[b.id] = targets.length ? pick(targets).id : "skip";
    }
  });
  if (voteComplete(game)) resolveVote(game);
}

async function startNight(game) {
  game.round += 1;
  game.phase = "NIGHT";
  game.nightActions = { gf: {}, detective: undefined, doctor: undefined };
  // Arm before pushState so the broadcast STATE carries the countdown deadline.
  armTimer(game, "NIGHT", () => resolveNight(game));
  pushState(game);
  await narrate(game, "night_falls");

  // Private prompts (chokepoint: all via sendPrivate).
  livingByRole(game, "godfather").forEach((gf) => {
    sendPrivate(game, gf.id, {
      type: "NIGHT_PROMPT",
      role: "godfather",
      prompt: pick(script.lines.mafia_prompt),
      valid_targets: targetsExcluding(game, gf.id),
    });
  });
  livingByRole(game, "detective").forEach((d) => {
    sendPrivate(game, d.id, {
      type: "NIGHT_PROMPT",
      role: "detective",
      prompt: pick(script.lines.detective_prompt),
      valid_targets: targetsExcluding(game, d.id),
    });
  });
  livingByRole(game, "doctor").forEach((d) => {
    sendPrivate(game, d.id, {
      type: "NIGHT_PROMPT",
      role: "doctor",
      prompt: pick(script.lines.doctor_prompt),
      valid_targets: allLivingTargets(game), // doctor may save self
    });
  });
  // Citizens (and powerless) just sleep.
  game.players
    .filter((p) => p.alive && p.role === "citizen")
    .forEach((p) =>
      sendPrivate(game, p.id, { type: "NIGHT_WAIT", text: "Eyes closed. Sleep tight." })
    );

  // Bots take their turn shortly after (humans still act on their own).
  if (game.players.some((p) => p.bot)) setTimeout(() => botNight(game), 1200);
}

function nightComplete(game) {
  const gfs = livingByRole(game, "godfather");
  const det = livingByRole(game, "detective");
  const doc = livingByRole(game, "doctor");
  const gfDone = gfs.every((g) => game.nightActions.gf[g.id] !== undefined);
  const detDone = det.length === 0 || game.nightActions.detective !== undefined;
  const docDone = doc.length === 0 || game.nightActions.doctor !== undefined;
  return gfDone && detDone && docDone;
}

function mafiaTarget(game) {
  // Plurality among godfather submissions; first-seen wins ties.
  const votes = game.nightActions.gf;
  const tally = {};
  let best = null;
  let bestN = 0;
  Object.keys(votes).forEach((gfId) => {
    const t = votes[gfId];
    if (!t) return;
    tally[t] = (tally[t] || 0) + 1;
    if (tally[t] > bestN) {
      bestN = tally[t];
      best = t;
    }
  });
  return best;
}

async function resolveNight(game) {
  if (game.phase !== "NIGHT") return; // already resolved (guard vs. double-trigger)
  clearTimer(game);
  game.phase = "RESOLVING"; // claim the transition so a racing call bails above
  const actions = {
    godfather_target: mafiaTarget(game),
    doctor_save: game.nightActions.doctor || null,
    detective_query: game.nightActions.detective || null,
  };
  const result = logic.resolveNight(game.players, actions);

  // Private detective result (chokepoint).
  if (result.detective) {
    const det = livingByRole(game, "detective")[0];
    if (det) {
      const key =
        result.detective.verdict === "dirty"
          ? "detective_result_dirty"
          : "detective_result_clean";
      const line = fillTemplate(pick(script.lines[key]), {
        NAME: result.detective.name,
      });
      sendPrivate(game, det.id, { type: "NIGHT_RESULT", text: line });
    }
  }

  // Apply death (role stays hidden for night kills).
  if (result.deathId) {
    game.players = game.players.map((p) =>
      p.id === result.deathId ? Object.assign({}, p, { alive: false }) : p
    );
    rebindSockets(game); // keep socket refs after map()
    sendGhost(game, result.deathId);
  }

  game.phase = "MORNING";
  pushState(game);
  if (result.deathId) await narrate(game, "morning_death", { NAME: result.deathName });
  else await narrate(game, "morning_no_death");

  const outcome = logic.checkWin(game.players);
  if (outcome !== "continue") return endGame(game, outcome);

  await startDiscussion(game);
}

// ---- day -------------------------------------------------------------------
async function startDiscussion(game) {
  game.phase = "DAY_DISCUSSION";
  // Arm before pushState so the STATE broadcast carries the countdown deadline.
  armTimer(game, "DAY_DISCUSSION", () => startVote(game));
  pushState(game);
  await narrate(game, "day_discussion");
  // No living humans to talk it out (pure bot test) -> move to the vote quickly.
  if (!hasLivingHumans(game)) setTimeout(() => startVote(game), 3500);
}

async function startVote(game) {
  if (game.phase === "DAY_VOTE") return; // already open (guard vs. double-trigger)
  game.phase = "DAY_VOTE";
  game.votes = {};
  // Arm before pushState so the STATE broadcast carries the countdown deadline.
  armTimer(game, "DAY_VOTE", () => resolveVote(game));
  pushState(game);
  await narrate(game, "vote_call");
  const targets = allLivingTargets(game);
  game.players
    .filter((p) => p.alive)
    .forEach((p) =>
      send(p.socket, { type: "VOTE_PROMPT", valid_targets: targets })
    );

  // Bots vote shortly after (humans still vote on their own).
  if (game.players.some((p) => p.bot)) setTimeout(() => botVote(game), 1200);
}

function voteComplete(game) {
  const living = game.players.filter((p) => p.alive);
  return living.every((p) => game.votes[p.id] !== undefined);
}

async function resolveVote(game) {
  if (game.phase !== "DAY_VOTE") return; // already resolved (guard vs. double-trigger)
  clearTimer(game);
  game.phase = "RESOLVING"; // claim the transition so a racing call bails above
  const result = logic.tallyVotes(game.players, game.votes);
  broadcastRoom(game, { type: "VOTE_TALLY", tally: result.tally });

  if (result.tie || !result.eliminatedId) {
    game.phase = "MORNING";
    pushState(game);
    await narrate(game, "vote_tie");
  } else {
    game.players = game.players.map((p) =>
      p.id === result.eliminatedId
        ? Object.assign({}, p, { alive: false, revealed: true })
        : p
    );
    rebindSockets(game);
    sendGhost(game, result.eliminatedId);
    pushState(game);
    await narrate(game, "elimination", {
      NAME: result.eliminatedName,
      ROLE: roleLabel(result.role),
    });
  }

  const outcome = logic.checkWin(game.players);
  if (outcome !== "continue") return endGame(game, outcome);
  await startNight(game);
}

function roleLabel(role) {
  return { godfather: "the Godfather", detective: "the Detective", doctor: "the Doctor", citizen: "just a Citizen" }[role] || role;
}

// ---- ghost mode (spec §11) -------------------------------------------------
function sendGhost(game, playerId) {
  sendPrivate(game, playerId, {
    type: "GHOST",
    roles: game.players.map((p) => ({
      name: p.name,
      role: p.role,
      alive: p.alive,
    })),
  });
}

// ---- end -------------------------------------------------------------------
async function endGame(game, outcome) {
  clearTimer(game);
  game.phase = "END";
  game.players = game.players.map((p) => Object.assign({}, p, { revealed: true }));
  rebindSockets(game);
  pushState(game);
  await narrate(game, outcome === "town_win" ? "town_win" : "mafia_win");
  const reveal = {
    type: "GAME_OVER",
    winner: outcome === "town_win" ? "town" : "mafia",
    art_url:
      outcome === "town_win"
        ? assets.cards && assets.cards.victory_town
        : assets.cards && assets.cards.victory_mafia,
    roles: game.players.map((p) => ({ name: p.name, role: p.role })),
  };
  broadcastAll(game, reveal);
}

function restartGame(game) {
  clearTimer(game);
  game.phase = "LOBBY";
  game.round = 0;
  game.votes = {};
  game.nightActions = { gf: {}, detective: undefined, doctor: undefined };
  game.players = game.players.map((p) =>
    Object.assign({}, p, { role: undefined, alive: true, revealed: false })
  );
  rebindSockets(game);
  pushState(game);
  broadcastRoom(game, rosterEvent(game));
}

// logic.* returns NEW arrays (pure), so socket refs need re-attaching by id.
function rebindSockets(game) {
  // no-op placeholder: we keep sockets on the player objects, and our map()
  // calls use Object.assign copying the socket field, so refs survive.
  // (Kept as a single chokepoint in case the engine is swapped for one that
  // strips non-spec fields.)
}

// ---- start game ------------------------------------------------------------
async function startGame(game) {
  if (game.players.length < 5)
    return { error: "Need at least 5 players to start (have " + game.players.length + ")." };
  if (game.players.length > 12)
    return { error: "Max 12 players." };

  const ids = game.players.map((p) => p.id);
  const roleMap = logic.assignRoles(ids);
  game.players = game.players.map((p) =>
    Object.assign({}, p, { role: roleMap[p.id], alive: true, revealed: false })
  );
  rebindSockets(game);

  // Private role reveal (chokepoint).
  game.players.forEach((p) => {
    sendPrivate(game, p.id, {
      type: "ROLE_ASSIGNED",
      role: p.role,
      team: logic.TEAM[p.role],
      art_url: roleArt(p.role),
      blurb: ROLE_BLURB[p.role],
    });
  });

  game.phase = "REVEAL";
  pushState(game);
  await narrate(game, "game_start");
  await startNight(game);
  return { ok: true };
}

// ---- roster ----------------------------------------------------------------
function rosterEvent(game) {
  return {
    type: "ROSTER",
    code: game.code,
    count: game.players.length,
    players: game.players.map((p) => ({ id: p.id, name: p.name, connected: !!p.socket, bot: !!p.bot })),
  };
}

// ---- HTTP static -----------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".webmanifest": "application/manifest+json",
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  let pathname = decodeURIComponent(url.pathname);

  // cached TTS audio
  if (pathname.startsWith("/tts/")) {
    const file = ttsCache.resolve(pathname.slice("/tts/".length));
    if (file) return serveFile(res, file);
    res.writeHead(404);
    return res.end("no audio");
  }

  // expose config (assets only — never secrets)
  if (pathname === "/config/assets.json") return serveFile(res, path.join(ROOT, "config", "assets.json"));

  // routes
  if (pathname === "/" || pathname === "/phone" || pathname === "/phone/")
    return serveFile(res, path.join(ROOT, "web", "phone", "index.html"));
  if (pathname === "/host" || pathname === "/host/")
    return serveFile(res, path.join(ROOT, "web", "host", "index.html"));
  if (pathname === "/table" || pathname === "/table/")
    return serveFile(res, path.join(ROOT, "web", "table", "index.html"));
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, games: games.size, voice: voiceProvider.name }));
  }

  // static assets under /web and /core
  const candidates = [
    path.join(ROOT, "web", pathname.replace(/^\//, "")),
    path.join(ROOT, pathname.replace(/^\//, "")),
  ];
  for (const c of candidates) {
    if (c.startsWith(ROOT) && fs.existsSync(c) && fs.statSync(c).isFile())
      return serveFile(res, c);
  }
  res.writeHead(404);
  res.end("Not found");
});

// ---- WebSocket -------------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws._role = null;
  ws._code = null;
  ws._playerId = null;

  ws.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (e) {
      return send(ws, { type: "ERROR", message: "bad json" });
    }
    try {
      await handle(ws, msg);
    } catch (e) {
      console.error("handler error:", e);
      send(ws, { type: "ERROR", message: e.message });
    }
  });

  ws.on("close", () => {
    const game = ws._code && games.get(ws._code);
    if (!game) return;
    if (ws._role === "host") game.hostSockets.delete(ws);
    if (ws._role === "table") game.tableSockets.delete(ws);
    if (ws._role === "player" && ws._playerId) {
      const p = logic.byId(game.players, ws._playerId);
      if (p && p.socket === ws) p.socket = null; // keep record for rejoin
      broadcastRoom(game, rosterEvent(game));
    }
  });
});

function requireHost(game, msg) {
  if (!game || game.hostToken !== msg.hostToken) throw new Error("not host");
}
function playerByToken(game, token) {
  return game && game.players.find((p) => p.token === token);
}

async function handle(ws, msg) {
  switch (msg.type) {
    case "HOST_CREATE": {
      const game = createGame();
      ws._role = "host";
      ws._code = game.code;
      game.hostSockets.add(ws);
      send(ws, {
        type: "HOSTED",
        code: game.code,
        hostToken: game.hostToken,
        voice: voiceProvider.name,
      });
      send(ws, rosterEvent(game));
      send(ws, publicState(game));
      return;
    }

    case "HOST_RECONNECT": {
      const game = games.get(msg.code);
      requireHost(game, msg);
      ws._role = "host";
      ws._code = game.code;
      game.hostSockets.add(ws);
      send(ws, rosterEvent(game));
      send(ws, publicState(game));
      return;
    }

    case "TABLE_JOIN": {
      const game = games.get((msg.code || "").toUpperCase());
      if (!game) return send(ws, { type: "ERROR", message: "no such game" });
      ws._role = "table";
      ws._code = game.code;
      game.tableSockets.add(ws);
      send(ws, publicState(game));
      return;
    }

    case "JOIN": {
      const game = games.get((msg.code || "").toUpperCase());
      if (!game) return send(ws, { type: "ERROR", message: "No game with that code." });
      if (game.phase !== "LOBBY")
        return send(ws, { type: "ERROR", message: "That game already started." });
      const name = (msg.name || "").trim().slice(0, 20) || "Stranger";
      if (game.players.length >= 12)
        return send(ws, { type: "ERROR", message: "Table's full (12 max)." });
      const player = {
        id: newId(),
        name,
        role: undefined,
        alive: true,
        revealed: false,
        token: newToken(),
        socket: ws,
      };
      game.players.push(player);
      ws._role = "player";
      ws._code = game.code;
      ws._playerId = player.id;
      send(ws, {
        type: "JOINED",
        playerId: player.id,
        token: player.token,
        name: player.name,
        code: game.code,
      });
      send(ws, publicState(game));
      broadcastRoom(game, rosterEvent(game));
      return;
    }

    case "REJOIN": {
      const game = games.get((msg.code || "").toUpperCase());
      if (!game) return send(ws, { type: "ERROR", message: "no game" });
      const p = playerByToken(game, msg.token);
      if (!p) return send(ws, { type: "ERROR", message: "unknown session" });
      p.socket = ws;
      ws._role = "player";
      ws._code = game.code;
      ws._playerId = p.id;
      send(ws, { type: "JOINED", playerId: p.id, token: p.token, name: p.name, code: game.code });
      // resend their private context
      if (p.role) {
        send(ws, {
          type: "ROLE_ASSIGNED",
          role: p.role,
          team: logic.TEAM[p.role],
          art_url: roleArt(p.role),
          blurb: ROLE_BLURB[p.role],
        });
      }
      if (!p.alive) sendGhost(game, p.id);
      // Restore the player's *active* prompt so a mid-phase reconnect can still
      // act (phones lock / backgrounded tabs drop the socket constantly). Without
      // this, a dropped detective/doctor/voter silently stalls the whole game.
      if (p.alive) {
        if (game.phase === "NIGHT") {
          if (p.role === "godfather" && game.nightActions.gf[p.id] === undefined) {
            send(ws, { type: "NIGHT_PROMPT", role: "godfather",
              prompt: pick(script.lines.mafia_prompt), valid_targets: targetsExcluding(game, p.id) });
          } else if (p.role === "detective" && game.nightActions.detective === undefined) {
            send(ws, { type: "NIGHT_PROMPT", role: "detective",
              prompt: pick(script.lines.detective_prompt), valid_targets: targetsExcluding(game, p.id) });
          } else if (p.role === "doctor" && game.nightActions.doctor === undefined) {
            send(ws, { type: "NIGHT_PROMPT", role: "doctor",
              prompt: pick(script.lines.doctor_prompt), valid_targets: allLivingTargets(game) });
          } else {
            send(ws, { type: "NIGHT_WAIT", text: "Eyes closed. Sleep tight." });
          }
        } else if (game.phase === "DAY_VOTE" && game.votes[p.id] === undefined) {
          send(ws, { type: "VOTE_PROMPT", valid_targets: allLivingTargets(game) });
        }
      }
      send(ws, publicState(game));
      broadcastRoom(game, rosterEvent(game));
      return;
    }

    case "HOST_SET_RECORDING": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      game.recording = !!msg.value; // opt-in per game (spec §6)
      pushState(game);
      return;
    }

    case "HOST_ADD_BOTS": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      if (game.phase !== "LOBBY") return;
      const count = Math.max(1, Math.min(11, Number(msg.count) || 1));
      addBots(game, count);
      broadcastRoom(game, rosterEvent(game));
      pushState(game);
      return;
    }

    case "HOST_START": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      const r = await startGame(game);
      if (r && r.error) send(ws, { type: "ERROR", message: r.error });
      return;
    }

    case "NIGHT_ACTION": {
      const game = games.get(ws._code);
      const p = playerByToken(game, msg.token);
      if (!p || !p.alive || game.phase !== "NIGHT") return;
      const target = msg.target_id || null;
      if (p.role === "godfather") game.nightActions.gf[p.id] = target;
      else if (p.role === "detective") game.nightActions.detective = target;
      else if (p.role === "doctor") game.nightActions.doctor = target;
      else return;
      send(ws, { type: "ACTION_ACK" });
      if (nightComplete(game)) await resolveNight(game);
      return;
    }

    case "HOST_RESOLVE_NIGHT": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      if (game.phase === "NIGHT") await resolveNight(game);
      return;
    }

    case "HOST_OPEN_VOTE": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      if (game.phase === "DAY_DISCUSSION") await startVote(game);
      return;
    }

    case "VOTE": {
      const game = games.get(ws._code);
      const p = playerByToken(game, msg.token);
      if (!p || !p.alive || game.phase !== "DAY_VOTE") return;
      game.votes[p.id] = msg.target_id || "skip";
      send(ws, { type: "VOTE_ACK", target_id: game.votes[p.id] });
      broadcastRoom(game, {
        type: "VOTE_PROGRESS",
        cast: Object.keys(game.votes).length,
        total: game.players.filter((x) => x.alive).length,
      });
      if (voteComplete(game)) await resolveVote(game);
      return;
    }

    case "HOST_RESOLVE_VOTE": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      if (game.phase === "DAY_VOTE") await resolveVote(game);
      return;
    }

    case "HOST_RESTART": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      restartGame(game);
      return;
    }

    default:
      send(ws, { type: "ERROR", message: "unknown message: " + msg.type });
  }
}

// ---- housekeeping: sweep stale games every 30 min --------------------------
setInterval(() => {
  const now = Date.now();
  for (const [code, g] of games) {
    if (now - g.createdAt > 6 * 60 * 60 * 1000) {
      clearTimer(g);
      games.delete(code);
    }
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log("MIDNIGHT server on :" + PORT + " | voice provider: " + voiceProvider.name);
});

module.exports = { server, games, startGame }; // for tests
