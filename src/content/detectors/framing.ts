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
 *
 * WHAT THIS DETECTOR HAS NOT EARNED YET. The live audit of 22 retailers produced nineteen
 * firings and every one of them was wrong — four more than the adjudication counted, because
 * three of the four it passed are wrong for reasons the quoted text does not show (see
 * tests/unit/framingPrecision.test.ts, which writes the arithmetic out). After the evidence
 * gate below, those nineteen become zero. That is a precision fix and nothing else: it does
 * not demonstrate that the detector fires on a real Rule-of-100 page, because the audit
 * contains no case where it did. The unit tests show it still fires on the textbook shapes,
 * and the next spot:check is the only thing that can turn that into field evidence. Anyone
 * reading a quiet field report should read it as "unproven", not "working".
 */
import { parsePrices } from "@/shared/money";
import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, visibleCandidates } from "./util";

/**
 * A claim has to name its own number.
 *
 * `ABSOLUTE_CLAIM` used to be `/\b(?:save|you save|off)\b/`, and the audit of 22 retailers
 * showed what a bare `\boff\b` costs: every Zappos colourway called "Off White" satisfied it,
 * and so did any grid tile with a "% off" badge belonging to some other product in the same
 * row. Eight of the fifteen wrong firings were literally a colour name.
 *
 * So both claim forms now require the figure the shopper is being shown: "$40 off",
 * "save $40", "you save $40", "40% off", "save 40%". A word on its own is not a claim.
 *
 * PERCENT_CLAIM deliberately has no leading `\b`. Sites concatenate price and badge into one
 * text node with no separator — SHEIN renders "$12.99flash sale$3.6010% off" — and a leading
 * boundary fails on the "0" of "$3.60". The trailing `\b` is kept and is load-bearing: it is
 * what stops "74% offprettygarden" (two products glued together) from reading as a badge.
 */
const PERCENT_CLAIM = /(\d{1,2})\s*%\s*(?:off|discount|savings?|less)\b|\bsave\s*(\d{1,2})\s*%/;
const ABSOLUTE_CLAIM =
  /\b(?:you\s+)?save\s+(?:up\s+to\s+)?[$£€¥₹]\s?\d|[$£€¥₹]\s?[\d.,]*\d\s*(?:off|discount)\b/;

/** Reference-price lexemes, in the sense anchoring.ts uses them. Kept in sync by hand. */
const REFERENCE_LEXEME =
  /(?:was|msrp|reg\.?|regular price|orig\.?|originally|list price|compare at|compare to|retail price)\s*:?\s*$/;

/**
 * Words that may legitimately sit BETWEEN a was-price and a now-price.
 *
 * Anything else between them means they are two different products' prices, which is the
 * whole failure this detector was firing on. Kept to markdown vocabulary; a brand or a model
 * number must survive the scrub so the pair is rejected.
 */
const MARKDOWN_WORDS =
  /\b(?:now|was|then|sale|flash|deal|price|prices|save|saves|saving|savings|off|you|up|to|from|msrp|reg|orig|originally|list|retail|compare|at|our|your|today|only|member|extra|coupon|clearance)\b/g;

/** Beyond this many characters apart, two prices are not a was/now pair, whatever sits between. */
const MAX_PAIR_GAP = 32;

/**
 * A price that is the SAVING, not the now-price.
 *
 * Caught in review of the first draft of this fix, and it is the same error in a new place:
 * "$1,699.99 save $200" has two price-shaped strings and the pair rule happily read them as
 * was $1,699.99 / now $200, a 88% discount that nobody offered. The claim's own figure has to
 * be excluded from the pair before the pair means anything.
 */
const CLAIM_AMOUNT_BEFORE = /(?:\b(?:you\s+)?saves?\b|\bsaving\b|\bup\s+to\b|\bextra\b)\s*$/;
const CLAIM_AMOUNT_AFTER = /^\s*(?:off|discount)\b/;

const WEIGHTS: Record<string, number> = {
  percentFramingFlatters: 0.5,
  absoluteFramingFlatters: 0.5,
  bothPricesPresent: 0.25,
  largeGap: 0.2,
  referencePrice: 0.15,
};

/** How much bigger the chosen framing's number has to read before it counts. */
const FLATTER_FACTOR = 2;

/**
 * Struck-through, in anchoring.ts's sense.
 *
 * Duplicated rather than imported because anchoring.ts does not export it and this change is
 * scoped to framing. If a third detector ever needs it, it belongs in util.ts — say so then
 * rather than making a third copy.
 */
function isStruck(n: CandidateNode): boolean {
  if (n.tagName === "DEL" || n.tagName === "S" || n.tagName === "STRIKE") return true;
  return n.style.textDecorationLine.includes("line-through");
}

/** Is the text between two prices nothing but markdown chrome? */
function readsAsMarkdown(between: string): boolean {
  if (between.length > MAX_PAIR_GAP) return false;
  return (
    between
      .toLowerCase()
      .replace(/\d{1,3}\s*%/g, " ")
      .replace(MARKDOWN_WORDS, " ")
      .replace(/[^a-z]/g, "").length === 0
  );
}

interface Pair {
  high: bigint;
  low: bigint;
  /** Character offset of the reference price, for the lexeme lookbehind. */
  highStart: number;
}

