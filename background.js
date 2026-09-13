import { setStatus, getStatus } from "./lib/status.js";

chrome.runtime.onInstalled.addListener(async () => {
  await setStatus("idle");
});

async function activate(source) {
  const { state } = await getStatus();
  if (state !== "idle" && state !== "error") {
    console.log("[Marshal] busy, ignoring activation from", source);
    return;
  }
  console.log("[Marshal] activated via", source);
  // TODO(marshal): Phase 2 wires mic capture + transcription here.
  await setStatus("listening", { transcript: "", result: "", error: "" });
  setTimeout(() => setStatus("idle"), 1500);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "activate-marshal") activate("shortcut");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "activate") {
    activate(msg.source || "popup").then(() => sendResponse({ ok: true }));
    return true;
  }
});
