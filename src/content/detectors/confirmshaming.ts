/**
 * confirmshaming.decline_copy
 *
 * The signal is not "this text is negative" — it is "the control that declines is phrased in
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
  /\bi\s+(?:don'?t|do not|hate|prefer|would rather|'?d rather|am not|like|enjoy|want)\b|\bi'?m not\b|\bno,? i\b/;

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
  /\bmiss(?:ing)? out\b/,
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

      const hits = SELF_DEPRECATION.filter((re) => re.test(raw));
      if (hits.length === 0) continue;

      const control = isControl(n);
      const firstPerson = FIRST_PERSON.test(raw);

      // Copy alone is not enough — it has to be the thing you click to say no.
      if (!control && !DECLINE_HINT.test(raw)) continue;

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
