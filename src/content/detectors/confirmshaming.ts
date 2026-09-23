/**
 * confirmshaming.decline_copy
 *
 * The signal is not "this text is negative", it is "the control that declines is phrased in
 * the first person, so clicking it means saying something unflattering about yourself."
 * "No thanks" is fine. "No thanks, I don't like saving money" is not.
 *
 * So the detector requires BOTH:
 *   - the node is actually a decline-role control (button/link, near a dismissal), and
 *   - the copy is first-person AND self-deprecating.
 *
 * A plain "No thanks" scores below threshold on purpose. Firing on every dismissal button on
 * the web would be the single fastest way to make this extension unusable.
 *
 * §18D replaces the lexicon here with a hashed n-gram classifier, which is what catches
 * phrasings nobody anticipated. The lexicon is the v1 stand-in.
 */
import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, visibleCandidates } from "./util";

/** First-person constructions that put words in the user's mouth. */
const FIRST_PERSON =
  /\bi\s+(?:don'?t|do not|hate|prefer|would rather|'?d rather|am not|like|enjoy|want|understand|acknowledge|accept|agree|will|shall)\b|\bi'?(?:m not|ll)\b|\bno,? i\b/;

/** What the sentence disparages the user for wanting. */
const SELF_DEPRECATION: readonly RegExp[] = [
  /\b(?:don'?t|do not) (?:want|like|need|care about) (?:to )?(?:save|saving|savings|discounts?|deals?|money|offers?)\b/,
  /\bhate (?:saving|savings|money|discounts?|deals?|free)\b/,
  /\b(?:would |'?d )?rather pay (?:full|more|retail)\b/,
  /\bi'?m not interested in (?:saving|savings|discounts?|deals?)\b/,
  /\bdon'?t (?:want|need) (?:to be )?(?:smart|informed|updated|in the know)\b/,
  /\bprefer (?:to pay )?full price\b/,
  /\bi like paying (?:full|more)\b/,
  /\bno thanks,? i\b/,
  /\bi enjoy (?:paying|missing out|overpaying)\b/,
  /\bi don'?t (?:want|need) (?:free|better|good)\b/,
  /**
   * Every rule above encodes one exact phrasing of the sentiment, and the corpus contained
   * three real instances, all scoring zero:
   *
   *   "I Will Pay Full Price!", "rather pay full" and "prefer full price" are
   *   "I will pay full price"             here; the plain declaration is not
   *   "I don't want my mystery offer", "don't want" was required to be followed
   *                                        immediately by the noun, so a possessive broke it
   *
   * Confirmshaming is the one Tier-1 detector that was still at 0.00 recall, which is what
   * writing rules from imagined copy produces: the sentiment was right and the sentences
   * were invented.
   */
  /\bi\s*(?:will|'?ll|am going to)\s+pay\s+(?:the\s+)?(?:full|more|retail|extra)\b/,
  /\b(?:don'?t|do not)\s+(?:want|like|need)\s+(?:my|the|this|your|any)\s+\w+/,
  /\bi'?ll (?:risk it|take my chances|pass on)\b/,
  // First-person only. A bare "miss out" matched ordinary calls to action, a "Don't miss
  // out, shop now" button scored 0.8 and was shown as loaded decline wording, which it is not.
  /\b(?:i'?ll|i will|i'?d rather|i don'?t mind|i'?m (?:ok|okay|fine|happy)(?: with)?)\s+miss(?:ing)? out\b/,
  // A second shape of the same mechanism, found on flyfrontier: declining the upsell
  // requires TICKING A BOX that asserts something costly about your own choice,
  // "Basic Fare works for me. I understand purchasing options separately may result in a
  // higher overall price." Nothing here is rude, so none of the patterns above match, but
  // the decline is still written to be uncomfortable to agree with. Reported twice from the
  // field before it was handled.
];

/**
 * The second shape of the same mechanism, found on flyfrontier: declining the upsell
 * requires TICKING A BOX that asserts something costly about your own choice, "Basic Fare
 * works for me. I understand purchasing options separately may result in a higher overall
 * price."
 *
 * Nothing in that sentence is rude, so none of the patterns above match it, and the control
 * is a checkbox label rather than a button, so the decline-control gate rejected it too.
 * But ticking the box IS the act of declining, and it is written to be uncomfortable to
 * agree with. Reported from the field twice before it was handled.
 *
 * Kept separate from SELF_DEPRECATION because a match here also satisfies the control gate:
 * the acknowledgement is the decline.
 */
const COSTLY_ACKNOWLEDGEMENT: readonly RegExp[] = [
  /\bi understand\b[^.]{0,80}\b(?:higher|more expensive|greater|increased|additional)\b[^.]{0,40}\b(?:price|cost|total|fare|fee)/,
  /\bi understand\b[^.]{0,80}\b(?:may|might|could|will) (?:result in|cost more|be charged)\b/,
  /\bi (?:acknowledge|accept|agree)\b[^.]{0,80}\b(?:higher|more|additional|extra)\b[^.]{0,40}\b(?:price|cost|fee|charge)/,
];

/** Plain, non-shaming declines. These must NOT fire. */
const NEUTRAL_DECLINES: readonly RegExp[] = [
  /^(?:no thanks?|no thank you|not now|maybe later|dismiss|close|cancel|skip|not right now|no)$/,
  /^(?:continue without|decline|opt out)\b/,
];

const DECLINE_HINT = /\b(?:no|not|skip|dismiss|close|maybe later|decline|cancel)\b/;

const WEIGHTS: Record<string, number> = {
  selfDeprecating: 0.6,
  firstPerson: 0.3,
  declineControl: 0.2,
  inModal: 0.1,
};

function isControl(n: CandidateNode): boolean {
  return (
    n.tagName === "BUTTON" ||
    n.tagName === "A" ||
    n.role === "button" ||
    n.role === "link" ||
    n.attrs.role === "button" ||
    (n.tagName === "INPUT" && (n.attrs.type === "button" || n.attrs.type === "submit"))
  );
}

/** Heuristic for "this sits inside an overlay": a high z-index or dialog role nearby. */
function looksModal(n: CandidateNode, ctx: PageContext): boolean {
  let cur: CandidateNode | undefined = n;
  let hops = 0;
  while (cur && hops < 6) {
    if (cur.role === "dialog" || cur.attrs.role === "dialog" || cur.attrs.role === "alertdialog") {
      return true;
    }
    cur = cur.parentIdx !== null ? ctx.candidates[cur.parentIdx] : undefined;
    hops++;
  }
  return false;
}

export const confirmshamingDetector: Detector = {
  id: "confirmshaming.decline_copy@1",
  patternId: "confirmshaming.decline_copy",
  stages: ["browse", "pdp", "cart", "checkout"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];
    const seen = new Set<string>();

    for (const n of visibleCandidates(ctx)) {
      const raw = (n.accessibleName || n.text).toLowerCase().replace(/\s+/g, " ").trim();
      if (raw.length === 0 || raw.length > 160) continue;
      if (seen.has(n.selectorPath)) continue;

      // A plain "No thanks" is not confirmshaming. Bail before scoring.
      if (NEUTRAL_DECLINES.some((re) => re.test(raw))) continue;

      const ackHits = COSTLY_ACKNOWLEDGEMENT.filter((re) => re.test(raw));
      const hits = [...SELF_DEPRECATION.filter((re) => re.test(raw)), ...ackHits];
      if (hits.length === 0) continue;

      const control = isControl(n);
      const firstPerson = FIRST_PERSON.test(raw);

      // Copy alone is not enough, it has to be the thing you click to say no. A costly
      // acknowledgement counts as that thing in its own right: the box IS the decline, and
      // it is a label rather than a button, so neither isControl nor DECLINE_HINT sees it.
      if (!control && ackHits.length === 0 && !DECLINE_HINT.test(raw)) continue;

      seen.add(n.selectorPath);

      out.push(
        candidate(
          confirmshamingDetector.id,
          "confirmshaming.decline_copy",
          n,
          {
            selfDeprecating: 1,
            firstPerson: firstPerson ? 1 : 0,
            declineControl: control ? 1 : 0,
            inModal: looksModal(n, ctx) ? 1 : 0,
          },
          WEIGHTS,
          hits.map((re) => re.source.slice(0, 48)),
        ),
      );
    }

    return out;
  },
};
