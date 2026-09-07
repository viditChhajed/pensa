import { describe, expect, it } from "vitest";
import { mergeObservation } from "@/background/recordOffer";
import { temporalCandidates } from "@/background/temporal";
import { extractObservations, isEmpty } from "@/content/observations";
import type { OfferObservation } from "@/shared/schema";
import { contextFrom, withTextHistory } from "./helpers";

const HOUR = 3_600_000;

describe("extractObservations", () => {
  it("turns a ticking countdown into an ABSOLUTE deadline", () => {
    // A relative "02:00:00" is not comparable across visits; T + 2h is.
    const ctx = contextFrom(`<div class="t">02:00:00</div>`);
    const node = ctx.candidates.find((c) => c.text.includes("02:00:00"));
    if (node) {
      withTextHistory(node, [
        { t: 0, text: "02:00:02" },
        { t: 2000, text: "02:00:00" },
      ]);
    }
    const o = extractObservations(ctx, 1_000_000);
    expect(o.timers).toHaveLength(1);
    expect(o.timers[0]?.observedEndEpoch).toBe(1_000_000 + 2 * HOUR);
  });

  it("does NOT record a static clock as a deadline", () => {
    // Store hours would otherwise become a fabricated deadline in permanent storage.
    const ctx = contextFrom(`<div>Open until 21:00</div>`);
    expect(extractObservations(ctx, 0).timers).toHaveLength(0);
  });

  it("records a stock count but not variant availability", () => {
    expect(extractObservations(contextFrom(`<p>Only 3 left</p>`), 0).stockCounts).toEqual([3]);
    expect(extractObservations(contextFrom(`<p>2 sizes left</p>`), 0).stockCounts).toEqual([]);
  });

  it("records a viewer count", () => {
    const o = extractObservations(contextFrom(`<p>23 people are viewing this</p>`), 0);
    expect(o.viewerCounts).toEqual([23]);
  });

  it("passes money across the boundary as a string, never a bigint", () => {
    // chrome.runtime.sendMessage serialises as JSON, and JSON has no BigInt.
    const ctx = contextFrom(`<div><span>$49.99</span></div>`);
    for (const n of ctx.candidates) {
      (n as { box: { x: number; y: number; w: number; h: number } }).box = {
        x: 0,
        y: 0,
        w: 200,
        h: 40,
      };
    }
    const o = extractObservations(ctx, 0);
    for (const p of o.prices) expect(typeof p.minor).toBe("string");
    expect(() => JSON.stringify(o)).not.toThrow();
  });

  it("reports emptiness so a page with nothing to say sends nothing", () => {
    expect(isEmpty(extractObservations(contextFrom(`<p>Hello world</p>`), 0))).toBe(true);
  });
});

describe("mergeObservation", () => {
  const empty = {
    timers: [],
    stockCounts: [],
    viewerCounts: [],
    prices: [],
    referencePrices: [],
  };

  it("creates a record on first sighting", () => {
    const m = mergeObservation(
      null,
      "https://a.com",
      "sku:1",
      "sku",
      { ...empty, stockCounts: [5] },
      1000,
    );
    expect(m.sightings).toBe(1);
    expect(m.firstSeen).toBe(1000);
    expect(m.stockSightings).toEqual([{ ts: 1000, n: 5 }]);
  });

  it("accumulates across visits and preserves firstSeen", () => {
    const a = mergeObservation(
      null,
      "https://a.com",
      "sku:1",
      "sku",
      { ...empty, stockCounts: [5] },
      1000,
    );
    const b = mergeObservation(
      a,
      "https://a.com",
      "sku:1",
      "sku",
      { ...empty, stockCounts: [3] },
      2000,
    );
    expect(b.sightings).toBe(2);
    expect(b.firstSeen).toBe(1000);
    expect(b.lastSeen).toBe(2000);
    expect(b.stockSightings.map((s) => s.n)).toEqual([5, 3]);
  });

  it("converts price strings back to bigint on the way in", () => {
    const m = mergeObservation(
      null,
      "https://a.com",
      "sku:1",
      "sku",
      { ...empty, prices: [{ minor: "4999", currency: "USD" }] },
      1000,
    );
    expect(m.observedPrices[0]?.minor).toBe(4999n);
  });

  it("caps history so a heavily-visited product cannot grow without bound", () => {
    let rec: OfferObservation | null = null;
    for (let i = 0; i < 200; i++) {
      rec = mergeObservation(
        rec,
        "https://a.com",
        "sku:1",
        "sku",
        { ...empty, stockCounts: [i] },
        i * 1000,
      );
    }
    expect(rec?.stockSightings.length).toBeLessThanOrEqual(64);
    // Keeps the NEWEST samples — a claim is about recent behaviour.
    expect(rec?.stockSightings.at(-1)?.n).toBe(199);
  });
});

describe("end to end: repeat visits produce a temporal claim", () => {
  it("says nothing on the first visit and flags an evergreen timer on the second", () => {
    const build = (nowEpoch: number) => {
      const ctx = contextFrom(`<div class="t">02:00:00</div>`);
      const node = ctx.candidates.find((c) => c.text.includes("02:00:00"));
      if (node) {
        withTextHistory(node, [
          { t: 0, text: "02:00:02" },
          { t: 2000, text: "02:00:00" },
        ]);
      }
      return extractObservations(ctx, nowEpoch);
    };

    // Visit one.
    let rec = mergeObservation(null, "https://a.com", "sku:1", "sku", build(0), 0);
    expect(temporalCandidates(rec)).toEqual([]);

    // Visit two, three hours later. The timer STILL says two hours remaining, so its
    // deadline advanced by exactly the elapsed time.
    rec = mergeObservation(rec, "https://a.com", "sku:1", "sku", build(3 * HOUR), 3 * HOUR);
    const claims = temporalCandidates(rec);
    expect(claims.map((c) => c.patternId)).toContain("temporal.evergreen_countdown");
  });
});
