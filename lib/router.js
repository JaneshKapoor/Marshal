// Intent router: one OpenAI function-calling request per transcript.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 10000;

const SYSTEM_PROMPT = `You are Marshal, a voice assistant that controls the user's Chrome browser.
You can ONLY act by calling exactly one of the provided functions. Never reply with free text when a function fits.
- open_site: open a website. Always pass a full URL (e.g. "open LinkedIn" -> https://www.linkedin.com/feed/, "open YouTube" -> https://www.youtube.com). If the user also asks to summarize the page or its posts, set summarize_after to true.
- set_tab_volume: mute, unmute, turn the volume up or down, or set an exact level. "Full volume", "max volume", "volume 100" -> action "set", level 100. "Volume 50" / "half volume" -> action "set", level 50. "Silence" -> mute.
- media_control: play, pause, enter fullscreen ("full screen", "make it big", "maximize the video"), or exit fullscreen ("exit full screen", "come out of full screen", "minimize").
- summarize_current_page: summarize what is on the current page (including "top posts" on LinkedIn).
- scroll: scroll the current page up or down.
The transcript comes from speech recognition, so tolerate small transcription errors.
If the request does not map to any of these actions, do not call a function; reply with the single word NONE.`;

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "open_site",
      description: "Open a website in the browser, reusing an existing tab for that site if one is open.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full https URL of the site to open." },
          summarize_after: {
            type: "boolean",
            description: "True if the user also asked to summarize the page/posts once it loads.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_tab_volume",
      description: "Control audio of the tab that's playing media (not system volume).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["mute", "unmute", "up", "down", "set"] },
          level: { type: "integer", minimum: 0, maximum: 100, description: "Target volume percent, only for action 'set'." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "media_control",
      description: "Control the video/audio player on the page (e.g. YouTube).",
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["play", "pause", "fullscreen", "exit_fullscreen"] } },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_current_page",
      description: "Summarize the current page. On a LinkedIn feed, summarizes the top three posts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the current page.",
      parameters: {
        type: "object",
        properties: { direction: { type: "string", enum: ["up", "down"] } },
        required: ["direction"],
      },
    },
  },
];

export async function openaiChat(apiKey, body, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("OpenAI timed out.");
    throw new Error(`Couldn't reach OpenAI: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error?.message || msg; } catch {}
    throw new Error(`OpenAI error ${res.status}: ${msg}`);
  }
  return res.json();
}

// Returns { name, args } for a function call, or null if no command matched.
export async function routeIntent(transcript, { apiKey, model }) {
  const data = await openaiChat(apiKey, {
    model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ],
    tools: TOOLS,
    tool_choice: "auto",
    parallel_tool_calls: false,
  });
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return null;
  let args = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
  return { name: call.function.name, args };
}
