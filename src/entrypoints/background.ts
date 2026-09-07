import { defineBackground } from "wxt/utils/define-background";
import { CONTENT_SCRIPT_FILE, DETECTOR_SCRIPT_ID } from "@/shared/constants";
import { ALLOWLIST_ORIGINS, DEFAULT_PROMPT_THRESHOLD, isDenied, scoreUrl } from "@/shared/urlScore";

/**
 * Service worker.
 *
 * Two jobs on Day 1:
 *   1. Light up the toolbar icon on plausible shopping URLs WITHOUT reading any page
 *      (declarativeContent + pageUrl only — see plan §1.1).
 *   2. Register / unregister the detector content script as host permissions come and go
 *      (plan §1.2, §1.3). Registration is NOT injection: a registered script stays inert
 *      until the extension actually holds permission for that origin, so the grant and the
 *      registration have to stay in sync or the failure is silent.
 */
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(async () => {
    // MV3 has no declarativeContent.HideAction. `ShowAction` can only enable, so the
    // action must start disabled for the greyscale-by-default behaviour to work at all.
    await chrome.action.disable();
    await installPageRules();
    await reconcileRegistrations();
  });

  // Service workers die. Anything assumed to persist has to be re-derived on wake.
  chrome.runtime.onStartup.addListener(() => {
    void reconcileRegistrations();
  });
  void reconcileRegistrations();

  chrome.permissions.onAdded.addListener(() => {
    void reconcileRegistrations();
  });
  chrome.permissions.onRemoved.addListener(() => {
    void reconcileRegistrations();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    void handleMessage(msg, sender).then(sendResponse);
    return true; // async response
  });
});

/**
 * declarativeContent rules from the allowlist plus generic commerce path tokens.
 * `pageUrl` conditions need no host permission and read nothing. A `css` condition WOULD
 * require host permission, which is why Stage 1 is URL-only.
 */
async function installPageRules(): Promise<void> {
  const conditions: chrome.declarativeContent.PageStateMatcher[] = [];

  for (const origin of ALLOWLIST_ORIGINS) {
    const host = new URL(origin).hostname;
    conditions.push(
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { hostEquals: host, schemes: ["https"] },
      }),
    );
  }

  for (const contains of ["/cart", "/checkout", "/basket", "/products/", "/product/", "/dp/"]) {
    conditions.push(
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { pathContains: contains, schemes: ["https"] },
      }),
    );
  }

  await new Promise<void>((resolve) => {
    chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
      chrome.declarativeContent.onPageChanged.addRules(
        [{ conditions, actions: [new chrome.declarativeContent.ShowAction()] }],
        () => resolve(),
      );
    });
  });
}

/**
 * Make the set of registered content scripts match the set of granted origins, exactly.
 * Called on install, on wake, and on every permission change, because
 * `persistAcrossSessions` can drift from reality and a stale registration is invisible.
 */
async function reconcileRegistrations(): Promise<void> {
  const granted = await chrome.permissions.getAll();
  const origins = (granted.origins ?? []).filter((o) => !o.startsWith("chrome-extension://"));

  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [DETECTOR_SCRIPT_ID],
  });

  if (origins.length === 0) {
    if (existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [DETECTOR_SCRIPT_ID] });
    }
    return;
  }

  const registration: chrome.scripting.RegisteredContentScript = {
    id: DETECTOR_SCRIPT_ID,
    js: [CONTENT_SCRIPT_FILE],
    matches: origins,
    runAt: "document_idle",
    allFrames: false,
    persistAcrossSessions: true,
  };

  try {
    if (existing.length > 0) {
      await chrome.scripting.updateContentScripts([registration]);
    } else {
      await chrome.scripting.registerContentScripts([registration]);
    }
  } catch (err) {
    // Most likely cause: a match pattern the scripting API rejects. Surface it rather than
    // failing silently — a silent no-op here looks identical to "the detector found nothing".
    console.error("[patterns] content script registration failed", err, origins);
  }
}

interface EnablementQuery {
  type: "query-enablement";
  url: string;
}

type Message = EnablementQuery | { type: string; [k: string]: unknown };

async function handleMessage(msg: Message, _sender: chrome.runtime.MessageSender) {
  switch (msg.type) {
    case "query-enablement": {
      const url = (msg as EnablementQuery).url;
      const scored = scoreUrl(url);
      const granted = await chrome.permissions.getAll();
      const origins = granted.origins ?? [];
      let enabled = false;
      try {
        const origin = new URL(url).origin;
        enabled = origins.some((p) => p === `${origin}/*`);
      } catch {
        enabled = false;
      }
      return {
        ...scored,
        enabled,
        shouldOffer: !scored.denied && scored.score >= DEFAULT_PROMPT_THRESHOLD,
      };
    }
    case "ping":
      return { ok: true };
    default:
      return { ok: false, error: `unknown message: ${msg.type}` };
  }
}

export { isDenied };
