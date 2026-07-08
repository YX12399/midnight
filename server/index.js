// server/index.js
// MIDNIGHT — voice game-master server (spec §3-§10).
// HTTP static serving + WebSocket transport + phase orchestration.
// The pure rules live in core/logic.js; this file is the I/O layer.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// First non-internal IPv4 — so the voice host (which must run on localhost for a
// secure mic context) can still print a phone-reachable QR to the LAN address.
function lanIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

const logic = require("../core/logic");
const { createVoiceProvider } = require("./voice/provider");
const TtsCache = require("./tts-cache");

const ROOT = path.join(__dirname, "..");

// Load .env (no dependency) so ELEVENLABS_API_KEY et al. can live in a file
// instead of being exported by hand. Existing process env always wins.
(function loadDotenv() {
  try {
    const envPath = path.join(ROOT, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch (_) { /* a malformed .env should never crash the server */ }
})();

const PORT = process.env.PORT || 3000;

// ---- phase turn-timers (auto-resolve so one AFK player can't stall the table) ----
// Durations in seconds; override per-deploy via env. 0 disables that phase's timer.
//  · NIGHT is a backstop only — it resolves the instant every actor has moved
//    (nightComplete), so the family gets just enough time and no dead air.
//  · DAY_DISCUSSION runs long by default, but ends early the moment every living
//    player taps Ready (or the host calls the vote), and can be stretched +30s.
const PHASE_SECONDS = {
  NIGHT: Number(process.env.NIGHT_SECONDS || 75),
  DAY_DISCUSSION: Number(process.env.DISCUSSION_SECONDS || 180),
  DAY_VOTE: Number(process.env.VOTE_SECONDS || 45),
};
// The morning beat: a short, un-timed hold so a death lands before the day opens.
const MORNING_SECONDS = Number(process.env.MORNING_SECONDS != null ? process.env.MORNING_SECONDS : 6);
// The reveal beat: hold on the role card long enough to actually memorise it
// before night falls and the phone swaps to the action screen.
const REVEAL_SECONDS = Number(process.env.REVEAL_SECONDS != null ? process.env.REVEAL_SECONDS : 9);
// Anti-timing-leak jitter: when the last night actor submits, the night resolves
// after a short random delay instead of instantly — so the room can't clock
// exactly when (or that) the power roles finished. 0 disables (tests pin this).
const RESOLVE_DELAY_MS = Number(process.env.RESOLVE_DELAY_MS != null ? process.env.RESOLVE_DELAY_MS : 2500);

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
    ready: {}, // voterId -> true, during DAY_DISCUSSION (all ready -> vote opens early)
    timer: null, // active phase timer handle (setTimeout)
    warnTimer: null, // "last call" warning handle, fires before the deadline
    deadline: null, // epoch ms when current phase auto-resolves (null = no timer)
    timerPhase: null, // phase the active timer was armed for (for extend/re-arm)
    onExpire: null, // stashed expiry callback (so a host extend can re-arm it)
    onWarn: null, // stashed last-call callback
    resolveTimer: null, // jittered night-resolve handle (anti timing-leak)
    epoch: 0, // bumped on deal/restart — stale awaits & timers check it and bail
    allReadyFired: false, // debounce for the all-ready early vote
    lastNarration: null, // {text, art_url} — replayed to reconnecting host/table
    lastNightResult: null, // {playerId, round, text} — replayed to a rejoining detective
    lastGameOver: null, // full GAME_OVER payload — replayed to anyone reconnecting at END
    lastActivity: Date.now(), // any handled message bumps this (sweeper input)
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
  "NIGHT_WAIT",
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
  if (game.warnTimer) clearTimeout(game.warnTimer);
  if (game.resolveTimer) clearTimeout(game.resolveTimer);
  game.timer = null;
  game.warnTimer = null;
  game.resolveTimer = null;
  game.deadline = null;
  game.timerPhase = null;
  game.onExpire = null;
  game.onWarn = null;
}
// onWarn (optional) fires once, `lead` seconds before expiry, so Silas can call
// "last orders" while there's still time to act — the tension beat that makes a
// silent countdown feel alive. Skipped when the phase is too short to warrant it.
function armTimer(game, phase, onExpire, onWarn) {
  armTimerSecs(game, phase, PHASE_SECONDS[phase] || 0, onExpire, onWarn);
}
// Arm with an explicit duration. The expiry/warn callbacks are stashed on the
// game so the timer can be re-armed later (e.g. a host "+30s" extend) without
// the caller having to re-thread the closures.
function armTimerSecs(game, phase, secs, onExpire, onWarn) {
  clearTimer(game);
  if (secs <= 0) return; // disabled for this phase
  const armedPhase = phase;
  game.timerPhase = phase;
  game.onExpire = onExpire;
  game.onWarn = onWarn;
  game.deadline = Date.now() + secs * 1000;
  const lead = secs > 20 ? 10 : Math.max(1, Math.floor(secs / 3));
  if (onWarn && secs - lead >= 1) {
    game.warnTimer = setTimeout(() => {
      game.warnTimer = null;
      if (game.phase !== armedPhase) return; // phase already moved on
      Promise.resolve(onWarn()).catch((e) => console.error("timer warn error:", e));
    }, (secs - lead) * 1000);
  }
  game.timer = setTimeout(() => {
    game.timer = null;
    game.deadline = null;
    // Guard: only fire if we're still in the very phase this timer was armed for.
    if (game.phase !== armedPhase) return;
    Promise.resolve(onExpire()).catch((e) => console.error("timer expiry error:", e));
  }, secs * 1000);
}
// Host "give them more time": push the current deadline out by addSecs and
// re-arm (so the auto-resolve and last-call warning both shift with it). Returns
// the new remaining seconds, or null if no timed phase is currently running.
function extendDeadline(game, addSecs) {
  if (!game.timer || !game.deadline) return null;
  const phase = game.timerPhase, onExpire = game.onExpire, onWarn = game.onWarn;
  const remain = Math.max(0, Math.round((game.deadline - Date.now()) / 1000));
  const next = remain + addSecs;
  armTimerSecs(game, phase, next, onExpire, onWarn);
  return next;
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

// Public narration -> room gets audio+text (+optional art), phones get captions.
async function narrate(game, phaseKey, slots, artUrl) {
  const n = await narration(phaseKey, slots);
  game.lastNarration = { text: n.text, art_url: artUrl || null }; // for reconnect replay
  broadcastRoom(game, {
    type: "NARRATE",
    key: n.key,
    text: n.text,
    audio_url: n.audio_url,
    art_url: artUrl || null, // e.g. the death card on the morning a body is found
  });
  game.players.forEach(
    (p) => p.socket && send(p.socket, { type: "CAPTION", text: n.text })
  );
  return n;
}
function deathArt() {
  return (assets.cards && assets.cards.death) || "";
}
// Ad-hoc Silas line — a conversational ack/clarification the voice GM triggers
// (roster read-out, "didn't catch that", confirm prompts). Speaks through the
// SAME narrate pipeline (so a known script key plays in Vlad's prebaked voice,
// and arbitrary text falls through to runtime TTS), but is marked `ephemeral`
// and does NOT overwrite game.lastNarration — a reconnect still replays the real
// phase line, not a throwaway ack.
async function sayAdhoc(game, keyOrText, slots) {
  const n = await narration(keyOrText, slots);
  broadcastRoom(game, { type: "NARRATE", key: n.key, text: n.text, audio_url: n.audio_url, art_url: null, ephemeral: true });
  game.players.forEach((p) => p.socket && send(p.socket, { type: "CAPTION", text: n.text }));
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
// Stable per-string hash so a given player always gets the same variant
// (survives reconnects — the seed is the player id).
function hashInt(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) | 0;
  return Math.abs(h);
}
// A role's art. If assets.role_variants[role] holds several portraits (e.g. many
// distinct townsfolk / mafia faces), pick one deterministically by seed so the
// table feels populated with individuals rather than clones. Falls back to the
// single assets.roles[role], then to "" (CSS/emoji art).
function roleArt(role, seed) {
  const variants = assets.role_variants && assets.role_variants[role];
  if (Array.isArray(variants) && variants.length)
    return variants[seed != null ? hashInt(seed) % variants.length : 0];
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
// The mafia don't kill their own — a godfather's marks are the living TOWN only.
function nonMafiaTargets(game) {
  return game.players
    .filter((p) => p.alive && logic.TEAM[p.role] !== "mafia")
    .map((p) => ({ id: p.id, name: p.name }));
}
// Fellow-mafia names (known from the deal, so the family can coordinate). Includes
// the dead — you still knew who they were.
function mafiaAllyNames(game, exceptId) {
  return game.players
    .filter((p) => logic.TEAM[p.role] === "mafia" && p.id !== exceptId)
    .map((p) => p.name);
}

// The night prompt for a given living player. EVERY role gets one — citizens
// included. A citizen's pick is pure theater (the server ignores it), but it
// means a shoulder-surfer sees the same "pick a name" screen on every phone,
// so the night screen itself can't out a power role.
function buildNightPrompt(game, p) {
  if (p.role === "godfather")
    return { type: "NIGHT_PROMPT", role: "godfather", prompt: pick(script.lines.mafia_prompt),
      valid_targets: nonMafiaTargets(game) }; // can't mark your own family
  if (p.role === "detective")
    return { type: "NIGHT_PROMPT", role: "detective", prompt: pick(script.lines.detective_prompt),
      valid_targets: targetsExcluding(game, p.id) };
  if (p.role === "doctor")
    return { type: "NIGHT_PROMPT", role: "doctor", prompt: pick(script.lines.doctor_prompt),
      valid_targets: allLivingTargets(game) }; // doctor may save self
  return { type: "NIGHT_PROMPT", role: "citizen",
    prompt: pick(script.lines.citizen_prompt || ["Pick a name. It means nothing — that's the point."]),
    valid_targets: targetsExcluding(game, p.id) };
}

// Every dead player gets a fresh omniscient roster (ghosts follow later deaths).
function refreshGhosts(game) {
  game.players.filter((p) => !p.alive).forEach((p) => sendGhost(game, p.id));
}

// Jittered auto-resolve: fire resolveNight a beat AFTER the last actor submits,
// so night length never telegraphs when the power roles finished.
function scheduleNightResolve(game) {
  if (RESOLVE_DELAY_MS <= 0)
    return resolveNight(game).catch((e) => console.error("night resolve error:", e));
  if (game.resolveTimer) return; // already scheduled
  const epoch = game.epoch;
  game.resolveTimer = setTimeout(() => {
    game.resolveTimer = null;
    if (game.epoch !== epoch || game.phase !== "NIGHT") return;
    resolveNight(game).catch((e) => console.error("night resolve error:", e));
  }, RESOLVE_DELAY_MS + Math.floor(Math.random() * 1500));
}

async function startNight(game) {
  const epoch = game.epoch;
  game.round += 1;
  game.phase = "NIGHT";
  game.nightActions = { gf: {}, detective: undefined, doctor: undefined };
  // Arm before pushState so the broadcast STATE carries the countdown deadline.
  armTimer(game, "NIGHT", () => resolveNight(game), () => narrate(game, "night_last_call"));
  pushState(game);
  await narrate(game, "night_falls");
  // The narrate await can outlive the phase (host force-resolve, restart) —
  // never deal actionable prompts into a night that's already over.
  if (game.epoch !== epoch || game.phase !== "NIGHT") return;

  // Private prompts for every living player (chokepoint: all via sendPrivate).
  game.players
    .filter((p) => p.alive)
    .forEach((p) => sendPrivate(game, p.id, buildNightPrompt(game, p)));
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
  const epoch = game.epoch;
  clearTimer(game);
  game.phase = "RESOLVING"; // claim the transition so a racing call bails above
  const actions = {
    godfather_target: mafiaTarget(game),
    doctor_save: game.nightActions.doctor || null,
    detective_query: game.nightActions.detective || null,
  };
  const result = logic.resolveNight(game.players, actions);

  // Private detective result (chokepoint). Kept for replay: a detective whose
  // socket is down at this exact moment gets it re-sent on REJOIN.
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
      game.lastNightResult = { playerId: det.id, round: game.round, text: line };
      sendPrivate(game, det.id, { type: "NIGHT_RESULT", text: line });
    }
  }

  // Apply death (role stays hidden for night kills).
  if (result.deathId) {
    game.players = game.players.map((p) =>
      p.id === result.deathId ? Object.assign({}, p, { alive: false }) : p
    );
    rebindSockets(game); // keep socket refs after map()
    refreshGhosts(game); // the new ghost joins, and old ghosts see the update
  }

  game.phase = "MORNING";
  pushState(game);
  if (result.deathId) await narrate(game, "morning_death", { NAME: result.deathName }, deathArt());
  else await narrate(game, "morning_no_death");
  // A restart during the narration means this night no longer exists.
  if (game.epoch !== epoch) return;

  const outcome = logic.checkWin(game.players);
  if (outcome !== "continue") return endGame(game, outcome);

  // Hold on the morning beat so the death (and its card) lands before the day
  // opens. A plain, un-timed pause — no countdown clock, just a breath.
  clearTimer(game);
  if (MORNING_SECONDS <= 0) return void startDiscussion(game);
  game.timer = setTimeout(() => {
    game.timer = null;
    if (game.epoch === epoch && game.phase === "MORNING")
      startDiscussion(game).catch((e) => console.error("morning->day error:", e));
  }, MORNING_SECONDS * 1000);
}

// ---- day -------------------------------------------------------------------
async function startDiscussion(game) {
  game.phase = "DAY_DISCUSSION";
  game.ready = {}; // fresh Ready tally each day
  game.allReadyFired = false;
  // Arm before pushState so the STATE broadcast carries the countdown deadline.
  armTimer(game, "DAY_DISCUSSION", () => startVote(game), () => narrate(game, "discussion_last_call"));
  pushState(game);
  await narrate(game, "day_discussion");
}

async function startVote(game) {
  if (game.phase === "DAY_VOTE") return; // already open (guard vs. double-trigger)
  const epoch = game.epoch;
  game.phase = "DAY_VOTE";
  game.votes = {};
  // Arm before pushState so the STATE broadcast carries the countdown deadline.
  armTimer(game, "DAY_VOTE", () => resolveVote(game), () => narrate(game, "vote_last_call"));
  pushState(game);
  await narrate(game, "vote_call");
  // Don't deal ballots into a vote that ended (or a game that restarted) mid-narration.
  if (game.epoch !== epoch || game.phase !== "DAY_VOTE") return;
  const targets = allLivingTargets(game);
  game.players
    .filter((p) => p.alive)
    .forEach((p) =>
      send(p.socket, { type: "VOTE_PROMPT", valid_targets: targets })
    );
}

function voteComplete(game) {
  const living = game.players.filter((p) => p.alive);
  return living.every((p) => game.votes[p.id] !== undefined);
}

async function resolveVote(game) {
  if (game.phase !== "DAY_VOTE") return; // already resolved (guard vs. double-trigger)
  const epoch = game.epoch;
  clearTimer(game);
  game.phase = "RESOLVING"; // claim the transition so a racing call bails above
  const result = logic.tallyVotes(game.players, game.votes);
  // Named tally so the room can SEE how the vote fell (ids alone render nothing).
  broadcastRoom(game, {
    type: "VOTE_TALLY",
    tally: result.tally,
    results: Object.keys(result.tally)
      .map((id) => ({ name: (logic.byId(game.players, id) || {}).name || "?", votes: result.tally[id] }))
      .sort((a, b) => b.votes - a.votes),
  });

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
    refreshGhosts(game); // the lynched player joins the ghosts; old ghosts see it
    pushState(game);
    await narrate(game, "elimination", {
      NAME: result.eliminatedName,
      ROLE: roleLabel(result.role),
    });
  }
  // A restart during the narration means this vote no longer exists.
  if (game.epoch !== epoch) return;

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
  const town = outcome === "town_win";
  const reveal = {
    type: "GAME_OVER",
    winner: town ? "town" : "mafia",
    art_url: (assets.cards && (town ? assets.cards.victory_town : assets.cards.victory_mafia)) || "",
    video_url: (assets.cards && (town ? assets.cards.victory_town_video : assets.cards.victory_mafia_video)) || "",
    roles: game.players.map((p) => ({ name: p.name, role: p.role })),
  };
  game.lastGameOver = reveal; // replayed to anyone who reconnects at END
  broadcastAll(game, reveal);
}

