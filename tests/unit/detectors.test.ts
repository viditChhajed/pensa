import { describe, expect, it } from "vitest";
import { anchoringDetector } from "@/content/detectors/anchoring";
import { bnplDetector } from "@/content/detectors/bnpl";
import { charmDetector } from "@/content/detectors/charm";
import { defaultsDetector } from "@/content/detectors/defaults";
import { goalGradientDetector } from "@/content/detectors/goalGradient";
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

/**
 * Regression net for the live Glossier failure: the bag drawer was open, visibly a cart, and
 * `cartLineItems` read 0, so the stage stayed `pdp` and the cross-stage detectors never ran.
 *
 * The cause was the innermost-row filter discarding the real row. Shopify nests the price in
 * its own div inside the row, so "skip anything containing a priced descendant" threw away
 * the row that held the controls and kept a leaf that held only a price.
 */
describe("cart line items — nested price markup", () => {
  it("counts a row whose price sits in a nested element", () => {
    document.body.innerHTML = `
      <div class="row">
        <div class="title">Crème de You</div>
        <div class="pricing"><span>$45</span><span>$31.50</span></div>
        <input type="number" value="1" aria-label="Quantity">
        <button>Remove</button>
      </div>`;
    const meta = readDocumentMeta(document, "https://shop.example.com/products/x");
    expect(meta.cartLineItems).toBe(1);
  });

  it("classifies that drawer as a cart despite Product markup and a /products/ URL", () => {
    document.body.innerHTML = `
      <script type="application/ld+json">{"@type":"Product","name":"Crème de You"}</script>
      <div class="row">
        <div class="pricing"><span>$45</span><span>$31.50</span></div>
        <input type="number" value="1" aria-label="Quantity">
        <button>Remove</button>
      </div>
      <button>Checkout</button>`;
    const url = "https://www.glossier.com/products/creme-de-you";
    expect(classifyStage(url, readDocumentMeta(document, url))).toBe("cart");
  });

  it("still counts each row once when several are wrapped together", () => {
    const row = `<div class="row"><div><span>$10.00</span></div><button>Remove</button></div>`;
    document.body.innerHTML = `<div id="wrap">${row.repeat(3)}</div>`;
    const meta = readDocumentMeta(document, "https://shop.example.com/cart");
    expect(meta.cartLineItems).toBe(3);
  });
});

/**
 * A CLOSED cart drawer is not a cart. Shopify renders the drawer into every product page and
 * hides it until opened; its rows were counted anyway, so a product page opened with items
 * already in the cart read as a cart page before the shopper did anything.
 */
describe("cart line items — hidden drawers", () => {
  const drawerRows = `
    <div class="row"><div><span>$45.00</span></div><input type="number" value="1" aria-label="Quantity"><button>Remove</button></div>
    <div class="row"><div><span>$12.00</span></div><input type="number" value="1" aria-label="Quantity"><button>Remove</button></div>
    <div class="sum">Subtotal $57.00</div><div class="sum">Total $57.00</div>`;
  const pdp = `
    <script type="application/ld+json">{"@type":"Product","name":"Tote"}</script>
    <h1>Tote</h1><p>$45.00</p><button id="atc">Add to cart</button>`;
  const url = "https://shop.example.com/products/tote";

  for (const [how, attrs] of [
    ["display: none", 'style="display:none"'],
    ["visibility: hidden (Dawn)", 'style="visibility:hidden"'],
    ["the hidden attribute", "hidden"],
    ["aria-hidden", 'aria-hidden="true"'],
    ["inert", "inert"],
  ] as const) {
    it(`ignores rows inside a drawer closed with ${how}`, () => {
      document.body.innerHTML = `${pdp}<aside ${attrs}>${drawerRows}</aside>`;
      const meta = readDocumentMeta(document, url);
      expect(meta.cartLineItems).toBe(0);
      expect(meta.moneySummaryRows).toBe(0);
      expect(classifyStage(url, meta)).toBe("pdp");
    });
  }

  it("counts the same rows once the drawer is open", () => {
    document.body.innerHTML = `${pdp}<aside>${drawerRows}</aside>`;
    const meta = readDocumentMeta(document, url);
    expect(meta.cartLineItems).toBe(2);
    expect(classifyStage(url, meta)).toBe("cart");
  });

  it("counts a row a child makes visible inside a visibility-hidden parent", () => {
    // visibility inherits and can be overridden from below; display cannot.
    document.body.innerHTML = `${pdp}<aside style="visibility:hidden"><div style="visibility:visible">${drawerRows}</div></aside>`;
    expect(readDocumentMeta(document, url).cartLineItems).toBe(2);
  });
});

