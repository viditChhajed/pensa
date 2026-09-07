/**
 * The detector content script.
 *
 * Built via `defineUnlistedScript`, which means WXT compiles it but never writes it into the
 * manifest. That is what keeps `host_permissions` empty (plan §1.2): a content script
 * declared in the manifest implicitly grants its match patterns at install time, which would
 * produce the 150-site install warning the whole permission design exists to avoid. This
 * file is registered at runtime by the service worker, only for origins the user granted.
 */
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { runDetectors } from "@/content/detectors";
import { classifyStage } from "@/content/funnel";
import { harvest, readDocumentMeta } from "@/content/harvest";
import { PageObserver } from "@/content/observer";
import { SalienceTracker } from "@/content/salience";
import { drainAcrossIdle } from "@/content/scheduler";
import { TriggerWatcher } from "@/content/triggers";
import type { PageContext } from "@/content/types";
import { type CardItem, DigestCard } from "@/content/ui/card";
import { DETECTOR_VERSION, INJECTION_FLAG } from "@/shared/constants";
import type { DetectionCandidate, FunnelStage, PatternId } from "@/shared/schema";
import { TAXONOMY } from "@/shared/taxonomy";
import { ALLOWLIST_VERSION } from "@/shared/urlScore";

/** Day 1: hand-set, precision-biased. Revisited after the §10 spot-check. */
const SURFACE_THRESHOLD = 0.75;
const LOG_THRESHOLD = 0.35;

interface ScoredCandidate {
  candidate: DetectionCandidate;
  salienceKey: string;
}

export default defineUnlistedScript(() => {
  const w = globalThis as unknown as Record<string, unknown>;
  if (w[INJECTION_FLAG]) return;
  w[INJECTION_FLAG] = true;

  const card = new DigestCard();
  const salience = new SalienceTracker();
  let stage: FunnelStage = "browse";
  let latest: ScoredCandidate[] = [];
  let passScheduled = false;

  const observer = new PageObserver(() => schedulePass());
  const triggers = new TriggerWatcher(
    (e) => onTrigger(e.kind),
    () => stage,
  );

  function buildContext(): PageContext {
    const url = location.href;
    const meta = readDocumentMeta(document, url);
    const candidates = harvest(document, {
      textHistories: observer.state.textHistories,
      ephemeral: observer.state.ephemeral,
    });
    const nextStage = classifyStage(url, meta);
    if (nextStage !== stage) {
      stage = nextStage;
      triggers.noteStageChange(stage);
    }
    return {
      candidates,
      meta,
      funnelStage: stage,
      now: performance.now(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }

  async function pass(): Promise<void> {
    const started = performance.now();
    const ctx = buildContext();
    const collected: ScoredCandidate[] = [];

    await drainAcrossIdle(runDetectors(ctx), (run) => {
      for (const c of run.candidates) {
        if (c.rawScore < LOG_THRESHOLD) continue;
        collected.push({ candidate: c, salienceKey: c.nodeRef });
        // Attach an IntersectionObserver so dwell starts accruing for anything we might
        // later want to surface. Re-finding by selector is best-effort by design.
        const el = safeQuery(c.nodeRef);
        if (el) salience.observe(el, c.nodeRef, isEphemeral(ctx, c.nodeRef));
      }
    });

    latest = collected;
    const elapsed = performance.now() - started;
    if (elapsed > 50) {
      console.warn(`[patterns] pass took ${elapsed.toFixed(1)}ms (budget 50ms)`);
    }
  }

  function schedulePass(): void {
    if (passScheduled) return;
    passScheduled = true;
    setTimeout(() => {
      passScheduled = false;
      void pass();
    }, 300);
  }

  function onTrigger(kind: string): void {
    // Rank by confidence x dwell x severity, dedupe by pattern family, cap at 4 (plan §9).
    const byFamily = new Map<string, { item: CardItem; rank: number }>();

    for (const { candidate: c, salienceKey } of latest) {
      if (c.rawScore < SURFACE_THRESHOLD) continue;
      if (!salience.passesGate(salienceKey)) continue;

      const entry = TAXONOMY[c.patternId as PatternId];
      const dwell = salience.get(salienceKey).visibleMs;
      const rank = c.rawScore * Math.log(1 + dwell / 1000) * entry.severityWeight;

      const existing = byFamily.get(entry.family);
      if (!existing || rank > existing.rank) {
        byFamily.set(entry.family, {
          item: { patternId: c.patternId as PatternId, confidence: c.rawScore },
          rank,
        });
      }
    }

    const items = [...byFamily.values()]
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 4)
      .map((x) => x.item);

    if (items.length === 0) return;
    card.show(items);

    console.debug("[patterns] digest", {
      kind,
      stage,
      shown: items.map((i) => i.patternId),
      detectorVersion: DETECTOR_VERSION,
      rulepackVersion: ALLOWLIST_VERSION,
    });
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

  // --- boot ---
  observer.start();
  triggers.attach();
  void pass();

  // SPA routing. The `navigation` API where available, a light URL poll otherwise —
  // never `history.pushState` patching, which breaks host pages (plan §14.6).
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
