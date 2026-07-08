# MIDNIGHT — Voice-First Variant

*Silas runs the table by ear and by mouth. The phone holds only the secrets.*

This document is the single, opinionated design for the voice-first variant of MIDNIGHT. It synthesizes six dimension studies (interaction model, secrecy, architecture, phone voting, robustness/accessibility, phasing) into one product. It is written so that a collaborator (Vedant, or anyone) can pick up **Phase 1** and build it. Every recommendation is grounded in the existing MIDNIGHT code at `~/Desktop/midnight`.

---

## 1. The pitch

MIDNIGHT today is a screen game with a great voice *on top*: a Node WS server drives a phase engine (LOBBY→REVEAL→NIGHT→MORNING→DAY_DISCUSSION→DAY_VOTE→END), and a gravelly host named **Silas** narrates every beat in a pre-baked voice. The voice-first variant flips the ratio. Instead of tapping through phases, **the table talks to Silas and he runs the room like a human game-master** — you say "Silas, deal us in," he locks the doors and deals; in the morning he tells you who was found by the piano; someone says "Silas, call the vote" and the phones buzz for a private ballot he then reads aloud with a showman's pause. The magic is that MIDNIGHT is *already voice-output-complete and already fully host-driven*: every phase advances by a discrete WS message the host page already sends by tapping a button, and `narrate()`/`ttsCache` already synthesize arbitrary Silas speech (including player names) at runtime. So the entire "conversational GM" ambition collapses to **adding one ear** — a listening loop on the host device that turns spoken intents into the WS messages the server already accepts. The phones don't disappear; they shrink to the one job a shared open microphone physically *cannot* do without leaking: the private, simultaneous, secret beats (your role, your night action, your vote). Everything the whole table is allowed to know is spoken. Everything that must stay hidden stays on the phone. That single principle settles the whole design.

---

## 2. The experience — one game, as spoken dialogue

Legend: **[voice]** = spoken through the host device's mic/speaker (public, heard by the whole table). **[phone]** = a silent, private touch on your own phone. **[buzz]** = the phone vibrates. Server messages the beat maps to are shown in `(monospace)`.

### Setup / Lobby
Six friends around a table, one laptop in the middle running the host page (`web/host/index.html`) in "hands-free" mode: a big Silas orb, a listening indicator, a live caption strip.

- Players scan the QR / type the 4-letter code on their phones (unchanged join, `showQR` + `newCode`). Instead of free-typing a name, each **taps to claim a character** from a curated speakeasy deck shown on their phone — *Vince, Rosa, Sal, Cleo, Dutch, Marlowe…* One tap; the name greys out for everyone else. (Why a deck, not free-type: Silas says these names out loud every round, so they must be pronounceable and pre-renderable — see §3 and §8.)
- **[voice]** Someone: *"Silas, deal us in."*
- **[voice]** Silas (readback, because this is destructive): *"Six stools filled, doors about to lock. Everybody in? …Say the word."*
- **[voice]** Table: *"Do it."* → `(HOST_START)`
  - (If only four had joined, Silas refuses out loud instead of silently failing: *"Need five bodies at least. Rustle up one more."* — reuses the existing 5-player guard.)

### The deal / Reveal
- **[voice]** Silas: *"Doors are bolted. Pick up your phone — hold it to your ear. This part's just between us."* `(game_start)`
- **[phone][to ear]** Each player taps and holds the phone to their ear. Silas **whispers their role privately** through that phone's earpiece: *"You run the family. Cold and quiet. Your people are Rosa and Sal. Tell no one."* / *"You read people for a living — each night, one name, I'll tell you clean or dirty."* Citizens hear a flavor whisper too, so holding-phone-to-ear never outs a power role. This rides the existing private `ROLE_ASSIGNED` socket with a new `role_audio_url`.
- **[voice]** Silas: *"Everybody knows their own business now. Phones down. Here comes the dark."*

