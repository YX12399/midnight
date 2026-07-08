// web/host/intents.js — the voice GM's grammar.
// Pure, deterministic, phase-aware: turns a spoken transcript into either a host
// WS command (that the server ALREADY accepts) or a client-side flow action.
// No LLM on the hot path — a mis-parse that deals early or resolves the wrong
// phase is game-breaking, so the command surface is small, explicit, and
// confirm-gated by the caller for anything consequential.
// UMD: window.MidnightIntents in the browser, require()-able in Node for tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MidnightIntents = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Lowercase, drop punctuation, collapse spaces, and strip a leading wake word.
  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(hey |ok |okay |yo |hi )?silas\b[,\s]*/, "")
      .trim();
  }
  const any = (t, pats) => pats.some((p) => p.test(t));

  // Consequential commands — each maps to an EXISTING host WS message. The
  // caller (host page) gates these behind an in-character confirm.
  const COMMANDS = [
    { intent: "deal", type: "HOST_START", label: "deal the roles", phases: ["LOBBY"],
      // bare "deal" excluded so "deal again"/"deal a fresh game" fall to restart
      pats: [/\bdeal (us |everyone )?in\b/, /\bstart (the )?game\b/, /\block the doors?\b/, /\bbegin\b/] },
    { intent: "resolve_night", type: "HOST_RESOLVE_NIGHT", label: "wake the town", phases: ["NIGHT"],
      pats: [/\bwake (the )?town\b/, /\b(wake|resolve|end|finish)\b[^.]*\bnight\b/, /\bwake up\b/, /\bmorning\b/] },
    { intent: "open_vote", type: "HOST_OPEN_VOTE", label: "call the vote", phases: ["DAY_DISCUSSION"],
      pats: [/\b(call|open|start|bring)\b[^.]*\bvote\b/, /\blet'?s vote\b/, /\bvote now\b/, /\btime to vote\b/, /\bto the vote\b/] },
    { intent: "resolve_vote", type: "HOST_RESOLVE_VOTE", label: "count the votes", phases: ["DAY_VOTE"],
      pats: [/\b(count|tally|close|read)\b[^.]*\bvote/, /\btally (it|them|em|up)\b/, /\bcount (them|em|it)\b/, /\bwho (won|got it)\b/] },
    { intent: "extend", type: "HOST_EXTEND", seconds: 30, label: "add thirty seconds", phases: ["NIGHT", "DAY_DISCUSSION", "DAY_VOTE"],
      pats: [/\bmore time\b/, /\b(thirty|30) (more )?seconds?\b/, /\bgive (us|em|them) (a bit )?(more )?time\b/, /\ba (bit|little) longer\b/, /\bextend\b/] },
    { intent: "restart", type: "HOST_RESTART", label: "deal a fresh game", phases: ["END", "LOBBY", "MORNING", "NIGHT", "DAY_DISCUSSION", "DAY_VOTE", "REVEAL"],
      pats: [/\b(play|deal|go) again\b/, /\bnew game\b/, /\banother round\b/, /\breshuffle\b/, /\brematch\b/, /\bdeal a(nother)? (fresh|new) (game|round)\b/] },
  ];

  // Flow verbs — instant, no confirm (a menu on every utterance is IVR hell).
  const FLOW = [
    { intent: "repeat", action: "repeat",
      pats: [/\bsay (that )?again\b/, /\brepeat( that)?\b/, /\bcome again\b/, /\bwhat did you say\b/, /\bone more time\b/] },
    { intent: "roster", action: "roster",
      pats: [/\bwho'?s (still )?(left|here|alive|standing|in|around)\b/, /\bwho is (left|alive|standing|here)\b/, /\bwho'?s (dead|gone|out)\b/, /\bhow many (are )?left\b/] },
    { intent: "help", action: "help",
      pats: [/\bhow (do|does) (we|i|it|this|you) (play|work)\b/, /\bhow do you play\b/, /\bwhat are the rules\b/, /\bexplain( the (game|rules))?\b/, /\bhow does (this|it) work\b/, /\bwhat do i do\b/] },
    { intent: "time", action: "time",
      pats: [/\bhow (much|long) (time|left|do we have)\b/, /\bhow long('?s| is| have we| do we)?( got| left)?\b/, /\btime (left|remaining)\b/, /\bhow much longer\b/] },
  ];

  const AFFIRM = [/^(yes|yeah|yep|yup|aye|sure|do it|go|go ahead|confirm|send it|let'?s go|absolutely|please)\b/];
  const CANCEL = [/\b(no|nope|nah|wait|hold on|hold up|hold|stop|cancel|not yet|never ?mind|scrap (that|it)|scratch that|forget it|abort)\b/];

  // Parse a fresh utterance (used when no confirm is pending).
  function parse(raw) {
    const t = norm(raw);
    if (!t) return { kind: "empty", transcript: "" };
    for (const c of COMMANDS) {
      if (any(t, c.pats)) {
        const message = { type: c.type };
        if (c.seconds) message.seconds = c.seconds;
        return { kind: "command", intent: c.intent, label: c.label, phases: c.phases, message, transcript: t };
      }
    }
    for (const f of FLOW) if (any(t, f.pats)) return { kind: "flow", intent: f.intent, action: f.action, transcript: t };
    return { kind: "unknown", transcript: t };
  }

  const isAffirm = (raw) => any(norm(raw), AFFIRM);
  const isCancel = (raw) => any(norm(raw), CANCEL);
  // Is a command legal in the current phase? (server guards too; this is for UX)
  const inPhase = (parsed, phase) => !parsed.phases || parsed.phases.indexOf(phase) !== -1;

  return { parse, isAffirm, isCancel, inPhase, norm };
});
