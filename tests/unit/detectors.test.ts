import { describe, expect, it } from "vitest";
import { anchoringDetector } from "@/content/detectors/anchoring";
import { charmDetector } from "@/content/detectors/charm";
import { defaultsDetector } from "@/content/detectors/defaults";
import { scarcityDetector } from "@/content/detectors/scarcity";
import { urgencyDetector } from "@/content/detectors/urgency";
import { classifyStage, explainStage } from "@/content/funnel";
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

/**
 * Funnel classifier.
 *
 * The three "field" cases below are transcriptions of pages where the URL-weighted
 * classifier was wrong during the manual spot-check (EVAL.md). They are the reason the
 * weights were inverted, so they are the tests that must not be quietly relaxed.
 */
describe("funnel classifier", () => {
  const stageOf = (html: string, url: string) => {
    document.body.innerHTML = html;
    return classifyStage(url, readDocumentMeta(document, url));
  };

  it("classifies a payment page from a cc-number field, not the URL", () => {
    expect(
      stageOf(`<form><input autocomplete="cc-number"></form>`, "https://shop.example.com/step3"),
    ).toBe("payment");
  });

  it("classifies a checkout page from an address cluster", () => {
    expect(
      stageOf(
        `<form>
           <input autocomplete="address-line1"><input autocomplete="address-level2">
           <input autocomplete="postal-code">
         </form>`,
        "https://shop.example.com/x",
      ),
    ).toBe("checkout");
  });

  it("classifies a PDP from Product JSON-LD plus a single add-to-cart", () => {
    expect(
      stageOf(
        `<script type="application/ld+json">{"@type":"Product","name":"x"}</script>
         <div>$24.00</div><button>Add to bag</button>`,
        "https://shop.example.com/products/x",
      ),
    ).toBe("pdp");
  });

  it("classifies a listing from a grid of add-to-cart buttons", () => {
    const card = `<li><span>$24.00</span><button>Add to cart</button></li>`;
    expect(stageOf(`<ul>${card.repeat(6)}</ul>`, "https://shop.example.com/collections/all")).toBe(
      "browse",
    );
  });

  // ---- field cases ----

  it("field: a Shopify bag drawer on a /products/ URL is a cart, not a PDP", () => {
    // Glossier. The drawer opens over the product page, so the path never changes and the
    // Product JSON-LD is still in the head. Editable line items outrank both.
    expect(
      stageOf(
        `<script type="application/ld+json">{"@type":"Product","name":"Futuredew"}</script>
         <aside>
           <div class="line"><span>Futuredew</span><span>$26.00</span>
             <input type="number" value="1" aria-label="Quantity">
             <button>Remove</button></div>
           <p><span>Subtotal</span><span>$26.00</span></p>
           <button>Checkout</button>
         </aside>`,
        "https://www.glossier.com/products/futuredew",
      ),
    ).toBe("cart");
  });

  it("field: a Ticketmaster ticket-select page is a cart, not a PDP", () => {
    // /event/<id> throughout, no remove control, and the CTA is "Reserve" rather than
    // anything containing the word checkout.
    expect(
      stageOf(
        `<div class="sel"><span>2 tickets</span><span>$270.00</span>
           <select name="qty"><option>2</option></select></div>
         <p><span>Subtotal</span><span>$270.00</span></p>
         <button>Reserve Tickets</button>`,
        "https://www.ticketmaster.com/event/0500648A9C927EA6",
      ),
    ).toBe("cart");
  });

  it("field: an airline fare-selection page is a cart, not browse", () => {
    // Frontier. No cart markup and no product schema, but a running trip total and step
    // chrome. Asserting the signals as well as the stage: an earlier version of this test
    // only checked `not browse`, and passed while both signals were silently reading zero.
    const html = `<nav>Flights &gt; Bundle &gt; Seats &gt; Payment</nav>
       <div><span>Trip total</span><span>$118.00</span></div>
       <div><span>Taxes and fees</span><span>$41.00</span></div>
       <button>Continue to payment</button>`;
    const url = "https://www.flyfrontier.com/booking/bundle";
    document.body.innerHTML = html;
    const meta = readDocumentMeta(document, url);
    expect(meta.moneySummaryRows).toBeGreaterThanOrEqual(2);
    expect(meta.hasStepIndicator).toBe(true);
    expect(classifyStage(url, meta)).toBe("cart");
  });

  it("a cart wrapper is not counted alongside the rows it wraps", () => {
    document.body.innerHTML = `
      <div id="wrap">
        <div class="row"><span>$10.00</span><button>Remove</button></div>
        <div class="row"><span>$20.00</span><button>Remove</button></div>
      </div>`;
    const meta = readDocumentMeta(document, "https://shop.example.com/cart");
    expect(meta.cartLineItems).toBe(2);
  });

  it("survives malformed JSON-LD without throwing", () => {
    document.body.innerHTML = `<script type="application/ld+json">{not json</script>`;
    expect(() => readDocumentMeta(document, "https://shop.example.com/x")).not.toThrow();
  });

  it("explains its decision", () => {
    document.body.innerHTML = `<form><input autocomplete="cc-number"></form>`;
    const url = "https://shop.example.com/pay";
    const { stage, reasons } = explainStage(url, readDocumentMeta(document, url));
    expect(stage).toBe("payment");
    expect(reasons.join(" ")).toContain("card-number field");
  });
});
