import { describe, expect, it } from "vitest";
import { contrastRatio, parseColor, relativeLuminance } from "@/content/contrast";
import { decoyDetector } from "@/content/detectors/decoy";
import { exitIntentDetector } from "@/content/detectors/exitIntent";
import { framingDetector } from "@/content/detectors/framing";
import { interferenceDetector } from "@/content/detectors/interference";
import { naggingDetector } from "@/content/detectors/nagging";
import type { CandidateNode } from "@/content/types";
import { contextFrom } from "./helpers";

/** jsdom computes no real colours or boxes; apply what a browser would report. */
function style(n: CandidateNode, patch: Partial<CandidateNode["style"]>): void {
  Object.assign(n.style as unknown as Record<string, unknown>, patch);
}
function box(n: CandidateNode, w: number, h: number): void {
  (n as { box: CandidateNode["box"] }).box = { x: 0, y: 100, w, h };
}

describe("contrast math", () => {
  it("parses rgb, rgba and hex", () => {
    expect(parseColor("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 0.5)")?.a).toBe(0.5);
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#336699")).toEqual({ r: 51, g: 102, b: 153, a: 1 });
  });

  it("returns null on an unparseable colour rather than guessing", () => {
    expect(parseColor("color-mix(in srgb, red, blue)")).toBeNull();
  });

  it("computes the WCAG extremes correctly", () => {
    // Black on white is the maximum ratio, 21:1. This is the standard's own anchor point.
    expect(contrastRatio("rgb(0,0,0)", "rgb(255,255,255)")).toBeCloseTo(21, 1);
    expect(contrastRatio("rgb(255,255,255)", "rgb(255,255,255)")).toBeCloseTo(1, 5);
  });

  it("orders luminance the way perception does", () => {
    const white = relativeLuminance({ r: 255, g: 255, b: 255, a: 1 });
    const green = relativeLuminance({ r: 0, g: 255, b: 0, a: 1 });
    const blue = relativeLuminance({ r: 0, g: 0, b: 255, a: 1 });
    expect(white).toBeGreaterThan(green);
    expect(green).toBeGreaterThan(blue);
  });

  it("composites a translucent foreground before measuring", () => {
    const solid = contrastRatio("rgba(0,0,0,1)", "rgb(255,255,255)") ?? 0;
    const faded = contrastRatio("rgba(0,0,0,0.2)", "rgb(255,255,255)") ?? 0;
    expect(faded).toBeLessThan(solid);
  });
});

