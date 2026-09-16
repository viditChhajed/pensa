import { defineBackground } from "wxt/utils/define-background";
import {
  clearAllData,
  evictOffers,
  prevalence,
  pruneEvents,
  readEvents,
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
import { DETECTOR_SCRIPT_ID, TELEMETRY_ENDPOINT } from "@/shared/constants";
import { matchesPattern } from "@/shared/domain";
import type { ShowDigest } from "@/shared/messages";
import { Message } from "@/shared/messages.schema";
import { decodePriceSnapshot } from "@/shared/wire";

/**
 * Service worker.
 *
 *   1. Own the session ledger and the digest decision, because both outlive any one page.
 *   2. Answer the popup's "are you actually running here?" question.
 *   3. Clean up after the permission model this build replaced (see dropLegacyRegistration).
 *
 * What it no longer does: register the content script. The manifest declares it, matching
 * the required https host permission and excluding what the denylist can express, so there
 * is nothing to keep in sync at runtime and nothing that can silently fail to register. It
 * also no longer installs declarativeContent page rules — the action is enabled everywhere
 * and the popup opens on every page, so there was nothing for a page rule to decide.
 */
export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void dropLegacyRegistration();
  });

  // Service workers die. Anything assumed to persist has to be re-derived on wake.
  chrome.runtime.onStartup.addListener(() => {
    void dropLegacyRegistration();
    void housekeeping();
  });

  // No `chrome.permissions.onAdded` / `onRemoved` listener any more, and that is not an
  // oversight. They existed to re-derive the runtime registration when an optional origin
  // was granted or revoked from the popup. There are no optional origins now, nothing in
  // this extension calls `permissions.request` or `permissions.remove`, and the content
  // script is declared in the manifest — so a permission change has nothing to reconcile.
  // If a user narrows site access from chrome://extensions, Chrome simply stops injecting;
  // that needs no cooperation from us, and the popup reports it (see diagnose-registration).

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
          `[vero] handler threw for ${(raw as { type?: string })?.type ?? "unknown"}:`,
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
      console.info(`[vero] telemetry: ${result.reason}, ${result.sent} sent, ${result.held} held`);
    }
  } catch (err) {
    console.error("[vero] telemetry flush failed", err);
  }
}

/**
 * Remove the runtime content-script registration left behind by an earlier permission model.
 *
 * Builds before this one registered the detector with `chrome.scripting`, per granted
 * origin, with `persistAcrossSessions: true`. Those registrations SURVIVE an extension
 * update. On an upgraded install the manifest entry and the stale runtime entry would both
 * match, so the script would be injected twice (harmless — the injection flag catches the
 * second) and, far worse, the stale entry carries whatever matches the old model had
 * accumulated, with no exclude_matches on it at all. A user who once granted a bank
 * subdomain would keep being injected there, invisibly, forever.
 *
 * This is the only reason the `scripting` permission is still requested. It is a migration,
 * and it is cheap enough to run on every wake rather than trying to remember whether it has
 * already happened.
 */
async function dropLegacyRegistration(): Promise<void> {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [DETECTOR_SCRIPT_ID],
    });
    if (existing.length === 0) return;
    await chrome.scripting.unregisterContentScripts({ ids: [DETECTOR_SCRIPT_ID] });
    console.info(
      `[vero] removed a legacy runtime registration (${existing[0]?.matches?.length ?? 0} ` +
        "match patterns); the manifest declares the content script now",
    );
  } catch (err) {
    // Surface it. A failure here means the old registration is still live alongside the new
    // manifest one, which is exactly the state that looks fine and is not.
    console.error("[vero] could not drop the legacy content-script registration", err);
  }
}

