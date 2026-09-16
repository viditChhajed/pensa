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
  /** "Space Limited" on an event registration — capacity framed as short supply. */
  /\bspaces?\s+(?:is |are )?limited\b|\blimited\s+spaces?\b/,
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

/**
 * Legal boilerplate, not a badge.
 *
 * ADJUDICATION, live audit, sephora.com/cart. "While supplies last" fired three times inside
 * the terms footnotes under the promo tiles:
 *
 *     "*Exclusions/terms apply. While supplies last."
 *     "*Exclusions/terms apply. • While supplies last"
 *     "a Exclusions/terms apply. While supplies last. † Terms apply."
 *
 * The call, and the argument for it. "While supplies last" IS scarcity language — it is a
 * claim that stock is finite, it is the commonest such phrase in the labelled corpus, and all
 * three of these are labelled positive there. So it is not a false positive and this does not
 * silence it. What is wrong is SURFACING it. The pattern is about a claim placed to pressure a
 * decision; a sentence sitting between "Exclusions apply" and "Terms apply", in footnote type,
 * behind a dagger, is a lawyer limiting an offer, and it is the same sentence whether the
 * shopper is hurrying or not. Interrupting someone to ask "what would you do if this weren't
 * limited?" about a disclaimer spends the one interruption we get on the least persuasive
 * text on the page — three times over, for what a shopper sees as one footnote.
 *
 * So: it counts, it never interrupts. The arithmetic is chosen against the thresholds, not by
 * feel — boilerplate costs 0.2 and forfeits the `shortText` badge bonus, which puts a
 * qualitative claim at 0.45 and a numeric one at 0.55, both over the 0.35 log threshold and
 * under the 0.75 surface threshold even with a progress bar beside them (0.70).
 *
 * The limit of this, said plainly: it reads the SENTENCE, not the typography. A promo that
 * writes "Only 3 left. Terms apply." in 24pt on the hero is downgraded too, and that one is a
 * real badge. Reading font size and viewport position would settle it properly; that is a
 * salience change and belongs with the salience gate, not in a lexicon.
 *
 * Deliberately NOT here: "while supplies last" on its own, and "see details" — a bare "see
 * details" link sits under plenty of genuine badges.
 */
const DISCLAIMER_CONTEXT =
  /\b(?:exclusions?|restrictions?|terms|conditions)\b[^.]{0,30}\bapply\b|\bterms (?:and|&) conditions\b/;

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
  /** See DISCLAIMER_CONTEXT: enough to keep a terms footnote logged and off the screen. */
  boilerplate: -0.2,
};

/**
 * Is `child` inside `ancestor`, judged on selector paths alone?
 *
 * Copied from urgency.ts, which has the long version of this comment and the same two holes
 * (a path truncated at MAX_PATH_DEPTH or rooted at an id can hide a real ancestry). Both fail
 * open: unrelated paths mean both claims stand, which is what this file did before.
 */
function isWithin(child: string, ancestor: string): boolean {
  return child.length > ancestor.length && child.startsWith(`${ancestor}>`);
}

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

    /**
     * Has this sentence already been claimed by something in the same nest?
     *
     * Exact-match was not enough, and the live audit shows the hole precisely. Zappos renders
     * a grid tile as `<div class=tile><span>a11y description…</span><span>Low Stock</span></div>`.
     * Pass 1 claims the badge's own path; the a11y span is a leftover whose container is the
     * TILE, which no one had claimed, so pass 2 matched "Low Stock" a second time in the
     * tile's joined text and quoted it as "brand name birkenstock product name birki flow eva
     * clog gender…". One badge, two claims, and the second one evidenced with a catalogue dump
     * — note it is the only scarcity firing in the audit with no lexeme tag, because the
     * lexemes were matched against the node's own text and the pattern against its parent's.
     *
     * So ancestry, in both directions: a container holding an existing claim adds nothing, and
     * neither does one nested inside a claim already made.
     */
    const alreadyClaimed = (path: string): boolean => {
      if (claimedContainers.has(path)) return true;
      for (const claimed of claimedContainers) {
        if (isWithin(claimed, path) || isWithin(path, claimed)) return true;
      }
      return false;
    };

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
            // A disclaimer forfeits the badge bonus: terse legal text is terse because it was
            // written to be skipped, not because it is a badge.
            shortText: t.length < 60 && !DISCLAIMER_CONTEXT.test(t) ? 1 : 0,
            boilerplate: DISCLAIMER_CONTEXT.test(t) ? 1 : 0,
          },
          WEIGHTS,
          matchLexemes(n, LEXEMES),
        ),
      );
    }

    for (const n of leftovers) {
      const container = n.containerPath;
      if (!container || alreadyClaimed(container)) continue;
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
            shortText:
              n.containerText.length < 60 && !DISCLAIMER_CONTEXT.test(n.containerText) ? 1 : 0,
            boilerplate: DISCLAIMER_CONTEXT.test(n.containerText) ? 1 : 0,
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
