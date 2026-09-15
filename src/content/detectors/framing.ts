/**
 * framing.savings_ratio — the "Rule of 100".
 *
 * The same discount reads as larger when expressed as a percentage on a cheap item and as an
 * absolute amount on an expensive one. When a page shows a was-price, a now-price AND a
 * savings claim, both framings are computable, so the asymmetry is arithmetic rather than
 * interpretation.
 *
 * Fires only when the chosen framing is the one that looks bigger by a clear margin, so a
 * page that simply states "$5 off" on a $20 item is not flagged.
 */
import { parsePrices } from "@/shared/money";
import type { DetectionCandidate } from "@/shared/schema";
import type { Detector, PageContext } from "../types";
import { candidate, visibleCandidates } from "./util";

const PERCENT_CLAIM = /\b(\d{1,2})\s*%\s*(?:off|discount|savings?|less)\b/;
const ABSOLUTE_CLAIM = /\b(?:save|you save|off)\b/;

const WEIGHTS: Record<string, number> = {
  percentFramingFlatters: 0.5,
  absoluteFramingFlatters: 0.5,
  bothPricesPresent: 0.25,
  largeGap: 0.2,
};

/** How much bigger the chosen framing's number has to read before it counts. */
const FLATTER_FACTOR = 2;

export const framingDetector: Detector = {
  id: "framing.savings_ratio@1",
  patternId: "framing.savings_ratio",
  stages: ["pdp", "browse", "cart"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];
    const seen = new Set<string>();

    /**
     * One claim per CONTAINER, quoting the container.
     *
     * This scores `containerText` but used to attribute to — and quote — the node's own
     * text. On a Zappos product grid that meant one real was/now price pair produced five
     * separate firings, evidenced as "370", "237v1", "WL574V2", "603" and "V5 Runner": New
     * Balance model numbers, which is what the sibling spans inside the tile happen to
     * contain.
     *
     * Both halves were wrong. The claim was counted five times, and the card would have
     * quoted a model number as its evidence — the same riddle the scarcity fallback was
     * fixed for: name the pattern, show something unrelated, ask the reader to trust you.
     */
    const claimedContainers = new Set<string>();

    for (const n of visibleCandidates(ctx)) {
      const t = n.containerText || n.normalizedText;
      if (t.length === 0 || t.length > 240) continue;
      if (seen.has(n.selectorPath)) continue;

      const container = n.containerPath;
      if (n.containerText.length > 0) {
        if (container === null || claimedContainers.has(container)) continue;
      }

      const prices = parsePrices(t);
      if (prices.length < 2) continue;

      const high = prices.reduce((a, b) => (b.amount > a.amount ? b : a));
      const low = prices.reduce((a, b) => (b.amount < a.amount ? b : a));
      if (high.amount <= low.amount) continue;

      const absoluteSaving = Number(high.amount - low.amount) / 100;
      const percentSaving = (Number(high.amount - low.amount) / Number(high.amount)) * 100;
      if (absoluteSaving <= 0 || percentSaving <= 0) continue;

      const showsPercent = PERCENT_CLAIM.test(t);
      const showsAbsolute = ABSOLUTE_CLAIM.test(t) && !showsPercent;
      if (!showsPercent && !showsAbsolute) continue;

      // The Rule of 100: below $100, the percentage reads larger; above, the dollar amount does.
      const percentFlatters = percentSaving > absoluteSaving * FLATTER_FACTOR;
      const absoluteFlatters = absoluteSaving > percentSaving * FLATTER_FACTOR;

      const percentChosenAndFlatters = showsPercent && percentFlatters ? 1 : 0;
      const absoluteChosenAndFlatters = showsAbsolute && absoluteFlatters ? 1 : 0;
      if (percentChosenAndFlatters === 0 && absoluteChosenAndFlatters === 0) continue;

      seen.add(n.selectorPath);
      if (n.containerText.length > 0 && container !== null) claimedContainers.add(container);

      out.push(
        candidate(
          framingDetector.id,
          "framing.savings_ratio",
          n,
          {
            percentFramingFlatters: percentChosenAndFlatters,
            absoluteFramingFlatters: absoluteChosenAndFlatters,
            bothPricesPresent: 1,
            largeGap:
              Math.max(percentSaving, absoluteSaving) /
                Math.max(1, Math.min(percentSaving, absoluteSaving)) >
              4
                ? 1
                : 0,
          },
          WEIGHTS,
          [showsPercent ? "percent-framing" : "absolute-framing"],
          // Quote what was SCORED — the container — not the span it happened to attach to.
          n.containerText.length > 0 ? n.containerText : undefined,
        ),
      );
    }

    return out;
  },
};
