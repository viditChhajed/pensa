/** Shared helpers for detectors. Pure — no DOM, no clock, no network. */

import type { DetectionCandidate, Evidence } from "@/shared/schema";
import type { CandidateNode, PageContext } from "../types";
import { createHash } from "./hash";

export function buildEvidence(
  node: CandidateNode,
  matchedLexemes: string[],
  extraStyle?: Evidence["computedStyle"],
): Evidence {
  return {
    selectorPath: node.selectorPath,
    textHash: createHash(node.normalizedText),
    textSample: node.text.slice(0, 240),
    matchedLexemes: matchedLexemes.slice(0, 24),
    computedStyle: extraStyle ?? {
      fontWeight: node.style.fontWeight,
      fontSizePx: node.style.fontSizePx,
      textDecoration: node.style.textDecorationLine,
      renderedArea: node.box.w * node.box.h,
      effectiveBackground: node.style.effectiveBackground,
    },
    boundingBox: node.box,
  };
}

/** Weighted sum of named sub-signals, clamped to 0..1. Weights are data, not code. */
export function score(subSignals: Record<string, number>, weights: Record<string, number>): number {
  let total = 0;
  for (const [k, v] of Object.entries(subSignals)) {
    total += v * (weights[k] ?? 0);
  }
  return Math.max(0, Math.min(1, total));
}

export function candidate(
  detectorId: string,
  patternId: DetectionCandidate["patternId"],
  node: CandidateNode,
  subSignals: Record<string, number>,
  weights: Record<string, number>,
  matchedLexemes: string[],
): DetectionCandidate {
  return {
    detectorId,
    patternId,
    rawScore: score(subSignals, weights),
    subSignals,
    evidence: buildEvidence(node, matchedLexemes),
    nodeRef: node.selectorPath,
  };
}

/** Is this node rendered at all? Cheap gate every detector should apply first. */
export function isRendered(n: CandidateNode): boolean {
  return (
    n.style.display !== "none" &&
    n.style.visibility !== "hidden" &&
    n.style.opacity > 0.05 &&
    n.box.w > 0 &&
    n.box.h > 0
  );
}

export function visibleCandidates(ctx: PageContext): CandidateNode[] {
  return ctx.candidates.filter(isRendered);
}

/** Which of `lexemes` appear in the node's normalized text. */
export function matchLexemes(n: CandidateNode, lexemes: readonly string[]): string[] {
  const hits: string[] = [];
  for (const l of lexemes) {
    if (n.normalizedText.includes(l)) hits.push(l);
  }
  return hits;
}
