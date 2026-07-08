# MIDNIGHT — Voice Game-Master Edition

A voice-narrated game of **trust & lies** (Mafia / social deduction) for **5–12 players
around a real table**. An AI barkeep named **Silas** narrates in a 1940s speakeasy voice,
secretly assigns roles, runs the night→day cycle, and tallies votes — while every secret
travels privately to each player's phone. The room speaker is public theater; the phones
hold the lies.

> This is the **P1 MVP**: QR join · private role reveal · phone-tap night actions ·
> spoken day votes · scripted Silas narration · the rules engine. Built to the
> "blind narrator + private whisper" architecture so **secrets cannot leak**.

---

## Quick start (play tonight, on your Wi-Fi)

```bash
npm install          # installs `ws`
npm start            # server on http://localhost:3000
```

1. **Host device** (laptop/TV — this is the room speaker): open **`/host`**, click
   **Open the Bar**, turn the volume up. A 4-letter code + QR appear.
2. **Players**: scan the QR (or open the site and punch in the code) → enter a name.
   Each phone is now that player's private channel.
3. With **5–12** players in, the host clicks **Lock the Doors & Deal**. Silas takes over.

Everyone on the **same Wi-Fi** can reach the host device — find your host's LAN IP
(e.g. `192.168.1.20`) and players visit `http://192.168.1.20:3000`. (The QR encodes
whatever origin the host page is served from, so serving over your LAN IP "just works".)

### Try it solo first
Open `/host` in one tab and `/?code=XXXX` in five private/incognito windows to watch a
full game run end-to-end.

---

## How it works (the architecture)

**Blind narrator + private whisper** (the one decision that shapes everything):

- The **room speaker is output-only theater** — narration, deaths, vote tallies. Public, heard by all.
- **Secrets travel through each player's phone** — role reveal, the Godfather's kill, the
  Detective's query + result, the Doctor's save. Never spoken aloud.
- **The day stays face-to-face** — discussion is out loud, eyes up. Phones are used only
  for the secret night moments and the vote.

### The anti-leak chokepoint
Every event that carries a hidden role or a night result (`ROLE_ASSIGNED`, `NIGHT_PROMPT`,
`NIGHT_RESULT`, `GHOST`) may travel **only** through a player's private socket. The
broadcast functions in `server/index.js` *throw* if you ever try to broadcast one — so
leaks are impossible **by construction**, not by discipline. The smoke test asserts this.

```
server→phone:  ROLE_ASSIGNED · NIGHT_PROMPT · NIGHT_RESULT · GHOST   (private only)
server→room:   NARRATE · STATE · VOTE_TALLY · GAME_OVER             (public theater)
```

### Roles & balance (5–12)
| Players | Godfather | Detective | Doctor | Citizens |
|---|---|---|---|---|
| 5 | 1 | 1 | 1 | 2 |
| 6–7 | 1 | 1 | 1 | rest |
| 8–9 | 2 | 1 | 1 | rest |
| 10–12 | 3 | 1 | 1 | rest |

Town wins when no mafia remain. The family wins when they equal or outnumber the town.

---

## The narrator (Silas)

By default Silas speaks through the **host browser's built-in TTS** (free, instant, works
offline). It sounds decent but robotic. To give him the real smoky-barkeep voice:

1. Create a voice on ElevenLabs using the prompt in `content/script.json` / the voice bible
   (a world-weary 1940s noir speakeasy bartender, smoky gravelly warmth, slow hard-boiled cadence).
2. Set the env var and voice id:
   ```bash
   export ELEVENLABS_API_KEY=sk_...            # never commit this
   ```
   and put the voice id in `config/voice.json → narrator_voice_id`.
3. (Optional, recommended) pre-render the fixed lines once for instant, cheap playback:
   ```bash
   npm run prerender
   ```

The server caches every synthesized line to `.cache/tts/` and serves it from `/tts/...`,
so each line costs an API call **once**. Dynamic lines (names, roles) cache on first use.
If a key isn't set, the game silently falls back to browser TTS — nothing breaks.

The key can also live in a **`.env`** file at the repo root (auto-loaded on boot — no
`export` needed): `ELEVENLABS_API_KEY=sk_...`. `.env` is gitignored.

### The prebaked voice — **Vlad** (Higgsfield), shipping now

**Every fixed narration line** — game start, nightfall, the night/discussion/vote last-calls,
the quiet morning, the extend beat, the tie, the vote call, both endings (all 31 variants) —
is pre-rendered in **Vlad**, a gravelly Russian-mobster voice that suits the game-master, and
**committed under `content/audio/tts/`** so it ships and plays with **zero runtime cost or API
key**. Priority order at runtime:

1. **`ELEVENLABS_API_KEY` set** → ElevenLabs voices *every* line at runtime (incl. names/roles).
2. **No key** → the prebaked **Vlad** lines play for all fixed narration; only the two truly
   dynamic lines (`morning_death` and `elimination`, which splice in a `{NAME}`/`{ROLE}`) fall
   back to browser TTS.

