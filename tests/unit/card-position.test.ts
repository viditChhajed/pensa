import { describe, expect, it } from "vitest";
import { cardSize, chooseCorner, type Rect } from "@/content/ui/card";

/**
 * Regression net for the failure the plan called non-negotiable: the overlay must never be
 * able to cover a checkout button.
 *
 * This was found in a real browser, not in theory. With the card fixed at bottom-right and
 * `pointer-events: none` on the host, `document.elementFromPoint` at a bottom-right checkout
 * button's centre returned the overlay — because the card inside re-enables pointer events,
 * so wherever the card actually paints, it wins the hit test.
 *
 * The first fix (a 4x4 sample grid) ALSO failed, and worse, failed silently: 74px vertical
 * steps stepped over a 48px-tall button and reported the corner clear. Hence exact rects.
 */
const VIEWPORT = { w: 1280, h: 800 };

/** The fixture's checkout button: fixed at right:32px bottom:32px, ~150x48. */
const CHECKOUT_BUTTON: Rect = { left: 1098, top: 720, right: 1248, bottom: 768 };

function footprint(corner: ReturnType<typeof chooseCorner>, itemCount: number): Rect {
  const card = cardSize(itemCount, VIEWPORT);
  const left = corner.horizontal === "right" ? VIEWPORT.w - 16 - card.w : 16;
  const top = corner.vertical === "bottom" ? VIEWPORT.h - 16 - card.h : 16;
  return { left, top, right: left + card.w, bottom: top + card.h };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

describe("digest card placement", () => {
  it("moves away from a checkout button sitting in the default corner", () => {
    const corner = chooseCorner([CHECKOUT_BUTTON], VIEWPORT, cardSize(2, VIEWPORT));
    expect(corner.vertical === "bottom" && corner.horizontal === "right").toBe(false);
    expect(overlaps(footprint(corner, 2), CHECKOUT_BUTTON)).toBe(false);
  });

  it("detects the collision a 4x4 sample grid missed", () => {
    // The exact geometry the sample grid reported as clear.
    const bottomRight = { horizontal: "right", vertical: "bottom" } as const;
    expect(overlaps(footprint(bottomRight, 2), CHECKOUT_BUTTON)).toBe(true);
  });

  it("keeps the default corner when nothing is in the way", () => {
    const corner = chooseCorner([], VIEWPORT, cardSize(2, VIEWPORT));
    expect(corner).toEqual({ horizontal: "right", vertical: "bottom" });
  });

  it("never covers a control at any corner count, for 1 to 4 items", () => {
    for (let items = 1; items <= 4; items++) {
      const corner = chooseCorner([CHECKOUT_BUTTON], VIEWPORT, cardSize(items, VIEWPORT));
      expect(overlaps(footprint(corner, items), CHECKOUT_BUTTON)).toBe(false);
    }
  });

  it("picks the least-obstructed corner when every corner has something", () => {
    // A sticky bar across the bottom plus a single top-right control: top-left is cleanest.
    const controls: Rect[] = [
      { left: 0, top: 700, right: 1280, bottom: 800 }, // full-width sticky footer
      { left: 1100, top: 0, right: 1260, bottom: 60 }, // top-right control
      { left: 1100, top: 60, right: 1260, bottom: 120 }, // second top-right control
    ];
    const corner = chooseCorner(controls, VIEWPORT, cardSize(2, VIEWPORT));
    expect(corner).toEqual({ horizontal: "left", vertical: "top" });
  });

  it("always returns a corner, even when the whole viewport is covered", () => {
    const everything: Rect = { left: 0, top: 0, right: 1280, bottom: 800 };
    const corner = chooseCorner([everything], VIEWPORT, cardSize(4, VIEWPORT));
    expect(CORNER_KEYS).toContain(`${corner.vertical}-${corner.horizontal}`);
  });

  it("clamps the card to the viewport on a narrow screen", () => {
    const small = { w: 320, h: 560 };
    const card = cardSize(4, small);
    expect(card.w).toBeLessThanOrEqual(small.w - 32);
    expect(card.h).toBeLessThanOrEqual(small.h - 32);
  });
});

const CORNER_KEYS = ["bottom-right", "bottom-left", "top-right", "top-left"];
