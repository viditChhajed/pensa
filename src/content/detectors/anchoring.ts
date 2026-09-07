/**
 * anchoring.reference_price
 *
 * Signals: two price-shaped strings sharing an ancestor, one struck through (via
 * `text-decoration: line-through` or a <del>/<s> ancestor), plus reference-price lexemes
 * and/or a percent-off badge.
 *
 * Pairing is done by walking UP from each struck price to the nearest ancestor that also
 * contains a live price, bounded to a few levels. A single shared parent is not enough in
 * practice: `<span class="was">Was <s>$120</s></span><span>$79</span>` puts the two prices
 * under different immediate containers, and that markup is everywhere.
 *
 * The bound matters in the other direction too. Widening the search indefinitely would pair
 * prices from unrelated products in a grid, so the walk stops at 3 levels.
 */

import { type ParsedPrice, parsePrices } from "@/shared/money";
import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, visibleCandidates } from "./util";

const LEXEMES = [
  "was",
  "msrp",
  "compare at",
  "compare to",
  "list price",
  "orig.",
  "originally",
  "reg.",
  "regular price",
  "you save",
  "retail price",
] as const;

const WEIGHTS: Record<string, number> = {
  struckPrice: 0.45,
  twoPrices: 0.2,
  lexeme: 0.2,
  percentBadge: 0.15,
  struckIsHigher: 0.15,
};

/** How many ancestor levels to search for the matching live price. */
const MAX_PAIR_DISTANCE = 3;

function isStruck(n: CandidateNode): boolean {
  if (n.tagName === "DEL" || n.tagName === "S" || n.tagName === "STRIKE") return true;
  return n.style.textDecorationLine.includes("line-through");
}

function segments(path: string): string[] {
  return path.split(">");
}

/** Is `path` inside the subtree rooted at `ancestor`? Compares whole segments, not strings. */
function isDescendant(path: string, ancestor: string[]): boolean {
  const segs = segments(path);
  if (segs.length < ancestor.length) return false;
  for (let i = 0; i < ancestor.length; i++) {
    if (segs[i] !== ancestor[i]) return false;
  }
  return true;
}

interface Priced {
  node: CandidateNode;
  prices: ParsedPrice[];
}

export const anchoringDetector: Detector = {
  id: "anchoring.reference_price@1",
  patternId: "anchoring.reference_price",
  stages: ["pdp", "browse", "cart"],

  run(ctx: PageContext): DetectionCandidate[] {
    const priced: Priced[] = [];
    for (const n of visibleCandidates(ctx)) {
      const prices = parsePrices(n.text);
      if (prices.length > 0) priced.push({ node: n, prices });
    }

    const struckNodes = priced.filter((p) => isStruck(p.node));
    const liveNodes = priced.filter((p) => !isStruck(p.node));
    if (struckNodes.length === 0 || liveNodes.length === 0) return [];

    const out: DetectionCandidate[] = [];
    const seen = new Set<string>();

    for (const struck of struckNodes) {
      if (seen.has(struck.node.selectorPath)) continue;

      const segs = segments(struck.node.selectorPath);
      let paired: Priced[] | null = null;
      let scopeText = "";

      // Walk up: immediate container first, then outward, so the tightest pairing wins.
      for (let up = 1; up <= MAX_PAIR_DISTANCE && segs.length - up > 0; up++) {
        const ancestor = segs.slice(0, segs.length - up);
        const inScope = liveNodes.filter(
          (l) =>
            isDescendant(l.node.selectorPath, ancestor) &&
            // An ancestor of the struck node re-reports the struck price as its own text
            // (`<span>Was <s>$120</s></span>`), which would pair $120 against itself.
            !isDescendant(struck.node.selectorPath, segments(l.node.selectorPath)),
        );
        if (inScope.length > 0) {
          paired = inScope;
          // Nearest candidate whose subtree covers the ancestor, for lexeme context.
          const ancestorPath = ancestor.join(">");
          scopeText =
            ctx.candidates.find((c) => c.selectorPath === ancestorPath)?.normalizedText ??
            struck.node.containerText;
          break;
        }
      }

      if (!paired) continue;

      const anchor = struck.prices.reduce((a, b) => (b.amount > a.amount ? b : a));
      const current = paired
        .flatMap((p) => p.prices)
        .reduce((a, b) => (b.amount < a.amount ? b : a));

      // A struck price below the live price is a rendering artifact, not an anchor.
      if (anchor.amount <= current.amount) continue;

      seen.add(struck.node.selectorPath);

      const context = `${scopeText} ${struck.node.containerText} ${struck.node.normalizedText}`;
      const lexemeHits = LEXEMES.filter((l) => context.includes(l));
      const percentBadge = /\b\d{1,2}%\s*off\b|\b-\s?\d{1,2}%/.test(context);

      out.push(
        candidate(
          anchoringDetector.id,
          "anchoring.reference_price",
          struck.node,
          {
            struckPrice: 1,
            twoPrices: 1,
            lexeme: lexemeHits.length > 0 ? 1 : 0,
            percentBadge: percentBadge ? 1 : 0,
            struckIsHigher: 1,
          },
          WEIGHTS,
          [...lexemeHits],
        ),
      );
    }

    return out;
  },
};
