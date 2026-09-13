// Browser actions. Each is independent of the intent router and returns a
// short sentence Marshal can speak back.

const VOLUME_STEP = 0.1;

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab found.");
  return tab;
}

function normalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("No site given.");
  if (!/^https?:\/\//i.test(s)) {
    if (!s.includes(".")) s = `${s.replace(/\s+/g, "")}.com`;
    s = `https://${s}`;
  }
  return new URL(s);
}

const siteName = (host) => host.replace(/^www\./, "").split(".")[0];

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => id === tabId && info.status === "complete" && done();
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done()).catch(done);
  });
}

export async function openSite(rawUrl, { waitForLoad = false } = {}) {
  const url = normalizeUrl(rawUrl);
  const bare = url.hostname.replace(/^www\./, "");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => {
    try { return new URL(t.url).hostname.replace(/^www\./, "") === bare; } catch { return false; }
  });

  let tab;
  if (existing) {
    tab = await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    const active = await getActiveTab().catch(() => null);
    const isBlank = active && /^(chrome:\/\/newtab|about:blank|chrome-search:)/.test(active.url || active.pendingUrl || "");
    tab = isBlank
      ? await chrome.tabs.update(active.id, { url: url.href })
      : await chrome.tabs.create({ url: url.href });
  }
  if (waitForLoad) await waitForTabComplete(tab.id);
  return { tab, message: `Opening ${siteName(url.hostname)}.` };
}

async function runInTab(tabId, func, args = [], world = "ISOLATED") {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
    return res?.result;
  } catch (e) {
    throw new Error("I can't control this page. Try a regular website tab.");
  }
}

// Volume commands should hit the tab that's actually making sound. Prefer the
// active tab if it's playing (or muted), otherwise the most recently used
// audible tab, otherwise the active tab.
async function getMediaTab() {
  const active = await getActiveTab();
  if (active.audible || active.mutedInfo?.muted) return active;
  const audible = await chrome.tabs.query({ audible: true });
  if (audible.length) return audible.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  return active;
}

// Injected into the page's MAIN world so it can use site player APIs.
// YouTube keeps its own volume state; setting <video>.volume directly gets
// overwritten on the next seek/ad/video, so use movie_player when present.
function adjustPageMedia(op, step) {
  const clamp = (n) => Math.min(100, Math.max(0, Math.round(n)));
  const yt = document.getElementById("movie_player");
  if (yt && typeof yt.setVolume === "function") {
    if (op === "unmute") { yt.unMute(); return { player: "youtube", volume: yt.getVolume() }; }
    if (op === "mute") return { player: "youtube", volume: yt.getVolume() };
    const next = clamp(yt.getVolume() + (op === "up" ? step : -step));
    yt.setVolume(next);
    if (op === "up" && yt.isMuted()) yt.unMute();
    return { player: "youtube", volume: next };
  }
  const media = [...document.querySelectorAll("video, audio")];
  if (!media.length) return { player: null };
  let volume = 0;
  media.forEach((m) => {
    if (op === "unmute") m.muted = false;
    if (op === "up" || op === "down") {
      m.volume = clamp(m.volume * 100 + (op === "up" ? step : -step)) / 100;
      if (op === "up") m.muted = false;
    }
    volume = Math.round(m.volume * 100);
  });
  return { player: "html5", volume };
}

export async function setTabVolume(action) {
  const tab = await getMediaTab();
  const step = VOLUME_STEP * 100;
  if (action === "mute" || action === "unmute") {
    await chrome.tabs.update(tab.id, { muted: action === "mute" });
    // Also clear a site-level mute (e.g. YouTube's own mute button) on unmute.
    if (action === "unmute") await runInTab(tab.id, adjustPageMedia, ["unmute", step], "MAIN").catch(() => {});
    return { message: action === "mute" ? "Tab muted." : "Tab unmuted." };
  }
  const result = await runInTab(tab.id, adjustPageMedia, [action, step], "MAIN");
  if (action === "up" && tab.mutedInfo?.muted) await chrome.tabs.update(tab.id, { muted: false });
  if (!result?.player) return { message: "I couldn't find any audio or video on this tab." };
  return { message: `Volume ${action === "up" ? "up" : "down"} to ${result.volume} percent.` };
}