function restartGame(game) {
  clearTimer(game);
  game.epoch += 1; // invalidate every stale timer & in-flight await from the old game
  game.phase = "LOBBY";
  game.round = 0;
  game.votes = {};
  game.ready = {};
  game.allReadyFired = false;
  game.nightActions = { gf: {}, detective: undefined, doctor: undefined };
  game.lastNarration = null;
  game.lastNightResult = null;
  game.lastGameOver = null;
  game.players = game.players.map((p) =>
    Object.assign({}, p, { role: undefined, alive: true, revealed: false })
  );
  rebindSockets(game);
  pushState(game);
  broadcastAll(game, rosterEvent(game)); // phones show the between-game lobby too
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
  // A deal is only legal from the lobby — a double-tapped (or replayed) start
  // must never re-deal roles mid-game or resurrect the dead.
  if (game.phase !== "LOBBY")
    return { error: "Game already started — use Play Again to reshuffle." };
  if (game.players.length < 5)
    return { error: "Need at least 5 players to start (have " + game.players.length + ")." };
  if (game.players.length > 12)
    return { error: "Max 12 players." };
  game.epoch += 1; // a fresh deal invalidates anything left over from before

  const ids = game.players.map((p) => p.id);
  const roleMap = logic.assignRoles(ids);
  game.players = game.players.map((p) =>
    Object.assign({}, p, { role: roleMap[p.id], alive: true, revealed: false })
  );
  rebindSockets(game);

  // Private role reveal (chokepoint). Mafia also learn their fellow family.
  game.players.forEach((p) => {
    sendPrivate(game, p.id, {
      type: "ROLE_ASSIGNED",
      role: p.role,
      team: logic.TEAM[p.role],
      art_url: roleArt(p.role, p.id),
      blurb: ROLE_BLURB[p.role],
      allies: logic.TEAM[p.role] === "mafia" ? mafiaAllyNames(game, p.id) : [],
    });
  });

  game.phase = "REVEAL";
  const epoch = game.epoch;
  pushState(game);
  await narrate(game, "game_start");
  if (game.epoch !== epoch) return { ok: true }; // restarted mid-narration
  // Hold on the reveal so players can actually study their role before the phone
  // swaps to the night screen. A quiet, guarded pause (same pattern as morning).
  clearTimer(game);
  if (REVEAL_SECONDS <= 0) { await startNight(game); return { ok: true }; }
  game.timer = setTimeout(() => {
    game.timer = null;
    if (game.epoch === epoch && game.phase === "REVEAL")
      startNight(game).catch((e) => console.error("reveal->night error:", e));
  }, REVEAL_SECONDS * 1000);
  return { ok: true };
}

