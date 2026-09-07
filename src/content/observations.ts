/**
 * Extract the temporal observables from a page (plan §18A, page side).
 *
 * Pure over a PageContext. The values here are the raw material the temporal engine reasons
 * over across visits: what deadline a timer claimed, what the stock counter said, what the
 * viewer count was, what price and reference price were shown.
 *
 * Everything recorded is numeric or hashed. This store is the longest-lived thing on disk
 * (90-day TTL), so no free text enters it.
 */
import { parsePrices } from "@/shared/money";
import { createHash } from "./detectors/hash";
import type { PageContext } from "./types";

export interface PageObservation {
  /** Absolute epoch a countdown claimed to end at, plus which timer said it. */
  timers: { containerPathHash: string; observedEndEpoch: number }[];
  /** "only N left" values. */
  stockCounts: number[];
  /** "N people viewing" values. */
  viewerCounts: number[];
  /** Prices displayed as the live price, in minor units. */
  prices: { minor: string; currency: string }[];
  /** Struck-through / "was" prices, in minor units. */
  referencePrices: { minor: string }[];
}

const CLOCK_RE = /\b(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\b/;
const STOCK_RE =
  /\bonly (\d{1,3}) (?:left|remaining|available)\b|\b(\d{1,3}) (?:left|remaining) in stock\b|\bonly (\d{1,3}) in stock\b/;
const VIEWER_RE =
  /\b(\d{1,4})\s*(?:other\s+)?(?:people|shoppers|customers|users|others)\s+(?:are\s+)?(?:viewing|looking at|watching)\b|\b(\d{1,4})\s+(?:sold|bought|purchased) in the (?:last|past)\b/;

/** Variant availability, not scarcity — same exclusion the scarcity detector applies. */
const VARIANT_RE =
  /\b\d{1,3} (?:sizes?|colou?rs?|styles?|variants?|options?|shades?) (?:left|remaining|available)\b/;

function clockToSeconds(text: string): number | null {
  const m = CLOCK_RE.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] !== undefined ? Number(m[3]) : null;
  const seconds = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  return Number.isFinite(seconds) ? seconds : null;
}

function isStruck(decoration: string, tag: string): boolean {
  return tag === "DEL" || tag === "S" || tag === "STRIKE" || decoration.includes("line-through");
}

/**
 * `nowEpoch` is passed in rather than read, so this stays pure and a fixture can pin it.
 * A countdown showing 02:14:31 at time T claims a deadline of T + 8071s — an absolute point,
 * which is the only form comparable across visits.
 */
export function extractObservations(ctx: PageContext, nowEpoch: number): PageObservation {
  const out: PageObservation = {
    timers: [],
    stockCounts: [],
    viewerCounts: [],
    prices: [],
    referencePrices: [],
  };

  const seenTimers = new Set<string>();

  for (const n of ctx.candidates) {
    const t = n.normalizedText;
    if (t.length === 0 || t.length > 200) continue;

    // Timers: only nodes actually observed ticking, so a static "21:00" opening time
    // never becomes a fabricated deadline.
    if (n.textHistory.length >= 2) {
      const seconds = clockToSeconds(t);
      if (seconds !== null && seconds > 0) {
        const hash = createHash(n.selectorPath);
        if (!seenTimers.has(hash)) {
          seenTimers.add(hash);
          out.timers.push({ containerPathHash: hash, observedEndEpoch: nowEpoch + seconds * 1000 });
        }
      }
    }

    if (!VARIANT_RE.test(t)) {
      const stock = STOCK_RE.exec(t);
      if (stock) {
        const n1 = stock[1] ?? stock[2] ?? stock[3];
        if (n1) {
          const v = Number.parseInt(n1, 10);
          if (Number.isFinite(v)) out.stockCounts.push(v);
        }
      }
    }

    const viewers = VIEWER_RE.exec(t);
    if (viewers) {
      const n1 = viewers[1] ?? viewers[2];
      if (n1) {
        const v = Number.parseInt(n1, 10);
        if (Number.isFinite(v)) out.viewerCounts.push(v);
      }
    }

    const prices = parsePrices(n.text);
    if (prices.length === 1) {
      const p = prices[0];
      if (p) {
        if (isStruck(n.style.textDecorationLine, n.tagName)) {
          out.referencePrices.push({ minor: p.amount.toString() });
        } else if (n.box.w * n.box.h > 400) {
          // The headline price, by rendered area — not every price on the page.
          out.prices.push({ minor: p.amount.toString(), currency: p.currency });
        }
      }
    }
  }

  // Keep only the most prominent of each, so one page contributes one data point.
  return {
    timers: out.timers.slice(0, 3),
    stockCounts: out.stockCounts.slice(0, 1),
    viewerCounts: out.viewerCounts.slice(0, 1),
    prices: out.prices.slice(0, 1),
    referencePrices: out.referencePrices.slice(0, 1),
  };
}

export function isEmpty(o: PageObservation): boolean {
  return (
    o.timers.length === 0 &&
    o.stockCounts.length === 0 &&
    o.viewerCounts.length === 0 &&
    o.prices.length === 0 &&
    o.referencePrices.length === 0
  );
}
