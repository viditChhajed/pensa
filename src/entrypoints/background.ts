import { defineBackground } from "wxt/utils/define-background";
import {
  clearAllData,
  evictOffers,
  prevalence,
  pruneEvents,
  readSettings,
  writeSettings,
} from "@/background/db";
import { recordObservation } from "@/background/recordOffer";
import { currentSessionId, decideDigest } from "@/background/session";
import {
  clearLedgers,
  loadLedger,
  noteStage,
  noteUserAdd,
  saveLedger,
} from "@/background/sessionLedger";
import { CONTENT_SCRIPT_FILE, DETECTOR_SCRIPT_ID } from "@/shared/constants";
import { Message } from "@/shared/messages.schema";
import { ALLOWLIST_ORIGINS, DEFAULT_PROMPT_THRESHOLD, scoreUrl } from "@/shared/urlScore";
import { decodePriceSnapshot } from "@/shared/wire";

/**
 * Service worker.
 *
 *   1. Light up the toolbar icon on plausible shopping URLs WITHOUT reading any page
 *      (declarativeContent + pageUrl only — plan §1.1).
 *   2. Register / unregister the detector content script as host permissions come and go
 *      (plan §1.2, §1.3). Registration is NOT injection: a registered script stays inert
 *      until the extension holds permission for that origin, so grant and registration have
 *      to stay in sync or the failure is completely silent.
 *   3. Own the session ledger and the digest decision, because both outlive any one page.
 */
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(async () => {
    // MV3 has no declarativeContent.HideAction. `ShowAction` can only enable, so the action
    // must start disabled for greyscale-by-default to work at all.
    await chrome.action.disable();
    await installPageRules();
    await reconcileRegistrations();
  });

  // Service workers die. Anything assumed to persist has to be re-derived on wake.
  chrome.runtime.onStartup.addListener(() => {
    void reconcileRegistrations();
    void housekeeping();
  });
  void reconcileRegistrations();

  chrome.permissions.onAdded.addListener(() => {
    void reconcileRegistrations();
  });
  chrome.permissions.onRemoved.addListener(() => {
    void reconcileRegistrations();
  });

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    void handleMessage(raw).then(sendResponse);
    return true; // async response
  });

  chrome.alarms?.create("housekeeping", { periodInMinutes: 720 });
  chrome.alarms?.onAlarm.addListener((a) => {
    if (a.name === "housekeeping") void housekeeping();
  });
});

/**
 * declarativeContent rules from the allowlist plus generic commerce path tokens.
 * `pageUrl` conditions need no host permission and read nothing. A `css` condition WOULD
 * require host permission, which is exactly why Stage 1 is URL-only.
 */
async function installPageRules(): Promise<void> {
  const conditions: chrome.declarativeContent.PageStateMatcher[] = [];

  for (const origin of ALLOWLIST_ORIGINS) {
    conditions.push(
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { hostEquals: new URL(origin).hostname, schemes: ["https"] },
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
 * Called on install, on wake, and on every permission change, because `persistAcrossSessions`
 * can drift from reality and a stale registration is invisible.
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
    // Most likely a match pattern the scripting API rejects. Surface it — a silent no-op
    // here looks identical to "the detector found nothing".
    console.error("[patterns] content script registration failed", err, origins);
  }
}

async function housekeeping(): Promise<void> {
  try {
    const settings = await readSettings();
    await pruneEvents(settings.retentionDays);
    await evictOffers();
  } catch (err) {
    console.error("[patterns] housekeeping failed", err);
  }
}

async function handleMessage(raw: unknown): Promise<unknown> {
  // Cross-context input is a trust boundary like any other.
  const parsed = Message.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid message" };
  const msg = parsed.data;

  switch (msg.type) {
    case "ping":
      return { ok: true };

    case "query-enablement": {
      const scored = scoreUrl(msg.url);
      const granted = await chrome.permissions.getAll();
      let enabled = false;
      try {
        enabled = (granted.origins ?? []).includes(`${new URL(msg.url).origin}/*`);
      } catch {
        enabled = false;
      }
      return {
        ...scored,
        enabled,
        shouldOffer: !scored.denied && scored.score >= DEFAULT_PROMPT_THRESHOLD,
      };
    }

    case "stage": {
      const sessionId = await currentSessionId();
      const ledger = await loadLedger(sessionId, msg.origin);
      const snapshot = msg.priceSnapshot ? decodePriceSnapshot(msg.priceSnapshot) : undefined;
      await saveLedger(noteStage(ledger, msg.stage, snapshot));
      return { ok: true };
    }

    case "trigger": {
      const sessionId = await currentSessionId();
      let ledger = await loadLedger(sessionId, msg.origin);
      if (msg.kind === "add_to_cart") {
        ledger = noteUserAdd(ledger, {
          ts: Date.now(),
          labelHash: msg.labelHash,
          ...(msg.labelSample ? { labelSample: msg.labelSample } : {}),
          confirmed: false,
        });
        await saveLedger(ledger);
      }
      return { ok: true };
    }

    case "candidates": {
      const items = await decideDigest(
        msg.origin,
        msg.pathTemplate,
        msg.stage,
        msg.items,
        msg.offerKey,
      );
      return { type: "show-digest", items };
    }

    case "observation": {
      // Record first; claims are derived at digest time from the accumulated history.
      await recordObservation(msg.origin, msg.offerKey, msg.offerKeySource, msg.observation);
      return { ok: true };
    }

    case "get-summary":
      return { rows: await prevalence(Date.now() - 24 * 60 * 60 * 1000) };

    case "get-settings":
      return await readSettings();

    case "set-settings":
      return await writeSettings(msg.patch);

    case "clear-data":
      await clearAllData();
      await clearLedgers();
      return { ok: true };

    default:
      return { ok: false, error: "unhandled" };
  }
}
