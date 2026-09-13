const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(["ASSEMBLYAI_API_KEY", "OPENAI_API_KEY", "OPENAI_MODEL"]);
  $("aai").value = s.ASSEMBLYAI_API_KEY || "";
  $("oai").value = s.OPENAI_API_KEY || "";
  $("model").value = s.OPENAI_MODEL || "";
  try {
    const perm = await navigator.permissions.query({ name: "microphone" });
    $("micMsg").textContent = perm.state === "granted" ? "Granted ✓" : "";
  } catch {}
}

$("save").onclick = async () => {
  await chrome.storage.local.set({
    ASSEMBLYAI_API_KEY: $("aai").value.trim(),
    OPENAI_API_KEY: $("oai").value.trim(),
    OPENAI_MODEL: $("model").value.trim(),
  });
  $("msg").textContent = "Saved ✓";
  setTimeout(() => ($("msg").textContent = ""), 2000);
};

$("mic").onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    $("micMsg").textContent = "Granted ✓";
  } catch (e) {
    $("micMsg").textContent = "Denied: " + e.message;
  }
};

load();
