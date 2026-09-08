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

import { BUILD_STAMP } from "@/shared/constants";
import { domainMatchPattern, isGrantable, registrableDomain } from "@/shared/domain";
import { send } from "@/shared/messages";
import { type PatternId, TAXONOMY } from "@/shared/taxonomy";
import { DEFAULT_PROMPT_THRESHOLD, describeSignals, isDenied, scoreUrl } from "@/shared/urlScore";

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const detailEl = document.getElementById("detail") as HTMLParagraphElement;
const enableBtn = document.getElementById("enable") as HTMLButtonElement;
const optionsLink = document.getElementById("options") as HTMLButtonElement;

// Same reason as the detector's startup log: a stale unpacked load is otherwise invisible.
document
  .getElementById("app")
  ?.insertAdjacentHTML(
    "beforeend",
    `<p class="detail score" style="opacity:.55">build ${BUILD_STAMP}</p>`,
  );

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

  // Domain-wide, so checkout subdomains (secure.booking.com) are covered by one grant.
  const pattern = domainMatchPattern(parsed.hostname);
  const domain = registrableDomain(parsed.hostname);

  // A permission that cannot be requested must not be offered. Chrome only grants patterns
  // declared in optional_host_permissions; anything else fails silently and the user is left
  // clicking a button that does nothing.
  const declared = chrome.runtime.getManifest().optional_host_permissions ?? [];
  if (!isGrantable(parsed, declared)) {
    // Should be unreachable now that https://*/* is declared, but a permission that cannot
    // be requested must never be offered as a button — that produced a dead control twice
    // during manual testing.
    statusEl.textContent = `${domain} cannot be enabled.`;
    detailEl.textContent = "This extension is not reading this page, and sent nothing anywhere.";
    return;
  }
  const alreadyGranted = await chrome.permissions.contains({ origins: [pattern] });

  if (alreadyGranted) {
    statusEl.textContent = `Watching ${domain}.`;
    detailEl.textContent = "Patterns found on this page will appear when you add to cart.";
    renderRevoke(pattern, domain);
    return;
  }

  const scored = scoreUrl(url);
  originPattern = pattern; // set BEFORE the button becomes clickable

  /**
   * Both branches are an OFFER. The low-score copy used to read "<host> does not look like a
   * shopping site" above a working Enable button — a sentence that talks the user out of
   * pressing the control directly beneath it, and which overstates what was measured. The
   * heuristic reads the URL and nothing else, by necessity: you cannot inspect a page to
   * decide whether to ask permission to inspect the page. So a low score is a statement
   * about a string, not a verdict on the site.
   */
  if (scored.score >= DEFAULT_PROMPT_THRESHOLD) {
    statusEl.textContent = `${parsed.hostname} looks like a shopping site.`;
  } else {
    statusEl.textContent = `Turn on Persuasion Patterns for ${domain}?`;
  }

  detailEl.textContent =
    `Enabling covers ${domain} and its checkout pages, on your device only. ` +
    "Nothing is sent anywhere.";

  // The heuristic's own reading, shown so a silent extension can be diagnosed: a score with
  // signals means the check ran and this URL simply had nothing commerce-shaped in it;
  // no score line at all means the popup never got this far.
  renderScore(scored, parsed);
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

/**
 * Why the extension thinks what it thinks, in one line.
 *
 * This exists to separate two failures that look identical from the outside: the heuristic
 * ran and scored the URL low, versus the heuristic never ran at all. Without it the only
 * available diagnosis was "nothing happened".
 */
function renderScore(scored: ReturnType<typeof scoreUrl>, parsed: URL): void {
  const line = document.createElement("p");
  line.className = "detail score";

  const pct = Math.round(scored.score * 100);
  const readable = describeSignals(scored.signals);

  line.textContent =
    readable.length > 0
      ? `URL check: ${pct}% — ${readable.join(", ")}.`
      : `URL check: ${pct}% — nothing commerce-shaped in ${parsed.pathname === "/" ? "this address" : parsed.pathname}. ` +
        "The check only reads the address, never the page.";

  detailEl.after(line);
}

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
