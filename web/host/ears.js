// web/host/ears.js — MidnightEars: the host device's listening loop.
// A thin wrapper over the browser SpeechRecognition API (Chrome/Edge/Android
// Chrome). Two input modes: push-to-talk (mic open only while a button is held —
// the reliable floor for a loud room) and wake-word "Silas" (continuous —
// hands-free ceiling). Echo-gated: the mic is HARD-MUTED while Silas speaks, so
// he can never transcribe himself. Emits interim + final transcripts; the host
// page feeds finals to MidnightIntents. If the browser has no ASR, `supported`
// is false and the host silently falls back to its tap buttons.
const MidnightEars = (function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SR && window.isSecureContext !== false;
  let rec = null, listening = false, muted = false, mode = "off"; // off | ptt | wake
  let wantOn = false, silasSpeaking = false, held = false;
  let cb = { final: null, interim: null, state: null };

  function emit() { if (cb.state) cb.state({ supported, listening, muted, mode, silasSpeaking, wantOn }); }

  function build() {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
      }
      if (interim && cb.interim) cb.interim(interim);
      if (final && cb.final) cb.final(final);
    };
    // Chrome ends recognition after silence even in continuous mode — reopen it
    // if we still want to be listening and Silas isn't talking.
    rec.onend = () => { listening = false; emit(); if (wantOn && !muted && !silasSpeaking) start(); };
    rec.onerror = (e) => {
      // no-speech / aborted are routine; network / not-allowed are real.
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "network") {
        if (cb.state) cb.state({ supported, listening: false, muted, mode, error: e.error });
      }
    };
  }
  function start() { if (!supported) return; if (!rec) build(); try { rec.start(); listening = true; } catch (_) { /* already running */ } emit(); }
  function stop() { try { rec && rec.stop(); } catch (_) {} listening = false; emit(); }

  return {
    get supported() { return supported; },
    init(callbacks) { cb = Object.assign(cb, callbacks || {}); emit(); },
    setMode(m) {
      mode = m;
      if (m === "wake") { wantOn = true; if (!silasSpeaking && !muted) start(); }
      else { wantOn = held && m === "ptt"; if (!wantOn) stop(); }
      emit();
    },
    // push-to-talk button
    hold() { held = true; if (mode === "ptt") { wantOn = true; if (!silasSpeaking && !muted) start(); } },
    release() { held = false; if (mode === "ptt") { wantOn = false; stop(); } },
    // echo-gate, driven by MidnightSpeak.onSpeech from the host page
    silasStart() { silasSpeaking = true; stop(); emit(); },
    silasEnd() { silasSpeaking = false; emit(); if (wantOn && !muted) setTimeout(() => { if (wantOn && !muted && !silasSpeaking) start(); }, 500); },
    mute(v) { muted = !!v; if (muted) stop(); else if (wantOn && !silasSpeaking) start(); emit(); },
    get isListening() { return listening; },
  };
})();
