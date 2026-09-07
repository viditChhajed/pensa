/**
 * The detector content script.
 *
 * Built via `defineUnlistedScript`, so WXT compiles it but never writes it into the
 * manifest. That is what keeps `host_permissions` empty (plan §1.2): a content script
 * declared in the manifest implicitly grants its match patterns at install, producing the
 * 150-site install warning the permission design exists to avoid. The service worker
 * registers this file at runtime, only for origins the user granted.
 *
 * Responsibilities here are narrow on purpose: observe the page, score it, report upward.
 * Ranking, persistence, and the cross-stage findings live in the worker, because they
 * outlive any single page.
 */
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { runDetectors } from "@/content/detectors";
import { createHash } from "@/content/detectors/hash";
import { classifyStage } from "@/content/funnel";
import { harvest, readDocumentMeta } from "@/content/harvest";
import { extractObservations, isEmpty } from "@/content/observations";
import { PageObserver } from "@/content/observer";
import { resolveOffer } from "@/content/offerKey";
import { extractPriceSnapshot } from "@/content/priceSummary";
import { SalienceTracker } from "@/content/salience";
import { drainAcrossIdle } from "@/content/scheduler";
import { TriggerWatcher } from "@/content/triggers";
import type { PageContext } from "@/content/types";
import { DigestCard, measureCapacity } from "@/content/ui/card";
import { INJECTION_FLAG } from "@/shared/constants";
import { type ShowDigest, send } from "@/shared/messages";
import type { DetectionCandidate, FunnelStage } from "@/shared/schema";
import { originOf, pathTemplate } from "@/shared/urlScore";
import { encodePriceSnapshot } from "@/shared/wire";

/** Day-1 hand-set value. Below this, a candidate is not even worth reporting upward. */
const LOG_THRESHOLD = 0.35;
const PASS_DEBOUNCE_MS = 300;
const PERF_BUDGET_MS = 50;
/** One temporal observation per visit, not per re-render (plan §18A). */
const OBSERVATION_INTERVAL_MS = 60_000;

interface Scored {
  candidate: DetectionCandidate;
  salienceKey: string;
}

