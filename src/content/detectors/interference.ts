/**
 * interference.visual_asymmetry
 *
 * Given a paired accept/decline control set, measure how differently the two are presented:
 * WCAG contrast against their effective backgrounds, rendered area, and font weight.
 *
 * This is the most defensible detector in the set because every input is a number with a
 * standard behind it. "The accept button has 6.2x the contrast and 2.4x the area of the
 * decline control" is a measurement. It says nothing about intent, which is exactly the
 * posture the whole product takes.
 *
 * Precision risk: a page where the only "decline" is a small × in a corner. That is a real
 * asymmetry but such a universal convention that flagging it would fire everywhere, so a
 * bare glyph with no words is excluded.
 */
import type { DetectionCandidate } from "@/shared/schema";
import { contrastRatio } from "../contrast";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, visibleCandidates } from "./util";

/**
 * Opt-in wording. `add`, `apply` and `start` are gone: they made a quick-view modal's "Add to
 * bag" beside its "Close" link read as a manipulative accept/decline pair, when that is ordinary
 * primary-versus-tertiary button design. Asymmetry is a finding when the page is asking for
 * CONSENT or an opt-in, not when it is offering the thing the shopper came to buy.
 */
const ACCEPT =
  /\b(?:accept|allow|agree|continue|yes|ok|got it|sounds good|sign me up|subscribe|get \d+% off|claim|unlock|save now)\b/;
const PURCHASE_CTA = /\b(?:add to (?:cart|bag|basket)|buy now|check ?out|place order|pay now)\b/;

const DECLINE =
  /\b(?:decline|no thanks?|no thank you|not now|maybe later|skip|dismiss|cancel|reject|opt out|continue without|not interested|close)\b/;

/** A bare glyph is a universal close convention, not a designed asymmetry. */
const GLYPH_ONLY = /^[\s×✕✖x✗+·—–-]*$/i;

const CONTRAST_RATIO_THRESHOLD = 3;
const AREA_RATIO_THRESHOLD = 2;

const WEIGHTS: Record<string, number> = {
  contrastAsymmetry: 0.45,
  areaAsymmetry: 0.3,
  weightAsymmetry: 0.15,
  bothPresent: 0.2,
};

function isControl(n: CandidateNode): boolean {
  return (
    n.tagName === "BUTTON" ||
    n.tagName === "A" ||
    n.role === "button" ||
    n.attrs.role === "button" ||
    (n.tagName === "INPUT" && (n.attrs.type === "button" || n.attrs.type === "submit"))
  );
}

function labelOf(n: CandidateNode): string {
  return (n.accessibleName || n.text).toLowerCase().replace(/\s+/g, " ").trim();
}

function contrastOf(n: CandidateNode): number | null {
  return contrastRatio(n.style.color, n.style.effectiveBackground);
}

function area(n: CandidateNode): number {
  return Math.max(1, n.box.w * n.box.h);
}

export const interferenceDetector: Detector = {
  id: "interference.visual_asymmetry@1",
  patternId: "interference.visual_asymmetry",
  stages: ["browse", "pdp", "cart", "checkout", "payment"],

  run(ctx: PageContext): DetectionCandidate[] {
    const controls = visibleCandidates(ctx).filter(isControl);
    if (controls.length < 2) return [];

    // Group by container: an accept/decline pair is a sibling set, not two arbitrary buttons
    // from opposite ends of the page.
    const byContainer = new Map<string, CandidateNode[]>();
    for (const c of controls) {
      const key = c.containerPath;
      if (key === null) continue;
      const arr = byContainer.get(key);
      if (arr) arr.push(c);
      else byContainer.set(key, [c]);
    }

    const out: DetectionCandidate[] = [];

    for (const [, group] of byContainer) {
      if (group.length < 2 || group.length > 6) continue;

      const accepts = group.filter(
        (n) => ACCEPT.test(labelOf(n)) && !PURCHASE_CTA.test(labelOf(n)),
      );
      const declines = group.filter((n) => {
        const l = labelOf(n);
        return DECLINE.test(l) && !GLYPH_ONLY.test(l) && l.length > 1;
      });
      if (accepts.length === 0 || declines.length === 0) continue;

      // The most prominent accept against the least prominent decline — the pairing a
      // shopper's eye actually resolves.
      const accept = accepts.reduce((a, b) => (area(b) > area(a) ? b : a));
      const decline = declines.reduce((a, b) => (area(b) < area(a) ? b : a));
      if (accept.selectorPath === decline.selectorPath) continue;

      const acceptContrast = contrastOf(accept);
      const declineContrast = contrastOf(decline);

      let contrastAsym = 0;
      let contrastEvidence: number | undefined;
      if (acceptContrast !== null && declineContrast !== null && declineContrast > 0) {
        const ratio = acceptContrast / declineContrast;
        contrastEvidence = ratio;
        if (ratio > CONTRAST_RATIO_THRESHOLD) contrastAsym = 1;
      }

      const areaRatio = area(accept) / area(decline);
      const areaAsym = areaRatio > AREA_RATIO_THRESHOLD ? 1 : 0;

      const weightDelta = accept.style.fontWeight - decline.style.fontWeight;
      const weightAsym = weightDelta >= 200 ? 1 : 0;

      if (contrastAsym === 0 && areaAsym === 0 && weightAsym === 0) continue;

      const c = candidate(
        interferenceDetector.id,
        "interference.visual_asymmetry",
        accept,
        {
          contrastAsymmetry: contrastAsym,
          areaAsymmetry: areaAsym,
          weightAsymmetry: weightAsym,
          bothPresent: 1,
        },
        WEIGHTS,
        [labelOf(accept).slice(0, 40), labelOf(decline).slice(0, 40)],
      );

      // Carry the measured numbers as evidence — they are the entire claim.
      c.evidence.computedStyle = {
        ...c.evidence.computedStyle,
        ...(contrastEvidence !== undefined ? { contrastRatio: contrastEvidence } : {}),
        renderedArea: areaRatio,
        fontWeight: weightDelta,
      };

      out.push(c);
    }

    return out;
  },
};
