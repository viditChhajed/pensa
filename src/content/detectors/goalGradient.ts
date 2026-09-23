/**
 * goal_gradient.threshold
 *
 * "You're $12 away from free shipping" plus a progress bar. The mechanism is that effort
 * toward a goal rises as the goal appears closer, so a near-miss threshold pulls spend up.
 *
 * Precision note: a bare "Free shipping over $50" is a policy statement, not a goal gradient
 *, there is no progress and no personalised remainder. The detector requires either an
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
// in "$20.00", which silently broke every pattern here on realistic copy.
/**
 * What sits between "only"/"you're" and "away"/"to go" must be an AMOUNT: money, or a count of
 * items. It used to be any 16 characters (`.{0,16}?`), which matched "only available in more
 * colours" and, on every hotel page, "just 5 minutes away from the beach".
 */
const AMOUNT =
  "(?:[$£€¥₹]\\s?[\\d.,]*\\d|\\d[\\d.,]*\\s?(?:[$£€]|usd|eur|gbp|cad|aud)|\\d{1,3}\\s+(?:more\\s+)?(?:items?|products?|pieces?|units?))";
const r = (source: string): RegExp => new RegExp(source.replaceAll("AMOUNT", AMOUNT));

const REMAINDER_PATTERNS: readonly RegExp[] = [
  r("\\byou'?re\\s+(?:only\\s+|just\\s+)?AMOUNT\\s+(?:more\\s+)?away\\b"),
  r("\\byou are\\s+(?:only\\s+|just\\s+)?AMOUNT\\s+(?:more\\s+)?away\\b"),
  r("\\b(?:only|just)\\s+AMOUNT\\s+(?:more\\s+)?(?:away|to go|until|till)\\b"),
  r(
    "\\badd\\s+(?:another\\s+)?AMOUNT\\s+(?:more\\s+)?to (?:get|unlock|qualify|receive|(?:your\\s+)?(?:cart|bag|basket))\\b",
  ),
  // "Only $12 more and shipping's on us", a remainder needs no destination word once it names an amount.
  r("\\b(?:only|just|another)\\s+AMOUNT\\s+more\\b"),
  r("\\bspend\\s+(?:another\\s+)?AMOUNT\\s+(?:more\\s+)?to (?:get|unlock|qualify)\\b"),
  r("(?:^|[^\\w.,])AMOUNT\\s+(?:more\\s+)?away from (?:free|a free|your)\\b"),
  r("(?:^|[^\\w.,])AMOUNT\\s+(?:more\\s+)?(?:until|till|to reach|to hit)\\s+(?:free|your)\\b"),
  r("(?:^|[^\\w.,])AMOUNT\\s*(?:more\\s+)?to go\\b"),
  r("(?:^|[^\\w.,])AMOUNT\\s*(?:more\\s+)?(?:and|for)\\s+(?:you\\s+)?(?:get|unlock|qualify)\\b"),
  // "Almost there" only counts beside the reward it is almost at.
  /\balmost there\b.{0,40}\bfree (?:shipping|delivery)\b|\bfree (?:shipping|delivery)\b.{0,40}\balmost there\b/,
];

/** Threshold copy without a personalised remainder, needs a progress bar to count. */
const THRESHOLD_COPY =
  /\bfree (?:shipping|delivery)\b|\bunlock (?:free|a )\b|\bqualif(?:y|ies) for\b|\bto reach\b/;

/**
 * A spend threshold stated as a policy, in any of the shapes shops actually use.
 *
 * The first version of this matched "free shipping on orders over $50" and essentially
 * nothing else. Measured against 2,639 real snippets it found 3 of 72 threshold messages,
 * recall 0.04. The corpus showed why: the copy comes in at least five families, and the
 * regex covered one of them.
 *
 *   free shipping on orders $40+ / over $35 / ¥990 or more / 480kr or more / $60 CAD+
 *   free with $45 min. spend / complimentary with $45+ spend / with any $50 online purchase
 *   $15 off on $109 / $15 off your first order of $35 / $70 OFF orders $499+
 *   spend $49+, get $25 eGift card / for every $50 spent / earn a $30 card when you spend $50+
 *   save when you buy 3 / BOGO 25% off / buy one, get one free / buy 3, get 4th free
 *
 * So it is built from parts rather than as a list of sentences: an AMOUNT, a THRESHOLD
 * preposition, and a REWARD. That composes across currencies and word orders, which a
 * sentence list never will, nine of the misses were the same Uniqlo sentence in nine
 * currencies.
 */

