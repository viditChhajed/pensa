/**
 * scarcity.stock
 *
 * The negative case matters more than the positive one here. "2 sizes left" and "2 colors
 * left" are genuine variant availability, not a scarcity cue, and firing on them is exactly
 * the false positive that makes someone uninstall. They are excluded explicitly, and there
 * is a fixture for it.
 */

import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, matchLexemes, visibleCandidates } from "./util";

/**
 * Inventory nouns that may sit between the count and "left".
 *
 * Booking.com says "Only 3 rooms left at this price", not "Only 3 left" — measured, and it
 * scored zero. Enumerated rather than accepting any word, because `\w+` here would swallow
 * "only 3 sizes left", which is a catalogue fact rather than manufactured urgency and is the
 * exact false positive the plan warns causes uninstalls. Variant nouns stay excluded below.
 */
const UNIT_NOUN =
  "(?:rooms?|tickets?|seats?|items?|units?|pieces?|spots?|places?|nights?|copies|copy|boxes|packs?|bottles?|sets?)";

const STOCK_PATTERNS: readonly RegExp[] = [
  /**
   * Added from the labelled corpus. Each is real copy that scored zero: "While supplies
   * last" — the commonest scarcity phrase in the whole set, and it was being reported as
   * URGENCY — plus "Back in stock soon", "Hurry! Before these items sold out!", and
   * "A limited number of passes will be sold at special introductory pricing".
   */
  /\bwhile (?:stocks?|supplies) last\b/,
  /\bwhile they last\b/,
  /** "will fill up fast", "selling out fast" — supply pressure with no stock vocabulary. */
  /\b(?:fill(?:s|ing)? up|selling out|going) fast\b/,
  /\bback in stock soon\b/,
  /\bbefore (?:these |they |it )?(?:items? )?(?:are |is )?(?:sold ?out|gone)\b/,
  /\ba limited (?:number|quantity|amount)\b/,
  /\blimited (?:quantity|quantities|availability|stock|supply)\b/,
  new RegExp(`\\bonly (\\d{1,3}) (?:${UNIT_NOUN} )?(?:left|remaining|available)\\b`),
  new RegExp(`\\b(\\d{1,3}) ${UNIT_NOUN} (?:left|remaining|available)\\b`),
  /\b(\d{1,3}) (?:left|remaining) in stock\b/,
  /\bonly (\d{1,3}) in stock\b/,
  /\b(\d{1,3}) items? left\b/,
  /\blow stock\b/,
  /\balmost (?:gone|sold out)\b/,
  /\bselling fast\b/,
  /\bgoing fast\b/,
  /\bhurry,? only\b/,
  /\bwhile supplies last\b/,
  /\blimited quantity\b/,
  // "limited availability" reads as scarcity to a shopper exactly as "limited quantity"
  // does, and had no pattern. Found by asserting every shipped pattern is reachable.
  /\blimited availability\b/,
];

/**
 * Genuine variant availability. A page saying "2 sizes left" is describing its catalogue,
 * not manufacturing urgency.
 */
const VARIANT_EXCLUSIONS: readonly RegExp[] = [
  /\b\d{1,3} (?:sizes?|colou?rs?|styles?|variants?|options?|shades?|widths?|lengths?) (?:left|remaining|available)\b/,
  /\b(?:size|colou?r|style) .{0,20}(?:out of stock|unavailable|sold out)\b/,
];

const LEXEMES = [
  "only",
  "left",
  "in stock",
  "low stock",
  "almost gone",
  "selling fast",
  "while supplies last",
  "limited quantity",
] as const;

/**
 * Recalibrated after spot-check run 2 (EVAL.md), on evidence rather than taste.
 *
 * The old weights put a plain numeric claim at 0.60 and a qualitative one at 0.40, against a
 * 0.75 surface threshold. So scarcity.stock could only ever show a card when a progress bar
 * happened to sit beside the copy — and across five sites it fired correctly every single
 * time and surfaced not once. A detector that is always right and never speaks is not
 * cautious, it is broken, and it was silently costing the product its second-highest
 * severity pattern.
 *
 * Zero false positives across booking, ticketmaster, shein, glossier and choicehotels was
 * the evidence for moving. The shape of the change matters as much as the size:
 *
 *   - A numeric claim ("only 3 rooms left") is self-evidently scarcity and now clears the
 *     threshold on its own.
 *   - A qualitative one ("almost sold out") does not. It needs to be terse — badge-shaped
 *     rather than buried in a paragraph — because that is what distinguishes a scarcity
 *     badge from prose that happens to contain the words.
 *
 * Reversible: drop numericStock back to 0.5 and this returns to log-only.
 */
