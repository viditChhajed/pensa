/** Shared helpers for detectors. Pure, no DOM, no clock, no network. */

import type { DetectionCandidate, Evidence } from "@/shared/schema";
import type { CandidateNode, PageContext } from "../types";
import { createHash } from "./hash";

export function buildEvidence(
  node: CandidateNode,
  matchedLexemes: string[],
  extraStyle?: Evidence["computedStyle"],
  /**
   * The text the match was actually made against, when that is not the node's own.
   *
   * A detector that matched on `containerText`, because a site split one sentence across
   * three spans, must quote the sentence, not the fragment it happened to attach to. The
   * card renders this verbatim, so without it the evidence line reads "3" and the question
   * becomes a riddle.
   */
  matchedText?: string,
): Evidence {
  const sample = matchedText?.trim();
  return {
    selectorPath: node.selectorPath,
    textHash: createHash(sample && sample.length > 0 ? sample : node.normalizedText),
    // A control often carries no text of its own, a pre-ticked checkbox is the clearest
    // case, and it produced an evidence sample of exactly one space. Its meaning lives in
    // its accessible name or in the label wrapped around it, so fall through to those.
    // Without this the card can only say "One choice was made for you in advance" and never
    // say which, which is the difference between a question and a riddle.
    textSample: (
      (sample && sample.length > 0 ? sample : "") ||
      node.text.trim() ||
      node.accessibleName.trim() ||
      node.containerText.trim()
    )
      .replace(/\s+/g, " ")
      .slice(0, 240),
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
  /** See buildEvidence: the text matched against, when it is not the node's own. */
  matchedText?: string,
): DetectionCandidate {
  return {
    detectorId,
    patternId,
    rawScore: score(subSignals, weights),
    subSignals,
    evidence: buildEvidence(node, matchedLexemes, undefined, matchedText),
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
