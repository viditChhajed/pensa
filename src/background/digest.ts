/**
 * Digest ranking and selection (plan §9, T26).
 *
 * Pure: takes scored candidates plus their dwell times and returns what to show. Pure so the
 * ranking is testable without a browser, and so the same function can be replayed over a
 * recorded session to ask "what would we have shown here?"
 *
 * Rank = confidence x log(1 + dwellSeconds) x severityWeight.
 *
 * The log matters. Linear dwell would let one banner that sat on screen for four minutes
 * dominate a fee first disclosed at payment that the shopper saw for two seconds. The log
 * says "seen at all" counts for most of it and "seen for ages" adds a little.
 */

import type {
  DetectionCandidate,
  DigestFrequency,
  FunnelStage,
  SuppressionReason,
} from "@/shared/schema";
import { type PatternFamily, type PatternId, TAXONOMY } from "@/shared/taxonomy";

export const MAX_DIGEST_ITEMS = 4;

export interface RankInput {
  candidate: DetectionCandidate;
  /** Accumulated on-screen milliseconds, from the salience tracker. */
  visibleMs: number;
  /** Whether it cleared the salience gate at all. */
  passedGate: boolean;
}

export interface RankedItem {
  patternId: PatternId;
  detectorId: string;
  confidence: number;
  rank: number;
  visibleMs: number;
}

export interface DigestResult {
  items: RankedItem[];
  /** Everything considered, with why it was or was not shown. Logged for research. */
  decisions: {
    patternId: PatternId;
    surfaced: boolean;
    reason: SuppressionReason;
    rank: number;
  }[];
}

export interface DigestOptions {
  surfaceThreshold: number;
  disabledDetectors: ReadonlySet<string>;
  max?: number;
}

export function rankOne(candidate: DetectionCandidate, visibleMs: number): number {
  const entry = TAXONOMY[candidate.patternId as PatternId];
  if (!entry) return 0;
  return candidate.rawScore * Math.log(1 + visibleMs / 1000) * entry.severityWeight;
}

/**
 * Select at most `max` items, one per pattern family.
 *
 * Family dedup exists because `anchoring.reference_price` and `pricing.charm` will both fire
 * on the same price tag on almost every page, and showing both reads as padding rather than
 * as two observations.
 */
export function buildDigest(inputs: RankInput[], opts: DigestOptions): DigestResult {
  const max = opts.max ?? MAX_DIGEST_ITEMS;
  const decisions: DigestResult["decisions"] = [];
  const byFamily = new Map<PatternFamily, RankedItem>();

  for (const input of inputs) {
    const { candidate, visibleMs, passedGate } = input;
    const patternId = candidate.patternId as PatternId;
    const entry = TAXONOMY[patternId];
    const rank = rankOne(candidate, visibleMs);

    const reject = (reason: SuppressionReason): void => {
      decisions.push({ patternId, surfaced: false, reason, rank });
    };

    if (!entry) {
      reject("below_threshold");
      continue;
    }
    if (opts.disabledDetectors.has(candidate.detectorId) || opts.disabledDetectors.has(patternId)) {
      reject("user_disabled");
      continue;
    }
    if (candidate.rawScore < opts.surfaceThreshold) {
      reject("below_threshold");
      continue;
    }
    if (!passedGate) {
      // Detected but never actually on screen long enough to have been seen. Logged, not shown.
      reject("below_salience_gate");
      continue;
    }

    const existing = byFamily.get(entry.family);
    if (existing && existing.rank >= rank) {
      reject("dedup_family");
      continue;
    }
    if (existing) {
      decisions.push({
        patternId: existing.patternId,
        surfaced: false,
        reason: "dedup_family",
        rank: existing.rank,
      });
    }

    byFamily.set(entry.family, {
      patternId,
      detectorId: candidate.detectorId,
      confidence: candidate.rawScore,
      rank,
      visibleMs,
    });
  }

  const sorted = [...byFamily.values()].sort((a, b) => b.rank - a.rank);
  const items = sorted.slice(0, max);

  for (const dropped of sorted.slice(max)) {
    decisions.push({
      patternId: dropped.patternId,
      surfaced: false,
      reason: "digest_full",
      rank: dropped.rank,
    });
  }
  for (const shown of items) {
    decisions.push({
      patternId: shown.patternId,
      surfaced: true,
      reason: "none",
      rank: shown.rank,
    });
  }

  return { items, decisions };
}

/**
 * The sensitivity control (plan §16, shipped in v1 rather than v1.1).
 *
 * Perceived nagging is the single largest uninstall driver, which would be a poor look for
 * a tool that ships a nagging detector. This is the mitigation, and it is why the control is
 * not deferred.
 */
export interface FrequencyState {
  /** `${origin}:${stage}` keys already digested this session. */
  shownThisSession: ReadonlySet<string>;
  /** Origins that have shown a digest at all this session. */
  originsShown: ReadonlySet<string>;
}

export function shouldShowDigest(
  frequency: DigestFrequency,
  origin: string,
  stage: FunnelStage,
  state: FrequencyState,
): { show: boolean; reason: SuppressionReason } {
  if (frequency === "off" || frequency === "weekly_only") {
    return { show: false, reason: "user_disabled" };
  }

  if (frequency === "once_per_site" && state.originsShown.has(origin)) {
    return { show: false, reason: "debounced" };
  }

  // Even on the most frequent setting: one digest per origin per stage per session.
  if (state.shownThisSession.has(`${origin}:${stage}`)) {
    return { show: false, reason: "debounced" };
  }

  return { show: true, reason: "none" };
}
