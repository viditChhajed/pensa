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
import { explainStage } from "@/content/funnel";
import {
  harvest,
  invalidateAllStyles,
  invalidateStyles,
  readDocumentMeta,
} from "@/content/harvest";
import { extractObservations, isEmpty } from "@/content/observations";
import { PageObserver } from "@/content/observer";
import { resolveOffer } from "@/content/offerKey";
import { extractPriceSnapshot } from "@/content/priceSummary";
import { SalienceTracker } from "@/content/salience";
import { drainAcrossIdle } from "@/content/scheduler";
import { TriggerWatcher } from "@/content/triggers";
import type { PageContext } from "@/content/types";
import { DigestCard, measureCapacity } from "@/content/ui/card";
import { BUILD_STAMP, INJECTION_FLAG } from "@/shared/constants";
import { type ShowDigest, send } from "@/shared/messages";
import type { DetectionCandidate, FunnelStage } from "@/shared/schema";
import { originOf, pathTemplate } from "@/shared/urlScore";
import { encodePriceSnapshot } from "@/shared/wire";

/** Day-1 hand-set value. Below this, a candidate is not even worth reporting upward. */
const LOG_THRESHOLD = 0.35;
const PASS_DEBOUNCE_MS = 300;
/** Never let detection occupy more than this share of the main thread. */
const MAX_DUTY_CYCLE = 0.1;
const MAX_DEBOUNCE_MS = 15_000;
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
  let passTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Adaptive, because a full re-harvest on every mutation batch is the wrong algorithm and
   * the right one is not a quick fix.
   *
   * Plan §18C's dirty-subtree invalidation now covers the expensive half: computed style is
   * memoised across passes and dropped only for the subtrees the observer saw change, so a
   * busy SPA no longer re-resolves style for thousands of unchanged elements every pass.
   * (Measured on target.com before any of this: passes of 1839ms.) Boxes are still re-read
   * every pass and always will be — they are viewport-relative, so a scroll invalidates them
   * with no mutation to notice.
   *
   * This backoff stays regardless, because the cache helps a page that settles and does
   * nothing for one that rewrites itself continuously. It bounds the damage rather than
   * hiding it: the gap before the next pass scales with how long the last one took, so
   * detection can never occupy more than MAX_DUTY_CYCLE of the main thread no matter how
   * hostile the page.
   */
  let debounceMs = PASS_DEBOUNCE_MS;
  let lastReportedStage: FunnelStage | null = null;
  let offerKey: string | undefined;
  let lastObservationAt = 0;

  const observer = new PageObserver(() => schedulePass());
  const triggers = new TriggerWatcher(
    (e) => void onTrigger(e.kind, e.label),
    () => stage,
  );

  /** Per-phase cost of the last pass, so a budget overrun names its own cause. */
  const phase = { meta: 0, harvest: 0, detectors: 0 };

  function buildContext(): PageContext {
    const url = location.href;
    const t0 = performance.now();
    const meta = readDocumentMeta(document, url);
    const t1 = performance.now();

    // Plan §18C, the affordable half. Computed style is memoised across passes and dropped
    // only for the subtrees the MutationObserver actually saw change, so an unchanged page
    // is not re-resolved from scratch every pass — which is both the cost and the reason
    // the time budget kept truncating dense pages at the same node, pass after pass.
    invalidateStyles(observer.takeDirtyRoots());

    const candidates = harvest(document, {
      textHistories: observer.state.textHistories,
      ephemeral: observer.state.ephemeral,
    });
    phase.meta = t1 - t0;
    phase.harvest = performance.now() - t1;
    // explainStage rather than classifyStage: a wrong stage disables the cross-stage
    // detectors entirely, and "it said pdp" is not a diagnosis. The reasons make it one.
    const explained = explainStage(url, meta);
    if (explained.stage !== stage) {
      stage = explained.stage;
      console.info(`[patterns] stage -> ${stage} :: ${explained.reasons.join(" | ")}`);
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

    // One badge, one event.
    //
    // Shein renders "Almost Sold Out" on nine cards and Glossier repeats a price row
    // thirteen times, so a single piece of copy produced nine or thirteen identical events.
    // The digest dedupes by family so only one would ever be SHOWN — but the event log is
    // the prevalence substrate, and counting one badge nine times would put a 9x multiplier
    // on whichever retailers happen to repeat their markup most. That is a measurement
    // error, not a display one, and it survives into every statistic built on the log.
    //
    // Keyed on pattern + hashed text, so two genuinely different scarcity claims still count
    // twice. The first occurrence wins, which is the one nearest the top of the document.
    const seenText = new Set<string>();
    let duplicates = 0;

    const detectorCpuMs = await drainAcrossIdle(runDetectors(ctx), (run) => {
      for (const c of run.candidates) {
        if (c.rawScore < LOG_THRESHOLD) continue;
        const key = `${c.patternId}|${c.evidence.textHash}`;
        if (seenText.has(key)) {
          duplicates++;
          continue;
        }
        seenText.add(key);
        collected.push({ candidate: c, salienceKey: c.nodeRef });
        // Start dwell accounting for anything that might later be surfaced. Re-finding by
        // selector is best-effort by design — a miss costs a candidate, never a crash.
        const el = safeQuery(c.nodeRef);
        if (el) salience.observe(el, c.nodeRef, isEphemeral(ctx, c.nodeRef));
      }
    });

    phase.detectors = detectorCpuMs;
    const wallMs = performance.now() - started;
    latest = collected;
    if (collected.length > 0) {
      // Log the MATCHED TEXT, not just the pattern id.
      //
      // A line reading "9 detections — anchoring.reference_price x9" is undiagnosable: it
      // cannot distinguish nine genuine was/now price pairs from one runaway selector, and
      // it gives no way to tell why scarcity.stock stayed silent on a page covered in
      // "only 3 left at this price". The evidence already carries a text sample; showing it
      // turns every spot-check page into usable data.
      const byPattern = new Map<string, string[]>();
      for (const { candidate: c } of collected) {
        // Show WHAT MATCHED, not just the first 60 characters of the node's text.
        //
        // A firing logged as `scarcity.stock x1: "Enjoy the US Open in a spacious, private
        // luxury suite locate"` cannot be judged correct or incorrect: the matched phrase is
        // somewhere in the truncated remainder. Without the lexemes, every spot-check row's
        // "correct?" column is guesswork.
        const lexemes = c.evidence.matchedLexemes.slice(0, 4).join(",");
        const sample =
          `${(c.evidence.textSample ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}` +
          (lexemes.length > 0 ? ` [${lexemes}]` : "");
        const arr = byPattern.get(c.patternId);
        if (arr) arr.push(sample);
        else byPattern.set(c.patternId, [sample]);
      }
      const summary = [...byPattern.entries()]
        .map(([id, samples]) => {
          const shown = samples
            .slice(0, 3)
            .map((t) => `"${t}"`)
            .join(", ");
          const extra = samples.length > 3 ? ` +${samples.length - 3} more` : "";
          return `${id} x${samples.length}: ${shown}${extra}`;
        })
        .join(" | ");
      console.info(
        `[patterns] ${stage}: ${collected.length} detection(s)` +
          (duplicates > 0 ? ` (+${duplicates} repeat(s) of the same copy)` : "") +
          ` — ${summary}`,
      );
    }

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
      const snap = extractPriceSnapshot(ctx);
      // The ONLY observable evidence that the cross-stage pipeline has anything to work
      // with. `pricing.drip` compares fees between the earliest and latest stage snapshot,
      // so when it stays quiet there are two very different explanations — the site did not
      // drip, or the snapshots were empty — and nothing in the log distinguished them.
      // A full Glossier journey ended with no drip finding and no way to say which it was.
      const money = (m?: { amount: bigint; currency: string }): string =>
        m ? `${m.currency} ${(Number(m.amount) / 100).toFixed(2)}` : "-";
      console.info(
        `[patterns] snapshot @${stage}: price ${money(snap.displayedPrice)}, ` +
          `subtotal ${money(snap.subtotal)}, total ${money(snap.total)}, ` +
          `shipping ${money(snap.shipping)}, ${snap.fees.length} fee(s)` +
          (snap.fees.length > 0
            ? ` — ${snap.fees.map((f) => `${f.labelSample ?? "?"} ${money(f.amount)}`).join("; ")}`
            : ""),
      );
      await send({
        type: "stage",
        origin: pageOrigin,
        pathTemplate: pathTemplate(location.href),
        stage,
        priceSnapshot: encodePriceSnapshot(snap),
      });
    }

    // CPU, not wall-clock. See drainAcrossIdle: wall-clock is mostly time spent waiting for
    // an idle window, which costs the page nothing and must not drive the backoff.
    const elapsed = phase.meta + phase.harvest + phase.detectors;
    debounceMs = Math.min(
      MAX_DEBOUNCE_MS,
      Math.max(PASS_DEBOUNCE_MS, Math.round(elapsed / MAX_DUTY_CYCLE)),
    );
    if (elapsed > PERF_BUDGET_MS) {
      // Naming the phase matters: "the pass is slow" has three possible causes with three
      // different fixes, and the previous message did not distinguish them.
      console.warn(
        `[patterns] pass used ${elapsed.toFixed(0)}ms CPU of ${wallMs.toFixed(0)}ms wall ` +
          `(budget ${PERF_BUDGET_MS}ms) — ` +
          `meta ${phase.meta.toFixed(0)}ms, harvest ${phase.harvest.toFixed(0)}ms, ` +
          `detectors ${phase.detectors.toFixed(0)}ms, ${ctx.candidates.length} candidates — ` +
          `backing off to ${debounceMs}ms between passes`,
      );
    }
  }

  /**
   * The duty-cycle backoff is a main-thread protection, and on heavy storefronts it settles
   * at the 15s ceiling. That is fine for idle re-scans and wrong for the two moments where
   * being current is the whole point: the shopper has just navigated, or has just clicked
   * add-to-cart and a digest is about to be built from `latest`. Waiting up to 15 seconds
   * there means classifying the previous page and reporting stale candidates.
   *
   * So an immediate pass jumps the queue. It still costs a pass, but at most one per
   * navigation or per add-to-cart, which is not a duty cycle a page can drive.
   */
  const IMMEDIATE_SETTLE_MS = 150;

  /**
   * ...and then how long to wait before BUILDING the digest.
   *
   * The salience gate requires a node to have been on screen ~800ms, which is right: it is
   * what stops the tool asking about something that flashed past. But a node discovered by
   * the post-click pass has zero accumulated dwell by construction, so every candidate in a
   * freshly-opened drawer failed the gate and the digest came back empty. Every event in the
   * first real run was logged `below_salience_gate`.
   *
   * Waiting here lets genuinely-visible content earn its dwell honestly, rather than
   * weakening the gate. Cost is roughly a second between the click and the card, during
   * which the drawer is animating open anyway.
   */
  const SALIENCE_ACCRUAL_MS = 450;

  /**
   * Total budget for waiting on a post-click page to become worth asking about.
   *
   * A fixed delay cannot work here. Glossier's bag drawer is populated by a network round
   * trip, so at 750ms after the click the page still held the pre-click content and the
   * digest was built from two off-screen carousel prices with 0ms dwell. Retailers differ by
   * an order of magnitude in how fast that drawer appears, so the wait polls instead of
   * guessing: re-harvest, let salience accrue, and stop as soon as something has genuinely
   * been on screen long enough — or give up at the deadline and report what there is.
   */
  const TRIGGER_WINDOW_MS = 5000;

  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  function schedulePass(immediate = false): Promise<void> {
    if (immediate) {
      if (passTimer !== null) clearTimeout(passTimer);
      passScheduled = true;
      return new Promise((resolve) => {
        passTimer = setTimeout(() => {
          passTimer = null;
          passScheduled = false;
          void pass().finally(resolve);
        }, IMMEDIATE_SETTLE_MS);
      });
    }
    if (passScheduled) return Promise.resolve();
    passScheduled = true;
    return new Promise((resolve) => {
      passTimer = setTimeout(() => {
        passTimer = null;
        passScheduled = false;
        void pass().finally(resolve);
      }, debounceMs);
    });
  }

  async function onTrigger(kind: string, label: string): Promise<void> {
    // Re-scan first. A click on add-to-cart usually changes the page (a drawer opens, a
    // count updates), and `latest` is otherwise whatever the last backed-off pass saw.
    // Then wait again, so what the drawer just revealed can accrue real on-screen time
    // before the salience gate judges it. See SALIENCE_ACCRUAL_MS.

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

    const snapshot = () =>
      latest.map(({ candidate, salienceKey }) => {
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

    const capacity = measureCapacity();

    // Check what is ALREADY qualified before waiting for anything.
    //
    // On a cart page the interesting content has usually been on screen for seconds before
    // the click, so it has earned its dwell and the card can appear at once. The previous
    // version waited out a settle delay and a poll step unconditionally, which cost several
    // seconds on exactly the pages where nothing needed waiting for — long enough that a
    // shopper clicked Checkout and navigated away before the card arrived.
    //
    // The polling below is still there for the other case: a drawer that has not rendered
    // yet, whose content cannot have dwell because it does not exist yet.
    const deadline = Date.now() + TRIGGER_WINDOW_MS;
    let items = snapshot();
    while (Date.now() < deadline && !items.some((i) => i.passedGate)) {
      await schedulePass(true);
      await wait(SALIENCE_ACCRUAL_MS);
      items = snapshot();
    }

    // Why a digest did or did not appear, in one line. Without this the only observable
    // symptom is "nothing happened", which is indistinguishable from every other failure in
    // the chain — and that cost a full manual test round.
    console.info(
      `[patterns] trigger ${kind} @${stage}: ${items.length} candidate(s) — ` +
        items
          .map(
            (i) =>
              `${i.candidate.patternId} score=${i.candidate.rawScore.toFixed(2)} ` +
              `dwell=${Math.round(i.salience.visibleMs)}ms gate=${i.passedGate ? "pass" : "FAIL"}`,
          )
          .join(" | "),
    );

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
      placement: capacity,
    });

    const cap = capacity;
    if (reply?.items && reply.items.length > 0 && reply.mode !== "suppressed") {
      const rendered = card.show(reply.items);
      console.info(`[patterns] digest ${reply.mode} -> rendered ${rendered}`);
    } else {
      const why = (reply as { issues?: string[]; error?: string } | null)?.issues;
      console.info(
        `[patterns] no digest: mode=${reply?.mode ?? "none"} items=${reply?.items?.length ?? 0} ` +
          `capacity=card:${cap.maxCardItems}/pill:${cap.pillFits}` +
          (why ? ` REJECTED -> ${why.join("; ")}` : ""),
      );
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
  // Visible at default log level, deliberately. Injection was previously only observable by
  // inferring it from chrome.storage.session, which is cleared on every extension reload —
  // so "no ledger key" was ambiguous between "not injected" and "you reloaded the extension
  // and have not revisited the page yet". One line removes the ambiguity.
  console.info(`[patterns] active on ${pageOrigin} — build ${BUILD_STAMP}`);

  observer.start();
  triggers.attach();

  /**
   * A resize re-evaluates every media query and every relative unit on the page, and no
   * element reports it — there is no mutation record to invalidate against, so the style
   * cache would keep serving pre-resize values indefinitely. Dropped wholesale rather than
   * selectively, because after a resize there is no "unchanged" subtree to preserve.
   *
   * Passive and coalesced by the pass debounce: resize fires continuously while a window is
   * being dragged, and bumping an integer per event is deliberately the cheapest possible
   * response to that.
   */
  addEventListener("resize", () => invalidateAllStyles(), { passive: true });

  void pass();

  // SPA routing: the `navigation` API where available, a light URL poll otherwise. Never
  // `history.pushState` patching — it breaks host pages and reads as hostile (plan §14.6).
  const nav = (globalThis as { navigation?: EventTarget }).navigation;
  if (nav) {
    nav.addEventListener("navigate", () => void schedulePass(true));
  } else {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        void schedulePass(true);
      }
    }, 800);
  }
});
