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
    statusEl.textContent = "Not offered on this site.";
    detailEl.textContent =
      "This looks like a site where page access should not be requested — banking, health, mail, or similar.";
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
