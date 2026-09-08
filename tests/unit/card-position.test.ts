import { describe, expect, it } from "vitest";
import { type Control, cardSize, choosePlacement, positionOf, type Rect } from "@/content/ui/card";

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

/** The fixture's checkout button: fixed at right:32px bottom:32px, ~150x48. Critical. */
const CHECKOUT_BUTTON: Control = { left: 1098, top: 720, right: 1248, bottom: 768 };

function footprint(itemCount: number, controls: readonly Control[]): Rect | null {
  const p = choosePlacement(controls, VIEWPORT, itemCount);
  if (p.mode === "suppressed") return null;
  return {
    left: p.position.left,
    top: p.position.top,
    right: p.position.left + p.size.w,
    bottom: p.position.top + p.size.h,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

describe("digest card placement", () => {
  it("moves away from a checkout button sitting in the default corner", () => {
    const box = footprint(2, [CHECKOUT_BUTTON]);
    expect(box).not.toBeNull();
    expect(overlaps(box as Rect, CHECKOUT_BUTTON)).toBe(false);
  });

  it("detects the collision a 4x4 sample grid missed", () => {
    // The exact geometry the sample grid reported as clear.
    const card = cardSize(2, VIEWPORT);
    const bottomRight = positionOf({ h: "right", v: "bottom" }, VIEWPORT, card);
    const box = {
      left: bottomRight.left,
      top: bottomRight.top,
      right: bottomRight.left + card.w,
      bottom: bottomRight.top + card.h,
    };
    expect(overlaps(box, CHECKOUT_BUTTON)).toBe(true);
  });

  it("keeps the default corner when nothing is in the way", () => {
    const p = choosePlacement([], VIEWPORT, 2);
    expect(p.anchor).toEqual({ h: "right", v: "bottom" });
  });

  it("never covers a critical control, for 1 to 4 items", () => {
    for (let items = 1; items <= 4; items++) {
      const box = footprint(items, [CHECKOUT_BUTTON]);
      if (box === null) continue;
      expect(overlaps(box, CHECKOUT_BUTTON), `${items} items`).toBe(false);
    }
  });

  it("clamps the card to the viewport on a narrow screen", () => {
    const small = { w: 320, h: 560 };
    const card = cardSize(4, small);
    expect(card.w).toBeLessThanOrEqual(small.w - 32);
    expect(card.h).toBeLessThanOrEqual(small.h - 32);
  });
});

/**
 * The reason the product showed nothing for six sites running.
 *
 * The old rule was "cover nothing clickable". On a real storefront the header, footer and
 * nav fill every corner with links, so the rule was unsatisfiable and 60% of measured
 * samples suppressed. These tests pin the corrected rule: purchase-path controls and form
 * fields are inviolable; ordinary links are a preference, not a veto.
 */
describe("dense-page placement (the six-sites-no-card bug)", () => {
  /** A storefront chrome: header nav, footer links, a chat bubble. None purchase-critical. */
  const CHROME: Control[] = [
    { left: 0, top: 0, right: 1280, bottom: 72, critical: false }, // header nav
    { left: 0, top: 700, right: 1280, bottom: 800, critical: false }, // footer links
    { left: 1180, top: 620, right: 1250, bottom: 690, critical: false }, // chat bubble
  ];

  it("renders a card on a page whose every corner has an ordinary link", () => {
    const p = choosePlacement(CHROME, VIEWPORT, 3);
    expect(p.mode).toBe("card");
  });

  it("still refuses when the obstruction is a purchase-path control", () => {
    const wall: Control[] = [{ left: 0, top: 0, right: 1280, bottom: 800 }];
    expect(choosePlacement(wall, VIEWPORT, 4).mode).toBe("suppressed");
  });

  it("treats an untiered control as critical, so a careless caller gets the safe answer", () => {
    const untiered: Control[] = [{ left: 0, top: 0, right: 1280, bottom: 800 }];
    expect(choosePlacement(untiered, VIEWPORT, 1).mode).toBe("suppressed");
  });

  it("prefers the position covering the fewest ordinary controls", () => {
    // Bottom-right has three ordinary links in it; bottom-left has one.
    const controls: Control[] = [
      { left: 900, top: 600, right: 1280, bottom: 800, critical: false },
      { left: 900, top: 400, right: 1280, bottom: 600, critical: false },
      { left: 700, top: 600, right: 900, bottom: 800, critical: false },
      { left: 0, top: 0, right: 1280, bottom: 400, critical: false },
    ];
    const p = choosePlacement(controls, VIEWPORT, 1);
    expect(p.mode).toBe("card");
    expect(p.anchor.h).toBe("left");
  });

  it("keeps clear of a checkout button even when it must cover ordinary links", () => {
    const controls: Control[] = [...CHROME, CHECKOUT_BUTTON];
    const p = choosePlacement(controls, VIEWPORT, 4);
    if (p.mode === "suppressed") return;
    const box = {
      left: p.position.left,
      top: p.position.top,
      right: p.position.left + p.size.w,
      bottom: p.position.top + p.size.h,
    };
    expect(overlaps(box, CHECKOUT_BUTTON)).toBe(false);
  });

  it("uses the middle and centre anchors when both top and bottom bands are critical", () => {
    const bands: Control[] = [
      { left: 0, top: 0, right: 1280, bottom: 300 },
      { left: 0, top: 620, right: 1280, bottom: 800 },
    ];
    const p = choosePlacement(bands, VIEWPORT, 1);
    expect(p.mode).not.toBe("suppressed");
    expect(p.position.top).toBeGreaterThanOrEqual(300);
    expect(p.position.top + p.size.h).toBeLessThanOrEqual(620);
  });
});
