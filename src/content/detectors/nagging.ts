/**
 * nagging.repeat_interstitial
 *
 * Counts the modals/interstitials that BECAME VISIBLE per page-session, and flags at 2 or more.
 *
 * Visible, not inserted. The observer owns that distinction and the comment on `considerModal`
 * explains what it cost to learn twice: a cookie banner and the dim scrim behind it are two
 * elements and one interruption, and at `FLAG_AT = 2` that off-by-one was the entire
 * difference between this detector staying quiet and calling nearly every shop on the web a
 * nagger for showing one consent notice.
 *
 * Worth stating plainly: this extension itself shows an interstitial, which is why the
 * sensitivity control ships in v1 rather than v1.1. A tool that flags repeated interruption
 * while being one would deserve the criticism.
 *
 * One candidate per page maximum, nagging is a property of the page, not of a node.
 */
import type { DetectionCandidate } from "@/shared/schema";
import type { Detector, PageContext } from "../types";
import { createHash } from "./hash";
import { score } from "./util";

const FLAG_AT = 2;

const WEIGHTS: Record<string, number> = {
  repeatCount: 0.5,
  manyRepeats: 0.3,
  rapidSuccession: 0.25,
};

export const naggingDetector: Detector = {
  id: "nagging.repeat_interstitial@1",
  patternId: "nagging.repeat_interstitial",
  stages: ["browse", "pdp", "cart", "checkout"],

  run(ctx: PageContext): DetectionCandidate[] {
    const count = ctx.signals.modalInsertionCount;
    if (count < FLAG_AT) return [];

    // Two modals a minute apart is a site with a cookie banner and a newsletter prompt.
    // Two in ten seconds is a different experience.
    const times = ctx.signals.modalsInsertedAt;
    let rapid = 0;
    for (let i = 1; i < times.length; i++) {
      const prev = times[i - 1];
      const cur = times[i];
      if (prev !== undefined && cur !== undefined && cur - prev < 10_000) rapid = 1;
    }

    // Page-level evidence. This finding is about the page, not about any node, and it must
    // not depend on the harvester having produced a candidate, a page whose only content is
    // prose yields none, and that page can still nag.
    const subSignals = {
      repeatCount: 1,
      manyRepeats: count >= 3 ? 1 : 0,
      rapidSuccession: rapid,
    };
    const summary = `${count} interstitials`;

    return [
      {
        detectorId: naggingDetector.id,
        patternId: "nagging.repeat_interstitial",
        rawScore: score(subSignals, WEIGHTS),
        subSignals,
        evidence: {
          selectorPath: "(page)",
          textHash: createHash(summary),
          textSample: summary,
          matchedLexemes: [summary],
          boundingBox: { x: 0, y: 0, w: 0, h: 0 },
        },
        nodeRef: "(page)",
      },
    ];
  },
};
