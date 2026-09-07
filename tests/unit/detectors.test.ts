import { describe, expect, it } from "vitest";
import { anchoringDetector } from "@/content/detectors/anchoring";
import { charmDetector } from "@/content/detectors/charm";
import { defaultsDetector } from "@/content/detectors/defaults";
import { scarcityDetector } from "@/content/detectors/scarcity";
import { urgencyDetector } from "@/content/detectors/urgency";
import { classifyStage } from "@/content/funnel";
import { readDocumentMeta } from "@/content/harvest";
import { applyStrike, contextFrom } from "./helpers";

describe("anchoring.reference_price", () => {
  it("fires on a struck-through was/now pair", () => {
    const ctx = contextFrom(
      `<div class="price"><del>$89.99</del> <span>$49.99</span> <span>45% off</span></div>`,
      { stage: "pdp", patch: applyStrike },
    );
    const out = anchoringDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.rawScore).toBeGreaterThan(0.75);
  });

  it('fires on "Was $X" lexeme wording', () => {
    const ctx = contextFrom(
      `<div><span class="was">Was <s>$120.00</s></span><span>$79.00</span></div>`,
      { stage: "pdp", patch: applyStrike },
    );
    expect(anchoringDetector.run(ctx).length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT fire on a single price", () => {
    const ctx = contextFrom(`<div><span>$49.99</span></div>`);
    expect(anchoringDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on two prices when neither is struck", () => {
    const ctx = contextFrom(`<div><span>$49.99</span><span>$89.99</span></div>`);
    expect(anchoringDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire when the struck price is LOWER than the live one", () => {
    // A rendering artifact, not an anchor. Firing here would be a false accusation.
    const ctx = contextFrom(`<div><del>$19.99</del> <span>$49.99</span></div>`, {
      stage: "pdp",
      patch: applyStrike,
    });
    expect(anchoringDetector.run(ctx)).toHaveLength(0);
  });
});

describe("scarcity.stock", () => {
  it('fires on "Only 3 left"', () => {
    const ctx = contextFrom(`<p class="stock">Only 3 left in stock</p>`);
    const out = scarcityDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.numericStock).toBe(1);
  });

  it("fires on qualitative scarcity copy", () => {
    const ctx = contextFrom(`<p>Selling fast</p>`);
    expect(scarcityDetector.run(ctx)).toHaveLength(1);
  });

  it('does NOT fire on genuine variant availability — "2 sizes left"', () => {
    // The exact false positive that makes someone uninstall (plan §8).
    const ctx = contextFrom(`<p>2 sizes left</p>`);
    expect(scarcityDetector.run(ctx)).toHaveLength(0);
  });

  it('does NOT fire on "3 colors available"', () => {
    const ctx = contextFrom(`<p>3 colors available</p>`);
    expect(scarcityDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on ordinary product copy", () => {
    const ctx = contextFrom(`<p>Ships in 3 business days</p>`);
    expect(scarcityDetector.run(ctx)).toHaveLength(0);
  });
});

describe("urgency.countdown", () => {
  it("fires when a clock-shaped node was observed decrementing", () => {
    const ctx = contextFrom(`<div class="timer">02:14:31</div>`);
    const node = ctx.candidates.find((c) => c.text.includes("02:14:31"));
    (node as unknown as { textHistory: { t: number; text: string }[] }).textHistory = [
      { t: 0, text: "02:14:33" },
      { t: 1000, text: "02:14:32" },
      { t: 2000, text: "02:14:31" },
    ];
    const out = urgencyDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.decrementing).toBe(1);
  });

  it("fires on explicit urgency wording", () => {
    const ctx = contextFrom(`<div>Deal ends in 04:12</div>`);
    expect(urgencyDetector.run(ctx).length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT fire on a static clock-shaped string with no decrement", () => {
    // Store hours and video durations are clock-shaped. The decrement is the signal.
    const ctx = contextFrom(`<div>Open until 21:00</div>`);
    expect(urgencyDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on a video duration", () => {
    const ctx = contextFrom(`<span>3:45</span>`);
    expect(urgencyDetector.run(ctx)).toHaveLength(0);
  });
});

describe("defaults.preselected", () => {
  it("fires on a preselected protection plan", () => {
    const ctx = contextFrom(
      `<label><input type="checkbox" checked name="warranty"> Add 2-year protection plan $12.99</label>`,
      { stage: "checkout" },
    );
    const out = defaultsDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.hasPrice).toBe(1);
  });

  it("fires on a preselected marketing opt-in", () => {
    const ctx = contextFrom(
      `<label><input type="checkbox" checked> Send me promotional emails</label>`,
      { stage: "checkout" },
    );
    expect(defaultsDetector.run(ctx)).toHaveLength(1);
  });

  it("does NOT fire on an UNchecked add-on", () => {
    const ctx = contextFrom(
      `<label><input type="checkbox"> Add 2-year protection plan $12.99</label>`,
      { stage: "checkout" },
    );
    expect(defaultsDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on a benign preselected checkbox", () => {
    const ctx = contextFrom(`<label><input type="checkbox" checked> Remember me</label>`, {
      stage: "checkout",
    });
    expect(defaultsDetector.run(ctx)).toHaveLength(0);
  });
});

describe("pricing.charm", () => {
  it("fires on a .99 price", () => {
    const ctx = contextFrom(`<div class="price">$19.99</div>`);
    expect(charmDetector.run(ctx)).toHaveLength(1);
  });

  it("does NOT fire on a round price", () => {
    const ctx = contextFrom(`<div class="price">$20.00</div>`);
    expect(charmDetector.run(ctx)).toHaveLength(0);
  });

  it("emits at most one candidate per page", () => {
    const ctx = contextFrom(`<div><span>$19.99</span><span>$4.99</span><span>$34.95</span></div>`);
    expect(charmDetector.run(ctx).length).toBeLessThanOrEqual(1);
  });
});

describe("funnel classifier", () => {
  it("classifies a payment page from a cc-number field, not the URL", () => {
    document.body.innerHTML = `<form><input autocomplete="cc-number"></form>`;
    const meta = readDocumentMeta(document, "https://shop.example.com/step3");
    expect(classifyStage("https://shop.example.com/step3", meta)).toBe("payment");
  });

  it("classifies a cart page from the path", () => {
    document.body.innerHTML = "<div></div>";
    const meta = readDocumentMeta(document, "https://shop.example.com/cart");
    expect(classifyStage("https://shop.example.com/cart", meta)).toBe("cart");
  });

  it("classifies a PDP from Product JSON-LD", () => {
    document.body.innerHTML = `<script type="application/ld+json">{"@type":"Product","name":"x"}</script>`;
    const meta = readDocumentMeta(document, "https://shop.example.com/x");
    expect(classifyStage("https://shop.example.com/x", meta)).toBe("pdp");
  });

  it("survives malformed JSON-LD without throwing", () => {
    document.body.innerHTML = `<script type="application/ld+json">{not json</script>`;
    expect(() => readDocumentMeta(document, "https://shop.example.com/x")).not.toThrow();
  });
});
