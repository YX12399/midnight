// app-common.js — shared client helpers (WebSocket + narrator playback)

// Escape a string for interpolation into innerHTML (player names are
// user-supplied; the server strips markup too — defense in depth).
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function MidnightWS(onMessage, onOpen) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = proto + "://" + location.host + "/ws";
  let ws, queue = [], ready = false, retry = 0;

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      ready = true; retry = 0;
      // Re-identify FIRST (onOpen sends REJOIN/HOST_RECONNECT, which binds this
      // socket to the game) — only then flush queued actions, or the server
      // would drop them as coming from an unknown socket.
      if (onOpen) onOpen();
      queue.forEach((m) => ws.send(m)); queue = [];
    };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      ready = false;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 400 * retry);
    };
    ws.onerror = () => ws.close();
  }
  connect();

  return {
    send(obj) {
      const s = JSON.stringify(obj);
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(s);
      else queue.push(s);
    },
  };
}

// Narrator playback: prefer cached/ElevenLabs mp3, else browser TTS as Silas.
const MidnightSpeak = (function () {
  let audioEl = null;
  let chosenVoice = null;
  let onStart = null, onEnd = null; // fired around playback so ambient can duck
  const fireStart = () => { try { onStart && onStart(); } catch (_) {} };
  const fireEnd = () => { try { onEnd && onEnd(); } catch (_) {} };

  function pickVoice() {
    const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    // prefer a deep English male voice
    const prefer = ["Daniel", "Alex", "Fred", "Google UK English Male", "Microsoft Guy", "Microsoft David"];
    for (const name of prefer) {
      const v = voices.find((x) => x.name.includes(name));
      if (v) return v;
    }
    return voices.find((v) => /en/i.test(v.lang)) || voices[0] || null;
  }
  if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = () => { chosenVoice = pickVoice(); };
  }

  // Narration is a QUEUE: back-to-back beats (a death, then a win) play in
  // full, one after another, instead of the second clipping the first.
  let q = [], speaking = false, guardTimer = null;

  function lineDone() {
    if (!speaking) return; // already settled (guard vs. double onend/onerror)
    speaking = false;
    if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }
    fireEnd();
    setTimeout(playNext, 350); // a breath between lines
  }

  function speakText(text) {
    if (!window.speechSynthesis || !text) { lineDone(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (!chosenVoice) chosenVoice = pickVoice();
    if (chosenVoice) u.voice = chosenVoice;
    u.pitch = 0.7;   // smoky, low
    u.rate = 0.88;   // slow, deliberate
    u.volume = 1;
    u.onend = lineDone; u.onerror = lineDone;
    speechSynthesis.speak(u);
  }

  function playNext() {
    if (speaking || !q.length) return;
    const payload = q.shift();
    speaking = true;
    fireStart();
    guardTimer = setTimeout(lineDone, 25000); // never let a stuck line jam the queue
    if (payload.audio_url) {
      if (!audioEl) { audioEl = new Audio(); audioEl.onended = lineDone; audioEl.onerror = lineDone; }
      audioEl.src = payload.audio_url;
      audioEl.play().catch(() => speakText(payload.text));
    } else {
      speakText(payload.text);
    }
  }

  return {
    // narrate({text, audio_url}): queue the line; mp3 preferred, browser TTS fallback
    narrate(payload) {
      q.push(payload);
      playNext();
    },
    // Register duck hooks: onSpeech(whenSilasStarts, whenSilasStops).
    onSpeech(startFn, endFn) { onStart = startFn; onEnd = endFn; },
    // call once from a user gesture to unlock audio/TTS on mobile
    unlock() {
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0; speechSynthesis.speak(u);
      }
    },
  };
})();

