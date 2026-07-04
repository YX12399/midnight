// scripts/test-engine.js — pure unit tests for core/logic.js (no network)
const assert = require("assert");
const L = require("../core/logic");

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

// --- role balancing ---
for (let n = 5; n <= 12; n++) {
  const c = L.roleCountsFor(n);
  ok(c.godfather + c.detective + c.doctor + c.citizen === n, "counts sum to " + n);
  ok(c.detective === 1 && c.doctor === 1, "1 detective + 1 doctor at " + n);
  ok(c.citizen >= 0, "non-negative citizens at " + n);
}
ok(L.roleCountsFor(5).godfather === 1, "5p -> 1 godfather");
ok(L.roleCountsFor(8).godfather === 2, "8p -> 2 godfathers");
ok(L.roleCountsFor(12).godfather === 3, "12p -> 3 godfathers");
assert.throws(() => L.roleCountsFor(4), "rejects <5");
assert.throws(() => L.roleCountsFor(13), "rejects >12");

// --- assignRoles ---
const ids = ["a", "b", "c", "d", "e", "f", "g"];
const map = L.assignRoles(ids);
const roles = ids.map((i) => map[i]);
ok(roles.filter((r) => r === "godfather").length === 1, "7p assigns 1 GF");
ok(roles.filter((r) => r === "detective").length === 1, "7p assigns 1 det");
ok(Object.keys(map).length === 7, "every id gets a role");

// --- resolveNight: kill, save, verdict ---
const players = [
  { id: "gf", name: "Vic", role: "godfather", alive: true },
  { id: "de", name: "Sam", role: "detective", alive: true },
  { id: "doc", name: "Doc", role: "doctor", alive: true },
  { id: "c1", name: "Rosa", role: "citizen", alive: true },
  { id: "c2", name: "Hank", role: "citizen", alive: true },
];
let r = L.resolveNight(players, { godfather_target: "c1", doctor_save: "c2", detective_query: "gf" });
ok(r.deathId === "c1", "unsaved target dies");
ok(r.detective.verdict === "dirty", "godfather reads dirty");

r = L.resolveNight(players, { godfather_target: "c1", doctor_save: "c1", detective_query: "de" });
ok(r.deathId === null && r.savedBlocked === true, "doctor save blocks kill");
ok(r.detective.verdict === "clean", "townie reads clean");

r = L.resolveNight(players, { godfather_target: null });
ok(r.deathId === null, "no target -> no death");

// a face-down corpse keeps its secret: dead players can't be investigated
const withDead = players.map((p) => (p.id === "gf" ? { ...p, alive: false } : p));
r = L.resolveNight(withDead, { godfather_target: null, detective_query: "gf" });
ok(r.detective === null, "investigating a dead player yields no verdict");
r = L.resolveNight(withDead, { godfather_target: "gf" });
ok(r.deathId === null, "killing a corpse does nothing");

// --- tallyVotes ---
let v = L.tallyVotes(players, { gf: "c1", de: "c1", doc: "c2", c1: "c2", c2: "c1" });
ok(v.eliminatedId === "c1" && v.tie === false, "plurality elimination");
v = L.tallyVotes(players, { gf: "c1", de: "c2" });
ok(v.tie === true, "tie detected");
v = L.tallyVotes(players, { c1: "skip", c2: "skip" });
ok(v.tie === true, "all-skip -> no elimination");

// dead can't vote / be lynched
const players2 = players.map((p) => (p.id === "c2" ? { ...p, alive: false } : p));
v = L.tallyVotes(players2, { gf: "c2", de: "c2", doc: "gf" });
ok(v.eliminatedId === "gf", "votes for dead ignored, gf lynched");

// --- checkWin ---
ok(L.checkWin(players) === "continue", "balanced -> continue");
ok(L.checkWin(players.map((p) => p.role === "godfather" ? { ...p, alive: false } : p)) === "town_win", "no mafia -> town win");
const mafiaHeavy = [
  { id: "gf", role: "godfather", alive: true },
  { id: "c1", role: "citizen", alive: true },
];
ok(L.checkWin(mafiaHeavy) === "mafia_win", "mafia >= town -> mafia win");

console.log("ENGINE TESTS PASSED (" + pass + " assertions)");
