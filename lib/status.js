// Shared activation state, kept in chrome.storage.local so the popup can
// render it and it survives service-worker restarts.

export const STATES = ["idle", "listening", "thinking", "speaking", "error"];

const BADGE = {
  idle: { text: "", color: "#666" },
  listening: { text: "REC", color: "#d93025" },
  thinking: { text: "...", color: "#f9ab00" },
  speaking: { text: "SAY", color: "#1a73e8" },
  error: { text: "!", color: "#d93025" },
};

export async function setStatus(state, extra = {}) {
  const { marshalStatus = {} } = await chrome.storage.local.get("marshalStatus");
  const next = { ...marshalStatus, ...extra, state, updatedAt: Date.now() };
  await chrome.storage.local.set({ marshalStatus: next });
  const badge = BADGE[state] || BADGE.idle;
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  console.log("[Marshal] state:", state, extra);
  return next;
}

export async function getStatus() {
  const { marshalStatus = { state: "idle" } } = await chrome.storage.local.get("marshalStatus");
  return marshalStatus;
}

export async function getKeys() {
  const { ASSEMBLYAI_API_KEY = "", OPENAI_API_KEY = "", OPENAI_MODEL = "" } =
    await chrome.storage.local.get(["ASSEMBLYAI_API_KEY", "OPENAI_API_KEY", "OPENAI_MODEL"]);
  return { ASSEMBLYAI_API_KEY, OPENAI_API_KEY, OPENAI_MODEL: OPENAI_MODEL || "gpt-4.1-nano" };
}