/**
 * Bombas prices a pack as `$55  <s>$60</s>  8% Pack Savings` — live price FIRST, and a
 * savings badge whose wording matches neither the reference-price lexemes nor the
 * `% off` badge pattern. Reported from the field as a miss, so pinning it: the struck
 * price, the pair, and the struck-is-higher signal are enough on their own.
 */
describe("anchoring on a savings-badge layout", () => {
  const shapes: [string, string][] = [
    ["inline", `<div><span>$55</span> <s>$60</s> <span>8% Pack Savings</span></div>`],
    [
      "nested",
      `<div><div><span>$55</span></div><div><s>$60</s></div><div>8% Pack Savings</div></div>`,
    ],
    [
      "grid card",
      `<div><h3>Solids Half Calf Sock 4-Pack</h3><div><span>$55</span> <s>$60</s></div></div>`,
    ],
  ];

  for (const [name, html] of shapes) {
    it(`fires above the surface threshold: ${name}`, () => {
      const found = anchoringDetector.run(contextFrom(html));
      expect(found).toHaveLength(1);
      // 0.75 is the shipped surfaceThreshold; below it the card would never show.
      expect(found[0]?.rawScore ?? 0).toBeGreaterThanOrEqual(0.75);
    });
  }

  it("does not fire when the struck price is lower than the live one", () => {
    // A struck price below the live price is a rendering artifact, not an anchor.
    expect(
      anchoringDetector.run(contextFrom(`<div><span>$60</span> <s>$55</s></div>`)),
    ).toHaveLength(0);
  });
});

/**
 * charm used to rank priced nodes by rendered area, which on a grid page selects the largest
 * BOX — a container whose text is every child run together. Logged on shein as
 * "Customers Also Viewed 10 #KnitEssentials -15% SHEIN PETITE Balle": a blob whose visible
 * sample contained no price at all, because the charm price sat further along in text the
 * log truncated. A shopper shown that would not know what was being pointed at.
 */
describe("charm picks the price node, not the box around it", () => {
  it("reports the price element, not its grid container", () => {
    const card = (name: string, price: string) =>
      `<li><h3>${name}</h3><span class="price">${price}</span></li>`;
    const ctx = contextFrom(
      `<ul class="grid">${card("Knit Essentials", "$19.99")}${card("Denim Jacket", "$34.99")}</ul>`,
      {
        // Make the grid container by far the largest box, which is what used to win.
        patch: (n, el) => {
          if (el?.tagName === "UL") Object.assign(n.box, { w: 1200, h: 900 });
          else if (el?.classList.contains("price")) Object.assign(n.box, { w: 90, h: 30 });
        },
      },
    );
    const found = charmDetector.run(ctx);
    expect(found).toHaveLength(1);
    const sample = found[0]?.evidence.textSample ?? "";
    expect(sample.length, `blob evidence: ${sample}`).toBeLessThanOrEqual(60);
    expect(sample).toContain(".99");
    expect(sample).not.toContain("Knit Essentials");
  });

  it("ignores a container whose text merely sweeps up a price", () => {
    const ctx = contextFrom(
      `<div class="wrap">Customers Also Viewed. Free returns on every order placed today.
        Members save more. <span class="price">$24.99</span></div>`,
    );
    const found = charmDetector.run(ctx);
    // Either it reports the span, or nothing — never the sentence-long wrapper.
    for (const c of found) {
      expect((c.evidence.textSample ?? "").length).toBeLessThanOrEqual(60);
    }
  });

  it("still fires on an ordinary product price", () => {
    expect(charmDetector.run(contextFrom(`<div class="price">$19.99</div>`))).toHaveLength(1);
  });
});

