import { setStatus, getStatus, getKeys } from "./lib/status.js";

chrome.runtime.onInstalled.addListener(async () => {
  await setStatus("idle");
});

// ---------- Offscreen recorder ----------

let creatingOffscreen;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Record a short voice command from the microphone.",
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function captureTranscript(assemblyKey) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "record-and-transcribe",
    assemblyKey,
  });
  if (!res) throw new Error("Recorder didn't respond.");
  if (!res.ok) throw new Error(res.error);
  return res;
}

// ---------- Activation pipeline ----------

async function activate(source) {
  const { state } = await getStatus();
  if (state === "listening" || state === "thinking") {
    console.log("[Marshal] busy, ignoring activation from", source);
    return;
  }
  const keys = await getKeys();
  if (!keys.ASSEMBLYAI_API_KEY || !keys.OPENAI_API_KEY) {
    await setStatus("error", { error: "Add your API keys in Marshal settings." });
    chrome.runtime.openOptionsPage();
    return;
  }

  console.log("[Marshal] activated via", source);
  await setStatus("listening", { transcript: "", result: "", error: "" });
  try {
    const t = await captureTranscript(keys.ASSEMBLYAI_API_KEY);
    if (t.noSpeech || !t.transcript) {
      await setStatus("idle", { result: "I didn't hear anything." });
      return;
    }
    console.log("[Marshal] transcript:", t.transcript, "| raw:", t.rawText, "|", t.transcribeMs, "ms");
    await setStatus("thinking", { transcript: t.transcript });
    // TODO(marshal): Phase 3 routes the transcript through OpenAI function calling.
    await setStatus("idle", { transcript: t.transcript, result: `Transcribed in ${t.transcribeMs} ms` });
  } catch (e) {
    console.error("[Marshal] pipeline error", e);
    await setStatus("error", { error: e.message || String(e) });
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "activate-marshal") activate("shortcut");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === "offscreen") return;
  if (msg?.type === "activate") {
    activate(msg.source || "popup");
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "recording-done") {
    getStatus().then((s) => s.state === "listening" && setStatus("thinking"));
  }
});
