import { describe, expect, it } from "vitest";
import { DETECTORS } from "@/content/detectors";
import { contextFrom } from "./helpers";

/**
 * Copy the live audit caught a detector firing on, and should not.
 *
 * `npm run spot:check` loads the extension into Chromium and records every claim it makes on
 * real pages. Every case here came out of a run of it, which is the only instrument in the
 * project that covers the STRUCTURAL detectors — the labelled corpus is text, and says
 * nothing about anchoring, framing, nagging, interference or decoy, which are half the
 * shipped set.
 *
 * A false positive is the failure that gets an extension uninstalled. Nobody notices a miss.
 */

const score = (text: string, patternId: string): number => {
  const ctx = contextFrom(`<div class="cart">${text}</div>`, { stage: "cart" });
  return Math.max(
    0,
    ...DETECTORS.flatMap((d) => d.run(ctx))
      .filter((h) => h.patternId === patternId)
      .map((h) => h.rawScore),
  );
};

const LOG_THRESHOLD = 0.35;

describe("social_proof does not read years or follower counts as viewers", () => {
  /**
   * The "LIVE • 279" rule was written for one observed string and over-fired the same day:
   * `\blive\b[^a-z0-9]{0,4}(\d{2,6})\b` matched "Live 2026" and "Live 768 followers" across
   * Eventbrite. A rule generalised from a single example deserves the narrowest form that
   * still covers the example.
   */
  const SILENT = [
    "From Day One - Los Angeles Live 2026: Marketing",
    "Save this event: From Day One - Los Angeles Live 2026",
    "Pace Live 768 followers",
    "Live from the studio",
    "Watch live",
  ];
  for (const text of SILENT) {
    it(`stays silent on ${JSON.stringify(text)}`, () => {
      expect(score(text, "social_proof.live_activity")).toBeLessThan(LOG_THRESHOLD);
    });
  }

  const FIRES = [
    "LIVE • 279",
    "LIVE 340 watching",
    "505 people have purchased this in the last 3 hours!",
  ];
  for (const text of FIRES) {
    it(`still fires on ${JSON.stringify(text)}`, () => {
      expect(score(text, "social_proof.live_activity")).toBeGreaterThanOrEqual(LOG_THRESHOLD);
    });
  }
});

describe("framing quotes the prices it scored, not a sibling", () => {
  it("claims a product tile once, and evidences it with the prices", () => {
    /**
     * A Zappos grid tile produced FIVE firings from one was/now price pair, evidenced as
     * "370", "237v1", "WL574V2", "603" and "V5 Runner" — New Balance model numbers, which is
     * what the sibling spans inside the tile contain. The detector scores `containerText`
     * and was attributing to the node it happened to attach to.
     *
     * Both halves were wrong: one claim counted five times, and a card that would name the
     * pattern and then quote a model number as its proof.
     */
    const ctx = contextFrom(
      `<div class="tile"><span>New Balance</span><span>530</span><span>V5 Runner</span>` +
        `<span class="was">$109.95</span><span class="now">$54.95</span><span>50% off</span></div>`,
      { stage: "browse" },
    );
    const hits = DETECTORS.flatMap((d) => d.run(ctx)).filter(
      (h) => h.patternId === "framing.savings_ratio",
    );

    expect(hits.length, "one price pair produced more than one claim").toBeLessThanOrEqual(1);
    if (hits.length === 1) {
      const quoted = hits[0]?.evidence.textSample ?? "";
      expect(quoted, `evidence quoted a sibling, not the prices: ${quoted}`).toMatch(/\d+\.\d{2}/);
    }
  });
});
