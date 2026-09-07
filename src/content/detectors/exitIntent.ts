/**
 * loss_aversion.exit_intent
 *
 * A modal inserted within 500ms of the pointer leaving toward the top of the viewport, or of
 * the tab being hidden. The offer is framed as something about to be lost rather than gained,
 * which is the prospect-theory asymmetry.
 *
 * The timing is the signal and it comes from the observer — a pure detector has no clock.
 * Copy matching alone would fire on any "Wait!" text anywhere on the page.
 */
import type { DetectionCandidate } from "@/shared/schema";
import type { Detector, PageContext } from "../types";
import { candidate, matchLexemes, visibleCandidates } from "./util";

const EXIT_COPY = [
  "wait",
  "don't go",
  "dont go",
  "before you go",
  "before you leave",
  "leaving so soon",
  "hold on",
  "one more thing",
  "your cart is waiting",
  "still thinking",
  "don't miss",
] as const;

const WEIGHTS: Record<string, number> = {
  modalOnExit: 0.6,
  exitCopy: 0.3,
  hasOffer: 0.2,
};

export const exitIntentDetector: Detector = {
  id: "loss_aversion.exit_intent@1",
  patternId: "loss_aversion.exit_intent",
  stages: ["browse", "pdp", "cart", "checkout"],

  run(ctx: PageContext): DetectionCandidate[] {
    const paths = new Set(ctx.signals.exitIntentModals);
    if (paths.size === 0) return [];

    const out: DetectionCandidate[] = [];

    for (const n of visibleCandidates(ctx)) {
      // The recorded modal is an ancestor-or-self of the copy we want to point at.
      const insideExitModal = [...paths].some(
        (p) => n.selectorPath === p || n.selectorPath.startsWith(`${p}>`),
      );
      if (!insideExitModal) continue;

      const hits = matchLexemes(n, EXIT_COPY);
      const hasOffer = /\b\d{1,2}%\s*off\b|\bfree shipping\b|\bcoupon\b|\bdiscount\b/.test(
        n.normalizedText,
      );

      if (hits.length === 0 && !hasOffer) continue;

      out.push(
        candidate(
          exitIntentDetector.id,
          "loss_aversion.exit_intent",
          n,
          {
            modalOnExit: 1,
            exitCopy: hits.length > 0 ? 1 : 0,
            hasOffer: hasOffer ? 1 : 0,
          },
          WEIGHTS,
          hits,
        ),
      );
      break; // one per modal is enough
    }

    return out;
  },
};
