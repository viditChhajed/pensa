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

/**
 * Concatenated DOM text. The harvester joins adjacent nodes, so a price badge next to a
 * discount badge reaches the parser as one unbroken string. Found by the framing audit,
 * fixed in the shared parser because drip and basket-sneak read the same numbers.
 */
describe("prices glued to the text that follows them", () => {
  it("does not read $184.00 followed by 74% off as $184,007", () => {
    const [p] = parsePrices("apple$184.0074% off");
    expect(p?.amount).toBe(18_400n);
  });

  it("does not read $3.60 followed by 10% off as $3,601", () => {
    const prices = parsePrices("$12.99flash sale$3.6010% off");
    expect(prices[0]?.amount).toBe(1_299n);
    expect(prices[1]?.amount).toBe(360n);
  });

  it("still reads a genuine thousands group", () => {
    expect(parsePrices("$1,234.56 total")[0]?.amount).toBe(123_456n);
    expect(parsePrices("$999,999.00")[0]?.amount).toBe(99_999_900n);
  });

  it("still reads a grouped number with no decimals", () => {
    // Yen has no subunit, so 1200 minor units IS ¥1,200, not a tenth of it.
    expect(parsePrices("¥1,200")[0]?.amount).toBe(1_200n);
    expect(parsePrices("$1,200")[0]?.amount).toBe(120_000n);
  });

  it("still reads one-decimal and bare amounts", () => {
    expect(parsePrices("$9.9")[0]?.amount).toBe(990n);
    expect(parsePrices("$9")[0]?.amount).toBe(900n);
  });
});
