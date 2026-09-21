/**
 * The popup.
 *
 * It used to be the enablement surface: an "Enable on this site" button, a live user
 * gesture carefully preserved through to `chrome.permissions.request()`, and a revoke
 * control once a site was granted. All of that is gone. Pensa now holds `https://` for every
 * site at install, so there is nothing left to ask for and nothing left to take back — the
 * only per-site control that ever existed was the permission itself, and settings has no
 * per-site flag to wire this to instead.
 *
 * What is left is the question the popup was always really answering, now answered honestly
 * instead of inferred from a permission: is Pensa running on this page, or not, and why not.
 *
 * `activeTab` is what lets this read the current tab's URL on pages the host permission
 * does NOT cover — http://, chrome://, a PDF viewer — so a page Pensa cannot run on can still
 * be told apart from a popup that failed to load.
 */

import { BUILD_STAMP } from "@/shared/constants";
import type { RegistrationReport } from "@/shared/messages";
import { send } from "@/shared/messages";
import { type PatternId, TAXONOMY } from "@/shared/taxonomy";
import { isDenied } from "@/shared/urlScore";

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const detailEl = document.getElementById("detail") as HTMLParagraphElement;
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

  /**
   * The refusal, stated first and stated plainly.
   *
   * This is the most important sentence in the popup. Everywhere else Pensa runs by default
   * now, which makes the places it does not run the only thing a person cannot infer. The
   * copy says both halves — it does not run here, and it is not reading this page — because
   * "not running" is a claim about behaviour and "not reading" is the one people care about.
   */
  if (isDenied(parsed)) {
    statusEl.textContent = `Pensa does not run on ${parsed.hostname}.`;
    detailEl.textContent =
      "Pensa never runs on banking, health, government, webmail or similar sites. It is not " +
      "reading this page, and nothing about it is recorded.";
    return;
  }

  if (parsed.protocol !== "https:") {
    // Honest about the edge the permission deliberately does not cover. Pensa asks for
    // https:// only, so a plaintext page — or a chrome:// page, or a local file — is one it
    // has no access to at all.
    statusEl.textContent = `Pensa does not run on ${parsed.hostname || "this page"}.`;
    detailEl.textContent =
      `Pensa only runs on https:// pages, and this one is ${parsed.protocol.replace(":", "")}. ` +
      "It is not reading this page.";
    return;
  }

  // The hostname as the shopper reads it, minus a leading "www.". The popup used to call
  // registrableDomain here, which now pulls in the Public Suffix List — ~100 KB to open a
  // popup, for a label the address bar already shows.
  const domain = parsed.hostname.replace(/^www\./, "");
  // Provisional, until the checks below settle it. It used to be final: "Pensa is running on
  // X. Patterns found on this page will appear when you add to cart." was written first, and
  // the shop verdict appended beneath it — so on a page that is not a shop the popup said it
  // was running and would report patterns, then in the next line that it was idle and
  // recording nothing. Now the verdict writes the headline.
  statusEl.textContent = `Checking ${domain}…`;
  detailEl.textContent = "";

  /**
   * "Running" is a claim, so check it.
   *
   * Chrome's per-extension site access can be narrowed to "on click" or to a list of sites
   * from chrome://extensions, and the extension is never told. The symptom is a popup
   * saying it is watching a site while nothing whatsoever runs on it — indistinguishable
   * from the detectors genuinely finding nothing. The worker answers from the manifest
   * Chrome actually loaded, so this also catches a page the denylist exclusions cover by a
   * pattern the local `isDenied()` above did not.
   */
  const report = await send<RegistrationReport>({ type: "diagnose-registration", url });
  if (report && !(report.granted && report.registered)) {
    const line = document.createElement("p");
    line.className = "detail score";
    if (report.excluded) {
      statusEl.textContent = `Pensa does not run on ${parsed.hostname}.`;
      detailEl.textContent = "This site is on Pensa's permanent exclusion list.";
      line.textContent = "Chrome is not allowed to load Pensa's detector here at all.";
    } else if (!report.granted) {
      statusEl.textContent = `Pensa is not running on ${domain}.`;
      detailEl.textContent =
        "Chrome is withholding access to this site. Check Site access for Pensa in " +
        "chrome://extensions if that was not deliberate.";
      line.textContent = report.error ?? "";
    } else {
      line.textContent = report.error
        ? `Not running here — ${report.error}.`
        : "Not running on this page yet. Reload it to start.";
    }
    if (line.textContent) detailEl.after(line);
    if (report.excluded || !report.granted) return;
  }

  renderPageKind(domain, report?.active === true);
}

/**
 * Whether Pensa is actually working on this page, or idling.
 *
 * This replaces a line that reported a URL SCORE — "nothing commerce-shaped in
 * /chat/67039775…, so you may see nothing here. That check only reads the address, never the
 * page." It existed because the old permission model had to guess from the address: you
 * cannot inspect a page to decide whether to ask permission to inspect the page. It read as
 * nonsense on an obviously non-shopping page, and it was nonsense — the address was never
 * the question.
 *
 * Pensa now reads the page and decides from what is on it. So this reports the decision
 * instead of the guess, and the answer for a page that is not a shop is the useful one:
 * nothing is being collected here.
 */
function renderPageKind(domain: string, active: boolean): void {
  if (active) {
    statusEl.textContent = `Pensa is checking ${domain}.`;
    detailEl.textContent = "If it notices anything, you will see a card when you add to cart.";
  } else {
    // Also what a shop shows in the first moments, before Pensa has finished reading it —
    // hence "yet" rather than a flat verdict.
    statusEl.textContent = `Pensa is idle on ${domain}.`;
    detailEl.textContent =
      "This page does not look like a shop (yet), so Pensa is not checking it or recording " +
      "anything here.";
  }
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
