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
├─ config/assets.json     # paste Higgsfield art URLs here (falls back to CSS art)
├─ config/voice.json      # voice provider config
├─ scripts/               # engine tests, end-to-end smoke test, line pre-render
├─ Dockerfile · render.yaml · fly.toml
└─ .env.example
```

## Tests

```bash
npm test     # pure-engine assertions + a full 5-player game over WebSockets,
             # asserting town win AND zero secret leaks
```

## What's next (P2–P4, see the build spec)
- **P2** live ElevenLabs voice for dynamic lines · ambient track · death/victory art.
- **P3** push-to-talk capture · Scribe v2 transcription · cloud storage · **post-game recap reel**.
- **P4** voice-enrollment diarization so the day phase can use a center mic · SMS fallback ·
  role packs (Jester/Vigilante/…) · sub-90-second setup.

## Privacy
Recording is **opt-in per game** (host toggle in the lobby) and off by default. The capture
pipeline is P3 — this MVP records nothing.
