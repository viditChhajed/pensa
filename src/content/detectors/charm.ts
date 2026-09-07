/**
 * pricing.charm
 *
 * Lowest-severity detector in the set, and the one most likely to be noise if it surfaces
 * on every page — nearly all retail pricing is charm pricing. It earns its place in the
 * LOG path (prevalence is genuinely interesting) far more than in the surfacing path,
 * which is why its severity weight is 0.20 and it dedupes to one candidate per page.
 */

import { parsePrices } from "@/shared/money";
import type { DetectionCandidate } from "@/shared/schema";
import type { Detector, PageContext } from "../types";
import { candidate, visibleCandidates } from "./util";

const CHARM_FRACTIONS = new Set(["99", "95", "97", "98"]);

const WEIGHTS: Record<string, number> = {
  charmFraction: 0.6,
  superscriptCents: 0.25,
  isPrimaryPrice: 0.2,
};

export const charmDetector: Detector = {
  id: "pricing.charm@1",
  patternId: "pricing.charm",
  stages: ["pdp", "browse"],

  run(ctx: PageContext): DetectionCandidate[] {
    const nodes = visibleCandidates(ctx);

    let best: { node: (typeof nodes)[number]; sub: Record<string, number>; frac: string } | null =
      null;
    let bestArea = -1;

    for (const n of nodes) {
      const prices = parsePrices(n.text);
      if (prices.length === 0) continue;

      for (const p of prices) {
        if (!CHARM_FRACTIONS.has(p.fraction)) continue;

        // Cents rendered smaller than the surrounding text: the left-digit effect made visual.
        const centsChild = n.childIdxs
          .map((i) => ctx.candidates[i])
          .find(
            (c) =>
              c !== undefined &&
              c.style.fontSizePx < n.style.fontSizePx * 0.8 &&
              /^\d{2}$/.test(c.text.trim()),
          );

        const area = n.box.w * n.box.h;
        const sub = {
          charmFraction: 1,
          superscriptCents: centsChild ? 1 : 0,
          // Largest rendered price on the page is almost certainly the item's own price.
          isPrimaryPrice: area > 400 ? 1 : 0,
        };

        if (area > bestArea) {
          bestArea = area;
          best = { node: n, sub, frac: p.fraction };
        }
      }
    }

    if (!best) return [];
    return [
      candidate(charmDetector.id, "pricing.charm", best.node, best.sub, WEIGHTS, [`.${best.frac}`]),
    ];
  },
};
