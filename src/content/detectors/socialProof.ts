/**
 * social_proof.live_activity
 *
 * Two distinct shapes, scored separately:
 *   1. Counter copy — "47 people are viewing this", "12 sold in the last 24 hours".
 *   2. Ephemeral toasts — a node injected and removed again within 15s, containing a place
 *      name plus a purchase verb ("Sarah in Denver just bought this").
 *
 * The toast case is why `CandidateNode.ephemeral` exists. A single frozen DOM snapshot
 * cannot distinguish a toast from a static banner; the insert/remove timing is the signal.
 *
 * Precision risk: genuine review counts ("1,203 reviews") and genuine stock-sold figures on
 * marketplaces. Requiring a present-tense activity verb or an explicit recency window keeps
 * those out — "1,203 reviews" has neither.
 */
import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, matchLexemes, visibleCandidates } from "./util";

/** Present-tense activity, or an explicit recency window. */
const COUNTER_PATTERNS: readonly RegExp[] = [
  /\b(\d{1,4})\s*(?:other\s+)?(?:people|shoppers|customers|users|others)\s+(?:are\s+)?(?:viewing|looking at|watching|browsing)\b/,
  /\bviewing (?:this )?(?:right )?now\b/,
  /\b(\d{1,4})\s+(?:sold|bought|purchased|ordered)\s+in the (?:last|past)\s+\d+\s*(?:hour|hours|day|days|minute|minutes)\b/,
  /\b(\d{1,4})\s+(?:in|added to)\s+(?:\d+\s+)?(?:carts|baskets|bags)\b/,
  /\b(\d{1,4})\s+people (?:have )?(?:booked|reserved)\b/,
  /**
   * From the labelled corpus. "447 people have purchased this in the last 3 hours!" scored
   * zero: the verb list above covers booked and reserved but not purchased or bought, and
   * the count-plus-timeframe pattern requires the number to sit directly before the verb.
   */
  /\b(\d{1,4})\s+(?:people|shoppers|customers|others)\s+(?:have\s+)?(?:bought|purchased|ordered|grabbed|claimed)\b/,
  /**
   * "LIVE • 279" — a bare viewer count on a live-shopping card, with no verb and no noun.
   * Requires the LIVE marker: a naked number is not a claim about anybody.
   */
  /\blive\b[^a-z0-9]{0,4}(\d{2,6})\b/i,
  /\bbooked\s+\d+\s+times? in (?:the )?last\b/,
  /**
   * Past tense, and a recency window without the definite article. All three scored zero:
   *
   *   "181 people have viewed this in the last 3 hours"  — the rule wanted "are viewing"
   *   "Booked 22 times in last 24 hr"                    — the rule wanted "in THE last"
   *   "31 sold today"                                    — no rule covered a bare day window
   *
   * A definite article is not a mechanism, and neither is a tense.
   */
  /\b(\d{1,5})\s+(?:other\s+)?(?:people|shoppers|customers|users|others)\s+(?:have\s+)?(?:viewed|looked at|watched|browsed)\b/,
  /\b(\d{1,5})\s+(?:sold|bought|purchased|booked|ordered)\s+(?:today|this (?:hour|week)|in the past)\b/,
  /**
   * "People want this." — eBay's badge, with no number at all.
   *
   * Kept narrow deliberately: this exact claim about other shoppers' desire, not a general
   * rule about the word "people", which appears in half the copy on the web.
   */
  /\bpeople want this\b/,
  /\bin high demand\b/,
  /\b(\d{1,4})\s+others? (?:are )?(?:looking|interested)\b/,
];

/** "Sarah in Denver just bought this" — the classic injected toast. */
const TOAST_PATTERN =
  /\b(?:just|recently)\s+(?:bought|purchased|ordered|booked|signed up|joined|claimed)\b|\bsomeone (?:in|from)\s+[a-z]/;

const PLACE_HINT = /\b(?:in|from)\s+[A-Z][a-z]+(?:[ ,][A-Z][a-z]+)?/;

const LEXEMES = [
  "viewing",
  "people",
  "shoppers",
  "sold",
  "in carts",
  "just bought",
  "just purchased",
  "in high demand",
  "others",
] as const;

/** Review counts and totals are legitimate reporting, not manufactured activity. */
const EXCLUSIONS: readonly RegExp[] = [
  /\b\d[\d,]*\s+(?:reviews?|ratings?|questions?|answers?)\b/,
  /\b\d[\d,]*\s+(?:items?|products?|results?)\s+(?:found|available|match)/,
  /\bout of \d+ stars?\b/,
];

const WEIGHTS: Record<string, number> = {
  counterCopy: 0.55,
  ephemeralToast: 0.6,
  placeName: 0.15,
  recencyWindow: 0.2,
  shortText: 0.1,
};

function isToast(n: CandidateNode): boolean {
  // Inserted then removed inside the ephemeral window, or still present but short-lived.
  return n.ephemeral || (n.insertedAt !== null && n.removedAt !== null);
}

export const socialProofDetector: Detector = {
  id: "social_proof.live_activity@1",
  patternId: "social_proof.live_activity",
  stages: ["pdp", "browse", "cart", "checkout"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];
    const seen = new Set<string>();

    for (const n of visibleCandidates(ctx)) {
      const t = n.normalizedText;
      if (t.length === 0 || t.length > 180) continue;
      if (EXCLUSIONS.some((re) => re.test(t))) continue;
      if (seen.has(n.selectorPath)) continue;

      const counter = COUNTER_PATTERNS.some((re) => re.test(t)) ? 1 : 0;
      const toastCopy = TOAST_PATTERN.test(t);
      const toast = toastCopy && isToast(n) ? 1 : 0;

      if (counter === 0 && toast === 0) continue;
      seen.add(n.selectorPath);

      out.push(
        candidate(
          socialProofDetector.id,
          "social_proof.live_activity",
          n,
          {
            counterCopy: counter,
            ephemeralToast: toast,
            placeName: PLACE_HINT.test(n.text) ? 1 : 0,
            recencyWindow: /\bin the (?:last|past)\b|\bright now\b|\btoday\b/.test(t) ? 1 : 0,
            shortText: t.length < 80 ? 1 : 0,
          },
          WEIGHTS,
          matchLexemes(n, LEXEMES),
        ),
      );
    }

    return out;
  },
};
