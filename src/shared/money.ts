/**
 * Price extraction (plan §18B). Returns minor units as bigint — never a float.
 *
 * Floats are wrong here for a concrete reason, not a stylistic one: drip-pricing
 * reconciliation is `total − Σ(items)`, and in float that residual accumulates error and
 * produces phantom "unexplained" amounts. In minor-unit bigint it is exact or it is a real
 * discrepancy.
 */
import type { Money } from "./schema";

export interface ParsedPrice extends Money {
  /** Character offsets in the source string, for evidence. */
  start: number;
  end: number;
  raw: string;
  /** Fractional part as written, e.g. "99". Empty when the price had no minor units. */
  fraction: string;
}

const SYMBOL_TO_CURRENCY: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
  "₹": "INR",
};

/**
 * Matches `$1,234.56`, `1.234,56 €`, `USD 19.99`, `19,99€`, `$9`, `$9.99*`.
 * Deliberately does NOT match bare numbers — a price needs a symbol or an ISO code, or the
 * false-positive rate on any page with a phone number or a product spec becomes absurd.
 */
/**
 * The grouped branch requires AT LEAST ONE separator (`+`, not `*`). With `*` it matched a
 * 3-digit prefix and stopped, so `¥1200` parsed as 120 and `$999999999.00` parsed as 999 —
 * which also meant the implausible-value guard below never saw the real number.
 *
 * The branch ORDER is the other half of that, and it is load-bearing on real pages. The
 * harvester joins adjacent DOM text, so a price badge sitting beside a discount badge
 * arrives as one string: `$184.0074% off`. The grouped branch took `.007` as a thousands
 * group and reported **$184,007** for a $184 item — and `$3.6010% off` as $3,601.
 *
 * So the grouped branch now refuses to end mid-digit, and a plain two-decimal reading is
 * tried before anything shorter. Guarding alone was not enough: it correctly rejected
 * $184,007 but then backtracked to a bare `184`, and turned `$3.6010% off` into $3.00 —
 * a quieter wrong answer is still a wrong answer. Two decimals is what a price looks like,
 * so `184.00` and `3.60` win even though a digit follows them. A single-decimal or bare
 * integer still has to end cleanly, or `$184.0074` would come back as `184` again.
 *
 * This matters well beyond the detector that found it. `parsePrices` feeds drip
 * reconciliation and basket-sneak, the two highest-severity patterns, both of which compare
 * totals across funnel stages — so a three-orders-of-magnitude misread does not produce a
 * missed claim, it produces a confident and absurd one.
 */
const NUM = String.raw`(?:\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+[.,]\d{2}|\d+[.,]\d(?!\d)|\d+(?!\d))`;

const PRICE_RE = new RegExp(
  `(?:(?<sym>[$£€¥₹])\\s?|(?<iso>USD|GBP|EUR|JPY|INR|CAD|AUD)\\s)(?<num1>${NUM})` +
    `|(?<num2>${NUM})\\s?(?<sym2>[$£€¥₹])`,
  "gu",
);

/**
 * Decide whether `.`/`,` is the decimal separator for this particular number.
 * `1.234,56` -> comma decimal. `1,234.56` -> dot decimal. `1.234` -> ambiguous, and we
 * treat a 3-digit group as thousands, which is right far more often than not.
 */
function toMinorUnits(numeric: string, currency: string): { minor: bigint; fraction: string } {
  const cleaned = numeric.replace(/\s/g, "");
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");

  let decimalSep: "." | "," | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot >= 0) {
    decimalSep = cleaned.length - lastDot - 1 === 3 ? null : ".";
  } else if (lastComma >= 0) {
    decimalSep = cleaned.length - lastComma - 1 === 3 ? null : ",";
  }

  let intPart: string;
  let fracPart: string;
  if (decimalSep === null) {
    intPart = cleaned.replace(/[.,]/g, "");
    fracPart = "";
  } else {
    const idx = decimalSep === "." ? lastDot : lastComma;
    intPart = cleaned.slice(0, idx).replace(/[.,]/g, "");
    fracPart = cleaned.slice(idx + 1);
  }

  const exponent = currency === "JPY" ? 0 : 2;
  const paddedFrac = fracPart.padEnd(exponent, "0").slice(0, exponent);
  const minor = BigInt(intPart || "0") * BigInt(10 ** exponent) + BigInt(paddedFrac || "0");
  return { minor, fraction: fracPart };
}

/** All prices in a string, in source order. */
export function parsePrices(text: string, defaultCurrency = "USD"): ParsedPrice[] {
  const out: ParsedPrice[] = [];
  PRICE_RE.lastIndex = 0;
  for (const m of text.matchAll(PRICE_RE)) {
    const g = m.groups;
    if (!g) continue;
    const numeric = g.num1 ?? g.num2;
    if (!numeric) continue;

    const symbol = g.sym ?? g.sym2;
    const currency =
      g.iso ?? (symbol ? (SYMBOL_TO_CURRENCY[symbol] ?? defaultCurrency) : defaultCurrency);
    const { minor, fraction } = toMinorUnits(numeric, currency);

    // A "price" over ~$1M on a retail page is almost always a phone number or an id that
    // slipped through. Cheap sanity bound.
    if (minor > 100_000_000n) continue;

    out.push({
      amount: minor,
      currency,
      confidence: symbol || g.iso ? 0.9 : 0.5,
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      fraction,
    });
  }
  return out;
}

export function formatMinor(minor: bigint, currency = "USD"): string {
  const exponent = currency === "JPY" ? 0 : 2;
  const divisor = BigInt(10 ** exponent);
  const whole = minor / divisor;
  const frac = (minor % divisor).toString().padStart(exponent, "0");
  return exponent === 0 ? `${whole}` : `${whole}.${frac}`;
}