/**
 * The was/now pair, or null.
 *
 * Two prices co-occurring in a container is NOT a savings claim, and the old code's
 * `max(prices)` / `min(prices)` treated it as one. In a product grid the max and the min
 * belong to two different products, so it computed a "discount" between a $245 Hoka and an
 * $89.95 New Balance and then reported the arithmetic with a straight face.
 *
 * What makes two prices a pair is that they are written as one: adjacent in reading order,
 * higher first, with nothing between them but markdown chrome. A product title between them
 * is the tell that they are not a pair.
 */
function referencePair(text: string): Pair | null {
  const prices = parsePrices(text).filter(
    (p) =>
      !CLAIM_AMOUNT_BEFORE.test(text.slice(Math.max(0, p.start - 12), p.start)) &&
      !CLAIM_AMOUNT_AFTER.test(text.slice(p.end, p.end + 12)),
  );
  for (let i = 0; i + 1 < prices.length; i++) {
    const a = prices[i];
    const b = prices[i + 1];
    if (!a || !b) continue;
    if (a.amount <= b.amount) continue;
    if (!readsAsMarkdown(text.slice(a.end, b.start))) continue;
    return { high: a.amount, low: b.amount, highStart: a.start };
  }
  return null;
}

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
     *
     * THAT FIX DID NOT WORK, and it is worth being precise about why, because the obvious
     * second fix is to tighten the same knob again. It fixed ATTRIBUTION — which node gets
     * quoted, and how many times — and left RECOGNITION untouched. The re-audit shows the
     * result: the same tiles fired, once each instead of five times, and now quoted their
     * container faithfully. The evidence line went from "370" to "brand name new balance
     * product name 370 gender unisex color off white…". Better quoted, still wrong. Sixteen
     * of nineteen firings across 22 retailers quoted a product title, because the detector
     * had never been asked whether a discount was being claimed at all — only whether two
     * prices and the letters "off" happened to share a box.
     *
     * So the gate below is on the EVIDENCE, not on the bookkeeping: a was/now pair written as
     * a pair (see `referencePair`), plus a claim that names its own number. The container
     * dedupe stays because it was right about the thing it was right about.
     */
    const claimedContainers = new Set<string>();

    /**
     * Container paths holding a struck-through price.
     *
     * anchoring.reference_price already establishes what a reference price is, and
     * `computedStyle.textDecoration` rides along in the harvest snapshot for exactly this.
     * It corroborates a pair rather than gating it: strike-through is the strongest evidence
     * available, but it is only available in a browser — the labelled corpus is plain text
     * and would score zero on a strike-only rule.
     */
    const struckContainers = new Set<string>();
    for (const n of visibleCandidates(ctx)) {
      if (!isStruck(n) || parsePrices(n.text).length === 0) continue;
      const segs = n.selectorPath.split(">");
      for (let i = 1; i <= segs.length; i++) struckContainers.add(segs.slice(0, i).join(">"));
    }

    for (const n of visibleCandidates(ctx)) {
      const t = n.containerText || n.normalizedText;
      if (t.length === 0 || t.length > 240) continue;
      if (seen.has(n.selectorPath)) continue;

      const container = n.containerPath;
      if (n.containerText.length > 0) {
        if (container === null || claimedContainers.has(container)) continue;
      }

      const pair = referencePair(t);
      if (!pair) continue;

      const absoluteSaving = Number(pair.high - pair.low) / 100;
      const percentSaving = (Number(pair.high - pair.low) / Number(pair.high)) * 100;
      if (absoluteSaving <= 0 || percentSaving <= 0) continue;

      const showsPercent = PERCENT_CLAIM.test(t);
      const showsAbsolute = ABSOLUTE_CLAIM.test(t) && !showsPercent;
      if (!showsPercent && !showsAbsolute) continue;

      /**
       * The claim has to describe THIS markdown.
       *
       * The detector's premise is "the page chose whichever framing of this discount looks
       * bigger", and that premise only holds if the stated number is the discount between the
       * two prices it found. It never checked. SHEIN's "$12.99 → $3.60, 10% off" fired as
       * percent framing of a 72% drop — but that "10% off" is an extra coupon, not a framing of
       * the markdown at all. A claimed figure that does not match the computed one is about
       * something else, and says nothing about how this discount was framed.
       */
      if (showsPercent) {
        const m = PERCENT_CLAIM.exec(t);
        const claimed = Number(m?.[1] ?? m?.[2]);
        if (!Number.isFinite(claimed) || Math.abs(claimed - percentSaving) > 3) continue;
      } else {
        const m = ABSOLUTE_CLAIM.exec(t);
        const claimedPrice = m
          ? parsePrices(t.slice(m.index, m.index + m[0].length + 12))[0]
          : undefined;
        if (claimedPrice) {
          const claimed = Number(claimedPrice.amount) / 100;
          if (Math.abs(claimed - absoluteSaving) > Math.max(1, absoluteSaving * 0.05)) continue;
        }
      }

      // The Rule of 100: below $100, the percentage reads larger; above, the dollar amount does.
      const percentFlatters = percentSaving > absoluteSaving * FLATTER_FACTOR;
      const absoluteFlatters = absoluteSaving > percentSaving * FLATTER_FACTOR;

      const percentChosenAndFlatters = showsPercent && percentFlatters ? 1 : 0;
      const absoluteChosenAndFlatters = showsAbsolute && absoluteFlatters ? 1 : 0;
      if (percentChosenAndFlatters === 0 && absoluteChosenAndFlatters === 0) continue;

      const labelled = REFERENCE_LEXEME.test(
        t.slice(Math.max(0, pair.highStart - 24), pair.highStart),
      );
      const struck = container !== null && struckContainers.has(container);

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
            referencePrice: struck || labelled ? 1 : 0,
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
