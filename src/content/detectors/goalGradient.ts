/**
 * goal_gradient.threshold
 *
 * "You're $12 away from free shipping" plus a progress bar. The mechanism is that effort
 * toward a goal rises as the goal appears closer, so a near-miss threshold pulls spend up.
 *
 * Precision note: a bare "Free shipping over $50" is a policy statement, not a goal gradient
 * — there is no progress and no personalised remainder. The detector requires either an
 * explicit remaining amount addressed to the shopper, or a progress element paired with
 * threshold copy.
 */

import { parsePrices } from "@/shared/money";
import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, matchLexemes, visibleCandidates } from "./util";

/** A personalised remainder: addressed to you, with an amount still to go. */
// Note: these deliberately use `.{0,16}?` rather than `[^.]{0,16}`. The gap between the
// verb and the goal is almost always an amount, and `[^.]` cannot cross the decimal point
// in "$20.00" — which silently broke every pattern here on realistic copy.
const REMAINDER_PATTERNS: readonly RegExp[] = [
  /\byou'?re\s+.{0,16}?\s*away from\b/,
  /\bonly\s+.{0,16}?\s*(?:away|more|to go)\b/,
  /\badd\s+.{0,16}?\s*(?:more\s+)?to (?:get|unlock|qualify|receive)\b/,
  // Shein: "Add $2.77 more to cart for FREE STANDARD SHIPPING on SHEIN products!" — the
  // threshold is phrased as a destination ("to cart for X") rather than a purpose ("to get
  // X"), and scored zero. "more" is load-bearing here: without it this would match the
  // plain "Add to cart" on every product page in existence.
  /\badd\s+.{0,16}?\s*more\s+to (?:your\s+)?(?:cart|bag|basket)\b/,
  /\bspend\s+.{0,16}?\s*(?:more\s+)?to (?:get|unlock|qualify)\b/,
  /\b.{0,16}?\s*away from free (?:shipping|delivery)\b/,
  /\byou are\s+.{0,16}?\s*away\b/,
  /\bjust\s+.{0,16}?\s*(?:more\s+)?(?:away|to go|until)\b/,
  /**
   * Field-reported misses. Each one is a phrasing a shopper offered from memory that scored
   * exactly zero, which is the same failure mode EVAL run 1 recorded seven times: the
   * lexicon was written against copy I imagined rather than copy that exists.
   *
   * "until" was in the `just …` pattern and nowhere else, so "only $30 until free shipping"
   * — as ordinary a sentence as this detector will ever see — was invisible.
   */
  /\bonly\s+.{0,16}?\s*until\b/,
  /\b(?:only|just)?\s*.{0,12}?\s*(?:more\s+)?(?:until|till|to reach|to hit)\s+(?:free|your)\b/,
  /** "You're almost there! $8 to go" — the remainder is in a second clause. */
  /\balmost there\b/,
  /\b[$£€]\s?[\d.,]+\s*(?:more\s+)?to go\b/,
  /\b[$£€]\s?[\d.,]+\s*(?:more\s+)?(?:and|for)\s+(?:you\s+)?(?:get|unlock|qualify)\b/,
];

/** Threshold copy without a personalised remainder — needs a progress bar to count. */
const THRESHOLD_COPY =
  /\bfree (?:shipping|delivery)\b|\bunlock (?:free|a )\b|\bqualif(?:y|ies) for\b|\bto reach\b/;

/**
 * A bare policy: "free shipping on orders over $50". No progress, no personalised remainder.
 *
 * This is NOT something to show a shopper — practically every shop has one, and a card about
 * it would be noise that teaches people to dismiss cards. But it was scoring zero, which
 * meant it was not RECORDED either, and the two are different claims: §5 makes `surfaced`
 * first-class precisely so a thing can be counted without being shown.
 *
 * It matters for the measurement half of the product. "How many shops set a free-shipping
 * threshold, and at what amount" is a real question about choice architecture, and a store
 * that logs nothing can never answer it. Weighted to land in the log band and to be unable
 * to reach the surface band on its own.
 */
const THRESHOLD_POLICY =
  /\b(?:free (?:shipping|delivery)|ships? free)\b[^.]{0,30}?\b(?:over|above|on orders? (?:over|above)|when you spend|with \$?[\d.,]+)\b|\b(?:orders?|spend)\b[^.]{0,20}?\b(?:over|above|of)\s*[$£€]?\s*[\d.,]+[^.]{0,24}?\bfree (?:shipping|delivery)\b|\bspend\s*[$£€]?[\d.,]+\s*(?:for|and get)\s+free\b|\borders?\s+(?:over|above)\s*[$£€]?[\d.,]+\s+ships?\s+free\b/;

const LEXEMES = [
  "away from",
  "add",
  "more",
  "unlock",
  "spend",
  "free shipping",
  "free delivery",
  "qualify",
  "to go",
] as const;

const WEIGHTS: Record<string, number> = {
  personalisedRemainder: 0.6,
  progressBar: 0.3,
  thresholdCopy: 0.2,
  hasAmount: 0.15,
  /**
   * 0.45 is chosen against the two thresholds, not picked for feel: above LOG_THRESHOLD
   * (0.35) so a bare policy is counted, and below the 0.75 surface threshold by enough that
   * `hasAmount` — which a policy always has — cannot push it over. A policy can therefore be
   * measured and can never interrupt anyone.
   */
  thresholdPolicy: 0.45,
};

function hasProgressChild(n: CandidateNode): boolean {
  if (n.role === "progressbar" || n.attrs.role === "progressbar") return true;
  if (n.tagName === "PROGRESS") return true;
  return n.hasProgressDescendant;
}

export const goalGradientDetector: Detector = {
  id: "goal_gradient.threshold@1",
  patternId: "goal_gradient.threshold",
  stages: ["cart", "checkout", "pdp"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];
    const seen = new Set<string>();

    for (const n of visibleCandidates(ctx)) {
      const t = n.normalizedText;
      if (t.length === 0 || t.length > 200) continue;
      if (seen.has(n.selectorPath)) continue;

      const remainder = REMAINDER_PATTERNS.some((re) => re.test(t)) ? 1 : 0;
      const threshold = THRESHOLD_COPY.test(t) ? 1 : 0;
      const progress = hasProgressChild(n) ? 1 : 0;
      // Counted, never shown. See THRESHOLD_POLICY.
      const policy = remainder === 0 && THRESHOLD_POLICY.test(t) ? 1 : 0;

      // A policy statement is not a goal gradient — but it is worth recording that the shop
      // set a threshold at all, so it no longer drops out here.
      if (remainder === 0 && policy === 0 && !(threshold === 1 && progress === 1)) continue;

      seen.add(n.selectorPath);
      const prices = parsePrices(n.text);

      out.push(
        candidate(
          goalGradientDetector.id,
          "goal_gradient.threshold",
          n,
          {
            personalisedRemainder: remainder,
            progressBar: progress,
            // A bare policy must not also collect `thresholdCopy`, or the two together
            // reach 0.65 and a third signal would surface it.
            thresholdCopy: policy === 1 ? 0 : threshold,
            thresholdPolicy: policy,
            hasAmount: prices.length > 0 ? 1 : 0,
          },
          WEIGHTS,
          matchLexemes(n, LEXEMES),
        ),
      );
    }

    return out;
  },
};
