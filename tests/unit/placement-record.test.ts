import { describe, expect, it } from "vitest";
import { type Control, choosePlacement } from "@/content/ui/card";
import { SuppressionReason } from "@/shared/schema";

/**
 * The record must distinguish "did not fire" from "fired but there was nowhere to put it".
 *
 * Without that split, a spot-check log cannot tell a THRESHOLD problem from a PLACEMENT
 * problem — both look like a detector that did nothing. Worse, the worker used to write
 * `surfaced: true` before the card attempted placement, so a suppressed digest was recorded
 * as shown and the popup's Noticed/Shown split was actively wrong.
 */
const VIEWPORT = { w: 1280, h: 800 };

describe("placement_suppressed is a first-class outcome", () => {
  it("exists in the suppression reason enum", () => {
    expect(SuppressionReason.options).toContain("placement_suppressed");
  });

  it("is distinct from every other reason a detection goes unshown", () => {
    // Each of these answers a different question during a spot-check.
    for (const r of [
      "below_salience_gate",
      "below_threshold",
      "dedup_family",
      "digest_full",
      "debounced",
      "user_disabled",
    ]) {
      expect(SuppressionReason.options).toContain(r);
      expect(r).not.toBe("placement_suppressed");
    }
  });
});

describe("choosePlacement degradation", () => {
  it("uses a full card when the page is clear", () => {
    expect(choosePlacement([], VIEWPORT, 4).mode).toBe("card");
  });

  it("falls back to a pill when only a small space is free", () => {
    // Occupy everything except a small bottom-left region.
    const controls: Control[] = [
      { left: 0, top: 0, right: 1280, bottom: 690 },
      { left: 400, top: 690, right: 1280, bottom: 800 },
    ];
    expect(choosePlacement(controls, VIEWPORT, 4).mode).toBe("pill");
  });

  it("suppresses rather than covering a control", () => {
    // The whole viewport is interactive — the real situation on a dense storefront.
    const controls: Control[] = [{ left: 0, top: 0, right: 1280, bottom: 800 }];
    expect(choosePlacement(controls, VIEWPORT, 4).mode).toBe("suppressed");
  });

  it("never returns a placement that overlaps a control", () => {
    const control: Control = { left: 1098, top: 720, right: 1248, bottom: 768 };
    for (let items = 1; items <= 4; items++) {
      const p = choosePlacement([control], VIEWPORT, items);
      if (p.mode === "suppressed") continue;
      const { left, top } = p.position;
      const overlaps =
        left < control.right &&
        left + p.size.w > control.left &&
        top < control.bottom &&
        top + p.size.h > control.top;
      expect(overlaps, `${p.mode} at ${p.anchor.v}-${p.anchor.h} overlaps`).toBe(false);
    }
  });

  it("prefers a smaller card over a pill when a smaller card fits", () => {
    // A 1-item card is shorter than a 4-item one and may fit where the full card cannot.
    const controls: Control[] = [{ left: 0, top: 0, right: 1280, bottom: 500 }];
    const four = choosePlacement(controls, VIEWPORT, 4);
    const one = choosePlacement(controls, VIEWPORT, 1);
    expect(one.mode).toBe("card");
    expect(["card", "pill", "suppressed"]).toContain(four.mode);
  });
});