/** Amounts in the currencies the corpus actually contains, prefix and suffix forms. */
const MONEY_ISH =
  /(?:[$£€¥₹₪₩]|R\$|MX\$|A\$|C\$|NZ\$)\s?[\d.,]+|[\d.,]+\s?(?:kr|€|₩|zł|Kč)\b|[\d.,]+\s?(?:usd|cad|aud|nzd|eur|gbp|sek|dkk|nok)\b/i;

/**
 * The word that turns an amount into a bar you have to clear.
 *
 * `with` was originally optional-qualified, `with (?:any|select|your)?`, which made a bare
 * "with" a threshold. Boohoo's product cards end "Extra 15% Off, With Code: 15EXTRA", so
 * every one of them qualified: money, a reward ("off"), and "with". That single `?` was 40
 * of 54 false positives and dropped precision from 1.00 to 0.49. `with` now has to be
 * followed by something that makes it a condition.
 */
const THRESHOLD_PREP =
  /\b(?:over|above|or more|minimum|min\.?\s*(?:spend|purchase|order)|when you spend|spend|purchase of|first order of|on orders?|orders? (?:over|above)|for every|qualifying)\b|\bwith\s+(?:any|select|your|min\.?)\b|\b[\d.,]+\+/i;

/** What clearing it gets you. Without this, any two prices in a sentence would qualify. */
const REWARD =
  /\bfree\b|\bcomplimentary\b|\bgift\b|\b\d+%?\s*off\b|\boff\b|\bsample|\begift\b|\bvoucher\b|\bpromo card\b|\breward|\bdelivery\b|\bshipping\b|\bcash\b/i;

/**
 * Quantity thresholds, "buy 3, get the 4th free", "BOGO 25% off", are DELIBERATELY not
 * matched, and that is a change of mind rather than an oversight.
 *
 * The mechanism is arguably the same: a bar that pulls the basket upward, in units instead
 * of money. But the labelling disagreed with ITSELF about them, one pass recorded BOGO as a
 * spend threshold, another recorded it as a separate technique, and a detector should not
 * encode a judgement the labelling could not reach consensus on. Encoding it cost precision
 * and the evidence for it was split.
 *
 * Worth revisiting with labels that agree. Until then the honest position is that this is an
 * open question, not a rule.
 */

function looksLikeAListingBlob(text: string): boolean {
  const prices = text.match(new RegExp(MONEY_ISH.source, "gi"))?.length ?? 0;
  if (prices < 2) return false;
  return !/\b(?:you|your|spend|orders?|minimum|min\.)\b/i.test(text);
}

/**
 * The threshold MET, not just offered: "Success! Free Shipping Unlocked".
 *
 * Reported from the corpus and scored zero, because every rule here needs an amount and the
 * completion message has none, the number has served its purpose and been dropped. It is
 * still the same mechanism, and arguably the most interesting moment of it: the goal
 * gradient paid off, which is what makes the next threshold work.
 */
const THRESHOLD_MET =
  /\bfree (?:shipping|delivery)\s+unlocked\b|\bunlocked\s+free (?:shipping|delivery)\b|\byou(?:'ve| have)\s+(?:earned|unlocked|qualified for)\b/i;

function looksLikeAPolicy(text: string): boolean {
  if (looksLikeAListingBlob(text)) return false;
  if (THRESHOLD_MET.test(text)) return true;
  if (!MONEY_ISH.test(text)) return false;
  if (!REWARD.test(text)) return false;
  return THRESHOLD_PREP.test(text);
}

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
   * `hasAmount`, which a policy always has, cannot push it over. A policy can therefore be
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
      const policy = remainder === 0 && looksLikeAPolicy(t) ? 1 : 0;

      // A policy statement is not a goal gradient, but it is worth recording that the shop
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
