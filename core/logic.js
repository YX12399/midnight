// core/logic.js
// MIDNIGHT — pure, transport-agnostic social-deduction rules engine.
// No I/O, no network, no DOM. The server/voice layer calls into this.
// Works in Node (CommonJS) and the browser (window.MidnightLogic).

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MidnightLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ROLES = {
    GODFATHER: "godfather",
    DETECTIVE: "detective",
    DOCTOR: "doctor",
    CITIZEN: "citizen",
  };

  // Which team a role belongs to.
  const TEAM = {
    godfather: "mafia",
    detective: "town",
    doctor: "town",
    citizen: "town",
  };

  // --- Role balancing (spec §8) --------------------------------------------
  // Returns { godfather, detective, doctor, citizen } for a given player count.
  function roleCountsFor(n) {
    if (n < 5 || n > 12) {
      throw new Error("MIDNIGHT supports 5–12 players (got " + n + ")");
    }
    let godfather;
    if (n <= 7) godfather = 1;
    else if (n <= 9) godfather = 2;
    else godfather = 3; // 10–12
    const detective = 1;
    const doctor = 1;
    const citizen = n - godfather - detective - doctor;
    return { godfather, detective, doctor, citizen };
  }

  // --- Deterministic-friendly shuffle --------------------------------------
  // rng() must return a float in [0,1). Defaults to Math.random.
  function shuffle(arr, rng) {
    rng = rng || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  // Assigns roles to a roster of player ids. Returns Map<id, role>.
  function assignRoles(playerIds, rng) {
    const counts = roleCountsFor(playerIds.length);
    const pool = [];
    for (let i = 0; i < counts.godfather; i++) pool.push(ROLES.GODFATHER);
    for (let i = 0; i < counts.detective; i++) pool.push(ROLES.DETECTIVE);
    for (let i = 0; i < counts.doctor; i++) pool.push(ROLES.DOCTOR);
    for (let i = 0; i < counts.citizen; i++) pool.push(ROLES.CITIZEN);
    const shuffledRoles = shuffle(pool, rng);
    const shuffledIds = shuffle(playerIds, rng);
    const map = {};
    shuffledIds.forEach((id, i) => (map[id] = shuffledRoles[i]));
    return map;
  }

  // --- Players helpers ------------------------------------------------------
  // A player: { id, name, role, alive }
  function alivePlayers(players) {
    return players.filter((p) => p.alive);
  }
  function byId(players, id) {
    return players.find((p) => p.id === id) || null;
  }
  function aliveOfTeam(players, team) {
    return alivePlayers(players).filter((p) => TEAM[p.role] === team);
  }

  // --- Night resolution (spec §8) ------------------------------------------
  // actions = {
  //   godfather_target: playerId | null,   // who mafia wants dead
  //   doctor_save:      playerId | null,    // who doctor protects
  //   detective_query:  playerId | null,    // who detective investigates
  // }
  // Returns { deathId, deathName, savedBlocked, detective: {targetId, name, team, verdict} | null }
  function resolveNight(players, actions) {
    actions = actions || {};
    let deathId = null;
    let savedBlocked = false;

    const target = actions.godfather_target
      ? byId(players, actions.godfather_target)
      : null;

    if (target && target.alive) {
      if (actions.doctor_save && actions.doctor_save === target.id) {
        savedBlocked = true; // doctor saved the mark
      } else {
        deathId = target.id;
      }
    }

    let detective = null;
    if (actions.detective_query) {
      const q = byId(players, actions.detective_query);
      // Only the living can be investigated — a face-down night kill keeps
      // its secret (mirrors the alive-check on the kill branch above).
      if (q && q.alive) {
        const team = TEAM[q.role];
        detective = {
          targetId: q.id,
          name: q.name,
          team: team,
          // Godfather reads as mafia ("dirty"); everyone else "clean".
          verdict: team === "mafia" ? "dirty" : "clean",
        };
      }
    }

    return {
      deathId: deathId,
      deathName: deathId ? byId(players, deathId).name : null,
      savedBlocked: savedBlocked,
      detective: detective,
    };
  }

  // Apply a resolved death to the roster (mutates a copy, returns new array).
  function applyDeath(players, deathId) {
    return players.map((p) =>
      p.id === deathId ? Object.assign({}, p, { alive: false }) : p
    );
  }

  // --- Day vote resolution (spec §8) ---------------------------------------
  // votes = { voterId: targetId, ... }  (only living voters/targets count)
  // Returns { eliminatedId, eliminatedName, role, team, tie, tally }
  function tallyVotes(players, votes) {
    const living = new Set(alivePlayers(players).map((p) => p.id));
    const tally = {};
    Object.keys(votes || {}).forEach((voter) => {
      const target = votes[voter];
      if (!living.has(voter)) return; // dead can't vote
      if (target === "skip" || target == null) return;
      if (!living.has(target)) return; // can't lynch the dead
      tally[target] = (tally[target] || 0) + 1;
    });

    let max = 0;
    let leaders = [];
    Object.keys(tally).forEach((id) => {
      if (tally[id] > max) {
        max = tally[id];
        leaders = [id];
      } else if (tally[id] === max) {
        leaders.push(id);
      }
    });

    if (leaders.length !== 1 || max === 0) {
      return { eliminatedId: null, tie: true, tally: tally };
    }
    const elim = byId(players, leaders[0]);
    return {
      eliminatedId: elim.id,
      eliminatedName: elim.name,
      role: elim.role,
      team: TEAM[elim.role],
      tie: false,
      tally: tally,
    };
  }

  // --- Win check (spec §8) --------------------------------------------------
  // town_win  : no mafia remain
  // mafia_win : mafia >= town (they control the vote / can't be stopped)
  // continue  : otherwise
  function checkWin(players) {
    const mafia = aliveOfTeam(players, "mafia").length;
    const town = aliveOfTeam(players, "town").length;
    if (mafia === 0) return "town_win";
    if (mafia >= town) return "mafia_win";
    return "continue";
  }

  return {
    ROLES,
    TEAM,
    roleCountsFor,
    shuffle,
    assignRoles,
    resolveNight,
    applyDeath,
    tallyVotes,
    checkWin,
    alivePlayers,
    byId,
  };
});
