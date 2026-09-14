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
import { discardQueue, flush, pendingRecords } from "@/background/telemetry";
import { CONTENT_SCRIPT_FILE, DETECTOR_SCRIPT_ID, TELEMETRY_ENDPOINT } from "@/shared/constants";
import { domainMatchPattern, matchesPattern } from "@/shared/domain";
import type { ShowDigest } from "@/shared/messages";
import { Message } from "@/shared/messages.schema";
import { ALLOWLIST_DOMAINS, DEFAULT_PROMPT_THRESHOLD, scoreUrl } from "@/shared/urlScore";
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
    // The action stays ENABLED everywhere on purpose.
    //
    // It used to be disabled by default so `ShowAction` could grey it out on non-shopping
    // pages. That worked visually and failed as UX: a disabled action is unclickable, so on
    // a bank or a wiki the user got no response and no explanation at all. Silence is a
    // worse answer than "not offered here", especially for the denylist case where the
    // refusal is the most important thing this product does.
    //
    // The popup now always opens and says which of the three states applies. The
    // declarativeContent rules below still run and still mark shopping pages.
    await chrome.action.enable();
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
    // The .catch is load-bearing. Without it a throw anywhere inside handleMessage skips
    // sendResponse entirely, the message port closes with no reply, and the caller sees an
    // ordinary empty answer — the same silent-failure shape as the BigInt bug and the quiet
    // {ok:false}. A digest that could not be built must say so, not vanish.
    void handleMessage(raw)
      .then(sendResponse)
      .catch((err: unknown) => {
        const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        console.error(
          `[patterns] handler threw for ${(raw as { type?: string })?.type ?? "unknown"}:`,
          detail,
        );
        sendResponse({ ok: false, error: "handler threw", issues: [detail.slice(0, 400)] });
      });
    return true; // async response
  });

  chrome.alarms?.create("housekeeping", { periodInMinutes: 720 });

  /**
   * Telemetry flushes on a CLOCK, never on a detection.
   *
   * A request timed to the moment something was found tells an observer when this person was
   * shopping, and how often, even though the payload itself says neither. Decoupling the
   * send from the event is the difference between an anonymous count and a timestamped one.
   *
   * Six hours rather than the housekeeping twelve: long enough that the timing carries
   * nothing, short enough that a batch is not sitting on disk for days.
   */
  chrome.alarms?.create("telemetry", { periodInMinutes: 360 });

  chrome.alarms?.onAlarm.addListener((a) => {
    if (a.name === "housekeeping") void housekeeping();
    if (a.name === "telemetry") void flushTelemetry();
  });
});

/** Send whatever is both consented to and past the k-anonymity floor. Logs its own outcome. */
async function flushTelemetry(): Promise<void> {
  try {
    const result = await flush(await readSettings());
    // Every branch is worth seeing. "Nothing was sent" has six different causes and they
    // have six different fixes — an unset endpoint is not the same as a failed request, and
    // neither is the same as a batch correctly held back for being too identifying.
    if (result.reason !== "no_consent" || result.sent > 0) {
      console.info(
        `[patterns] telemetry: ${result.reason}, ${result.sent} sent, ${result.held} held`,
      );
    }
  } catch (err) {
    console.error("[patterns] telemetry flush failed", err);
  }
}

/**
 * declarativeContent rules from the allowlist plus generic commerce path tokens.
 * `pageUrl` conditions need no host permission and read nothing. A `css` condition WOULD
 * require host permission, which is exactly why Stage 1 is URL-only.
 */
