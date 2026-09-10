/**
 * Detector registry and the scheduler entry point.
 *
 * Detectors are generator-friendly: `runDetectors` yields between detectors so the caller
 * can respect an idle time slice and resume on the next window rather than blocking a frame.
 */

import type { DetectionCandidate, FunnelStage } from "@/shared/schema";
import type { Detector, PageContext } from "../types";
import { anchoringDetector } from "./anchoring";
import { bnplDetector } from "./bnpl";
import { charmDetector } from "./charm";
import { confirmshamingDetector } from "./confirmshaming";
import { decoyDetector } from "./decoy";
import { defaultsDetector } from "./defaults";
import { exitIntentDetector } from "./exitIntent";
import { framingDetector } from "./framing";
import { interferenceDetector } from "./interference";
import { naggingDetector } from "./nagging";
import { goalGradientDetector } from "./goalGradient";
import { scarcityDetector } from "./scarcity";
import { socialProofDetector } from "./socialProof";
import { urgencyDetector } from "./urgency";

/**
 * Every page detector that ships.
 *
 * Tier 2 was held back for "v1.1 during store review", which was a schedule decision rather
 * than a quality one — all five were built and tested at the same time as Tier 1. The spot
 * check made the cost concrete: flyfrontier's fare grid is a textbook asymmetric-dominance
 * decoy, four bundles priced so the middle one looks obvious, and the extension produced
 * ZERO detections on that page because the only detector that could see it was excluded
 * from the bundle. Shipping what is already built and passing is the better trade.
 */
export const DETECTORS: readonly Detector[] = [
  // Tier 1
  anchoringDetector,
  charmDetector,
  scarcityDetector,
  urgencyDetector,
  defaultsDetector,
  socialProofDetector,
  confirmshamingDetector,
  goalGradientDetector,
  bnplDetector,
  // Tier 2
  interferenceDetector,
  decoyDetector,
  naggingDetector,
  framingDetector,
  exitIntentDetector,
];

export const DETECTORS_BY_ID = new Map(DETECTORS.map((d) => [d.id, d]));

export function detectorsForStage(stage: FunnelStage): Detector[] {
  return DETECTORS.filter((d) => d.stages.includes(stage));
}

export interface DetectorRun {
  detectorId: string;
  candidates: DetectionCandidate[];
  elapsedMs: number;
}

/**
 * Stage-gated, one detector per yield. A detector that throws is skipped and reported —
 * one broken detector must never take down detection for the whole page.
 */
export function* runDetectors(
  ctx: PageContext,
  disabled: ReadonlySet<string> = new Set(),
): Generator<DetectorRun, void, unknown> {
  for (const d of detectorsForStage(ctx.funnelStage)) {
    if (disabled.has(d.id) || disabled.has(d.patternId)) continue;
    const started = performance.now();
    let candidates: DetectionCandidate[] = [];
    try {
      candidates = d.run(ctx);
    } catch (err) {
      console.error(`[patterns] detector ${d.id} threw`, err);
    }
    yield { detectorId: d.id, candidates, elapsedMs: performance.now() - started };
  }
}