// Procedural speakeasy ambience for the room speaker — a faint warm drone,
// vinyl crackle, and the odd sparse piano note, all synthesized in the browser
// (no asset, works offline). Phase-aware, ducks under narration, mutable. Only
// the host starts it; phones never do. Everything is guarded so audio quirks on
// any device can never break the game.
const MidnightAmbient = (function () {
  let ctx = null, master = null, filter = null, crackleGain = null;
  let started = false, muted = false, phase = "reveal", curLevel = 0.13;
  const timers = [];
  const BASE = 0.13;
  const at = () => ctx.currentTime;

  function buildDrone() {
    filter = ctx.createBiquadFilter();
    filter.type = "lowpass"; filter.frequency.value = 440; filter.Q.value = 0.6;
    const dg = ctx.createGain(); dg.gain.value = 0.9;
    filter.connect(dg); dg.connect(master);
    [55, 82.4, 110].forEach((f, i) => {          // A1 / E2 / A2 — a warm hum
      const o = ctx.createOscillator(); o.type = i === 0 ? "sine" : "triangle"; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = i === 0 ? 0.5 : 0.16;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05 + i * 0.03;
      const lg = ctx.createGain(); lg.gain.value = f * 0.004; // gentle detune drift
      lfo.connect(lg); lg.connect(o.frequency);
      o.connect(g); g.connect(filter); o.start(); lfo.start();
    });
  }
  function buildCrackle() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.06 ? 1 : 0.05);
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1800;
    crackleGain = ctx.createGain(); crackleGain.gain.value = 0.06;
    src.connect(hp); hp.connect(crackleGain); crackleGain.connect(master); src.start();
  }
  function piano() {
    if (!started) return;
    try {
      const scale = [220, 246.9, 293.7, 329.6, 392, 440]; // A-minor-ish, tasteful
      const f = scale[Math.floor(Math.random() * scale.length)];
      const lvl = phase === "night" ? 0.05 : phase === "day" ? 0.09 : 0.07;
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f;
      const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = f * 2;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at());
      g.gain.linearRampToValueAtTime(lvl, at() + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at() + 1.9);
      const g2 = ctx.createGain(); g2.gain.value = 0.3; o2.connect(g2); g2.connect(g);
      o.connect(g); g.connect(master);
      o.start(); o2.start(); o.stop(at() + 2); o2.stop(at() + 2);
    } catch (_) {}
    timers.push(setTimeout(piano, 3500 + Math.random() * 6500)); // sparse
  }
  function ramp(v, t) { if (master && !muted) master.gain.linearRampToValueAtTime(v, at() + (t || 0.5)); }

  return {
    start() {
      if (started) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        ctx = new AC();
        if (ctx.state === "suspended" && ctx.resume) ctx.resume();
        master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
        buildDrone(); buildCrackle();
        started = true;
        ramp(BASE, 4);                          // slow fade-in
        timers.push(setTimeout(piano, 2500));
      } catch (e) { console.warn("[ambient] disabled:", e && e.message); }
    },
    setPhase(p) {
      phase = p || "reveal"; if (!started) return;
      try {
        const map = { night: { f: 300, g: 0.10 }, morning: { f: 430, g: 0.12 }, day: { f: 660, g: 0.15 }, vote: { f: 360, g: 0.13 }, end: { f: 260, g: 0.10 } };
        const m = map[phase] || { f: 470, g: 0.13 };
        filter.frequency.linearRampToValueAtTime(m.f, at() + 2.5);
        curLevel = m.g; ramp(m.g, 2.5);
      } catch (_) {}
    },
    duck(on) {
      if (!started || muted) return;
      try { master.gain.cancelScheduledValues(at()); master.gain.linearRampToValueAtTime(on ? Math.min(0.05, curLevel * 0.35) : curLevel, at() + 0.25); } catch (_) {}
    },
    toggleMute() {
      muted = !muted;
      try { if (master) master.gain.linearRampToValueAtTime(muted ? 0 : curLevel, at() + 0.4); } catch (_) {}
      return muted;
    },
    get muted() { return muted; },
    get enabled() { return started; },
  };
})();

// Phase countdown clock: turns the server's `deadline` (epoch ms) into a live
// ticking mm:ss so the day/night/action/vote intervals feel real at the table.
// Mount one element, then call set(deadline) on every STATE — pass a non-number
// (null) to hide it between timed phases. Goes red + pulses in the final 10s.
const MidnightClock = (function () {
  let interval = null;
  let el = null;
  function fmt(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function stop() { if (interval) { clearInterval(interval); interval = null; } }
  function tick(deadline) {
    if (!el) return;
    const remain = deadline - Date.now();
    el.textContent = fmt(remain);
    el.classList.toggle("urgent", remain <= 10000);
    if (remain <= 0) { el.textContent = "0:00"; stop(); }
  }
  return {
    mount(element) { el = element; },
    set(deadline) {
      stop();
      if (!el) return;
      if (typeof deadline !== "number") {
        el.textContent = "";
        el.classList.remove("urgent");
        el.classList.add("hidden");
        return;
      }
      el.classList.remove("hidden");
      tick(deadline);
      interval = setInterval(() => tick(deadline), 250);
    },
  };
})();