describe("interference.visual_asymmetry", () => {
  it("fires when accept dwarfs decline in contrast and area", () => {
    const ctx = contextFrom(
      `<div class="modal">
         <button id="a">Get 20% off</button>
         <button id="d">No thanks, maybe later</button>
       </div>`,
      { stage: "pdp" },
    );
    for (const n of ctx.candidates) {
      if (n.attrs.id === "a") {
        style(n, {
          color: "rgb(255,255,255)",
          effectiveBackground: "rgb(0,90,200)",
          fontWeight: 700,
        });
        box(n, 220, 48);
      }
      if (n.attrs.id === "d") {
        style(n, {
          color: "rgb(200,200,200)",
          effectiveBackground: "rgb(255,255,255)",
          fontWeight: 400,
        });
        box(n, 90, 20);
      }
    }
    const out = interferenceDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.areaAsymmetry).toBe(1);
    expect(out[0]?.evidence.computedStyle?.contrastRatio).toBeGreaterThan(1);
  });

  it("does NOT fire when both controls are presented evenly", () => {
    const ctx = contextFrom(
      `<div><button id="a">Continue</button><button id="d">No thanks, cancel</button></div>`,
    );
    for (const n of ctx.candidates) {
      style(n, {
        color: "rgb(20,20,20)",
        effectiveBackground: "rgb(255,255,255)",
        fontWeight: 500,
      });
      box(n, 140, 40);
    }
    expect(interferenceDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on a bare × close glyph", () => {
    // A small × is a universal convention, not a designed asymmetry. Flagging it fires everywhere.
    const ctx = contextFrom(
      `<div><button id="a">Subscribe</button><button id="d">×</button></div>`,
    );
    for (const n of ctx.candidates) {
      if (n.attrs.id === "a") box(n, 220, 48);
      if (n.attrs.id === "d") box(n, 16, 16);
    }
    expect(interferenceDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire when there is no decline control at all", () => {
    const ctx = contextFrom(`<div><button>Add to cart</button><button>Buy now</button></div>`);
    expect(interferenceDetector.run(ctx)).toHaveLength(0);
  });
});

describe("decoy.asymmetric_dominance", () => {
  it("flags a best-value badge on a worse unit price", () => {
    const ctx = contextFrom(
      `<div class="plans">
         <div>1 month $12.00</div>
         <div>6 months $66.00 Most popular</div>
         <div>12 months $96.00</div>
       </div>`,
      { stage: "pdp" },
    );
    const out = decoyDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.badgeOnWorseUnitPrice).toBe(1);
  });

  it("does NOT fire when the badge sits on the genuine best value", () => {
    const ctx = contextFrom(
      `<div><div>1 month $12.00</div><div>12 months $96.00 Best value</div></div>`,
      { stage: "pdp" },
    );
    expect(decoyDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on a single option", () => {
    const ctx = contextFrom(`<div><div>12 months $96.00</div></div>`, { stage: "pdp" });
    expect(decoyDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire when quantity cannot be read", () => {
    // Without a denominator there is no unit price, so there is no claim to make.
    const ctx = contextFrom(`<div><div>Basic $12.00</div><div>Pro $96.00</div></div>`, {
      stage: "pdp",
    });
    expect(decoyDetector.run(ctx)).toHaveLength(0);
  });
});

describe("nagging.repeat_interstitial", () => {
  it("fires at two interstitials", () => {
    const ctx = contextFrom(`<p>Some page content here</p>`, {
      signals: { modalInsertionCount: 2, modalsInsertedAt: [1000, 40_000] },
    });
    expect(naggingDetector.run(ctx)).toHaveLength(1);
  });

  it("does NOT fire at one", () => {
    const ctx = contextFrom(`<p>Some page content here</p>`, {
      signals: { modalInsertionCount: 1, modalsInsertedAt: [1000] },
    });
    expect(naggingDetector.run(ctx)).toHaveLength(0);
  });

  it("scores rapid succession above spaced-out prompts", () => {
    const spaced = contextFrom(`<p>Some page content here</p>`, {
      signals: { modalInsertionCount: 2, modalsInsertedAt: [1000, 90_000] },
    });
    const rapid = contextFrom(`<p>Some page content here</p>`, {
      signals: { modalInsertionCount: 2, modalsInsertedAt: [1000, 4000] },
    });
    const a = naggingDetector.run(spaced)[0]?.rawScore ?? 0;
    const b = naggingDetector.run(rapid)[0]?.rawScore ?? 0;
    expect(b).toBeGreaterThan(a);
  });

  it("emits at most one candidate, nagging is a page property", () => {
    const ctx = contextFrom(`<div><p>One $1.00</p><p>Two $2.00</p><p>Three $3.00</p></div>`, {
      signals: { modalInsertionCount: 3, modalsInsertedAt: [1, 2, 3] },
    });
    expect(naggingDetector.run(ctx).length).toBeLessThanOrEqual(1);
  });
});

describe("loss_aversion.exit_intent", () => {
  it("fires on a modal inserted at the exit gesture", () => {
    const ctx = contextFrom(`<div id="m"><p>Wait! Here is 10% off</p></div>`, {
      signals: { exitIntentModals: ["#m"], lastExitIntentAt: 1000 },
    });
    const out = exitIntentDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.modalOnExit).toBe(1);
  });

  it("does NOT fire on the same copy with no exit gesture recorded", () => {
    // Copy alone would match any "Wait!" anywhere on the page. The timing is the signal.
    const ctx = contextFrom(`<div id="m"><p>Wait! Here is 10% off</p></div>`);
    expect(exitIntentDetector.run(ctx)).toHaveLength(0);
  });
});

describe("framing.savings_ratio", () => {
  it("flags a percentage framing that flatters a small absolute saving", () => {
    // $12 -> $9 is $3 off but 25% off. The percentage is the bigger-looking number.
    const ctx = contextFrom(`<div><span>$12.00</span><span>$9.00</span><span>25% off</span></div>`);
    const out = framingDetector.run(ctx);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]?.subSignals.percentFramingFlatters).toBe(1);
  });

  it("does NOT fire when the two framings are comparable", () => {
    // $100 -> $50 is $50 off and 50% off. Neither framing flatters.
    const ctx = contextFrom(
      `<div><span>$100.00</span><span>$50.00</span><span>50% off</span></div>`,
    );
    expect(framingDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire without a savings claim at all", () => {
    const ctx = contextFrom(`<div><span>$12.00</span><span>$9.00</span></div>`);
    expect(framingDetector.run(ctx)).toHaveLength(0);
  });
});
