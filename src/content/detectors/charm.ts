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

    // Only nodes where the price IS the content, not nodes that merely contain one.
    //
    // Ranking every priced node by rendered area picked the biggest box on the page, which
    // on a grid is a container whose text is every child run together. Observed on shein:
    // the match was logged as "Customers Also Viewed 10 #KnitEssentials -15% SHEIN PETITE
    // Balle" — a blob with no price in the visible sample at all; the charm price was
    // further along in text that the log truncated. The evidence was meaningless, and a
    // shopper shown that would have no idea what the extension was pointing at.
    //
    // Two guards, because either alone leaks. A price node's text is short — that rejects
    // blobs. And no candidate deeper in the subtree may carry the same price — that rejects
    // a tight wrapper around a real price node, which is short enough to pass the first.
    const MAX_PRICE_TEXT = 60;

    interface Priced {
      node: (typeof nodes)[number];
      sub: Record<string, number>;
      frac: string;
      amount: bigint;
    }

    const priced: Priced[] = [];
    for (const n of nodes) {
      if (n.text.length > MAX_PRICE_TEXT) continue;
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

        priced.push({
          node: n,
          frac: p.fraction,
          amount: p.amount,
          sub: {
            charmFraction: 1,
            superscriptCents: centsChild ? 1 : 0,
            // Filled in below, once wrappers are out of the running.
            isPrimaryPrice: 0,
          },
        });
      }
    }

    const isWrapperOf = (outer: Priced, inner: Priced): boolean =>
      inner.node.selectorPath.length > outer.node.selectorPath.length &&
      inner.node.selectorPath.startsWith(`${outer.node.selectorPath}>`) &&
      inner.amount === outer.amount;

    const leaves = priced.filter((a) => !priced.some((b) => isWrapperOf(a, b)));

    let best: Priced | null = null;
    let bestArea = -1;
    for (const p of leaves) {
      const area = p.node.box.w * p.node.box.h;
      if (area > bestArea) {
        bestArea = area;
        best = p;
      }
    }
    // The largest rendered price among real price nodes is the item's own price.
    if (best && bestArea > 400) best.sub.isPrimaryPrice = 1;

    if (!best) return [];
    return [
      candidate(charmDetector.id, "pricing.charm", best.node, best.sub, WEIGHTS, [`.${best.frac}`]),
    ];
  },
};
