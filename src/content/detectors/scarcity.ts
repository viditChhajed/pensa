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
 * Booking.com says "Only 3 rooms left at this price", not "Only 3 left", measured, and it
 * scored zero. Enumerated rather than accepting any word, because `\w+` here would swallow
 * "only 3 sizes left", which is a catalogue fact rather than manufactured urgency and is the
 * exact false positive the plan warns causes uninstalls. Variant nouns stay excluded below.
 */
const UNIT_NOUN =
  "(?:rooms?|tickets?|seats?|items?|units?|pieces?|spots?|places?|nights?|copies|copy|boxes|packs?|bottles?|sets?)";

const STOCK_PATTERNS: readonly RegExp[] = [
  /**
   * Added from the labelled corpus. Each is real copy that scored zero: "While supplies
   * last", the commonest scarcity phrase in the whole set, and it was being reported as
   * URGENCY, plus "Back in stock soon", "Hurry! Before these items sold out!", and
   * "A limited number of passes will be sold at special introductory pricing".
   */
  /\bwhile (?:stocks?|supplies) last\b/,
  /\bwhile they last\b/,
  /** "will fill up fast", "selling out fast", supply pressure with no stock vocabulary. */
  /\b(?:fill(?:s|ing)? up|selling out|going) fast\b/,
  /** "Space Limited" on an event registration, capacity framed as short supply. */
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
  /\bhurry,? only\b/,
  // "limited availability" reads as scarcity to a shopper exactly as "limited quantity"
  // does, and had no pattern. Found by asserting every shipped pattern is reachable.
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
 * The call, and the argument for it. "While supplies last" IS scarcity language, it is a
 * claim that stock is finite, it is the commonest such phrase in the labelled corpus, and all
 * three of these are labelled positive there. So it is not a false positive and this does not
 * silence it. What is wrong is SURFACING it. The pattern is about a claim placed to pressure a
 * decision; a sentence sitting between "Exclusions apply" and "Terms apply", in footnote type,
 * behind a dagger, is a lawyer limiting an offer, and it is the same sentence whether the
 * shopper is hurrying or not. Interrupting someone to ask "what would you do if this weren't
 * limited?" about a disclaimer spends the one interruption we get on the least persuasive
 * text on the page, three times over, for what a shopper sees as one footnote.
 *
 * So: it counts, it never interrupts. The arithmetic is chosen against the thresholds, not by
 * feel, boilerplate costs 0.2 and forfeits the `shortText` badge bonus, which puts a
 * qualitative claim at 0.45 and a numeric one at 0.55, both over the 0.35 log threshold and
 * under the 0.75 surface threshold even with a progress bar beside them (0.70).
 *
 * The limit of this, said plainly: it reads the SENTENCE, not the typography. A promo that
 * writes "Only 3 left. Terms apply." in 24pt on the hero is downgraded too, and that one is a
 * real badge. Reading font size and viewport position would settle it properly; that is a
 * salience change and belongs with the salience gate, not in a lexicon.
 *
 * Deliberately NOT here: "while supplies last" on its own, and "see details", a bare "see
 * details" link sits under plenty of genuine badges.
 */
const DISCLAIMER_CONTEXT =
  /\b(?:exclusions?|restrictions?|terms|conditions)\b[^.]{0,30}\bapply\b|\bterms (?:and|&) conditions\b/;

/**
 * An offer to be TOLD about scarcity later is not a scarcity claim now.
 *
 * ADJUDICATION, live audit run 2, temu.com/login.html. `scarcity.stock` fired four times on
 * "Low stock items alerts", which the probe shows is a benefit blurb in the sign-in page's
 * footer, sitting next to "Faster & more secure checkout":
 *
 *     <div data-tooltip="FooterBenefitItem_lowstock">
 *       <img …><div class="text">Low stock items alerts</div></div>
 *
 * Nothing on that page is running out. The words "low stock" are the SUBJECT of a
 * notification feature, the thing they will email you about, not an assertion about any
 * item's inventory, and it scored 0.75, exactly the surface threshold, so it showed a card.
 *
 * The rule is about the construction, not the string, because a blocklist that only knew
 * "Low stock items alerts" would be back next week on "Back-in-stock alerts" or "Turn on low
 * stock notifications". Checked against the labelled corpus before shipping: of 4,957
 * scarcity rows, 31 negatives contain this vocabulary and ZERO of the 24 positives do.
 *
 * The seam, stated rather than hidden: "alerts" plural names a feature you subscribe to;
 * bare singular "alert" is left alone because "Low stock alert!" is badge English, an
 * interjection announcing the fact, not an offer to send you mail about it. Nothing in the
 * corpus exercises that case either way, so it is a judgement, not a measurement. Also
 * deliberately absent: "sign up" and "subscribe", which are far too common in genuine promo
 * copy ("Sign up and save 20%, while supplies last") to be read as a notification offer.
 */
const NOTIFICATION_OFFER =
  /\balerts\b|\bnotifications?\b|\breminders?\b|\bget notified\b|\b(?:notify|remind|email|text) (?:me|you)\b/;

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
 * happened to sit beside the copy, and across five sites it fired correctly every single
 * time and surfaced not once. A detector that is always right and never speaks is not
 * cautious, it is broken, and it was silently costing the product its second-highest
 * severity pattern.
 *
 * Zero false positives across booking, ticketmaster, shein, glossier and choicehotels was
 * the evidence for moving. The shape of the change matters as much as the size:
 *
 *   - A numeric claim ("only 3 rooms left") is self-evidently scarcity and now clears the
 *     threshold on its own.
 *   - A qualitative one ("almost sold out") does not. It needs to be terse, badge-shaped
 *     rather than buried in a paragraph, because that is what distinguishes a scarcity
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
 *
 * THE FIRST HOLE IS NOT THEORETICAL, and the previous fix here was built on top of it. See
 * the note on the container pass below: on a real grid tile every path in sight is truncated
 * and this function returns false for a genuine grandparent. It is kept because it is free
 * and it does work on shallow pages, but nothing load-bearing may depend on it.
 */
function isWithin(child: string, ancestor: string): boolean {
  return child.length > ancestor.length && child.startsWith(`${ancestor}>`);
}

/** One pattern hit, with where in the text it sat. */
interface StockMatch {
  readonly start: number;
  readonly end: number;
  /** A counted claim ("only 3 rooms left") rather than a qualitative one ("almost gone"). */
  readonly numeric: boolean;
}

/**
 * Which of `matches` does this node's OWN text actually carry part of?
 *
 * The general rule, which is the real answer to the Zappos duplicate: a claim may not be
 * evidenced by text that does not itself contain the matched phrase. The container pass
 * exists so that `Only <span>3</span> left` can be read as one sentence, the span "3" is a
 * FRAGMENT OF the sentence. A sibling that merely shares a parent with the sentence is not,
 * and attaching the claim to it is how the detector came to quote a catalogue dump.
 *
 * Judged by character span, not by substring containment, because a node can hold the head or
 * the tail of the phrase without holding all of it: in `<b>Only</b> 3 <b>left at this
 * price</b>` the node "left at this price" is neither inside "only 3 left" nor a superstring
 * of it, and it is still part of the sentence.
 *
 * A node whose own text cannot be located in its parent's joined text at all yields nothing.
 * That happens when `joinedText` separates on element boundaries one level and `textContent`
 * does not the next (`<span><b>Low</b><b>Stock</b></span>`), and the honest response to "I
 * cannot show this node is part of the sentence" is to not claim it. Guessing is the bug.
 */
function carriedBy(containerText: string, ownText: string, matches: readonly StockMatch[]) {
  if (ownText.length === 0) return [];
  const spans: Array<readonly [number, number]> = [];
  for (
    let i = containerText.indexOf(ownText);
    i !== -1;
    i = containerText.indexOf(ownText, i + 1)
  ) {
    spans.push([i, i + ownText.length]);
  }
  return matches.filter((m) => spans.some(([s, e]) => s < m.end && e > m.start));
}

/** Sub-signal shape for a set of hits: numeric wins the higher weight, qualitative the lower. */
function tally(matches: readonly StockMatch[]): { numeric: number; qualitative: number } {
  return {
    numeric: matches.some((m) => m.numeric) ? 1 : 0,
    qualitative: matches.some((m) => !m.numeric) ? 1 : 0,
  };
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
     * gap, the lexicon is right, it is reading at the wrong granularity, which EVAL run 1
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
     * Exact path match, plus ancestry in both directions: a container holding an existing
     * claim adds nothing, and neither does one nested inside a claim already made.
     *
     * WHAT THIS DOES NOT CATCH, and the second audit proved it. This was shipped as the fix
     * for Zappos' duplicate "Low Stock" claim, verified against a three-level fixture, and
     * declared done. It fired again on the next live run, unchanged. `selectorPath` caps at
     * MAX_PATH_DEPTH = 12 and truncates from the ROOT end, so two nodes at different depths
     * inside one tile get paths that begin at different ancestors and share no prefix at all.
     * The real badge sits at depth 20:
     *
     *   badge  section>…>div:nth-of-type(15)>div>article>div>dl>dd:nth-of-type(4)>span
     *   its dl div:nth-of-type(1)>div>section>…>div:nth-of-type(15)>div>article>div>dl
     *
     * `isWithin(badge, dl)` is false. Every claim of ancestry this function makes on a real
     * product grid is false, and the fixture that said otherwise was shallow enough that no
     * path was truncated, the fix was tested on the one DOM shape where the bug cannot occur.
     *
     * Ancestry is therefore kept only as a cheap first cut. What actually stops the duplicate
     * is `carriedBy` in the container pass: the a11y `<dt>` whose parent is the `<dl>` does not
     * contain "low stock" in its own text, so it cannot carry the claim, whatever the paths
     * say. That the audit row had no lexeme tag was the tell all along, the lexemes were read
     * off the node and the pattern off its parent, and nobody asked whether they agreed.
     */
    const alreadyClaimed = (path: string): boolean => {
      if (claimedContainers.has(path)) return true;
      for (const claimed of claimedContainers) {
        if (isWithin(claimed, path) || isWithin(path, claimed)) return true;
      }
      return false;
    };

    const evaluate = (text: string): StockMatch[] | null => {
      if (text.length === 0 || text.length > 160) return null;
      if (VARIANT_EXCLUSIONS.some((re) => re.test(text))) return null;
      // An offer to alert you about scarcity is not scarcity. See NOTIFICATION_OFFER.
      if (NOTIFICATION_OFFER.test(text)) return null;
      const matches: StockMatch[] = [];
      for (const re of STOCK_PATTERNS) {
        const m = re.exec(text);
        if (!m) continue;
        matches.push({ start: m.index, end: m.index + m[0].length, numeric: m[1] !== undefined });
      }
      return matches.length === 0 ? null : matches;
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
      // inside it, `Only <b>3</b> left` matched on the div and then again on the bold.
      claimedContainers.add(n.selectorPath);
      const { numeric, qualitative } = tally(hit);

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
      // The node must carry part of the phrase it is about to be blamed for. Without this a
      // sibling of the badge inherits the badge's claim and evidences it with its own text.
      const carried = carriedBy(n.containerText, n.normalizedText, hit);
      if (carried.length === 0) continue;
      const { numeric, qualitative } = tally(carried);
      claimedContainers.add(container);
      seen.add(n.selectorPath);

      out.push(
        candidate(
          scarcityDetector.id,
          "scarcity.stock",
          n,
          {
            numericStock: numeric,
            qualitativeStock: qualitative,
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
