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
import { defaultsDetector } from "./defaults";
import { goalGradientDetector } from "./goalGradient";
import { scarcityDetector } from "./scarcity";
import { socialProofDetector } from "./socialProof";
import { urgencyDetector } from "./urgency";

/** All nine Tier-1 detectors (plan T13 + T19). */
export const DETECTORS: readonly Detector[] = [
  anchoringDetector,
  charmDetector,
  scarcityDetector,
  urgencyDetector,
  defaultsDetector,
  socialProofDetector,
  confirmshamingDetector,
  goalGradientDetector,
  bnplDetector,
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