export async function scrollPage(direction) {
  const tab = await getActiveTab();
  await runInTab(tab.id, (dir) => {
    window.scrollBy({ top: (dir === "up" ? -1 : 1) * window.innerHeight * 0.8, behavior: "smooth" });
  }, [direction]);
  return { message: `Scrolled ${direction}.` };
}

// ---------- Page text extraction ----------

// Injected into LinkedIn. Scrolls briefly so posts render, then picks the top
// three large visible text blocks, without relying on LinkedIn class names.
async function extractLinkedInPosts() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const NOISE = /^(feed post|like|comment|repost|send|follow|share|[\d,]+\s*(comments?|reposts?|reactions?|followers)|see more|…more|promoted|.+ (likes|loves|commented on|reposted) this|• ?\d+(st|nd|rd|th)\+?)$/i;

  const clean = (el) =>
    el.innerText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !NOISE.test(l))
      .join("\n")
      .slice(0, 1500);

  const outsideSidebars = (el) => !el.closest("aside, header, nav");
  const notComposer = (el) => !/^\s*Start a post/i.test(el.innerText);

  const collect = () => {
    const root = document.querySelector("main") || document.body;
    // 1) Accessible "Feed post" headings (screen-reader labels are more stable than class names).
    let blocks = [...root.querySelectorAll("h2, h3")]
      .filter((h) => /^feed post$/i.test(h.textContent.trim()))
      .map((h) => h.closest('[role="listitem"], article, [role="article"]') || h.parentElement);
    // 2) Generic post containers.
    if (blocks.length < 3) {
      blocks = [...root.querySelectorAll('[role="listitem"], [data-urn*="activity"], article, [role="article"]')];
    }
    blocks = blocks.filter((b) => b && outsideSidebars(b) && notComposer(b));
    // 3) Last resort: large text blocks in the main column.
    if (blocks.length < 3) {
      blocks = [...root.querySelectorAll("div")].filter((d) => {
        const len = d.innerText?.length || 0;
        return len > 200 && len < 5000 && d.offsetHeight > 120 && d.offsetWidth > 300 && outsideSidebars(d) && notComposer(d);
      });
      // Keep the innermost big blocks so we don't return the whole feed as one "post".
      blocks = blocks.filter((b) => !blocks.some((o) => o !== b && b.contains(o) && o.innerText.length > b.innerText.length * 0.6));
    }
    // Drop blocks nested inside another candidate (e.g. a reshared post).
    blocks = blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b)));
    const seen = new Set();
    return blocks
      .filter((b) => b.getClientRects().length && b.innerText.trim().length > 120)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .filter((b) => {
        const key = b.innerText.slice(0, 120);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  for (let i = 0; i < 12 && collect().length < 3; i++) {
    window.scrollBy(0, window.innerHeight);
    await sleep(700);
  }
  const posts = collect().slice(0, 3).map(clean);
  window.scrollTo({ top: 0, behavior: "smooth" });
  return posts;
}

function extractPageText() {
  const root = document.querySelector("article") || document.querySelector("main") || document.body;
  return { title: document.title, text: (root.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 8000) };
}

export async function extractForSummary(tab) {
  const host = (() => { try { return new URL(tab.url).hostname; } catch { return ""; } })();
  if (/(^|\.)linkedin\.com$/.test(host)) {
    await waitForTabComplete(tab.id);
    let posts = await runInTab(tab.id, extractLinkedInPosts);
    if (!posts?.length) {
      // The feed renders after load; give it one more pass.
      await new Promise((r) => setTimeout(r, 2000));
      posts = await runInTab(tab.id, extractLinkedInPosts);
    }
    if (!posts?.length) throw new Error("I couldn't find any posts. Make sure you're logged in to LinkedIn.");
    return { kind: "linkedin", posts };
  }
  const page = await runInTab(tab.id, extractPageText);
  if (!page?.text?.trim()) throw new Error("This page has no text to summarize.");
  return { kind: "page", ...page };
}
