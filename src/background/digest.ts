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
  Salience,
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
  /** Page-measured salience, recorded on the event as measured. Absent for findings with no on-screen node. */
  salience?: Salience;
}

export interface RankedItem {
  /** Position in the `inputs` array this item came from. */
  inputIndex: number;
  patternId: PatternId;
  detectorId: string;
  confidence: number;
  rank: number;
  visibleMs: number;
}

export interface DigestResult {
  items: RankedItem[];
  /** Everything considered, with why it was or was not shown. Logged for research. */
  /**
   * Exactly one decision per input, carrying that input's index.
   *
   * The index is the point. Decisions used to carry only a patternId, and the caller matched
   * them back to candidates with `find(patternId)` — so when a page had three different
   * scarcity messages, all three recorded events carried the FIRST message's text and
   * confidence. The counts were right and every row after the first described the wrong thing.
   */
  decisions: {
    inputIndex: number;
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

  for (const [inputIndex, input] of inputs.entries()) {
    const { candidate, visibleMs, passedGate } = input;
    const patternId = candidate.patternId as PatternId;
    const entry = TAXONOMY[patternId];
    const rank = rankOne(candidate, visibleMs);

    const reject = (reason: SuppressionReason): void => {
      decisions.push({ inputIndex, patternId, surfaced: false, reason, rank });
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
        inputIndex: existing.inputIndex,
        patternId: existing.patternId,
        surfaced: false,
        reason: "dedup_family",
        rank: existing.rank,
      });
    }

    byFamily.set(entry.family, {
      inputIndex,
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
      inputIndex: dropped.inputIndex,
      patternId: dropped.patternId,
      surfaced: false,
      reason: "digest_full",
      rank: dropped.rank,
    });
  }
  for (const shown of items) {
    decisions.push({
      inputIndex: shown.inputIndex,
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
  /** `frequencyKey()` keys — origin, stage and page — already digested this session. */
  shownThisSession: ReadonlySet<string>;
  /** Origins that have shown a digest at all this session. */
  originsShown: ReadonlySet<string>;
}

/**
 * The debounce key: one card per PAGE per stage per session.
 *
 * It was origin + stage, so on the default "Every time I reach checkout" setting the first
 * card on a shop's product page silenced every later add-to-cart on that shop for the rest of
 * the day — a second product, a third, all quiet, which is not what "every time" says. The
 * page part is the product's resolved identity where one exists, else the path template; a
 * second click on the SAME page still shows nothing. "Once per site" is the setting for
 * anyone who wants the quieter behaviour.
 */
export function frequencyKey(origin: string, stage: FunnelStage, page: string): string {
  return `${origin}:${stage}:${page}`;
}

export function shouldShowDigest(
  frequency: DigestFrequency,
  origin: string,
  stage: FunnelStage,
  state: FrequencyState,
  page = "",
): { show: boolean; reason: SuppressionReason } {
  if (frequency === "off" || frequency === "never_interrupt") {
    return { show: false, reason: "user_disabled" };
  }

  if (frequency === "once_per_site" && state.originsShown.has(origin)) {
    return { show: false, reason: "debounced" };
  }

  // Even on the most frequent setting: one digest per page per stage per session.
  if (state.shownThisSession.has(frequencyKey(origin, stage, page))) {
    return { show: false, reason: "debounced" };
  }

  return { show: true, reason: "none" };
}
