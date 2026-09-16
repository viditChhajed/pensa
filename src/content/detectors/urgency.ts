/**
 * urgency.countdown
 *
 * A countdown is a node whose text CHANGES over time in a clock shape. A single frozen
 * frame cannot express that, which is why `CandidateNode.textHistory` exists and why
 * countdown fixtures are captured as two snapshots ~3s apart.
 *
 * Detecting a static "12:30" would fire on every store-hours listing and every video
 * duration on the page, so a clock-shaped string alone scores nothing — the decrement is
 * the signal.
 */

import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, matchLexemes, visibleCandidates } from "./util";

const CLOCK_RE = /\b(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\b/;

/**
 * A deadline stated in words, with no clock ticking anywhere: "Sale ends Sunday", "Offer
 * expires tonight", "Summer sale ending soon".
 *
 * These were falling through entirely. A static deadline scored `lexeme` alone — 0.25,
 * under even the 0.35 log threshold — so the commonest limited-time message on the web was
 * neither shown nor counted. The detector is named for countdowns and was doing exactly what
 * its name says; the TAXONOMY entry is broader ("a visible deadline shortens deliberation
 * and pushes a decision toward now"), and Mathur et al. treat limited-time messages as one
 * category rather than only ticking ones.
 */
const DEADLINE_COPY = new RegExp(
  [
    /**
     * "sale ends", "offer expires", "promo closes" — a noun and a verb, in either order.
     *
     * Two narrowings, both paid for by the live audit, where this alternative produced the
     * only nonsense `urgency.countdown` quoted on any of 22 retailers:
     *
     *   "Save this event: NYC Grocery Run with Rainforest Distribution" matched, as
     *   `event: nyc grocery run`. `runs?` accepted the singular, and "run" is a NOUN far more
     *   often than a deadline verb — a grocery run, a trail run, a print run, a test run.
     *   Only the third person ("Event runs 9/20–10/3", Target) states a schedule, so the
     *   optional "s" is gone. Nothing in the labelled corpus depended on it: 0 rows change.
     *
     *   The gap no longer crosses a colon or any other sentence-dividing mark. A colon
     *   separates a label from its content — "Save this event:", "Deal of the day:" — and a
     *   deadline is not stated across one. Cost on the corpus: also 0 rows.
     *
     * Honest about what this still allows: "offer" and "event" are common enough words that a
     * sentence pairing either with "ends" or "closes" within 24 characters will still match
     * something eventually. The gap is bounded and the verbs are now unambiguous, which is as
     * narrow as a copy rule gets without a list of specific strings — and a list of specific
     * strings would have known about "Save this event" and nothing about "Save this listing".
     */
    /\b(?:sale|offer|deal|discount|promo(?:tion)?|price|event|coupon)\b[^.:;!?|•]{0,24}?\b(?:ends?|ending|expires?|expiring|closes?|runs)\b/,
    // "ends soon", "expires in 3 days", "ends 9/16/26", "ending tomorrow".
    /\b(?:ends?|ending|expires?|expiring)\s+(?:soon|today|tonight|tomorrow|shortly|in\b|on\b|\d)/,
    // "thru Sep 17", "through September 17", "valid thru 9.30.26" — Ulta and Sephora write
    // almost every promotion this way, and it was the single largest family of misses.
    /\b(?:thru|through)\s+(?:\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/,
    // "book by Jan 7", "buy by 9/16/26" — a purchase deadline hidden in terms text.
    /\b(?:book|buy|order|shop)\s+by\s+(?:\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/,
    /\blimited[-\s]time\b/,
    /\b\d+\s+days?\s+left\b/,
    /\blast (?:chance|day|call|hours?)\b/,
    /\b(?:today|tonight) only\b/,
    /\bhurry\b/,
    /**
     * A deadline expressed as a consequence rather than an ending: "Price increases
     * after 9/24". Nothing ends — the cost of waiting simply goes up, which is the same
     * pressure stated the other way round.
     */
    /\bprices?\s+(?:go(?:es)? up|increases?|rises?)\s+(?:after|on|at)\b/,
  ]
    .map((r) => r.source)
    .join("|"),
  "i",
);

/**
 * "While supplies last" is NOT here, deliberately.
 *
 * It was, and it produced every one of this detector's false positives. It is a claim about
 * SUPPLY, not about time — the labelling put it under scarcity, and scarcity is where it
 * now lives. A deadline detector that fires on a stock claim reports the wrong technique
 * with full confidence, which is worse than missing it.
 */

/**
 * Does the deadline name WHEN? A weekday, a date, or a time.
 *
 * "Sale ends soon" is a nudge with no content and belongs in the log. "Sale ends Sunday" is
 * a specific claim a shopper can actually weigh — and the question worth asking ("would this
 * still be a good buy on Monday?") only makes sense when there is a Monday to point at.
 */
const DEADLINE_IS_SPECIFIC =
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:mon|tue|wed|thu|fri|sat|sun)\b|\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bin \d+ (?:hours?|days?|minutes?)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i;

const LEXEMES = [
  "ends in",
  "ending in",
  "deal ends",
  "sale ends",
  "offer ends",
  "hurry",
  "expires",
  "time left",
  "left to buy",
  "reserved for",
  "held for",
  "expires in",
  "ends today",
] as const;

const WEIGHTS: Record<string, number> = {
  decrementing: 0.55,
  clockShape: 0.2,
  lexeme: 0.25,
  cartHold: 0.15,
  /**
   * Chosen against the thresholds rather than by feel.
   *
   * `staticDeadline` alone (0.40) plus a lexeme (0.25) is 0.65 — logged, never surfaced. A
   * vague "sale ends soon" gets counted and interrupts nobody. Add `deadlineIsSpecific`
   * (0.25) and it reaches 0.90, which surfaces: "ends Sunday" is a claim someone can weigh,
   * and the prompt only makes sense when there is a named day to point at.
   */
  staticDeadline: 0.4,
  deadlineIsSpecific: 0.25,
};

/**
 * Is `child` inside `ancestor`, judged on selector paths alone?
 *
 * `selectorPath` is built root-first and joined with ">", so a descendant's path is its
 * ancestor's path plus more. Detectors are pure and have no DOM, and `parentIdx` only links
 * nodes that are both CANDIDATES — a plain wrapper div between them breaks that chain — so
 * the string is the only relationship available here.
 *
 * Two known holes, stated rather than papered over: a path that hit `MAX_PATH_DEPTH` starts
 * partway down the tree, and one that hit an `id` starts at that id, so a genuine
 * ancestor/descendant pair can look unrelated. Both fail OPEN — the pair is treated as
 * unrelated and both claims stand, which is the behaviour this whole file had before.
 *
 * Duplicated in scarcity.ts rather than shared, because this change was scoped to the two
 * detectors it fixes and util.ts belongs to everything. If a third detector needs it, move it.
 */
function isWithin(child: string, ancestor: string): boolean {
  return child.length > ancestor.length && child.startsWith(`${ancestor}>`);
}

/**
 * The part of a long blob that actually carries the deadline.
 *
 * `text` is joined from the node's whole subtree, so a product tile arrives as one string:
 * title, then price, then the promo badge. The detector scored the badge and the card then
 * quoted the title — the live audit caught exactly that on Newegg, where a claim about
 * "ends 10/09" was evidenced as "GY-BNO085 9DOF Nine-Axis AHRS IMU Sensor Module…". A card
 * that names a countdown and then quotes a part number is not a question, it is a riddle,
 * and it is the same defect framing.savings_ratio was fixed for.
 *
 * Returns undefined when the node's own text is already the claim, which is the common case.
 * Limited by punctuation: a tile written without any is still quoted whole. Better than
 * inventing a window around the match, which reads as a ransom note.
 */
function deadlineSentence(text: string, matches: (s: string) => boolean): string | undefined {
  if (text.length < 80) return undefined;
  const parts = text
    .split(/(?<=[.!?])\s+|\s*[•|]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < 2) return undefined;
  const hit = parts.find((p) => matches(p.toLowerCase()));
  // Only worth substituting when it is genuinely tighter than what we would otherwise quote.
  if (!hit || hit.length > text.length * 0.6) return undefined;
  return hit;
}

function clockToSeconds(text: string): number | null {
  const m = CLOCK_RE.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] !== undefined ? Number(m[3]) : null;
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
}

/** Two or more observations, strictly decreasing, at roughly 1Hz. */
function isDecrementing(n: CandidateNode): boolean {
  const obs = n.textHistory
    .map((o) => ({ t: o.t, sec: clockToSeconds(o.text) }))
    .filter((o): o is { t: number; sec: number } => o.sec !== null);

  if (obs.length < 2) return false;

  let decreases = 0;
  for (let i = 1; i < obs.length; i++) {
    const prev = obs[i - 1] as { t: number; sec: number };
    const cur = obs[i] as { t: number; sec: number };
    const dSec = prev.sec - cur.sec;
    const dT = (cur.t - prev.t) / 1000;
    if (dSec > 0 && dT > 0 && dSec / dT > 0.3 && dSec / dT < 4) decreases++;
  }
  return decreases >= 1;
}

export const urgencyDetector: Detector = {
  id: "urgency.countdown@1",
  patternId: "urgency.countdown",
  stages: ["pdp", "cart", "checkout", "browse"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];

    for (const n of visibleCandidates(ctx)) {
      const t = n.normalizedText;
      if (t.length > 200) continue;

      const hasClock = CLOCK_RE.test(t);
      const lexemeHits = matchLexemes(n, LEXEMES);
      const deadline = DEADLINE_COPY.test(t);
      if (!hasClock && lexemeHits.length === 0 && !deadline) continue;

      const decrementing = isDecrementing(n);
      // Without an observed decrement, a clock shape alone is not a countdown — a store-hours
      // listing and a video duration are both "12:30". A deadline stated in words is its own
      // signal and does not need one.
      if (!decrementing && lexemeHits.length === 0 && !deadline) continue;

      const cartHold = /\breserved for\b|\bheld for\b|\bcart expires\b/.test(t) ? 1 : 0;

      const quoted = deadlineSentence(
        n.text,
        (s) => DEADLINE_COPY.test(s) || LEXEMES.some((l) => s.includes(l)),
      );

      out.push(
        candidate(
          urgencyDetector.id,
          "urgency.countdown",
          n,
          {
            decrementing: decrementing ? 1 : 0,
            clockShape: hasClock ? 1 : 0,
            lexeme: lexemeHits.length > 0 ? 1 : 0,
            cartHold,
            staticDeadline: deadline && !decrementing ? 1 : 0,
            // Only meaningful alongside a deadline: a date elsewhere on the page is a
            // delivery estimate as often as it is an expiry.
            deadlineIsSpecific: deadline && DEADLINE_IS_SPECIFIC.test(t) ? 1 : 0,
          },
          WEIGHTS,
          lexemeHits,
          quoted,
        ),
      );
    }

    /**
     * One deadline, one claim: the INNERMOST node that carries it.
     *
     * A node's text is joined from its whole subtree, so a deadline is matched again by every
     * ancestor that contains it. The live audit shows what that costs: Ulta reported "Same
     * dayFree same day delivery over $35. Now thru 9.17." and "Free same day delivery over
     * $35. Now thru 9.17." as separate claims, 14 times each, for one line of copy — and the
     * Newegg tile above is the same duplication with the quote degraded into a part number.
     *
     * The inner node is the better of the two every time: it is closer to what the shopper
     * actually sees as the badge, and its text has less of the page mixed into it.
     *
     * The case this gets wrong, deliberately: an ancestor whose own text states a SECOND,
     * different deadline is dropped along with the duplicate, because its text contains the
     * child's and there is no cheap way to tell the two apart. One claim per nest is the right
     * trade — the alternative is what the audit measured, which was up to two claims per line.
     */
    return out.filter((h) => !out.some((o) => isWithin(o.nodeRef, h.nodeRef)));
  },
};