The prebaked layer is config-driven (`config/voice.json → prebaked`). To (re-)bake lines:
generate each fixed line with the Higgsfield `seed_audio` model + Vlad's `voice_id`, drop the
resulting `{key,index,url}` list into `.cache/audio-urls.json`, and run
`node scripts/bake-audio.mjs` — it downloads and files each clip under the exact hash the
server serves. `scripts/audio-manifest.mjs` prints which lines/hashes are expected.

---

## Hands-free (voice-first) mode 🎙️

The host device can run the game **entirely by voice** — the table talks to Silas
and he runs the room like a human game-master. Open the host on a **Chrome/Edge**
machine (Web Speech needs a secure context, so use `http://localhost:3000/host`);
the phones still join over your LAN (the QR auto-points at the LAN IP).

- **Hold to talk** (or press **spacebar**), or flip on the **wake word** ("Silas, …").
- Say **"deal us in"**, **"wake the town"**, **"call the vote"**, **"count the votes"**,
  **"give us more time"**, **"play again"** — each maps to the exact host action a
  button already fires. Consequential ones get a spoken, negative-gated confirm
  ("…say *wait* to stop") so a misheard word can never decide the game.
- Ask him things: **"who's still standing?"**, **"how do we play?"**, **"say that again."**
- **Secrets never touch the mic.** Roles, night actions and votes stay on the phones
  (the anti-leak chokepoint is unchanged). Voice only drives the *public* beats.
- If the browser can't hear (or you'd rather tap), the existing buttons are always
  there — voice is a convenience layer, never the system of record.

The full design (interaction model, the secrecy threat model, architecture, and the
phased build plan) is in **[VOICE_FIRST.md](VOICE_FIRST.md)**. Set `ELEVENLABS_API_KEY`
to have Silas speak dynamic lines (names, ad-hoc acks) in his real voice; without it,
fixed narration is the prebaked Vlad and ad-hoc acks fall back to browser TTS.

New modules: `web/host/intents.js` (the grammar — pure + unit-tested), `web/host/ears.js`
(the SpeechRecognition driver with echo-gate), one additive `HOST_SAY` server message,
and a voice bar on the host page. Tests: `scripts/intents-test.js` (28) + `scripts/voice-test.js`.

---

## Get a public URL (play with people anywhere)

The server is a long-lived WebSocket process, so it wants a persistent host (not
serverless). Any of these give you a free public URL in ~2 minutes:

**Render** — push this folder to GitHub, then "New Web Service" → it reads `render.yaml`.
**Fly.io** — `fly launch` (uses the included `Dockerfile` / `fly.toml`), then `fly deploy`.
**Railway** — "New Project → Deploy from repo"; it auto-detects `npm start`.

On all three: set `ELEVENLABS_API_KEY` in the dashboard's env vars if you want real voice.
Once live, the host page's QR will encode the public URL, so players can join from any
network — not just your Wi-Fi.

---

## Project layout

```
midnight/
├─ core/logic.js          # pure rules engine (no I/O) — port of the original logic.js
├─ server/
│  ├─ index.js            # http static + WebSocket transport + phase orchestration
│  ├─ voice/provider.js   # VoiceProvider interface (+ graceful browser fallback)
│  ├─ voice/elevenlabs.js # ElevenLabs TTS provider
│  └─ tts-cache.js        # hash → cache → serve (latency & cost trick, §7)
├─ web/
│  ├─ phone/              # player PWA: QR join, role reveal, night taps, vote, ghost
│  ├─ host/               # room speaker + host controls (start/resolve/recount/rematch)
│  ├─ table/              # optional read-only TV/projector view
│  ├─ app-common.js       # shared WS client + narrator playback
│  └─ shared.css          # noir / speakeasy styling
├─ content/script.json    # Silas's lines, templated by phase ({NAME}/{ROLE})
├─ config/assets.json     # art paths (role cards shipped in web/assets/; empty ⇒ CSS fallback)
├─ config/voice.json      # voice provider config
├─ scripts/               # engine tests, end-to-end smoke test, line pre-render
├─ Dockerfile · render.yaml · fly.toml
└─ .env.example
```

## Tests

```bash
npm test     # one command, six suites, ~69 checks:
             #  · engine  — pure rules-engine assertions
             #  · smoke   — a full 5-player game over WebSockets: town win + zero secret leaks
             #  · timer   — phases auto-resolve so one AFK player can't stall the table
             #  · edge    — role deal, private reveals, reconnect, bad-input hardening
             #  · warn    — Silas's "last call" narration fires before each phase expires
             #  · extend  — the host "+30s" control pushes the live deadline out
```
The socket suites self-spawn isolated servers (see `scripts/run-sockets.js`), so
there's nothing to start by hand.

## What's next (P2–P4, see the build spec)
- **P2** live ElevenLabs voice for dynamic lines · ambient track · death/victory art.
- **P3** push-to-talk capture · Scribe v2 transcription · cloud storage · **post-game recap reel**.
- **P4** voice-enrollment diarization so the day phase can use a center mic · SMS fallback ·
  role packs (Jester/Vigilante/…) · sub-90-second setup.

## Privacy
Recording is **opt-in per game** (host toggle in the lobby) and off by default. The capture
pipeline is P3 — this MVP records nothing.
