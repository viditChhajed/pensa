/**
 * defaults.preselected
 *
 * A checked checkbox is only interesting if what it opts you INTO costs something —
 * money, data, or mail. A preselected "remember me" or "I am over 18" is not the default
 * effect this taxonomy entry describes, and firing on those would be noise.
 *
 * Also covers the preselected non-cheapest radio in a plan group, which is the same
 * mechanism wearing different markup.
 */

import { parsePrices } from "@/shared/money";
import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, visibleCandidates } from "./util";

const COSTLY_LEXEMES = [
  "warranty",
  "protection plan",
  "protection",
  "insurance",
  "coverage",
  "accident",
  "donate",
  "donation",
  "round up",
  "tip",
  "gratuity",
  "newsletter",
  "marketing",
  "promotional",
  "special offers",
  "subscribe",
  "updates",
  "expedited",
  "express shipping",
  "priority shipping",
  "faster delivery",
  "shipping upgrade",
  "membership",
  "auto-renew",
  "auto renew",
  "subscription",
  "recurring",
  "gift wrap",
  "gift wrapping",
  "carbon offset",
  "signature confirmation",
] as const;

/** Preselected because the site needs it, not because it profits from it. */
const BENIGN = [
  "remember me",
  "keep me signed in",
  "i am over",
  "i agree to the terms",
  "save my information for next time",
  "accept cookies",
] as const;

const WEIGHTS: Record<string, number> = {
  checkedAndCostly: 0.6,
  hasPrice: 0.25,
  nonCheapestRadio: 0.5,
  paymentStage: 0.15,
};

function isChecked(n: CandidateNode): boolean {
  return n.attrs.checked === "true" || n.attrs.checked === "" || n.attrs["aria-checked"] === "true";
}

export const defaultsDetector: Detector = {
  id: "defaults.preselected@1",
  patternId: "defaults.preselected",
  stages: ["pdp", "cart", "checkout", "payment"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];
    const stageBonus = ctx.funnelStage === "payment" || ctx.funnelStage === "checkout" ? 1 : 0;

    for (const n of visibleCandidates(ctx)) {
      const isCheckbox = n.tagName === "INPUT" && n.attrs.type === "checkbox";
      const isRadio = n.tagName === "INPUT" && n.attrs.type === "radio";
      if (!isCheckbox && !isRadio) continue;
      if (!isChecked(n)) continue;

      // The control itself almost never holds its own label — a <label> wrapper carries no
      // qualifying text so it is not a candidate, which is what `containerText` is for.
      const context =
        `${n.accessibleName} ${n.attrs["aria-label"] ?? ""} ${n.attrs.name ?? ""} ${n.containerText}`
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      if (BENIGN.some((b) => context.includes(b))) continue;

      const hits = COSTLY_LEXEMES.filter((l) => context.includes(l));
      if (hits.length === 0) continue;

      const prices = parsePrices(n.containerText || n.text);

      out.push(
        candidate(
          defaultsDetector.id,
          "defaults.preselected",
          n,
          {
            checkedAndCostly: isCheckbox ? 1 : 0,
            nonCheapestRadio: isRadio ? 1 : 0,
            hasPrice: prices.length > 0 ? 1 : 0,
            paymentStage: stageBonus,
          },
          WEIGHTS,
          [...hits],
        ),
      );
    }

    return out;
  },
};