const WEIGHTS: Record<string, number> = {
  numericStock: 0.75,
  qualitativeStock: 0.65,
  progressBar: 0.15,
  shortText: 0.1,
};

export const scarcityDetector: Detector = {
  id: "scarcity.stock@1",
  patternId: "scarcity.stock",
  stages: ["pdp", "cart", "browse"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];
    const seen = new Set<string>();

    /**
     * Two passes, because a stock message is a SENTENCE and sites do not keep sentences in
     * one element.
     *
     * "Only 3 left at this price" is commonly `Only <span>3</span> left at this price`, or
     * three spans for animation. Split that way, no node carries both the number and the
     * words: "3" has no words, "left at this price" has no number, and this detector
     * returned NOTHING at all on copy it scores 0.85 on when flat. That is not a lexicon
     * gap — the lexicon is right — it is reading at the wrong granularity, which EVAL run 1
     * named as the second most expensive defect in the product.
     *
     * Pass 1 matches each node's own text, which is the precise reading and stays first.
     * Pass 2 retries the leftovers against the IMMEDIATE parent's joined text, one claim per
     * parent, and never for a parent that pass 1 already matched. Immediate parent only: a
     * walk up the tree would eventually pair "3" with the whole page, and a detector that
     * always finds its own evidence is not a detector.
     */
    const claimedContainers = new Set<string>();
    const leftovers: CandidateNode[] = [];

    const evaluate = (text: string): { numeric: number; qualitative: number } | null => {
      if (text.length === 0 || text.length > 160) return null;
      if (VARIANT_EXCLUSIONS.some((re) => re.test(text))) return null;
      let numeric = 0;
      let qualitative = 0;
      for (const re of STOCK_PATTERNS) {
        const m = re.exec(text);
        if (!m) continue;
        if (m[1] !== undefined) numeric = 1;
        else qualitative = 1;
      }
      return numeric === 0 && qualitative === 0 ? null : { numeric, qualitative };
    };

    for (const n of visibleCandidates(ctx)) {
      const t = n.normalizedText;
      const hit = evaluate(t);
      if (!hit) {
        if (n.containerPath) leftovers.push(n);
        continue;
      }
      if (seen.has(n.selectorPath)) continue;
      seen.add(n.selectorPath);
      // Claim THIS node's path, not its parent's. A child's `containerPath` is its parent's
      // `selectorPath`, so this is what stops pass 2 re-reporting the same sentence from
      // inside it — `Only <b>3</b> left` matched on the div and then again on the bold.
      claimedContainers.add(n.selectorPath);
      const { numeric, qualitative } = hit;

      // A stock bar rendered near the copy: role=progressbar, or a percent-width child.
      const progressBar = n.childIdxs.some((i) => {
        const c = ctx.candidates[i];
        return c?.role === "progressbar" || c?.attrs.role === "progressbar";
      })
        ? 1
        : 0;

      out.push(
        candidate(
          scarcityDetector.id,
          "scarcity.stock",
          n,
          {
            numericStock: numeric,
            qualitativeStock: qualitative,
            progressBar,
            shortText: t.length < 60 ? 1 : 0,
          },
          WEIGHTS,
          matchLexemes(n, LEXEMES),
        ),
      );
    }

    for (const n of leftovers) {
      const container = n.containerPath;
      if (!container || claimedContainers.has(container)) continue;
      const hit = evaluate(n.containerText);
      if (!hit) continue;
      claimedContainers.add(container);
      seen.add(n.selectorPath);

      out.push(
        candidate(
          scarcityDetector.id,
          "scarcity.stock",
          n,
          {
            numericStock: hit.numeric,
            qualitativeStock: hit.qualitative,
            // A progress bar is a sibling in this shape, not a child, and this pass has no
            // cheap way to see one. Scoring it 0 understates rather than invents.
            progressBar: 0,
            shortText: n.containerText.length < 60 ? 1 : 0,
          },
          WEIGHTS,
          matchLexemes(n, LEXEMES),
          // Quote the sentence, not the fragment. Without this the card says “3”.
          n.containerText,
        ),
      );
    }

    return out;
  },
};
