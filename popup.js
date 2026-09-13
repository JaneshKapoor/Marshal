const $ = (id) => document.getElementById(id);

function render(status = {}) {
  const state = status.state || "idle";
  document.body.dataset.state = state;
  $("state").textContent = state;
  $("transcript").textContent = status.transcript || "";
  $("result").textContent = status.result || "";
  $("error").hidden = !status.error;
  $("error").textContent = status.error || "";
  $("talk").disabled = state !== "idle" && state !== "error";
}

async function init() {
  const { marshalStatus, ASSEMBLYAI_API_KEY, OPENAI_API_KEY } = await chrome.storage.local.get([
    "marshalStatus", "ASSEMBLYAI_API_KEY", "OPENAI_API_KEY",
  ]);
  render(marshalStatus);
  if (!ASSEMBLYAI_API_KEY || !OPENAI_API_KEY) {
    $("missing").hidden = false;
    return;
  }
  // Clicking the toolbar icon opens this popup, so opening it counts as activation.
  chrome.runtime.sendMessage({ type: "activate", source: "icon" });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.marshalStatus) render(changes.marshalStatus.newValue);
});

$("talk").onclick = () => chrome.runtime.sendMessage({ type: "activate", source: "popup-button" });
$("openOptions").onclick = $("openOptions2").onclick = () => chrome.runtime.openOptionsPage();

init();
