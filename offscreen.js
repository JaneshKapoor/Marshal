// Offscreen document: records a single voice command as 16 kHz mono PCM,
// encodes it as WAV, and sends it to the AssemblyAI Dictation API.
// The Dictation API rejects compressed audio, so we don't use MediaRecorder here.

const SAMPLE_RATE = 16000;
const MAX_MS = 7000; // hard cap per command
const NO_SPEECH_MS = 4000; // give up if the user never starts talking
const TRAILING_SILENCE_MS = 900; // stop this long after speech ends
const SPEECH_RMS = 0.015; // energy threshold for simple VAD
const DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe/live";
const DICTATION_TIMEOUT_MS = 15000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "record-and-transcribe") {
    recordAndTranscribe(msg.assemblyKey)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type === "speak") {
    speak(msg.text).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "stop-speaking") {
    speechSynthesis.cancel();
    sendResponse({ ok: true });
  }
});

// Spoken feedback via the browser-native speechSynthesis API.
function speak(text) {
  return new Promise((resolve) => {
    if (!text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/^[-•*]\s*/gm, "").replace(/\n+/g, ". "));
    u.rate = 1.05;
    const voice = speechSynthesis.getVoices().find((v) => /en[-_]US/i.test(v.lang) && /Samantha|Google US English/i.test(v.name));
    if (voice) u.voice = voice;
    // Long utterances can stall without onend firing, so also cap the wait.
    const timer = setTimeout(resolve, Math.min(60000, 2000 + text.length * 90));
    u.onend = u.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

async function recordCommand() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    throw new Error(
      `Microphone unavailable (${e.name}). Open Marshal settings and click "Grant microphone access".`
    );
  }

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  const chunks = [];
  const start = performance.now();
  let heardSpeech = false;
  let lastSpeechAt = 0;

  try {
    await new Promise((resolve) => {
      node.port.onmessage = ({ data }) => {
        chunks.push(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (rms > SPEECH_RMS) {
          heardSpeech = true;
          lastSpeechAt = now;
        }
        const elapsed = now - start;
        if (
          elapsed >= MAX_MS ||
          (!heardSpeech && elapsed >= NO_SPEECH_MS) ||
          (heardSpeech && now - lastSpeechAt >= TRAILING_SILENCE_MS)
        ) {
          resolve();
        }
      };
      source.connect(node);
    });
  } finally {
    node.port.onmessage = null;
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  }

  const durationMs = Math.round(performance.now() - start);
  console.log("[Marshal offscreen] recorded", durationMs, "ms, speech:", heardSpeech);
  return { samples: concat(chunks), heardSpeech, durationMs };
}

function concat(chunks) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => [...s].forEach((ch, i) => v.setUint8(off + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function transcribe(wav, assemblyKey) {
  const form = new FormData();
  form.append(
    "config",
    new Blob(
      [JSON.stringify({
        keyterms_prompt: ["Marshal", "LinkedIn", "YouTube", "mute", "unmute", "volume", "summarize", "scroll"],
      })],
      { type: "application/json" }
    )
  );
  form.append("audio", wav, "command.wav");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DICTATION_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(DICTATION_URL, {
      method: "POST",
      headers: { Authorization: assemblyKey },
      body: form,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("AssemblyAI timed out. Try again.");
    throw new Error(`Couldn't reach AssemblyAI: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404) throw new Error("AssemblyAI rejected the API key (404). Check it in settings.");
    throw new Error(`AssemblyAI error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  console.log("[Marshal offscreen] dictation response", data);
  return {
    transcript: (data.llm_response || data.text || "").trim(),
    rawText: data.text || "",
    requestMs: data.request_time_ms,
  };
}

async function recordAndTranscribe(assemblyKey) {
  if (!assemblyKey) throw new Error("AssemblyAI API key missing. Add it in Marshal settings.");
  const { samples, heardSpeech, durationMs } = await recordCommand();
  chrome.runtime.sendMessage({ type: "recording-done", durationMs });
  if (!heardSpeech) return { transcript: "", rawText: "", noSpeech: true };
  const t0 = performance.now();
  const result = await transcribe(encodeWav(samples, SAMPLE_RATE), assemblyKey);
  result.transcribeMs = Math.round(performance.now() - t0);
  return result;
}