async function housekeeping(): Promise<void> {
  try {
    const settings = await readSettings();
    await pruneEvents(settings.retentionDays);
    await evictOffers();
  } catch (err) {
    console.error("[vero] housekeeping failed", err);
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
      `[vero] REJECTED ${(raw as { type?: string })?.type ?? "unknown"} message:`,
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
      /**
       * Three separate facts, only the last of which the popup can work out on its own.
       *
       *   granted    - does Chrome still hand us this origin? `https://*` is required at
       *                install, but the user can narrow site access from chrome://extensions
       *                at any time and the extension is never notified.
       *   excluded   - is this one of the hosts the manifest's `exclude_matches` refuses?
       *                Chrome will not inject there, whatever the permission says.
       *   registered - does the declared content script match this URL at all?
       *
       * Read from the manifest rather than from `chrome.scripting`: the content script is
       * declared, not registered, so `getRegisteredContentScripts` legitimately returns
       * nothing and reporting that as "not running" would be a lie.
       */
      let url: URL;
      try {
        url = new URL(msg.url);
      } catch {
        return {
          granted: false,
          registered: false,
          excluded: false,
          active: false,
          error: "unparseable url",
        };
      }

      let granted = false;
      let error: string | undefined;
      try {
        granted = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const declared = chrome.runtime.getManifest().content_scripts ?? [];
      const excluded = declared.some((cs) =>
        (cs.exclude_matches ?? []).some((p) => matchesPattern(p, url)),
      );
      const matched = declared.some((cs) => (cs.matches ?? []).some((p) => matchesPattern(p, url)));

      /**
       * Absence is the answer for a non-shop page.
       *
       * A ledger key exists only once the detector has messaged the worker, and it only
       * does that after its commerce gate passes. So this reports "Vero decided this is a
       * shop" without anything, anywhere, having written down that the other pages were
       * visited. storage.session is also cleared when the browser closes.
       */
      let active = false;
      try {
        const all = await chrome.storage.session.get(null);
        active = Object.keys(all).some((k) => k.startsWith("ledger:") && k.includes(url.origin));
      } catch {
        // Session storage being unavailable is not worth failing the whole report over.
      }

      return {
        granted,
        excluded,
        registered: matched && !excluded,
        active,
        ...(error ? { error } : {}),
      };
    }

    case "get-summary":
      return { rows: await prevalence(Date.now() - 24 * 60 * 60 * 1000) };

    case "export-events": {
      /**
       * The prevalence substrate, handed over whole.
       *
       * `get-summary` answers "what did I see today" for a person. This answers "what has
       * this browser actually observed" for research — one row per detection, with the
       * fields that make a row analysable: which pattern, where in the funnel, how confident,
       * whether it was ever actually shown, and why it was suppressed if not.
       *
       * Deliberately NOT the same shape as the telemetry record. Telemetry is k-anonymised
       * and strips the origin by design, because it leaves the device. This does not leave
       * the device unless the person exporting it chooses to move it, so it keeps the origin
       * — without which per-site prevalence cannot be computed at all, and per-site
       * prevalence is most of the point.
       *
       * `textSample` is included: it is already stored, it is what makes a row auditable
       * rather than merely countable, and a person exporting their own data should not have
       * to take the detector's word for what it matched. Anyone republishing an export is
       * republishing retailer copy they observed, which is their call to make knowingly.
       */
      const rows = await readEvents(0);
      return {
        rows: rows.map((e) => ({
          ts: e.ts,
          origin: e.origin,
          pathTemplate: e.pathTemplate,
          patternId: e.patternId,
          detectorId: e.detectorId,
          detectorVersion: e.detectorVersion,
          rulepackVersion: e.rulepackVersion,
          confidence: e.confidence,
          confidenceBasis: e.confidenceBasis,
          funnelStage: e.funnelStage,
          surfaced: e.surfaced,
          suppressionReason: e.suppressionReason,
          visibleMs: e.salience.visibleMs,
          viewportFraction: e.salience.viewportFraction,
          textSample: e.evidence.textSample ?? null,
          matchedLexemes: e.evidence.matchedLexemes,
        })),
      };
    }

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
