// app-common.js — shared client helpers (WebSocket + narrator playback)

function MidnightWS(onMessage, onOpen) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = proto + "://" + location.host + "/ws";
  let ws, queue = [], ready = false, retry = 0;

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      ready = true; retry = 0;
      queue.forEach((m) => ws.send(m)); queue = [];
      if (onOpen) onOpen();
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

  function speakText(text) {
    if (!window.speechSynthesis || !text) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (!chosenVoice) chosenVoice = pickVoice();
    if (chosenVoice) u.voice = chosenVoice;
    u.pitch = 0.7;   // smoky, low
    u.rate = 0.88;   // slow, deliberate
    u.volume = 1;
    speechSynthesis.speak(u);
  }

  return {
    // narrate({text, audio_url}): play mp3 if present, else browser TTS
    narrate(payload) {
      if (payload.audio_url) {
        if (!audioEl) audioEl = new Audio();
        audioEl.src = payload.audio_url;
        audioEl.play().catch(() => speakText(payload.text));
      } else {
        speakText(payload.text);
      }
    },
    // call once from a user gesture to unlock audio/TTS on mobile
    unlock() {
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0; speechSynthesis.speak(u);
      }
    },
  };
})();
