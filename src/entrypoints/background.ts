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
import { discardViews, notePageView, sweepViews } from "@/background/outcomes";
import { recordObservation } from "@/background/recordOffer";
import { currentSessionId, decideDigest, recordPassive } from "@/background/session";
import {
  clearLedgers,
  loadLedger,
  noteStage,
  noteUserAdd,
  noteUserChoice,
  saveLedger,
} from "@/background/sessionLedger";
import { discardQueue, flush, pendingRecords } from "@/background/telemetry";
import { TELEMETRY_ENDPOINT } from "@/shared/constants";
import { matchesPattern } from "@/shared/domain";
import type { ShowDigest } from "@/shared/messages";
import { Message } from "@/shared/messages.schema";
import { decodePriceSnapshot } from "@/shared/wire";

/**
 * Service worker.
 *
 *   1. Own the session ledger and the digest decision, because both outlive any one page.
 *   2. Answer the popup's "are you actually running here?" question.
 *
 * What it does not do: register the content script, and so it needs no `scripting`
 * permission. An earlier draft kept that permission solely to unregister a script left over
 * from the per-site grant model — but that model never shipped, so no installed copy can
 * have one, and a permission requested for a user who cannot exist is a permission a store
 * reviewer is right to reject. The manifest declares it, matching
 * the required https host permission and excluding what the denylist can express, so there
 * is nothing to keep in sync at runtime and nothing that can silently fail to register. It
 * also no longer installs declarativeContent page rules — the action is enabled everywhere
 * and the popup opens on every page, so there was nothing for a page rule to decide.
 */
export default defineBackground(() => {
  // Service workers die. Anything assumed to persist has to be re-derived on wake.
  chrome.runtime.onStartup.addListener(() => {
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

/** Send whatever is consented to and ready to go. Logs its own outcome. */
async function flushTelemetry(): Promise<void> {
  try {
    const settings = await readSettings();
    // End views that went idle first, so their non-adds travel in this batch rather than
    // waiting six more hours behind it.
    await sweepViews(settings);
    const result = await flush(settings);
    // Every branch is worth seeing. "Nothing was sent" has several causes with different
    // fixes: no consent, no endpoint compiled in, too few records yet, or a failed request.
    if (result.reason !== "no_consent" || result.sent > 0) {
      console.info(`[vero] telemetry: ${result.reason}, ${result.sent} sent, ${result.held} held`);
    }
  } catch (err) {
    console.error("[vero] telemetry flush failed", err);
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

    case "choice": {
      // Recorded per origin for the session, so an add-on chosen on a product page is still
      // the shopper's own when it shows up on the cart page two navigations later.
      const sessionId = await currentSessionId();
      let ledger = await loadLedger(sessionId, msg.origin);
      const ts = Date.now();
      for (const c of msg.choices) {
        ledger = noteUserChoice(ledger, { ts, key: c.key, selected: c.selected });
      }
      await saveLedger(ledger);
      return { ok: true };
    }

    case "pageview":
      return { queued: await notePageView(msg, await readSettings()) };

    case "candidates": {
      if (msg.intent === "record") {
        const { recorded } = await recordPassive(
          msg.origin,
          msg.pathTemplate,
          msg.stage,
          msg.items,
        );
        return {
          type: "show-digest",
          items: [],
          mode: "suppressed",
          recorded,
        } satisfies ShowDigest & {
          recorded: number;
        };
      }

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
      // The one-time sharing question rides on the first full card, and only then: it is
      // asked right after the person has seen what Vero does, never before, and never again
      // once answered or dismissed. A pill has no room to explain it honestly, so it waits.
      const settings = await readSettings();
      const askConsent =
        decision.mode === "card" &&
        decision.items.length > 0 &&
        !settings.telemetryConsent &&
        settings.telemetryConsentAskedAt === undefined;
      return {
        type: "show-digest",
        items: decision.items,
        mode: decision.mode,
        ...(askConsent ? { askConsent: true } : {}),
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
        // The exact key, not a substring: `includes("https://shop.co")` also matched the
        // ledger for https://shop.com, reporting one site as active because of another.
        active = `ledger:${url.origin}` in all;
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
      if (msg.patch.telemetryConsent === false) {
        await discardQueue();
        await discardViews();
      }
      return updated;
    }

    case "clear-data":
      await clearAllData();
      await clearLedgers();
      await discardViews();
      return { ok: true };

    default:
      return { ok: false, error: "unhandled" };
  }
}