### Night
- **[voice]** Silas: *"Midnight bolts its doors. Honest folk — eyes closed, heads down, hum me a little something. Family, doctor, detective: your phones are lit. One tap, in the dark, under the table. No words — nobody needs to hear you."* `(night_falls)`
- **[phone]** Every living phone shows an identical dark "tap a name" screen (power roles get real targets; citizens get a decoy). The mafia taps *Vince*; the doctor taps *Rosa*; the detective taps *Sal*; citizens tap anyone (ignored). **Silence — a tap makes no sound.** `(NIGHT_ACTION)` The engine resolves in parallel the instant everyone's tapped, with jitter so timing never reveals who acted.
- **[phone][to ear]** The detective's phone whispers back, privately: *"I ran your hunch. Sal's hands come back… dirty."* `(NIGHT_RESULT, private)`
- **[voice]** if the clock runs low: *"Almost sunup. Anyone still deciding, decide fast."* `(night_last_call)`

### Morning
- **[voice]** Silas, slow, a beat of dread: *"Sun's up. Eyes open. …And so's the body count. We found Vince, face-down by the piano."* `(morning_death, {NAME})` The death card also shows on the host screen. This is already voice today — no change.

### Day discussion
- **[voice]** Silas opens: *"Sun's up — so talk. Out loud, eyes up. When you've said your piece, tell me you're ready."*
- The table argues **freely**. The wake word keeps Silas out of it — he does not transcribe the debate (and must not; that audio is the mafia lying).
- **[voice]** Rosa: *"Silas, who's still standing?"* → *"On their feet: Rosa, Sal, Marco, Lena, and you."* (reads `publicState.alive`)
- **[voice]** Marco: *"Silas, how's the detective work again?"* → a short static rules blurb (public, no secret).
- **[voice]** Lena: *"Silas, we're ready."* → Silas: *"That's the room leaning toward a vote. Anyone object?"* (See §6 on how "ready" is handled without speaker-ID.)
- **[voice]** Anyone: *"Silas, call the vote."* → readback + light quorum → `(HOST_OPEN_VOTE)`

### The vote
- **[voice]** Silas: *"Time's up for talk. Phones out — point a finger, and mean it. No spine? Abstain."* `(vote_call)`
- **[buzz]** Every living phone vibrates and lights to the ballot: a one-tap roster + an "— Abstain —" row.
- **[phone]** Each player taps a name (provisional), then hits **LOCK IN** and puts the phone face-down. Change-your-mind is allowed until the tally resolves. `(VOTE)` The phone shows **no running count** — the suspense lives in the room.

