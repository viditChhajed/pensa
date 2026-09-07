/**
 * decoy.asymmetric_dominance
 *
 * Parse 2-4 sibling plan/SKU cards, extract price and quantity/duration, compute unit price,
 * and flag two distinct things:
 *   1. An option that is weakly dominated — costs more per unit AND gives no more than
 *      another option. Its only job is to make a neighbour look good.
 *   2. A "most popular" / "best value" badge sitting on an option that is NOT the best unit
 *      price. The badge is doing work the arithmetic does not support.
 *
 * The second is the more common and more checkable of the two, and it is stated as what it
 * is: the badge is on the option that costs more per unit. No claim about why.
 */
import { parsePrices } from "@/shared/money";
import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, visibleCandidates } from "./util";

const BADGE =
  /\b(?:most popular|best value|best deal|recommended|most chosen|our pick|popular choice|best seller)\b/;

/** "3 months", "12 pack", "per month", "x2" — the denominator of a unit price. */
const QUANTITY_PATTERNS: readonly RegExp[] = [
  /\b(\d{1,3})\s*(?:months?|mos?)\b/,
  /\b(\d{1,3})\s*(?:years?|yrs?)\b/,
  /\b(\d{1,4})\s*(?:pack|count|ct|pcs|pieces|items|units|bars|cans|bottles|servings|meals)\b/,
  /\bpack of\s*(\d{1,4})\b/,
  /\b(\d{1,4})\s*[x×]\b/,
];

const WEIGHTS: Record<string, number> = {
  badgeOnWorseUnitPrice: 0.65,
  dominatedOption: 0.55,
  threeOrMoreOptions: 0.15,
  unitPriceSpread: 0.15,
};

interface Option {
  node: CandidateNode;
  priceMinor: bigint;
  quantity: number;
  unitPrice: number;
  hasBadge: boolean;
}

function quantityOf(text: string): number | null {
  for (const re of QUANTITY_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (n > 0 && n <= 9999) return n;
    }
  }
  if (/\bper (?:month|mo)\b|\bmonthly\b/.test(text)) return 1;
  if (/\bper (?:year|yr)\b|\bannual(?:ly)?\b/.test(text)) return 12;
  return null;
}

export const decoyDetector: Detector = {
  id: "decoy.asymmetric_dominance@1",
  patternId: "decoy.asymmetric_dominance",
  stages: ["pdp", "browse", "cart"],

  run(ctx: PageContext): DetectionCandidate[] {
    // Sibling cards share a container.
    const byContainer = new Map<string, CandidateNode[]>();
    for (const n of visibleCandidates(ctx)) {
      if (n.containerPath === null) continue;
      const arr = byContainer.get(n.containerPath);
      if (arr) arr.push(n);
      else byContainer.set(n.containerPath, [n]);
    }

    const out: DetectionCandidate[] = [];

    for (const [, siblings] of byContainer) {
      if (siblings.length < 2 || siblings.length > 6) continue;

      const options: Option[] = [];
      for (const n of siblings) {
        const prices = parsePrices(n.text);
        if (prices.length !== 1) continue;
        const qty = quantityOf(n.normalizedText);
        if (qty === null) continue;
        const price = prices[0];
        if (!price || price.amount <= 0n) continue;
        options.push({
          node: n,
          priceMinor: price.amount,
          quantity: qty,
          unitPrice: Number(price.amount) / qty,
          hasBadge: BADGE.test(n.normalizedText),
        });
      }

      if (options.length < 2) continue;

      const best = options.reduce((a, b) => (b.unitPrice < a.unitPrice ? b : a));
      const badged = options.find((o) => o.hasBadge);

      // A badge on an option that is not the best per-unit value.
      const badgeOnWorse = badged !== undefined && badged.unitPrice > best.unitPrice * 1.02 ? 1 : 0;

      // Weak dominance: costs at least as much AND gives no more.
      let dominated = 0;
      for (const a of options) {
        for (const b of options) {
          if (a === b) continue;
          if (a.priceMinor >= b.priceMinor && a.quantity <= b.quantity) {
            if (a.priceMinor > b.priceMinor || a.quantity < b.quantity) dominated = 1;
          }
        }
      }

      if (badgeOnWorse === 0 && dominated === 0) continue;

      const spread =
        best.unitPrice > 0 ? Math.max(...options.map((o) => o.unitPrice)) / best.unitPrice : 1;

      out.push(
        candidate(
          decoyDetector.id,
          "decoy.asymmetric_dominance",
          (badged ?? best).node,
          {
            badgeOnWorseUnitPrice: badgeOnWorse,
            dominatedOption: dominated,
            threeOrMoreOptions: options.length >= 3 ? 1 : 0,
            unitPriceSpread: spread > 1.25 ? 1 : 0,
          },
          WEIGHTS,
          badged ? [badged.node.normalizedText.slice(0, 48)] : [],
        ),
      );
    }

    return out;
  },
};