// ---- roster ----------------------------------------------------------------
function rosterEvent(game) {
  return {
    type: "ROSTER",
    code: game.code,
    count: game.players.length,
    players: game.players.map((p) => ({ id: p.id, name: p.name, connected: !!p.socket })),
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
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
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

  // favicon (browsers auto-request /favicon.ico — serve the app icon, no 404)
  if (pathname === "/favicon.ico") return serveFile(res, path.join(ROOT, "web", "assets", "icon", "favicon.png"));

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
    return res.end(JSON.stringify({ ok: true, games: games.size, voice: voiceProvider.name, lan: lanIP(), port: PORT }));
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
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (e) {
      return send(ws, { type: "ERROR", message: "bad json" });
    }
    const g = games.get(ws._code || String(msg.code || "").toUpperCase());
    if (g) g.lastActivity = Date.now(); // sweeper input: this table is alive
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
      broadcastAll(game, rosterEvent(game)); // phones' lobby count too
    }
  });
});

// Heartbeat: phones on flaky Wi-Fi leave half-open sockets behind. Ping every
// 30s; a socket that never pongs gets terminated, which fires the close handler
// above and frees the seat for a clean REJOIN.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 30 * 1000);
wss.on("close", () => clearInterval(heartbeat));

function requireHost(game, msg) {
  if (!game || game.hostToken !== msg.hostToken) throw new Error("not host");
}
function playerByToken(game, token) {
  return game && game.players.find((p) => p.token === token);
}
// Everything a reconnecting room screen (host/table) needs to redraw the moment:
// the narration line + its art (replay: no audio), live progress, and — at the
// END — the full game-over reveal.
function sendRoomSnapshot(game, ws) {
  if (game.lastNarration)
    send(ws, { type: "NARRATE", text: game.lastNarration.text, art_url: game.lastNarration.art_url, replay: true });
  const living = game.players.filter((x) => x.alive);
  if (game.phase === "DAY_DISCUSSION")
    send(ws, { type: "READY_PROGRESS", ready: living.filter((x) => game.ready[x.id]).length, total: living.length });
  if (game.phase === "DAY_VOTE")
    send(ws, { type: "VOTE_PROGRESS", cast: Object.keys(game.votes).length, total: living.length });
  if (game.phase === "END" && game.lastGameOver) send(ws, game.lastGameOver);
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
      sendRoomSnapshot(game, ws); // current narration/art, progress, game-over
      return;
    }

    case "TABLE_JOIN": {
      const game = games.get((msg.code || "").toUpperCase());
      if (!game) return send(ws, { type: "ERROR", message: "No game with that code." });
      ws._role = "table";
      ws._code = game.code;
      game.tableSockets.add(ws);
      send(ws, { type: "TABLE_OK", code: game.code });
      send(ws, publicState(game));
      sendRoomSnapshot(game, ws);
      return;
    }

    case "JOIN": {
      const game = games.get((msg.code || "").toUpperCase());
      if (!game) return send(ws, { type: "ERROR", message: "No game with that code." });
      if (game.phase !== "LOBBY")
        return send(ws, { type: "ERROR", message: "That game already started." });
      // Names render on every surface — strip markup-significant characters.
      const name = String(msg.name || "").replace(/[<>&"'`]/g, "").replace(/\s+/g, " ").trim().slice(0, 20) || "Stranger";
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
      send(ws, rosterEvent(game)); // the phone's own lobby count
      broadcastRoom(game, rosterEvent(game));
      pushState(game); // table view renders its roster from STATE — keep it live
      return;
    }

    case "REJOIN": {
      const game = games.get((msg.code || "").toUpperCase());
      if (!game) return send(ws, { type: "ERROR", message: "no game" });
      const p = playerByToken(game, msg.token);
      if (!p) return send(ws, { type: "ERROR", message: "unknown session" });
      // A token lives on exactly one socket: kill any older one so a stale tab
      // can't keep acting for this player.
      if (p.socket && p.socket !== ws) { try { p.socket.close(); } catch (_) {} }
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
          art_url: roleArt(p.role, p.id),
          blurb: ROLE_BLURB[p.role],
          allies: logic.TEAM[p.role] === "mafia" ? mafiaAllyNames(game, p.id) : [],
        });
      }
      if (!p.alive) sendGhost(game, p.id);
      // Restore the player's *active* prompt AND acknowledged state so a
      // mid-phase reconnect lands exactly where they left off (phones lock /
      // backgrounded tabs drop the socket constantly). Without this, a dropped
      // detective/doctor/voter silently stalls the whole game.
      if (p.alive) {
        if (game.phase === "NIGHT") {
          const acted =
            (p.role === "godfather" && game.nightActions.gf[p.id] !== undefined) ||
            (p.role === "detective" && game.nightActions.detective !== undefined) ||
            (p.role === "doctor" && game.nightActions.doctor !== undefined);
          send(ws, buildNightPrompt(game, p));
          if (acted) send(ws, { type: "ACTION_ACK" });
        } else if (game.phase === "DAY_DISCUSSION") {
          send(ws, { type: "READY_ACK", ready: !!game.ready[p.id] });
          const living = game.players.filter((x) => x.alive);
          send(ws, { type: "READY_PROGRESS", ready: living.filter((x) => game.ready[x.id]).length, total: living.length });
        } else if (game.phase === "DAY_VOTE") {
          if (game.votes[p.id] === undefined) {
            send(ws, { type: "VOTE_PROMPT", valid_targets: allLivingTargets(game) });
          } else {
            send(ws, { type: "VOTE_PROMPT", valid_targets: allLivingTargets(game) });
            send(ws, { type: "VOTE_ACK", target_id: game.votes[p.id] });
          }
          send(ws, { type: "VOTE_PROGRESS", cast: Object.keys(game.votes).length,
            total: game.players.filter((x) => x.alive).length });
        }
        // A detective who missed the private verdict (socket down at resolution)
        // gets it replayed for the rest of this round.
        if (p.role === "detective" && game.lastNightResult &&
            game.lastNightResult.playerId === p.id && game.lastNightResult.round === game.round &&
            game.phase !== "NIGHT") {
          send(ws, { type: "NIGHT_RESULT", text: game.lastNightResult.text });
        }
      }
      if (game.phase === "END" && game.lastGameOver) send(ws, game.lastGameOver);
      send(ws, publicState(game));
      send(ws, rosterEvent(game));
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

    case "HOST_START": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      if (game.phase !== "LOBBY")
        return send(ws, { type: "ERROR", message: "Game already started." });
      const r = await startGame(game);
      if (r && r.error) send(ws, { type: "ERROR", message: r.error });
      return;
    }

    case "NIGHT_ACTION": {
      const game = games.get(ws._code);
      const p = playerByToken(game, msg.token);
      if (!p || !p.alive || game.phase !== "NIGHT") return;
      // "skip" = deliberately stay your hand (counts as acted, no target).
      const target = msg.target_id === "skip" ? null : (msg.target_id || null);
      // Server-side legality — never trust the client's target list:
      // targets must be real, living, and legal for the role (the godfather can
      // never mark family or himself; the detective can't check himself).
      if (target) {
        const t = logic.byId(game.players, target);
        if (!t || !t.alive) return;
        if (p.role === "godfather" && (logic.TEAM[t.role] === "mafia" || t.id === p.id)) return;
        if (p.role === "detective" && t.id === p.id) return;
      }
      if (p.role === "godfather") game.nightActions.gf[p.id] = target;
      else if (p.role === "detective") game.nightActions.detective = target;
      else if (p.role === "doctor") game.nightActions.doctor = target;
      else { send(ws, { type: "ACTION_ACK" }); return; } // citizen decoy: theater only
      send(ws, { type: "ACTION_ACK" });
      if (nightComplete(game)) scheduleNightResolve(game);
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

    // A living player signals they're done debating. When EVERY living player is
    // ready, the day ends early and the vote opens — no waiting on the clock.
    case "READY": {
      const game = games.get(ws._code);
      const p = playerByToken(game, msg.token);
      if (!p || !p.alive || game.phase !== "DAY_DISCUSSION") return;
      if (msg.value === false) delete game.ready[p.id];
      else game.ready[p.id] = true;
      send(ws, { type: "READY_ACK", ready: !!game.ready[p.id] });
      const living = game.players.filter((x) => x.alive);
      const readyCount = living.filter((x) => game.ready[x.id]).length;
      broadcastAll(game, { type: "READY_PROGRESS", ready: readyCount, total: living.length });
      if (readyCount === living.length && living.length > 0 && !game.allReadyFired) {
        game.allReadyFired = true; // two last-taps racing must narrate once
        await narrate(game, "all_ready");
        if (game.phase === "DAY_DISCUSSION") await startVote(game);
      }
      return;
    }

    case "HOST_EXTEND": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      const add = Math.min(120, Math.max(5, Math.round(Number(msg.seconds) || 30)));
      const remaining = extendDeadline(game, add);
      if (remaining != null) {
        pushState(game); // every screen's countdown clock jumps to the new deadline
        await narrate(game, "time_extended");
      }
      return;
    }

    case "VOTE": {
      const game = games.get(ws._code);
      const p = playerByToken(game, msg.token);
      if (!p || !p.alive || game.phase !== "DAY_VOTE") return;
      // A ballot must name a living player or be an explicit abstain — a bogus
      // or dead target is rejected outright (never silently counted as cast).
      const t = msg.target_id || "skip";
      if (t !== "skip" && ((logic.byId(game.players, t) || {}).alive !== true)) return;
      game.votes[p.id] = t;
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

    // Voice GM: make Silas speak an ad-hoc line. {key} plays a prebaked script
    // line in Vlad's voice; {text} speaks arbitrary words via runtime TTS.
    case "HOST_SAY": {
      const game = games.get(ws._code);
      requireHost(game, msg);
      const key = typeof msg.key === "string" && script.lines[msg.key] ? msg.key : null;
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 300) : "";
      if (key) await sayAdhoc(game, key);
      else if (text) await sayAdhoc(game, text);
      return;
    }

    default:
      send(ws, { type: "ERROR", message: "unknown message: " + msg.type });
  }
}

// ---- housekeeping: sweep ABANDONED games every 30 min -----------------------
// Idle-based (not age-based) so a long game night never vanishes mid-round:
// a table is reaped only after 2h of total silence, or a 24h hard cap.
setInterval(() => {
  const now = Date.now();
  for (const [code, g] of games) {
    const idle = now - (g.lastActivity || g.createdAt);
    if (idle > 2 * 60 * 60 * 1000 || now - g.createdAt > 24 * 60 * 60 * 1000) {
      clearTimer(g);
      games.delete(code);
    }
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log("MIDNIGHT server on :" + PORT + " | voice provider: " + voiceProvider.name);
});

module.exports = { server, games, startGame }; // for tests
