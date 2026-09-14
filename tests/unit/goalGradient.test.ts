import { describe, expect, it } from "vitest";
import { DETECTORS } from "@/content/detectors";
import { contextFrom } from "./helpers";

/**
 * Spend thresholds, against phrasings that were reported from memory rather than invented.
 *
 * "Only $30 until free shipping" scored exactly ZERO. So did "You're almost there! $8 to go".
 * Both are about as ordinary as this detector will ever see, and both were invisible because
 * "until" appeared in one pattern (`just … until`) and nowhere else.
 *
 * That is EVAL run 1's top finding repeating itself: the lexicon was written against copy I
 * imagined, the fixtures came out of the same imagination, and the tests therefore agreed
 * with themselves. The cases below came from somebody recalling what shops actually say,
 * which is the only reliable source for this — and the reason `npm run label` exists.
 *
 * The negatives are the load-bearing half. A THRESHOLD POLICY is not a goal gradient: "free
 * shipping on orders over $50" states a rule, names no remainder, and addresses nobody. If
 * this detector fires on that it fires on most carts on the internet, which is a broken
 * product rather than a sensitive one.
 */

const score = (text: string, stage: "cart" | "pdp" = "cart"): number => {
  const ctx = contextFrom(`<div class="cart">${text}</div>`, { stage });
  const hits = DETECTORS.flatMap((d) => d.run(ctx)).filter(
    (h) => h.patternId === "goal_gradient.threshold",
  );
  return Math.max(0, ...hits.map((h) => h.rawScore));
};

const SURFACE_THRESHOLD = 0.75;

describe("a personalised remainder fires", () => {
  const YES = [
    "You're $30 away from free shipping",
    "Add $30 more to get free shipping",
    "Spend $30 more to unlock free delivery",
    "$30 away from free shipping",
    "Add $2.77 more to cart for FREE STANDARD SHIPPING on SHEIN products!",
    // Reported from memory, and all four scored zero before this test existed.
    "Only $30 until free shipping",
    "You're almost there! $8 to go",
    "Only $12 more and shipping's on us",
    "$5 more to reach free delivery",
  ];

  for (const text of YES) {
    it(`fires on ${JSON.stringify(text)}`, () => {
      expect(score(text), "scored below the surface threshold").toBeGreaterThanOrEqual(
        SURFACE_THRESHOLD,
      );
    });
  }
});

describe("a policy statement does not", () => {
  const NO = [
    "Free shipping on orders over $50",
    "Free shipping",
    "Free returns within 30 days",
    "Shipping: $5.99",
    "Ships in 3 days",
    "Add to cart",
    "Only 3 left in stock",
    "Spend less, get more",
  ];

  for (const text of NO) {
    it(`stays silent on ${JSON.stringify(text)}`, () => {
      expect(score(text), "fired on copy with no personalised remainder").toBeLessThan(
        SURFACE_THRESHOLD,
      );
    });
  }
});
