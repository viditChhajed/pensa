/**
 * The enablement surface (plan §1.4).
 *
 * `chrome.permissions.request()` needs a live user gesture, and the gesture is consumed by
 * the first `await` that yields to the event loop. So everything asynchronous — reading the
 * tab URL, scoring it — happens when the popup OPENS. By the time the button exists, the
 * origin pattern is already a plain string in scope, and the click handler can call
 * `request()` with nothing in front of it.
 *
 * `activeTab` is what lets this read the current tab's URL without the `tabs` permission.
 */
import { send } from "@/shared/messages";
import { type PatternId, TAXONOMY } from "@/shared/taxonomy";
import { DEFAULT_PROMPT_THRESHOLD, isDenied, scoreUrl } from "@/shared/urlScore";

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const detailEl = document.getElementById("detail") as HTMLParagraphElement;
const enableBtn = document.getElementById("enable") as HTMLButtonElement;
const optionsLink = document.getElementById("options") as HTMLButtonElement;

optionsLink.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

/** Resolved during init, BEFORE any click can happen. Never awaited inside the handler. */
let originPattern: string | null = null;

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;

  if (!url) {
    statusEl.textContent = "No page to check.";
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    statusEl.textContent = "No page to check.";
    return;
  }

  if (isDenied(parsed)) {
    statusEl.textContent = `Not available on ${parsed.hostname}.`;
    detailEl.textContent =
      "This extension never asks for access to banking, health, government or mail sites. " +
      "It cannot be enabled here, and it is not reading this page.";
    return;
  }

  const pattern = `${parsed.origin}/*`;
  const alreadyGranted = await chrome.permissions.contains({ origins: [pattern] });

  if (alreadyGranted) {
    statusEl.textContent = `Watching ${parsed.hostname}.`;
    detailEl.textContent = "Patterns found on this page will appear when you add to cart.";
    renderRevoke(pattern, parsed.hostname);
    return;
  }

  const scored = scoreUrl(url);
  originPattern = pattern; // set BEFORE the button becomes clickable

  if (scored.score >= DEFAULT_PROMPT_THRESHOLD) {
    statusEl.textContent = `${parsed.hostname} looks like a shopping site.`;
  } else {
    statusEl.textContent = `${parsed.hostname} does not look like a shopping site.`;
    // Still offered: the user may know better than the URL heuristic (plan §14.3, Tier B).
  }
  detailEl.textContent =
    "Enabling lets this extension read this site’s pages, on your device only. Nothing is sent anywhere.";
  enableBtn.hidden = false;
}

// Synchronous handler. No `await` before request() — that is the whole point.
enableBtn.addEventListener("click", () => {
  if (!originPattern) return;
  const pattern = originPattern;

  chrome.permissions.request({ origins: [pattern] }, (granted) => {
    if (granted) {
      statusEl.textContent = "Enabled. Reload the page to start.";
      detailEl.textContent = "";
      enableBtn.hidden = true;
    } else {
      statusEl.textContent = "Not enabled.";
      detailEl.textContent = "Nothing changed. You can enable this site any time.";
    }
  });
});

function renderRevoke(pattern: string, hostname: string): void {
  enableBtn.hidden = false;
  enableBtn.textContent = `Stop watching ${hostname}`;
  enableBtn.classList.remove("primary");
  enableBtn.addEventListener(
    "click",
    () => {
      chrome.permissions.remove({ origins: [pattern] }, (removed) => {
        if (removed) {
          statusEl.textContent = "Stopped.";
          detailEl.textContent = "";
          enableBtn.hidden = true;
        }
      });
    },
    { once: true },
  );
}

void init();

/**
 * Today's summary (plan T30). Read on the user's own schedule rather than pushed at them —
 * the interruption has structurally bad retention, so the value has to accrue somewhere the
 * user chooses to look.
 */
async function renderToday(): Promise<void> {
  const reply = await send<{ rows: { patternId: string; detected: number; surfaced: number }[] }>({
    type: "get-summary",
  });
  const rows = reply?.rows ?? [];
  if (rows.length === 0) return;

  const byPattern = new Map<string, number>();
  for (const r of rows) {
    byPattern.set(r.patternId, (byPattern.get(r.patternId) ?? 0) + r.detected);
  }

  const list = document.getElementById("todayList") as HTMLUListElement;
  const section = document.getElementById("today") as HTMLElement;
  list.replaceChildren();

  for (const [patternId, count] of [...byPattern.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)) {
    const entry = TAXONOMY[patternId as PatternId];
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry?.label ?? patternId;
    const n = document.createElement("span");
    n.className = "count";
    n.textContent = String(count);
    li.append(name, n);
    list.append(li);
  }

  section.hidden = false;
}

void renderToday();
