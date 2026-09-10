import { describe, expect, it } from "vitest";
import { classifyLineItem, extractPriceSnapshot } from "@/content/priceSummary";
import { contextFrom } from "./helpers";

/**
 * Why pricing.drip never fired on any site, in one sentence: a summary row is two sibling
 * elements, and nothing could read them together.
 *
 * `harvest` accepts an element only if it has DIRECT text, so `<div class="row">` — whose
 * text lives entirely in its children — is never a candidate. `<span>Subtotal</span>` has no
 * digit or currency glyph and fails the character-class prefilter. Only the bare
 * `<span>$40.00</span>` survives, and `extractPriceSnapshot` reads a single candidate's text,
 * so the label in its sibling was unreachable. Subtotal, total and every fee came back empty
 * on pages that plainly displayed all of them — which silently disabled both cross-stage
 * detectors, the highest-severity patterns in the taxonomy.
 *
 * The fix reads `containerText` (the parent's joined text) when a candidate is a bare price.
 */
describe("summary rows split across sibling elements", () => {
  const row = (label: string, amount: string) =>
    `<div class="row"><span>${label}</span><span class="amt">${amount}</span></div>`;

  const checkout = () =>
    contextFrom(
      `<form><input autocomplete="address-line1" /><input autocomplete="postal-code" /></form>
       ${row("Subtotal", "$40.00")}${row("Service fee", "$6.00")}
       ${row("Shipping", "$5.00")}${row("Order total", "$51.00")}`,
      { stage: "checkout" },
    );

  it("reads a subtotal whose label is in a sibling element", () => {
    expect(extractPriceSnapshot(checkout()).subtotal?.amount).toBe(4000n);
  });

  it("reads the order total the same way", () => {
    expect(extractPriceSnapshot(checkout()).total?.amount).toBe(5100n);
  });

  it("classifies a sibling-labelled fee, which is what drip compares across stages", () => {
    const fees = extractPriceSnapshot(checkout()).fees;
    expect(fees.map((f) => f.labelSample?.trim())).toContain("service fee");
    expect(fees.find((f) => f.labelSample?.includes("service"))?.kind).toBe("mandatory_fee");
  });

  it("counts a fee once even when several candidates reach the same row", () => {
    const ctx = contextFrom(
      `<form><input autocomplete="postal-code" /></form>
       ${row("Subtotal", "$40.00")}${row("Shipping", "$5.00")}
       <div class="row"><span>Service fee</span><span class="amt"><b>$6.00</b></span></div>
       ${row("Order total", "$51.00")}`,
      { stage: "checkout" },
    );
    const service = extractPriceSnapshot(ctx).fees.filter((f) =>
      f.labelSample?.includes("service"),
    );
    expect(service).toHaveLength(1);
  });

  it("still treats a genuinely bare price as the product price, not a fee", () => {
    const ctx = contextFrom(`<h1>Ticket</h1><p class="price"><strong>$40.00</strong></p>`, {
      stage: "pdp",
    });
    const snap = extractPriceSnapshot(ctx);
    expect(snap.displayedPrice?.amount).toBe(4000n);
    expect(snap.fees).toHaveLength(0);
  });

  it("does not turn a product card's name+price into a fee on a PDP", () => {
    // The container fallback makes "Concert Ticket $40.00" look like a labelled row. The
    // summary-row guard is what stops that becoming an `unknown` fee outside a cart.
    const ctx = contextFrom(
      `<div class="card"><span>Concert Ticket</span><span>$40.00</span></div>`,
      { stage: "pdp" },
    );
    expect(extractPriceSnapshot(ctx).fees).toHaveLength(0);
  });
});

/**
 * Lodging fee labels, added before spot-checking a hotel booking.
 *
 * These are the best-known drip charges in the industry — the destination fee is the one
 * the FTC and several state attorneys general have actually litigated over — and every one
 * of them classified as `unknown`, reaching fees[] only through the summary-row fallback
 * rather than being recognised. pricing.drip compares fees across stages, so a hotel is the
 * most likely place for it to fire and the labels have to land.
 */
describe("lodging fees", () => {
  const mandatory = [
    "Resort fee",
    "Destination fee",
    "Amenity fee",
    "Cleaning fee",
    "Service charge",
    "Parking fee",
    "Taxes and fees",
    "Taxes & fees",
    "Estimated taxes and fees",
  ];

  for (const label of mandatory) {
    it(`classifies "${label}" as a mandatory fee`, () => {
      expect(classifyLineItem(label).kind).toBe("mandatory_fee");
    });
  }

  // A blended "taxes and fees" line is a fee line — the fees hide inside it. A bare tax is
  // not: it is universal and legally set, and calling it drip would be wrong.
  for (const label of ["Sales tax", "VAT", "Occupancy tax", "GST"]) {
    it(`still classifies "${label}" as tax, not a fee`, () => {
      expect(classifyLineItem(label).kind).toBe("tax");
    });
  }
});