### Result
- **[voice]** Silas, milking it: *"Let's count 'em. …Three fingers on Vince. Two on Rosa. And one of you didn't have the stomach to choose."* `(vote_tally_readout)` — a beat — *"…Vince. The room's decided. The door's that way."* `(elimination, {NAME})` — then the turn — *"…Turns out he was the Godfather."* `({ROLE})`
- **Only now** do the tally bars slide up on the host screen (the visual is gated behind Silas's spoken read, so numbers never spoil his reveal).

### End / rematch
- **[voice]** Silas: *"Last rat's in the river. Midnight's clean tonight. Drinks on the house."* `(town_win)`
- **[voice]** Someone: *"Silas, deal us again."* → *"Shuffling the deck. Same faces, new lies."* `(HOST_RESTART)`

No one touched the laptop the entire game. The phones were glanced at three times (role, night, vote) and otherwise face-down. That loop — *talk → he understands → he runs a phase → he reads the vote aloud* — is the entire product.

---

## 3. The secrecy model

### The core rule
**The shared room microphone is, physically, a broadcast device.** So it carries only PUBLIC speech. The three genuinely-secret beats — learning your role, choosing a night target, casting a vote — never go through the mic. They ride the existing per-phone private socket, which the codebase already makes leak-proof by construction: `PRIVATE_ONLY` + `assertBroadcastSafe` (`server/index.js:160-190`) *throw* if a role or night result is ever handed to a broadcast. We keep that backbone unchanged and only change the *modality* on the phone.

### Why "whisper your target to the device" is rejected
The romantic ritual — everyone hums, the Godfather leans in and whispers "kill Vince" to the table device — fails on three independent axes and is **out**:
1. **The leak is in the air, before any mic.** Your neighbors hear "Vince" with their own ears. A shared mic is therefore *strictly weaker* than tabletop Mafia, where you at least point silently in the dark.
2. **ASR can't do it anyway.** A whisper is unvoiced (~30-40 dB); a room humming to cover it is a 60-70 dB broadband masker centered in the speech band. A masked whisper of a *proper name* (the least predictable token there is) is scribe_v2's worst case.
3. **The confirmation leaks too.** Spoken back, it outs the target; kept silent, the player re-whispers and doubles the exposure.

### The recommended mechanism
- **Role reveal → private earpiece audio.** Reuse `ROLE_ASSIGNED` on the private socket; add a `role_audio_url` synthesized through the existing `narration()` → `ttsCache.urlFor()` → mp3 pipeline. The phone shows one line ("Hold me to your ear") and plays the whisper once per tap, with no on-screen text to shoulder-surf. Mafia allies fold into the same whisper. **Strictly better than a passed card** (a card can be glimpsed sideways; a 5 cm ear-held whisper can't). *Accessibility fallback:* the existing hold-to-peek **card reveal stays available** per-phone for deaf/HoH players or when audio fails.
- **Night target → one silent tap.** Already built and proven: `buildNightPrompt` sends every living phone an identical pick screen (citizen decoys), `NIGHT_ACTION` validates legality server-side, and resolution is parallel + jittered so timing never outs the actors. **A tap makes no sound** — that is the whole point. Speaking a target, even whispered, is the one thing we can't hide, so we don't. **Equal to classic** (silent choice under eyes-closed cover).
- **Vote → private simultaneous phone ballot.** Non-negotiable; see §5.
- **The night ritual is voice THEATER over silent taps.** Silas calls the roles aloud for atmosphere and cover ("Family, choose who doesn't see the sunrise"), and that role taps under the table while everyone's eyes are closed. We keep resolution **parallel**, not sequential — a sequential "call each role and wait" would both force the leaky shared mic *and* leak role identities by process of elimination.

### The honest threat model — stated plainly to players
- **By construction:** no device broadcast can ever carry a role or a night result — `assertBroadcastSafe` throws, asserted by the smoke test. Stronger than any human moderator's promise.
- **Role secrecy: better than classic** (earpiece whisper > passed card).
- **Result secrecy: better than classic** (private socket > a moderator's readable thumbs-up).
- **Target secrecy: equal to classic** (silent tap under eyes-closed = silent point under eyes-closed).
- **The residual threat** — a neighbor who peeks at your dimmed screen or refuses to close their eyes — is the *identical* cheating vector tabletop Mafia has always lived with, mitigated the *identical* way (social contract + a screen showing only a single dim tap target). We do **not** claim to beat physical co-presence; we claim to never leak through the machine. The "everyone hums" cover is now pure theater — set expectations so nobody thinks the hum is protecting a secret the silent tap already protects.

---

## 4. Architecture

### The one-line insight
**This is a client-side listener on the host page that speaks the existing WS dialect.** A voice command is nothing more than a spoken alias for a host button click. Build a new `MidnightEars` module in `web/app-common.js` (sibling to `MidnightSpeak`/`MidnightAmbient`/`MidnightWS`), wire it only into `web/host/index.html`, and have it emit the *exact* messages `renderControls()` already sends. The phase engine, transport, anti-leak chokepoint, phone voting, and TTS are **untouched**.

**Do NOT fork a `midnight-voice/` folder.** The engine (`core/logic.js`), server (`server/index.js`), phone, TTS, and content are all modality-agnostic — they don't know whether a message came from a tap or a voice. A sibling folder would duplicate the whole client to add one input modality. Ship it as a mode on the host page, gated behind `?voice=1` or a "Hands-free" toggle.

### The voice stack

**STT — two tiers.**
- *MVP:* browser Web Speech (`webkitSpeechRecognition`) on the host page. Zero infra, zero keys, ships today. The host is a desktop/Chromebook running Chrome — exactly Web Speech's supported target — and *players never run ASR* (their only phone touch is voting), so its Chrome-only limitation doesn't bite.
- *Real:* streaming STT (Deepgram Nova-3/Flux, or ElevenLabs Scribe v2 — already named as `stt_model: "scribe_v2"` in `config/voice.json`) over a WebSocket opened **directly from the host page** to the provider, authed by a short-lived key from a new `GET /voice/token` route. **Keep the media path off the Node server** — that halves latency and keeps the browser's echo canceller in the loop.

**Wake / turn-taking.**
- *Default (MVP):* **push-to-talk plus a "Silas" wake word with a confidence floor and a ≥1.2 s minimum utterance.** PTT is a big on-screen "hold to talk to Silas" button (and can live on a co-host phone). We ship PTT as the reliable default because Mafia is wall-to-wall loud cross-talk and the wake word ("Silas" is `/s/`-heavy) will false-trigger; the wake word is the aspirational hands-free path, always backed by PTT. This resolves the interaction study's "hands-free ideal" against the robustness study's "PTT is safer" — **both are present; PTT is the floor, wake word is the ceiling.**
- *Real:* on-device wake word (openWakeWord "hey_silas" via `onnxruntime-web` WASM — free, browser-viable, better far-field than Porcupine and no ~$6k/yr SDK) + WebRTC VAD for endpointing, PTT still wired as permanent fallback.

**Intent parsing.**
- **Client-side deterministic grammar, no LLM on the hot path.** The command surface is tiny (~10 intents) and phase-bounded, so a normalize → per-phase keyword/regex match is instant, free, offline, and 100% predictable — critical for a GM that must not misfire (a mis-parse that deals early or resolves the wrong night is game-breaking). The only fuzzy part is **names**, and it's roster-constrained: match the spoken token against the live `publicState.alive` set with Levenshtein/Double-Metaphone. A closed 5-12 name vocabulary handles accents better than a general LLM would. An LLM (Haiku) is allowed *only* as a fallback when the grammar returns no match, *only* behind a spoken confirm, never auto-executing.

**TTS — reuse the cache, flip the key to required.** Voice-first's whole payoff is Silas speaking names and tallies aloud, which the existing `narrate()` → `ttsCache.urlFor()` → ElevenLabs pipeline already does (dynamic `{NAME}`/`{ROLE}` lines in `morning_death`/`elimination` prove it). Two changes: (1) treat `ELEVENLABS_API_KEY` as **required** for this variant (`eleven_flash_v2_5`, ~75 ms, for dynamic lines; keep the Higgsfield/Vlad prebakes for the ~31 fixed lines); (2) pre-bake the curated name deck (§8) so `{NAME}` lines never fall to browser TTS mid-sentence. A new `HOST_SAY` message lets the client make Silas speak an arbitrary ad-hoc/ack/clarification line on demand via the same path.

**Echo / barge-in — state-gate the recognizer.** Silas must never transcribe himself. `MidnightSpeak.onSpeech(start,end)` already fires around every line and already drives `MidnightAmbient.duck()`. Subscribe `MidnightEars` to the *same* hook: hard-mute ASR while Silas speaks, resume ~500 ms after he stops. One signal drives ducking *and* muting so they can't drift. In MVP, PTT structurally excludes self-audio (mic open only while held). In the real tier, `getUserMedia({echoCancellation, noiseSuppression, autoGainControl})` is the barge-in safety net so a player can cut Silas off with the wake word.

### Data flow (prose)
Host holds PTT (or says "Silas") → recognizer opens → final transcript string → `MidnightEars.parse(transcript, phase, roster)` → matched intent, e.g. `{type:"HOST_OPEN_VOTE", hostToken}` → `MidnightWS.send()` → the *unchanged* `handle()` switch in `server/index.js` runs `startVote()` → server `narrate("vote_call")` → `NARRATE` broadcast → host's `MidnightSpeak.narrate()` speaks it → `onSpeech(start)` mutes ASR + ducks ambient → line ends → `onSpeech(end)` + 500 ms tail → ASR re-armed. Phone ballots then flow through the untouched `VOTE` path. The real tier swaps only the front half (streaming capture + VAD endpointing); everything downstream of `parse()` is identical.

### Reuse vs. new

| Component | REUSE (existing) | NEW (to build) |
|---|---|---|
| Game engine | `core/logic.js` — roles, night/vote resolution, win check | — |
| Phase orchestration | `server/index.js` handlers: `HOST_START` (993), `HOST_RESOLVE_NIGHT` (1027), `HOST_OPEN_VOTE` (1034), `HOST_EXTEND` (1061), `HOST_RESTART` (1099) | One additive `HOST_SAY` case (~8 lines) for ad-hoc Silas lines |
| Anti-leak | `PRIVATE_ONLY` + `assertBroadcastSafe` (160-190) | — (voice adds no hidden-info path) |
| Transport | `MidnightWS` (send/queue/reconnect) | — |
| Narration/TTS | `narrate()`/`narration()`, `ttsCache`, `voice/provider.js`, `voice/elevenlabs.js` | Pre-bake curated name deck; new script keys (§8) |
| Speaker + ambient | `MidnightSpeak` queue + `onSpeech` hooks; `MidnightAmbient.duck()` | `MidnightSpeak.pause()/flush()` for barge-in |
| **Listening** | — | **`MidnightEars`**: ASR driver, wake/PTT, per-phase grammar, roster fuzzy-matcher, `onSpeech`-gated echo mute |
| Host UI | `web/host/index.html` shell, QR, speaker, `renderControls()` (kept as visible fallback) | Voice mode: listening orb, live "heard: …" caption, spoken acks |
| STT provider (real) | `stt_model: scribe_v2` slot in `config/voice.json` | `GET /voice/token`; streaming STT wiring |
| Role reveal | `ROLE_ASSIGNED` private socket | `role_audio_url` + phone "hold to ear" playback |
| Night | `buildNightPrompt` decoys, `NIGHT_ACTION`, jittered parallel resolve, `NIGHT_RESULT` | Phone night screen restyled to a single dim tap target |
| Voting | `VOTE`/`VOTE_ACK`/`VOTE_PROMPT`/`VOTE_PROGRESS`/`VOTE_TALLY`, `REJOIN` replay | Lock-In UX; buzz; tally-gated visual |
| Join | QR/code (`showQR`, `newCode`), `REJOIN` token | Curated name deck (`config/names.json`) + claim-a-name grid |

---

## 5. Phone voting — the one sanctioned touchpoint

The phone becomes **a ballot box that sleeps in your pocket and lights up only when Silas calls the vote.** Its four states, total:
1. **Idle / dark** — "the ballot box is closed" (LOBBY-after-deal, NIGHT for non-powers, MORNING, DAY_DISCUSSION, END). Face-down.
2. **Night tap** (power roles only) — one silent private pick, then dark again.
3. **Vote** — buzzes, lights, one tap → **LOCK IN** → change-until-resolved.
4. **Ghost** — the existing read-only omniscient roster for the dead.

**Why the vote is phone-only, always:** voting must be **private, simultaneous, and irreversible** — three properties voice cannot preserve at a table. Spoken votes leak (the last voter hears the tally and the murderer can intimidate), can't be simultaneous, and one ASR mistally on a lynch is unrecoverable. The phone already solves all of this and is fully reconnect-safe. Voice's role at vote time is only to **open** it ("Silas, call the vote" → `HOST_OPEN_VOTE`) and to **read progress and the tally aloud**. A spoken accusation ("I accuse Vince") is *social theater* — Silas surfaces the name on the host screen and may say "Vince, the table's listening" — but it casts **nothing**.

**The mechanics, ~90% reuse:**
- On `VOTE_PROMPT` the phone **vibrates** (`navigator.vibrate`), flips from dark to the lit one-tap roster (with the existing "— Abstain —" row), and holds the existing wake-lock. No phone *sound* — Silas's "phones out" from the room speaker is the audible cue; the buzz is its tactile echo. (iOS Safari lacks the Vibration API; the buzz is a nice-to-have, not load-bearing.)
- **Provisional select → LOCK IN.** First tap only highlights; a big LOCK IN button sends `VOTE`. This matches Silas's "point a finger, and *mean* it."
- **Change-until-locked is free:** the server already overwrites on every `VOTE` (`game.votes[p.id] = t`) and only resolves on `voteComplete`/timer, so re-tapping re-sends and overwrites until `resolveVote` fires, after which the phone greys out (natural lock). If the vote closed before a late change lands, the phone shows a clear "the vote already closed" state, not a dead tap.
- The phone shows **no tally, no live count** — `VOTE_PROGRESS`/`VOTE_TALLY` stay room-only.

**Tally: ear first, eyes second.** Add a `vote_tally_readout` narration key voiced by Silas *before* `elimination`, and **gate the host-screen bar chart** behind the end of that spoken line (hook `MidnightSpeak.onSpeech(end)`, with a max-delay fallback so the screen never hangs). The room *hears* the count, then the bars slide up as punctuation. Phones see neither.

**Not a mic.** The phone is a ballot box, not a microphone — turning N phones into always-listening mics is a privacy/battery/echo nightmare that competes with the room mic and breaks the one-GM fiction. Leave one clean, unbuilt seam (a reserved `MIC_STREAM`/`WHISPER` message type) for a future accessibility "hold to whisper to Silas" mode; build nothing now.

---

## 6. Robustness & accessibility

**The governing law: voice is a convenience transducer, never the system of record.** ASR produces a *candidate intent*; the host emits the *same WS message a phone emits today*; the server re-validates every target, tallies via `core/logic.js`, and auto-resolves via `armTimer`. Every robustness property the existing audit won — target validation, epoch guards, reconnect replay, anti-leak — is inherited for free. **At any instant, the phone can do everything voice can**, so no misheard word, dead mic, or ASR outage can silently decide the game or block it.

**Confirm / undo, by blast radius:**
- **Tier A — irreversible (lynch, night kill):** never commit on voice alone. The vote is always a phone ballot; the night kill is always a phone tap. A misheard word cannot kill anyone.
- **Tier B — consequential but server-guarded (start, open-vote, extend, restart, name-bearing):** a two-stage, **negative-gated** readback. Silas reflects the *resolved name/action* (which is what catches homophones — the room hears the wrong name and objects) with a ~3 s cancel window: *"I heard: call the vote. Say 'wait' in the next three seconds… three, two, one — ballots open."* Commits on non-objection; aborts on any of {no, stop, wait, hold, not yet, cancel}. This protects the mis-speaker (goes quiet → still abortable by others) while a ready room flows. Flow intents (ready, repeat, who's-left, how-it-works, how-much-time) are **Tier C** — executed instantly, no confirm, because a menu on every utterance is the IVR feeling we're killing.
- **Undo after commit:** Tier B acts that haven't cascaded map to their existing inverse message (e.g. `READY value:false`). A *resolved* lynch has deliberately no undo — which is exactly why the vote is phone-only and simultaneous.

**Homophone safety ("Vince"/"Vint"):** build a Double-Metaphone index of the living roster at deal time. Exactly one match → proceed to the Tier-B readback. Two+ colliding names → Silas **force-disambiguates by seat/appearance, never guesses**: *"Two of you answer to that — Vince in the hat, or Vint by the window?"* A dead/illegal target → Silas rejects out loud, mirroring the server's own alive-checks. Non-native speakers get the same confidence-gated readback — no accent-specific tuning.

**Degradation ladder — always falls to taps.** A single `voiceStatus ∈ {live, muddy, off}`, announced by Silas on change:
1. **live** — full voice + phones.
2. **muddy** (ASR errors/latency spike) — Silas keeps narrating (prebaked mp3 is offline-capable), stops accepting voice intents, and says so: *"My ears are bad tonight, friends — thumbs on your phones."*
3. **off** (no ASR / no network to STT) — pure narration + phones. **This is literally today's shipped game**, not a broken state. Because phone controls are never hidden behind voice and the server is untouched, degrade-to-taps needs no reconnect and loses no progress. The failure is always made **loud** — Silas says he can't hear rather than silently swallowing a command (the worst UX: a player can't tell "ignored" from "mis-parsed").

**Accessibility — voice-first must not mean voice-only.** Every load-bearing fact Silas says is already on the wire as `NARRATE`/`CAPTION` text. Upgrade the host screen from transient to a **permanent visual mirror**: a sticky large-type, high-contrast caption of every Silas line (game fully playable with the sound off), plus a **"what Silas heard" echo with the visible confirm countdown** (*"I heard: hang Vince — locking in 3…2…1"*) so a deaf/HoH player can *see* a misheard act and veto it from their phone. The host's existing tap buttons stay as an always-available phone-parity control set, so a non-verbal player plays fully by tapping and a deaf player reads captions and taps. **The captions carry only public `NARRATE`/`CAPTION` text — never role or night data** (routed through the same `assertBroadcastSafe` funnel).

**The "who spoke?" gap (honest).** Without speaker-ID (deliberately deferred), a spoken "I'm ready" can't be attributed to one player's `READY`. **v1 resolution:** treat spoken "we're ready" as a **room-level nudge** — Silas says "the room's leaning toward a vote, anyone object?" and phase-ending intents lean on the server's existing quorum/host-gating — while **per-player Ready stays a silent phone tap** for tables that want precise readiness. This means one loud troll can't nuke a round, and it's the biggest v1 UX compromise to revisit in Phase 3.

---

## 7. Build plan

### Phase 0 — De-risking spike (0.5–1 day, throwaway)
**The single hard question:** can a device on a table hear a wake word + one command over 5-12 people cross-talking, *without* false-triggering on Silas's own speaker output?
- One throwaway page: host shell + `SpeechRecognition` (`continuous`, `interimResults`), wake-word "Silas" detection on interim transcript, capture the next clause, log it.
- **Prove echo-suppression** using the real hooks: on `MidnightSpeak.onSpeech(start)` `recognition.stop()`; on `onSpeech(end)` + tail `recognition.start()`.
- Run it once at a real noisy table. Measure catch-rate over cross-talk and false-trigger rate.
- **Deliverable:** a go/no-go on browser ASR. If it fails the noise test, the streaming `scribe_v2`/Deepgram path becomes Phase 1 scope instead of Phase 2 — this spike exists to learn that on day one.

### Phase 1 — POC / the magic moment (3–5 days on top of the spike; this is the PR)
Delivers §1's loop end-to-end: *talk → Silas acks in character → runs a phase → reads the vote aloud.*
- **`web/host/listen.js`** (new): `SpeechRecognition` wrapper — PTT + wake-word gating, echo mute via `onSpeech`, emits an intent-candidate stream.
- **`web/host/intents.js`** (new): per-phase keyword/regex parser → existing host WS messages, ~6 intents (`deal→HOST_START`, `resolve night→HOST_RESOLVE_NIGHT`, `call vote→HOST_OPEN_VOTE`, `count votes→HOST_RESOLVE_VOTE`, `more time→HOST_EXTEND`, `play again→HOST_RESTART`), plus a graceful "didn't catch that" path.
- **Host page voice mode**: `?voice=1` toggle, listening orb, live interim caption, in-character spoken ack before each intent (Tier-B readback for destructive ones).
- **Server `HOST_SAY`** (~8 lines, `requireHost`): `narrate(game, msg.text)` so the client can make Silas speak arbitrary ack/clarification lines. Everything else reuses existing host messages.
- **Voting + night taps stay exactly as-is.** Only public GM actions are voiced.
- Requires `ELEVENLABS_API_KEY` set so acks/names synthesize in Silas's voice.
- **Reuse:** engine, transport, anti-leak, TTS pipeline, phone, `MidnightSpeak.onSpeech`, all existing host messages — unchanged.

### Phase 2 — MVP (1–2 weeks)
The full product of §2–§6, playable start-to-finish hands-free with the secret beats on phones.
- **Secrecy modality:** `role_audio_url` on `ROLE_ASSIGNED` + phone "hold to ear" reveal (card fallback retained); night screen restyled to a single dim tap target.
- **Curated name deck** (`config/names.json`, ~40 names) + claim-a-name join grid; server `JOIN` takes `name_id` and rejects claimed names; **pre-bake each name** in Silas's voice.
- **Vote polish:** buzz, provisional-select → LOCK-IN, change-until-resolved, `vote_tally_readout` + tally-gated bars.
- **Confirm/undo state machine** (Tier A/B/C, negative-gated), Double-Metaphone disambiguation, `voiceStatus` ladder announced by Silas.
- **Accessibility:** sticky large-type captions + "what Silas heard" echo with visible countdown; phone-parity controls retained.
- New script keys: `vote_tally_readout`, `accusation`, `roster_readout`, `didnt_catch`, `name_ambiguous`, `target_dead`, `confirm_countdown`, `ears_muddy`, `scrapped`, plus a static rules blurb.

### Phase 3 — Polish (1–2 weeks)
- **Real STT tier** *only if the spike demanded it*: `GET /voice/token` + streaming Deepgram/`scribe_v2` from the host page, on-device wake word (openWakeWord WASM) + VAD, browser AEC barge-in.
- **Name-aware accusations** that steer the room (roster fuzzy-match), conversational filler via templates/optional LLM through `HOST_SAY`.
- **Close the "who spoke?" gap** if speaker attribution proves worth it; post-game voice recap (the existing unused `recording` flag).

### Reuse map (headline)
- **Reuse unchanged:** `core/logic.js`, the entire `server/index.js` phase engine + all host messages + `PRIVATE_ONLY`, `tts-cache.js` + `voice/*`, `content/script.json` (existing keys), the phone `VOTE`/night paths, `MidnightWS`/`MidnightSpeak`/`MidnightAmbient`/`MidnightClock`.
- **Extend, don't fork:** `web/host/index.html` (voice mode), `web/app-common.js` (`MidnightEars` + `MidnightSpeak.pause/flush`), `content/script.json` (new keys + name deck), `config/voice.json` (STT slot, key required).
- **Net-new:** `web/host/listen.js`, `web/host/intents.js`, `config/names.json`, the `HOST_SAY` case, and (Phase 3 only) `server/voice/stt.js` + `GET /voice/token`.
- **Delete:** the stale nested `~/Desktop/midnight/midnight/` duplicate, to avoid confusion.

---

## 8. Open questions / decisions for the team

1. **Host hardware.** Is the table device a Chrome laptop/Chromebook (Web Speech + WASM wake word both fine) or could it be a phone/tablet (Web Speech spottier)? This decides how safe the MVP ASR pick is. **Recommendation:** mandate a Chrome host for MVP.
2. **Wake word vs. PTT as the *shipped* default.** We ship both with PTT as the floor; the spike decides how aggressively to lean hands-free. Does the demo audience tolerate holding a button, or must it be fully hands-free to sell the vision?
3. **Speaker attribution for "ready."** Ship v1 as a room-level nudge with per-player Ready staying a phone tap (recommended), or invest in diarization sooner? This determines how much of the phone actually disappears.
4. **Name deck size/theme.** Is ~40 curated, era-appropriate names enough variety across repeat game nights? Should we later layer a free-type *unspoken* nickname on top of the spoken deck name? Needs a content pass with the persona/assets work.
5. **Does "accuse `<name>`" do anything mechanical** (bias ballot order, start a nomination timer) or stay pure theater? The server has no nomination concept today. **Recommendation:** theater-only in v1 to protect vote integrity.
6. **Should the host screen show a live "Silas heard: …" transcript** for trust/debuggability, or is visible text a betrayal of screens-down? **Recommendation:** show it — it's also the accessibility mirror, and it makes the confirm/undo model usable.
7. **Single-vendor vs. best-of-breed for the real tier** (ElevenLabs Scribe STT + TTS to simplify keys/billing, vs. Deepgram STT + ElevenLabs TTS for accuracy). Ties to the per-table cost tolerance.
8. **Godfather kill by voice, ever?** Kept phone-first here. A spoken option would need the full Tier-A treatment and still only writes one GF's `nightActions` entry — probably not worth it.
9. **Confirm-window length** — fixed 3 s or scaled to room noise / ASR confidence? And should "muddy" auto-recover to "live" silently or require a host re-arm to avoid flapping mid-discussion?
