/**
 * Funnel stage classifier (plan §6, T15).
 *
 * Weighted feature vector, not URL alone — SPA retailers route client-side, so a URL that
 * still says /products/ can be showing a cart. Day 1 uses URL plus form signals; JSON-LD
 * weighting is wired but deliberately light until Day 2.
 */
import type { FunnelStage } from "@/shared/schema";
import type { DocumentMeta } from "./types";

type Scores = Record<FunnelStage, number>;

const PATH_SIGNALS: readonly (readonly [RegExp, FunnelStage, number])[] = [
  [/\/payment|\/billing/i, "payment", 0.6],
  [/\/checkout/i, "checkout", 0.6],
  [/\/(cart|basket|bag)(\/|$|\?)/i, "cart", 0.6],
  [/\/(products?|item|itm|dp|pd)\//i, "pdp", 0.5],
  [/\/p\/[^/]+/i, "pdp", 0.5],
  [/\/(collections?|category|c)\//i, "browse", 0.4],
  [/\/(search|s)(\/|\?)/i, "browse", 0.4],
];

export function classifyStage(url: string, meta: DocumentMeta): FunnelStage {
  const scores: Scores = { browse: 0.1, pdp: 0, cart: 0, checkout: 0, payment: 0 };

  let pathname = "/";
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* keep default */
  }

  for (const [re, stage, w] of PATH_SIGNALS) {
    if (re.test(pathname)) scores[stage] += w;
  }

  // A credit-card field is the single most reliable signal on the page.
  if (meta.hasCcNumberField) scores.payment += 0.7;
  if (meta.hasAddressCluster) scores.checkout += 0.4;
  if (meta.hasPostalCodeField) scores.checkout += 0.2;
  if (meta.hasOrderSummaryTriple) {
    scores.cart += 0.3;
    scores.checkout += 0.3;
  }

  if (meta.ogType === "product") scores.pdp += 0.4;
  if (hasProductJsonLd(meta)) scores.pdp += 0.35;

  let best: FunnelStage = "browse";
  let bestScore = -1;
  for (const [stage, s] of Object.entries(scores) as [FunnelStage, number][]) {
    if (s > bestScore) {
      bestScore = s;
      best = stage;
    }
  }
  return best;
}

function hasProductJsonLd(meta: DocumentMeta): boolean {
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 4 || node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((n) => visit(n, depth + 1));
    const rec = node as Record<string, unknown>;
    const t = rec["@type"];
    if (t === "Product" || t === "Offer") return true;
    if (Array.isArray(t) && t.some((x) => x === "Product" || x === "Offer")) return true;
    return Object.values(rec).some((v) => visit(v, depth + 1));
  };
  return meta.jsonLd.some((b) => visit(b, 0));
}
