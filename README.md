# Marshal

Marshal is a voice-controlled browser agent built as a Chrome extension (Manifest V3). Press a shortcut, say what you want, and Marshal:

1. records the command from your microphone,
2. transcribes it with the **AssemblyAI Dictation API**,
3. picks one action with **OpenAI function calling**,
4. runs it in the browser (open sites, control tab audio, scroll, summarize), and
5. says the result aloud with the browser's built-in `speechSynthesis`.

## How it works

```
Alt+Shift+M / toolbar icon
        │
        ▼
background.js (service worker) ──► offscreen.html
        │                          getUserMedia → AudioWorklet (16 kHz PCM)
        │                          energy VAD → WAV → AssemblyAI Dictation
        │◄──────── transcript ─────┘
        ▼
lib/router.js  OpenAI tool call: open_site | set_tab_volume | summarize_current_page | scroll
        ▼
lib/actions.js chrome.tabs / chrome.scripting
        ▼
lib/summarize.js (summaries only) → offscreen speechSynthesis reply
```

- **Transcription:** `POST https://dictation.assemblyai.com/v1/transcribe/live`. The Dictation API only accepts WAV or raw 16-bit PCM, so Marshal records raw PCM and encodes the WAV itself instead of using `MediaRecorder` (which produces webm).
- **Recording:** stops 0.9 s after you stop talking, gives up after 4 s with no speech, and never goes past 7 s.
- **Routing:** `gpt-4.1-nano` (you can change this in settings). Summaries use `gpt-4.1-mini`.

## Setup

### 1. Get API keys
- **AssemblyAI:** https://www.assemblyai.com/dashboard. Copy your API key.
- **OpenAI:** https://platform.openai.com/api-keys. Create a secret key. The account needs billing credit.

### 2. Load the extension
1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repo folder.
4. Pin **Marshal** to the toolbar.

### 3. Configure
1. Open Marshal's options page: **Details → Extension options**, or **Settings** in the popup.
2. Paste both API keys and click **Save**.
3. Click **Grant microphone access** and allow it. Chrome only shows the mic prompt on a visible page; after that, the hidden offscreen recorder can use the mic.

Keys are stored only in `chrome.storage.local` and are never in the source code. See `config.example.js` for the expected shape.

## Usage

Press **Alt+Shift+M** or click the Marshal toolbar icon, then speak. The popup shows the current state (idle / listening / thinking / speaking), the transcript, and the result. You can change the shortcut at `chrome://extensions/shortcuts`.

## Demo script

| Say | What happens |
| --- | --- |
| "Open LinkedIn and summarize the top three posts for me" | Opens (or switches to) the LinkedIn feed, scrolls until 3 posts have loaded, and reads out a 3-bullet summary |
| "Mute this tab" / "Unmute" | Toggles the tab's mute state |
| "Turn the volume down" / "Turn it up" | Changes volume by 10 points on the tab that's playing sound. Uses YouTube's own player controls on YouTube so the slider stays in sync, and `<video>`/`<audio>` elements elsewhere |
| "Full volume" / "Set volume to 30" / "Half volume" | Sets an exact volume level (full = 100) |
| "Pause the video" / "Play" | Pauses or plays the video on the page |
| "Make it full screen" / "Exit full screen" | Makes the browser window fullscreen with the video filling it, or restores it. Chrome only allows true video fullscreen after a click or keypress on the page, which a voice command can't provide |
| "Open YouTube" / "Open Hacker News" | Opens the site, reusing an existing tab for it if there is one |
| "Scroll down" | Scrolls the page |
| "Summarize this page" | Reads out a 3-bullet summary of the current page |
| "What's the best pizza topping?" | Says "I didn't catch a command for that." |

## Limits (by design)

- **Tab audio only.** Chrome extensions can't change system volume.
- **LinkedIn summaries** only read what your own logged-in browser session already shows. This is not a scraper. Posts are found with text-block heuristics rather than LinkedIn class names, so it keeps working when LinkedIn changes its markup.
- Pages like `chrome://` and the Chrome Web Store can't be scripted, so volume up/down, scroll, and summarize don't work there.

## Debugging

- Service worker logs: `chrome://extensions` → Marshal → **Inspect views: service worker**. Transcript, intent, and timings are logged with a `[Marshal]` prefix.
- From that console you can skip the mic:
  ```js
  marshal.runText("open linkedin and summarize the top three posts")
  marshal.dispatch({ name: "set_tab_volume", args: { action: "mute" } })
  ```

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, `Alt+Shift+M` command |
| `background.js` | Activation pipeline and action dispatch |
| `offscreen.html/js`, `pcm-worklet.js` | Mic capture, VAD, WAV encoding, AssemblyAI call, speech output |
| `lib/router.js` | OpenAI tool definitions and intent routing |
| `lib/actions.js` | Browser actions and page/LinkedIn text extraction |
| `lib/summarize.js` | Summary prompt |
| `lib/status.js` | Shared state and toolbar badge |
| `popup.*`, `options.*` | UI |
