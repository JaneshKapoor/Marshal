import { setStatus, getStatus, getKeys } from "./lib/status.js";
import { routeIntent } from "./lib/router.js";
import { openSite, setTabVolume, mediaControl, scrollPage, getActiveTab, extractForSummary } from "./lib/actions.js";
import { summarize } from "./lib/summarize.js";

const SUMMARY_MODEL = "gpt-4.1-mini";

chrome.runtime.onInstalled.addListener(async () => {
  await setStatus("idle");
});

// ---------- Offscreen document (mic + speech) ----------

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
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
        justification: "Record short voice commands and speak Marshal's replies.",
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function captureTranscript(assemblyKey) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "record-and-transcribe", assemblyKey });
  if (!res) throw new Error("Recorder didn't respond.");
  if (!res.ok) throw new Error(res.error);
  return res;
}

async function speak(text) {
  await setStatus("speaking", { result: text });
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: "offscreen", type: "speak", text });
  } catch (e) {
    console.warn("[Marshal] speech failed", e);
  }
}

// ---------- Action dispatch ----------

async function runSummary(tab, keys) {
  await setStatus("thinking", { result: "Reading the page…" });
  const extracted = await extractForSummary(tab);
  console.log("[Marshal] extracted", extracted);
  return summarize(extracted, { apiKey: keys.OPENAI_API_KEY, model: SUMMARY_MODEL });
}

async function dispatch(intent, keys) {
  switch (intent.name) {
    case "open_site": {
      const { tab, message } = await openSite(intent.args.url, { waitForLoad: !!intent.args.summarize_after });
      if (!intent.args.summarize_after) return message;
      await speak(message);
      return runSummary(await chrome.tabs.get(tab.id), keys);
    }
    case "set_tab_volume":
      return (await setTabVolume(intent.args.action, intent.args.level)).message;
    case "media_control":
      return (await mediaControl(intent.args.action)).message;
    case "scroll":
      return (await scrollPage(intent.args.direction || "down")).message;
    case "summarize_current_page":
      return runSummary(await getActiveTab(), keys);
    default:
      return "I didn't catch a command for that.";
  }
}

// ---------- Activation pipeline ----------

async function muteAudibleTabs() {
  const tabs = await chrome.tabs.query({ audible: true });
  const toDuck = tabs.filter((t) => !t.mutedInfo?.muted);
  await Promise.all(toDuck.map((t) => chrome.tabs.update(t.id, { muted: true }).catch(() => {})));
  return toDuck.map((t) => t.id);
}

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
  chrome.runtime.sendMessage({ target: "offscreen", type: "stop-speaking" }).catch(() => {});
  await setStatus("listening", { transcript: "", result: "", error: "", intent: null, timings: null });
  const t0 = Date.now();
  try {
    // Duck playing tabs while recording so the mic hears the user, not the video.
    // Restored before routing so mute/unmute commands see the real state.
    const ducked = await muteAudibleTabs();
    let t;
    try {
      t = await captureTranscript(keys.ASSEMBLYAI_API_KEY);
    } finally {
      await Promise.all(ducked.map((id) => chrome.tabs.update(id, { muted: false }).catch(() => {})));
    }
    if (t.noSpeech || !t.transcript) {
      await speak("I didn't hear anything.");
      await setStatus("idle");
      return;
    }
    console.log("[Marshal] transcript:", t.transcript, "| raw:", t.rawText, "|", t.transcribeMs, "ms");
    await setStatus("thinking", { transcript: t.transcript });

    const r0 = Date.now();
    const intent = await routeIntent(t.transcript, { apiKey: keys.OPENAI_API_KEY, model: keys.OPENAI_MODEL });
    const routeMs = Date.now() - r0;
    console.log("[Marshal] intent:", intent, routeMs, "ms");
    await setStatus("thinking", { intent, timings: { transcribeMs: t.transcribeMs, routeMs } });

    const reply = intent ? await dispatch(intent, keys) : "I didn't catch a command for that.";
    console.log("[Marshal] done in", Date.now() - t0, "ms:", reply);
    await speak(reply);
    await setStatus("idle", { result: reply });
  } catch (e) {
    console.error("[Marshal] pipeline error", e);
    const msg = e.message || String(e);
    await setStatus("error", { error: msg });
    await speak(`Sorry. ${msg}`);
    await setStatus("error", { error: msg });
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

// Exposed for manual testing from the service-worker console, e.g.
//   marshal.dispatch({ name: "set_tab_volume", args: { action: "mute" } })
//   marshal.runText("open youtube")
globalThis.marshal = {
  dispatch: async (intent) => dispatch(intent, await getKeys()),
  runText: async (text) => {
    const keys = await getKeys();
    const intent = await routeIntent(text, { apiKey: keys.OPENAI_API_KEY, model: keys.OPENAI_MODEL });
    const reply = intent ? await dispatch(intent, keys) : "I didn't catch a command for that.";
    await speak(reply);
    await setStatus("idle", { transcript: text, intent, result: reply });
    return { intent, reply };
  },
};
