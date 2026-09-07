/**
 * Wire encoding for cross-context messages.
 *
 * `chrome.runtime.sendMessage` serialises as JSON, and JSON cannot represent BigInt. Money
 * is BigInt minor units everywhere else in this codebase — deliberately, because float error
 * in fee reconciliation manufactures phantom charges — so it MUST be converted at the
 * boundary and converted back on the other side.
 *
 * This is not theoretical. The `stage` message previously carried a raw PriceSnapshot, so
 * `JSON.stringify` threw, `send()` caught and returned null, and the message silently never
 * arrived. The ledger therefore never recorded a price snapshot and `pricing.drip` — the
 * highest-value detector in the product — could never fire in a real browser. Every unit
 * test passed the whole time, because none of them crossed the messaging boundary.
 */
import type { LineItem, Money, PriceSnapshot } from "./schema";

export interface WireMoney {
  /** Minor units as a decimal string. */
  minor: string;
  currency: string;
  confidence: number;
}

export interface WireLineItem {
  labelHash: string;
  labelSample?: string;
  amount: WireMoney;
  kind: LineItem["kind"];
  kindConfidence: number;
  userAttributed: boolean;
}

export interface WirePriceSnapshot {
  displayedPrice?: WireMoney;
  subtotal?: WireMoney;
  fees: WireLineItem[];
  shipping?: WireMoney;
  tax?: WireMoney;
  total?: WireMoney;
  capturedAt: number;
}

export function encodeMoney(m: Money): WireMoney {
  return { minor: m.amount.toString(), currency: m.currency, confidence: m.confidence };
}

export function decodeMoney(w: WireMoney): Money {
  return { amount: BigInt(w.minor), currency: w.currency, confidence: w.confidence };
}

export function encodePriceSnapshot(s: PriceSnapshot): WirePriceSnapshot {
  return {
    ...(s.displayedPrice ? { displayedPrice: encodeMoney(s.displayedPrice) } : {}),
    ...(s.subtotal ? { subtotal: encodeMoney(s.subtotal) } : {}),
    ...(s.shipping ? { shipping: encodeMoney(s.shipping) } : {}),
    ...(s.tax ? { tax: encodeMoney(s.tax) } : {}),
    ...(s.total ? { total: encodeMoney(s.total) } : {}),
    fees: s.fees.map((f) => ({
      labelHash: f.labelHash,
      ...(f.labelSample ? { labelSample: f.labelSample } : {}),
      amount: encodeMoney(f.amount),
      kind: f.kind,
      kindConfidence: f.kindConfidence,
      userAttributed: f.userAttributed,
    })),
    capturedAt: s.capturedAt,
  };
}

export function decodePriceSnapshot(w: WirePriceSnapshot): PriceSnapshot {
  return {
    ...(w.displayedPrice ? { displayedPrice: decodeMoney(w.displayedPrice) } : {}),
    ...(w.subtotal ? { subtotal: decodeMoney(w.subtotal) } : {}),
    ...(w.shipping ? { shipping: decodeMoney(w.shipping) } : {}),
    ...(w.tax ? { tax: decodeMoney(w.tax) } : {}),
    ...(w.total ? { total: decodeMoney(w.total) } : {}),
    fees: w.fees.map((f) => ({
      labelHash: f.labelHash,
      ...(f.labelSample ? { labelSample: f.labelSample } : {}),
      amount: decodeMoney(f.amount),
      kind: f.kind,
      kindConfidence: f.kindConfidence,
      userAttributed: f.userAttributed,
    })),
    capturedAt: w.capturedAt,
  };
}

/**
 * Is this value safe to hand to `chrome.runtime.sendMessage`?
 *
 * Used to turn an unsendable message from a silent no-op into a loud failure. A message that
 * can never be sent is a programming error, categorically different from "the worker is
 * asleep", and conflating the two is what hid the bug above for the entire build.
 */
export function findUnserializable(value: unknown, path = "$"): string | null {
  if (typeof value === "bigint") return `${path} is a BigInt`;
  if (typeof value === "function") return `${path} is a function`;
  if (typeof value === "symbol") return `${path} is a symbol`;
  if (value === null || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findUnserializable(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return `${path} is a ${value.constructor.name}`;
  }

  for (const [k, v] of Object.entries(value)) {
    const found = findUnserializable(v, `${path}.${k}`);
    if (found) return found;
  }
  return null;
}