export default defineUnlistedScript(() => {
  const w = globalThis as unknown as Record<string, unknown>;
  if (w[INJECTION_FLAG]) return;
  w[INJECTION_FLAG] = true;

  const card = new DigestCard();
  const salience = new SalienceTracker();
  const maybeOrigin = safeOrigin();
  if (maybeOrigin === null) return;
  const pageOrigin: string = maybeOrigin;

  let stage: FunnelStage = "browse";
  let latest: Scored[] = [];
  let passScheduled = false;
  let lastReportedStage: FunnelStage | null = null;
  let offerKey: string | undefined;
  let lastObservationAt = 0;

  const observer = new PageObserver(() => schedulePass());
  const triggers = new TriggerWatcher(
    (e) => void onTrigger(e.kind, e.label),
    () => stage,
  );

  function buildContext(): PageContext {
    const url = location.href;
    const meta = readDocumentMeta(document, url);
    const candidates = harvest(document, {
      textHistories: observer.state.textHistories,
      ephemeral: observer.state.ephemeral,
    });
    const next = classifyStage(url, meta);
    if (next !== stage) {
      stage = next;
      triggers.noteStageChange(stage);
    }
    return {
      candidates,
      meta,
      funnelStage: stage,
      signals: {
        modalInsertionCount: observer.state.modalsInsertedAt.length,
        modalsInsertedAt: observer.state.modalsInsertedAt,
        lastExitIntentAt: observer.state.lastExitIntentAt,
        exitIntentModals: observer.state.exitIntentModals,
      },
      now: performance.now(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }

  async function pass(): Promise<void> {
    const started = performance.now();
    const ctx = buildContext();
    const collected: Scored[] = [];

    await drainAcrossIdle(runDetectors(ctx), (run) => {
      for (const c of run.candidates) {
        if (c.rawScore < LOG_THRESHOLD) continue;
        collected.push({ candidate: c, salienceKey: c.nodeRef });
        // Start dwell accounting for anything that might later be surfaced. Re-finding by
        // selector is best-effort by design — a miss costs a candidate, never a crash.
        const el = safeQuery(c.nodeRef);
        if (el) salience.observe(el, c.nodeRef, isEphemeral(ctx, c.nodeRef));
      }
    });

    latest = collected;

    // §18A: resolve this page's offer identity and contribute one observation per visit.
    // Rate-limited so an SPA re-rendering ten times a minute does not inflate the history
    // into ten "sightings" and manufacture a temporal claim out of a single visit.
    const offer = resolveOffer(ctx.meta, document);
    if (offer) {
      offerKey = offer.offerKey;
      const sinceLast = Date.now() - lastObservationAt;
      if (sinceLast > OBSERVATION_INTERVAL_MS) {
        const observation = extractObservations(ctx, Date.now());
        if (!isEmpty(observation)) {
          lastObservationAt = Date.now();
          await send({
            type: "observation",
            origin: pageOrigin,
            offerKey: offer.offerKey,
            offerKeySource: offer.source,
            observation,
          });
        }
      }
    }

    // Report the stage and its price snapshot so the worker can do cross-stage work. The
    // snapshot is what makes drip pricing possible, and it only exists page-side.
    if (stage !== lastReportedStage) {
      lastReportedStage = stage;
      await send({
        type: "stage",
        origin: pageOrigin,
        pathTemplate: pathTemplate(location.href),
        stage,
        priceSnapshot: encodePriceSnapshot(extractPriceSnapshot(ctx)),
      });
    }

    const elapsed = performance.now() - started;
    if (elapsed > PERF_BUDGET_MS) {
      console.warn(`[patterns] pass took ${elapsed.toFixed(1)}ms (budget ${PERF_BUDGET_MS}ms)`);
    }
  }

  function schedulePass(): void {
    if (passScheduled) return;
    passScheduled = true;
    setTimeout(() => {
      passScheduled = false;
      void pass();
    }, PASS_DEBOUNCE_MS);
  }

  async function onTrigger(kind: string, label: string): Promise<void> {
    const path = pathTemplate(location.href);

    if (kind === "add_to_cart") {
      await send({
        type: "trigger",
        origin: pageOrigin,
        pathTemplate: path,
        stage,
        kind: "add_to_cart",
        labelHash: createHash(label.toLowerCase()),
        labelSample: label.slice(0, 120),
      });
    }

    const items = latest.map(({ candidate, salienceKey }) => {
      const rec = salience.get(salienceKey);
      return {
        candidate,
        salience: {
          visibleMs: rec.visibleMs,
          viewportFraction: rec.viewportFraction,
          scrollDepthAtFirstView: rec.scrollDepthAtFirstView,
          ephemeral: rec.ephemeral,
        },
        passedGate: salience.passesGate(salienceKey),
      };
    });

    // The worker decides. It holds the ledger, the settings, and the frequency state, none
    // of which a single page can see.
    const reply = await send<ShowDigest>({
      type: "candidates",
      origin: pageOrigin,
      pathTemplate: path,
      stage,
      items: items.slice(0, 200),
      ...(offerKey ? { offerKey } : {}),
      // Measured BEFORE the worker ranks, so the event log can record what was actually
      // displayed rather than what was intended.
      placement: measureCapacity(),
    });

    if (reply?.items && reply.items.length > 0 && reply.mode !== "suppressed") {
      card.show(reply.items);
    }
  }

  function isEphemeral(ctx: PageContext, path: string): boolean {
    return ctx.candidates.find((c) => c.selectorPath === path)?.ephemeral ?? false;
  }

  function safeQuery(path: string): Element | null {
    try {
      return document.querySelector(path);
    } catch {
      return null;
    }
  }

  function safeOrigin(): string | null {
    try {
      return originOf(location.href);
    } catch {
      return null;
    }
  }

  // --- boot ---
  observer.start();
  triggers.attach();
  void pass();

  // SPA routing: the `navigation` API where available, a light URL poll otherwise. Never
  // `history.pushState` patching — it breaks host pages and reads as hostile (plan §14.6).
  const nav = (globalThis as { navigation?: EventTarget }).navigation;
  if (nav) {
    nav.addEventListener("navigate", () => schedulePass());
  } else {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        schedulePass();
      }
    }, 800);
  }
});
