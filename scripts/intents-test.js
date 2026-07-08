// scripts/intents-test.js — pure unit tests for the voice GM grammar (no network).
const assert = require("assert");
const I = require("../web/host/intents");

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const cmd = (utter) => I.parse(utter);

// wake-word stripping + a few phrasings per command
ok(cmd("Silas, deal us in").message.type === "HOST_START", "deal us in -> HOST_START");
ok(cmd("hey silas start the game").message.type === "HOST_START", "start the game -> HOST_START");
ok(cmd("lock the doors").message.type === "HOST_START", "lock the doors -> HOST_START");
ok(cmd("Silas, wake the town").message.type === "HOST_RESOLVE_NIGHT", "wake the town -> resolve night");
ok(cmd("resolve the night").message.type === "HOST_RESOLVE_NIGHT", "resolve the night");
ok(cmd("call the vote").message.type === "HOST_OPEN_VOTE", "call the vote -> open vote");
ok(cmd("let's vote").message.type === "HOST_OPEN_VOTE", "let's vote -> open vote");
ok(cmd("count the votes").message.type === "HOST_RESOLVE_VOTE", "count the votes -> resolve vote");
ok(cmd("tally it up").message.type === "HOST_RESOLVE_VOTE", "tally it up -> resolve vote");
ok(cmd("give us more time").message.type === "HOST_EXTEND", "more time -> extend");
ok(cmd("give us more time").message.seconds === 30, "extend carries seconds");
ok(cmd("play again").message.type === "HOST_RESTART", "play again -> restart");
ok(cmd("deal a fresh game").message.type === "HOST_RESTART", "fresh game -> restart");

// flow verbs
ok(cmd("who's still standing").action === "roster", "who's standing -> roster");
ok(cmd("how do we play").action === "help", "how do we play -> help");
ok(cmd("say that again").action === "repeat", "say that again -> repeat");
ok(cmd("how much time is left").action === "time", "how much time -> time");

// phase legality
ok(I.inPhase(cmd("deal us in"), "LOBBY") === true, "deal legal in LOBBY");
ok(I.inPhase(cmd("deal us in"), "NIGHT") === false, "deal illegal in NIGHT");
ok(I.inPhase(cmd("call the vote"), "DAY_DISCUSSION") === true, "vote legal in discussion");
ok(I.inPhase(cmd("call the vote"), "NIGHT") === false, "vote illegal at night");

// confirm control words
ok(I.isAffirm("yes") && I.isAffirm("do it") && I.isAffirm("go ahead"), "affirm words");
ok(I.isCancel("wait") && I.isCancel("no") && I.isCancel("scrap that") && I.isCancel("hold on"), "cancel words");
ok(!I.isAffirm("call the vote"), "a command is not an affirm");

// empty / unknown / robustness
ok(cmd("Silas").kind === "empty", "bare wake word -> empty");
ok(cmd("").kind === "empty", "empty string -> empty");
ok(cmd("the weather is nice today").kind === "unknown", "chatter -> unknown");
ok(cmd("SILAS, CALL THE VOTE!!!").message.type === "HOST_OPEN_VOTE", "case + punctuation robust");

console.log("INTENT TESTS PASSED (" + pass + " assertions)");