async function installPageRules(): Promise<void> {
  const conditions: chrome.declarativeContent.PageStateMatcher[] = [];

  for (const domain of ALLOWLIST_DOMAINS) {
    // Two matchers per domain, deliberately. `hostSuffix: "shein.com"` alone would also
    // match notshein.com, since hostSuffix is a plain string suffix test. The bare domain
    // needs hostEquals and subdomains need the dot-prefixed suffix.
    conditions.push(
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { hostEquals: domain, schemes: ["https"] },
      }),
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { hostSuffix: `.${domain}`, schemes: ["https"] },
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
  if (!parsed.success) {
    // LOUD. A rejected message is a programming error, not a normal outcome, and returning
    // a quiet {ok:false} made it indistinguishable from "the worker had nothing to say" at
    // the caller. That is the same failure shape as the BigInt bug: a real error dressed up
    // as an ordinary empty answer. It cost two manual test rounds to localise.
    console.error(
      `[patterns] REJECTED ${(raw as { type?: string })?.type ?? "unknown"} message:`,
      JSON.stringify(parsed.error.issues.slice(0, 6), null, 1),
    );
    // Returned, not just logged. The service worker console is not reachable from every
    // debugging setup, and a caller that is told "invalid" without being told WHY has to
    // bisect the payload by hand.
    return {
      ok: false,
      error: "invalid message",
      issues: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
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
      // `decideDigest` returns { items, mode }. This used to assign that whole object to the
      // reply's `items` field, so the content script read `reply.items.length` on an object
      // (undefined) and `reply.mode` one level too high — and the card never rendered, on
      // every site, for the entire build. Nothing caught it because handleMessage returns
      // `unknown`; `satisfies ShowDigest` below is what makes it a compile error now.
      //
      // The same three lines also dropped `msg.placement`, so the capacity the page measures
      // was sent, validated, and then ignored in favour of the optimistic default.
      const decision = await decideDigest(
        msg.origin,
        msg.pathTemplate,
        msg.stage,
        msg.items,
        msg.offerKey,
        msg.placement,
      );
      return {
        type: "show-digest",
        items: decision.items,
        mode: decision.mode,
      } satisfies ShowDigest;
    }

    case "observation": {
      // Record first; claims are derived at digest time from the accumulated history.
      await recordObservation(msg.origin, msg.offerKey, msg.offerKeySource, msg.observation);
      return { ok: true };
    }

    case "diagnose-registration": {
      // Permission and registration are two separate things, and only the first is visible
      // in the popup. This reports the second.
      const pattern = domainMatchPattern(new URL(msg.url).hostname);
      const granted = await chrome.permissions.contains({ origins: [pattern] });
      let registered = false;
      let matchCount = 0;
      let error: string | undefined;
      try {
        const scripts = await chrome.scripting.getRegisteredContentScripts({
          ids: [DETECTOR_SCRIPT_ID],
        });
        const matches = scripts[0]?.matches ?? [];
        matchCount = matches.length;
        registered = matches.some((m) => matchesPattern(m, new URL(msg.url)));
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      // Registration can drift from permissions — a service worker dies mid-grant, or a bad
      // pattern makes the whole update throw. Repair it here rather than only reporting.
      if (granted && !registered) {
        await reconcileRegistrations();
        const after = await chrome.scripting.getRegisteredContentScripts({
          ids: [DETECTOR_SCRIPT_ID],
        });
        const matches = after[0]?.matches ?? [];
        matchCount = matches.length;
        registered = matches.some((m) => matchesPattern(m, new URL(msg.url)));
      }
      return { granted, registered, matchCount, ...(error ? { error } : {}) };
    }

    case "get-summary":
      return { rows: await prevalence(Date.now() - 24 * 60 * 60 * 1000) };

    case "get-settings":
      return await readSettings();

    case "get-pending-telemetry":
      // The settings page shows these verbatim. Asking someone to consent to "anonymous
      // statistics" without showing the rows is asking them to trust a sentence, and this
      // product's whole argument is that a claim you cannot check is worth less than one
      // you can.
      return { records: await pendingRecords(), endpoint: TELEMETRY_ENDPOINT };

    case "set-settings": {
      const updated = await writeSettings(msg.patch);
      // Withdrawing consent empties the queue NOW, not at the next six-hourly flush.
      // Anything already gathered was gathered under a permission that has been revoked, and
      // holding it for six hours in case they change their mind is not the user's decision
      // to have made for them.
      if (msg.patch.telemetryConsent === false) await discardQueue();
      return updated;
    }

    case "clear-data":
      await clearAllData();
      await clearLedgers();
      return { ok: true };

    default:
      return { ok: false, error: "unhandled" };
  }
}
