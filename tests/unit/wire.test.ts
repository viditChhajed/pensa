import { describe, expect, it } from "vitest";
import type { PriceSnapshot } from "@/shared/schema";
import { decodePriceSnapshot, encodePriceSnapshot, findUnserializable } from "@/shared/wire";

/**
 * Regression net for the most expensive bug in this build, which only a real browser found.
 *
 * The `stage` message carried a PriceSnapshot containing BigInt money.
 * `chrome.runtime.sendMessage` serialises as JSON, JSON.stringify throws on BigInt, and
 * `send()` caught the throw and returned null. The message therefore never arrived, the
 * ledger never received a price snapshot, and `pricing.drip` — the highest-value detector in
 * the product — could never fire. All 200 unit tests passed throughout, because not one of
 * them crossed the messaging boundary.
 */
const money = (minor: bigint) => ({ amount: minor, currency: "USD", confidence: 0.9 });

const SNAPSHOT: PriceSnapshot = {
  subtotal: money(10_000n),
  tax: money(800n),
  total: money(12_600n),
  displayedPrice: money(9999n),
  shipping: money(499n),
  fees: [
    {
      labelHash: "a".repeat(64),
      labelSample: "Service fee",
      amount: money(1800n),
      kind: "mandatory_fee",
      kindConfidence: 0.7,
    },
  ],
  capturedAt: 1_700_000_000_000,
};

describe("findUnserializable", () => {
  it("catches a BigInt anywhere in the payload", () => {
    expect(findUnserializable({ a: { b: [{ c: 1n }] } })).toContain("BigInt");
  });

  it("catches functions, symbols, Maps and Dates", () => {
    expect(findUnserializable({ f: () => 1 })).toContain("function");
    expect(findUnserializable({ s: Symbol("x") })).toContain("symbol");
    expect(findUnserializable({ m: new Map() })).toContain("Map");
    expect(findUnserializable({ d: new Date() })).toContain("Date");
  });

  it("passes ordinary JSON-safe data", () => {
    expect(findUnserializable({ a: 1, b: "x", c: [true, null], d: { e: 2.5 } })).toBeNull();
  });

  it("names the path so the failure is actionable", () => {
    expect(findUnserializable({ stage: { priceSnapshot: { subtotal: { amount: 1n } } } })).toBe(
      "$.stage.priceSnapshot.subtotal.amount is a BigInt",
    );
  });
});

describe("PriceSnapshot wire encoding", () => {
  it("a RAW snapshot is NOT sendable — this is the bug that shipped", () => {
    expect(findUnserializable(SNAPSHOT)).toContain("BigInt");
    expect(() => JSON.stringify(SNAPSHOT)).toThrow();
  });

  it("an ENCODED snapshot is sendable", () => {
    const wire = encodePriceSnapshot(SNAPSHOT);
    expect(findUnserializable(wire)).toBeNull();
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it("round-trips through JSON with exact values and no float drift", () => {
    const revived = decodePriceSnapshot(JSON.parse(JSON.stringify(encodePriceSnapshot(SNAPSHOT))));
    expect(revived.subtotal?.amount).toBe(10_000n);
    expect(revived.total?.amount).toBe(12_600n);
    expect(revived.tax?.amount).toBe(800n);
    expect(revived.shipping?.amount).toBe(499n);
    expect(revived.displayedPrice?.amount).toBe(9999n);
    expect(revived.fees[0]?.amount.amount).toBe(1800n);
    expect(revived.fees[0]?.kind).toBe("mandatory_fee");
    expect(revived.capturedAt).toBe(SNAPSHOT.capturedAt);
  });

  it("preserves a value larger than Number.MAX_SAFE_INTEGER", () => {
    // The whole reason money is BigInt. A string carries it; a JSON number would not.
    const big = { fees: [], capturedAt: 0, subtotal: money(9_007_199_254_740_993n) };
    const revived = decodePriceSnapshot(JSON.parse(JSON.stringify(encodePriceSnapshot(big))));
    expect(revived.subtotal?.amount).toBe(9_007_199_254_740_993n);
  });

  it("omits absent fields rather than sending undefined", () => {
    const wire = encodePriceSnapshot({ fees: [], capturedAt: 1 });
    expect("subtotal" in wire).toBe(false);
    expect("total" in wire).toBe(false);
  });
});
