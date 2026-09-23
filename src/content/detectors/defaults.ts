/**
 * defaults.preselected
 *
 * A checked checkbox is only interesting if what it opts you INTO costs something,
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

/**
 * Word-bounded lexeme test. These used to be substring matches, so "tip" matched "mul-TIP-le"
 * and a pre-ticked "Ship to multiple addresses" box read as a pre-ticked tip.
 */
const COSTLY_RES = COSTLY_LEXEMES.map(
  (l) => [l, new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)] as const,
);

/** One option's price, read from its own row. Null if absent or ambiguous. */
function optionPrice(n: CandidateNode): bigint | null {
  for (const scope of [n.rowText, n.containerText]) {
    if (!scope || scope.length > 160) continue;
    const prices = parsePrices(scope);
    if (prices.length === 1) return (prices[0] as { amount: bigint }).amount;
    if (prices.length === 0 && /\bfree\b/i.test(scope)) return 0n;
  }
  return null;
}

/**
 * Is this checked radio dearer than the cheapest option in its own group?
 *
 * The signal was called `nonCheapestRadio` and scored every checked radio near a cost word,
 * without looking at a single price, so a default "Standard shipping" radio whose container
 * also mentioned "Express shipping" was reported as a costly preselection. This compares the
 * group's prices and returns false whenever they cannot be read unambiguously, because
 * "we could not tell" must not become "it was the expensive one".
 */
function isNonCheapestInGroup(n: CandidateNode, ctx: PageContext): boolean {
  const name = n.attrs.name;
  if (!name) return false;
  const mine = optionPrice(n);
  if (mine === null) return false;
  let cheapest: bigint | null = null;
  let siblings = 0;
  for (const c of ctx.candidates) {
    if (c.tagName !== "INPUT" || c.attrs.type !== "radio" || c.attrs.name !== name) continue;
    siblings++;
    const p = optionPrice(c);
    if (p === null) continue;
    if (cheapest === null || p < cheapest) cheapest = p;
  }
  return siblings >= 2 && cheapest !== null && mine > cheapest;
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
      // The shopper set this one. Whatever it says, it was not chosen for them.
      if (n.attrs.userTouched === "true") continue;
      if (isRadio && !isNonCheapestInGroup(n, ctx)) continue;

      // The control itself almost never holds its own label, a <label> wrapper carries no
      // qualifying text so it is not a candidate, which is what `containerText` is for.
      const context =
        `${n.accessibleName} ${n.attrs["aria-label"] ?? ""} ${n.attrs.name ?? ""} ${n.containerText}`
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      if (BENIGN.some((b) => context.includes(b))) continue;

      const hits = COSTLY_RES.filter(([, re]) => re.test(context)).map(([l]) => l);
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