/**
 * Two misses recorded in EVAL.md during the field spot-check, pinned as tests.
 *
 * Both were real, but one was recorded with the wrong cause: "only 3 left at this price"
 * matches the existing pattern and scores 0.60. Booking's actual copy puts a noun in the
 * middle — "Only 3 rooms left at this price" — and that scored zero.
 */
describe("field lexicon gaps", () => {
  it("scarcity: counts an inventory noun between the number and 'left'", () => {
    for (const copy of [
      "Only 3 rooms left at this price",
      "Only 2 rooms left on our site",
      "Only 4 tickets left at this price",
      "3 seats left",
    ]) {
      expect(scarcityDetector.run(contextFrom(`<div>${copy}</div>`)), copy).toHaveLength(1);
    }
  });

  it("scarcity: still ignores catalogue variant counts", () => {
    // The exact false positive the plan warns causes uninstalls. Widening the pattern to
    // any word would have swallowed these, which is why the nouns are enumerated.
    for (const copy of ["Only 3 sizes left", "2 colours left", "Only 4 styles remaining"]) {
      expect(scarcityDetector.run(contextFrom(`<div>${copy}</div>`)), copy).toHaveLength(0);
    }
  });

  it("goal_gradient: catches a threshold phrased as a destination", () => {
    // Shein says "to cart for FREE SHIPPING", not "to get free shipping".
    const found = goalGradientDetector.run(
      contextFrom(
        `<div>Add $2.77 more to cart for FREE STANDARD SHIPPING on SHEIN products!</div>`,
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.rawScore ?? 0).toBeGreaterThanOrEqual(0.75);
  });

  it("goal_gradient: 'more' is load-bearing — plain add-to-cart must not fire", () => {
    for (const copy of ["Add to cart", "Add to bag $45", "Add to basket"]) {
      expect(goalGradientDetector.run(contextFrom(`<div>${copy}</div>`)), copy).toHaveLength(0);
    }
  });

  it("surfaces a numeric scarcity claim on its own", () => {
    // Recalibrated after spot-check run 2. This previously scored 0.60 against a 0.75
    // threshold, so scarcity.stock could only ever show a card when a progress bar happened
    // to sit beside the copy — it fired correctly on five sites and surfaced on none.
    // Zero false positives across those five was the evidence for moving it.
    const found = scarcityDetector.run(contextFrom(`<div>Only 3 rooms left at this rate</div>`));
    expect(found[0]?.rawScore ?? 0).toBeGreaterThanOrEqual(0.75);
  });

  it("keeps a qualitative claim below threshold when it is buried in prose", () => {
    // "Almost sold out" as a badge is a scarcity cue; the same words inside a paragraph are
    // description. Terseness is what separates them, which is why shortText still counts.
    const prose =
      "This is a long paragraph about our hotel which happens to mention that rooms are " +
      "almost sold out during peak season and that you should plan ahead";
    const found = scarcityDetector.run(contextFrom(`<div>${prose}</div>`));
    expect(found[0]?.rawScore ?? 0).toBeLessThan(0.75);
  });

  it("surfaces an installment claim on its own", () => {
    // Shein's "Pay now, or in 4 payments of $3.13" scored 0.70 against 0.75 on two visits.
    const found = bnplDetector.run(contextFrom(`<div>Pay now, or in 4 payments of $3.13</div>`));
    expect(found[0]?.rawScore ?? 0).toBeGreaterThanOrEqual(0.75);
  });
});

/**
 * Checkout pages that collect no shipping address.
 *
 * Checkout detection required autocomplete="address-line1" and friends, which assumes a
 * shipping checkout. booking.com's "Enter your details" is first name / last name / email /
 * country — a hotel booking has no street address — so its checkout page classified as
 * `browse`, the stage never changed, the checkout-intent trigger never fired, and no card
 * ever appeared. Travel, ticketing and digital goods all check out this way.
 */
describe("identity-based checkouts", () => {
  const bookingDetails = `
    <div>Your Selection</div><div>Your Details</div><div>Finish booking</div>
    <h2>Enter your details</h2>
    <form>
      <label>First name<input name="firstname" /></label>
      <label>Last name<input name="lastname" /></label>
      <label>Email address<input type="email" name="email" /></label>
      <label>Country/Region<select name="cc1"><option>United States</option></select></label>
    </form>
    <div class="r"><span>Original price</span><span>$123</span></div>
    <div class="r"><span>Total</span><span>$100</span></div>`;

  it("classifies a booking details page as checkout", () => {
    const url = "https://secure.booking.com/book.html?hotel_id=1";
    document.body.innerHTML = bookingDetails;
    expect(classifyStage(url, readDocumentMeta(document, url))).toBe("checkout");
  });

  it("reads name and email from name/placeholder, not just autocomplete", () => {
    document.body.innerHTML = bookingDetails;
    const meta = readDocumentMeta(document, "https://secure.booking.com/book.html");
    expect(meta.hasContactCluster).toBe(true);
  });

  // The reason identity fields only count alongside money: a signup form is not a checkout.
  it("does not turn a homepage with a newsletter signup into checkout", () => {
    const url = "https://shop.example.com/";
    document.body.innerHTML = `<h1>Welcome</h1><footer>
      <input name="first_name" placeholder="First name" />
      <input type="email" name="email" placeholder="Email" /><button>Subscribe</button></footer>`;
    expect(classifyStage(url, readDocumentMeta(document, url))).toBe("browse");
  });

  it("does not turn a product page with a newsletter signup into checkout", () => {
    const url = "https://shop.example.com/products/x";
    document.body.innerHTML = `
      <script type="application/ld+json">{"@type":"Product","name":"x"}</script>
      <div>$24.00</div><button>Add to cart</button>
      <footer><input name="first_name" placeholder="First name" />
        <input type="email" placeholder="Email" /></footer>`;
    expect(classifyStage(url, readDocumentMeta(document, url))).toBe("pdp");
  });

  it("still classifies an ordinary shipping checkout", () => {
    const url = "https://shop.example.com/x";
    document.body.innerHTML = `<form><input autocomplete="address-line1" />
      <input autocomplete="address-level2" /><input autocomplete="postal-code" /></form>`;
    expect(classifyStage(url, readDocumentMeta(document, url))).toBe("checkout");
  });
});

/**
 * Every shipped scarcity pattern must survive the harvest prefilter.
 *
 * `classifyText` rejects any node with no digit, no currency glyph and no trigger word, so a
 * detector pattern whose copy contains none of those can never fire — the detector never
 * sees the node. `/\bgoing fast\b/` was in STOCK_PATTERNS and unreachable: "Premium seats,
 * going fast" scored nothing. Same shape of dead code that hid pricing.drip, one stage
 * earlier in the pipeline.
 */
describe("scarcity patterns survive the prefilter", () => {
  const copy = [
    "Premium seats, going fast",
    "Hurry — while supplies last",
    "Limited quantity",
    "Limited availability on this date",
    "Almost sold out",
    "Selling fast",
    "Low stock",
    "Only 2 left in stock",
  ];

  for (const t of copy) {
    it(`reaches the detector: "${t}"`, () => {
      expect(scarcityDetector.run(contextFrom(`<div>${t}</div>`)), t).toHaveLength(1);
    });
  }
});
