import { describe, expect, it } from "vitest";
import { formatMinor, parsePrices } from "@/shared/money";

describe("parsePrices", () => {
  it("parses US format with thousands separator", () => {
    const [p] = parsePrices("$1,234.56");
    expect(p?.amount).toBe(123456n);
    expect(p?.currency).toBe("USD");
  });

  it("parses European format with comma decimal", () => {
    const [p] = parsePrices("1.234,56 €");
    expect(p?.amount).toBe(123456n);
    expect(p?.currency).toBe("EUR");
  });

  it("treats a lone 3-digit group as thousands, not cents", () => {
    const [p] = parsePrices("$1.234");
    expect(p?.amount).toBe(123400n);
  });

  it("captures the fractional part for charm detection", () => {
    const [p] = parsePrices("$19.99");
    expect(p?.fraction).toBe("99");
  });

  it("handles zero-decimal currencies", () => {
    const [p] = parsePrices("¥1200");
    expect(p?.amount).toBe(1200n);
  });

  it("does NOT match bare numbers without a currency marker", () => {
    expect(parsePrices("call 555 1234 for 10 items")).toHaveLength(0);
  });

  it("finds both prices in a was/now pair", () => {
    const prices = parsePrices("Was $89.99 Now $49.99");
    expect(prices.map((p) => p.amount)).toEqual([8999n, 4999n]);
  });

  it("rejects implausibly large values", () => {
    expect(parsePrices("$999999999.00")).toHaveLength(0);
  });

  it("round-trips through formatMinor", () => {
    expect(formatMinor(123456n)).toBe("1234.56");
    expect(formatMinor(1200n, "JPY")).toBe("1200");
  });
});
