/**
 * Order-summary extraction and line-item classification (plan §18B, T23 support).
 *
 * This is the substrate for `pricing.drip`, the highest-value detector in the product. The
 * hard call is mandatory vs. optional: a "Service fee" you cannot remove is the finding; a
 * "Gift wrap" you chose is not. v1 decides that lexically and records its confidence, so
 * that §18D can replace the lexicon with a trained classifier without changing anything
 * downstream.
 *
 * All arithmetic is bigint minor units. Reconciliation is `total - Σ(items)`, and in float
 * that residual accumulates error and manufactures phantom fees.
 */
import { type ParsedPrice, parsePrices } from "@/shared/money";
import type { LineItem, LineItemKind, Money, PriceSnapshot } from "@/shared/schema";
import { createHash } from "./detectors/hash";
import type { CandidateNode, PageContext } from "./types";

const KIND_LEXICON: readonly (readonly [LineItemKind, readonly RegExp[]])[] = [
  ["tax", [/\btax\b/, /\bvat\b/, /\bgst\b/, /\bhst\b/, /\bsales tax\b/, /\bduty\b/, /\bduties\b/]],
  ["shipping", [/\bshipping\b/, /\bdelivery\b/, /\bpostage\b/, /\bfreight\b/, /\bcarriage\b/]],
  [
    "discount",
    [/\bdiscount\b/, /\bpromo\b/, /\bcoupon\b/, /\bsavings?\b/, /\bcredit\b/, /\bvoucher\b/],
  ],
  [
    // The ones that matter. Charges you did not choose and usually cannot remove.
    "mandatory_fee",
    [
      /\bservice fee\b/,
      /\bhandling\b/,
      /\bprocessing fee\b/,
      /\bconvenience fee\b/,
      /\bresort fee\b/,
      /\bfacility (?:fee|charge)\b/,
      /\bbooking fee\b/,
      /\border fee\b/,
      /\bfulfillment fee\b/,
      /\bregulatory (?:fee|recovery)\b/,
      /\benvironmental fee\b/,
      /\bsurcharge\b/,
      /\bplatform fee\b/,
      /\bdelivery fee\b/,
      /\bsmall order fee\b/,
      /\bcarrier fee\b/,
    ],
  ],
  [
    "optional_addon",
    [
      /\bprotection plan\b/,
      /\bwarranty\b/,
      /\binsurance\b/,
      /\bgift wrap\b/,
      /\btip\b/,
      /\bgratuity\b/,
      /\bdonation\b/,
      /\bcarbon offset\b/,
      /\bexpedited\b/,
      /\bpriority\b/,
      /\bsignature confirmation\b/,
    ],
  ],
];

const SUBTOTAL_RE = /\bsub-?total\b|\bitems? total\b|\bmerchandise\b|\bbag total\b/;
const TOTAL_RE = /\b(?:order )?total\b|\bamount due\b|\byou pay\b|\bgrand total\b|\bto pay\b/;

export function classifyLineItem(label: string): { kind: LineItemKind; confidence: number } {
  const t = label.toLowerCase();
  for (const [kind, patterns] of KIND_LEXICON) {
    for (const re of patterns) {
      if (re.test(t)) {
        // Fee-vs-addon is the judgement call, so it is reported as less certain than tax.
        const confidence = kind === "mandatory_fee" || kind === "optional_addon" ? 0.7 : 0.9;
        return { kind, confidence };
      }
    }
  }
  return { kind: "unknown", confidence: 0.2 };
}

function money(p: ParsedPrice): Money {
  return { amount: p.amount, currency: p.currency, confidence: p.confidence };
}

/** Label text with the amount removed, so "Service fee $4.99" hashes as "service fee". */
function labelOf(text: string, price: ParsedPrice): string {
  return `${text.slice(0, price.start)}${text.slice(price.end)}`
    .replace(/\s+/g, " ")
    .replace(/[:•\-–—]+\s*$/, "")
    .trim()
    .slice(0, 120);
}

/**
 * Pull an order summary out of a harvested page.
 *
 * Deliberately conservative: a node must carry exactly one price and a short label to be a
 * line item. Summary blocks are tabular, so this holds far more often than it fails, and
 * over-reading here would corrupt the reconciliation that the whole detector rests on.
 */
export function extractPriceSnapshot(ctx: PageContext, capturedAt = Date.now()): PriceSnapshot {
  const fees: LineItem[] = [];
  let subtotal: Money | undefined;
  let total: Money | undefined;
  let shipping: Money | undefined;
  let tax: Money | undefined;
  let largestProductPrice: Money | undefined;

  for (const n of ctx.candidates) {
    const text = n.text;
    if (text.length === 0 || text.length > 120) continue;

    const prices = parsePrices(text);
    if (prices.length !== 1) continue;
    const price = prices[0] as ParsedPrice;

    const label = labelOf(text, price);
    const lower = label.toLowerCase();
    if (label.length === 0) {
      // A bare price with no label: candidate for the headline product price on a PDP.
      if (!largestProductPrice || price.amount > largestProductPrice.amount) {
        largestProductPrice = money(price);
      }
      continue;
    }

    if (TOTAL_RE.test(lower) && !SUBTOTAL_RE.test(lower)) {
      total = money(price);
      continue;
    }
    if (SUBTOTAL_RE.test(lower)) {
      subtotal = money(price);
      continue;
    }

    const { kind, confidence } = classifyLineItem(label);
    if (kind === "shipping") shipping = money(price);
    if (kind === "tax") tax = money(price);

    if (kind === "mandatory_fee" || kind === "optional_addon" || kind === "unknown") {
      // `unknown` rows are kept: an unexplained charge is exactly what reconciliation is for.
      if (kind !== "unknown" || looksLikeSummaryRow(n, ctx)) {
        fees.push({
          labelHash: createHash(lower),
          labelSample: label,
          amount: money(price),
          kind,
          kindConfidence: confidence,
          userAttributed: false,
        });
      }
    }
  }

  const snapshot: PriceSnapshot = { fees, capturedAt };
  if (subtotal) snapshot.subtotal = subtotal;
  if (total) snapshot.total = total;
  if (shipping) snapshot.shipping = shipping;
  if (tax) snapshot.tax = tax;
  if (largestProductPrice) snapshot.displayedPrice = largestProductPrice;
  return snapshot;
}

/** An unlabeled charge only counts if it sits in a block that also has a subtotal/total. */
function looksLikeSummaryRow(n: CandidateNode, ctx: PageContext): boolean {
  if (!ctx.meta.hasOrderSummaryTriple) return false;
  const container = n.containerText;
  return SUBTOTAL_RE.test(container) || TOTAL_RE.test(container);
}

export interface Reconciliation {
  /** Sum of all charges disclosed beyond the base item price. */
  feeTotal: bigint;
  mandatoryTotal: bigint;
  /** total - (subtotal + shipping + tax + fees). Nonzero means something is unaccounted for. */
  unexplained: bigint;
  /** feeTotal / base. The headline number: 0.15+ disclosed late is the strongest finding. */
  dripRatio: number;
  base: bigint;
}

export function reconcile(snapshot: PriceSnapshot): Reconciliation | null {
  const base = snapshot.subtotal?.amount ?? snapshot.displayedPrice?.amount;
  if (base === undefined || base === 0n) return null;

  let feeTotal = 0n;
  let mandatoryTotal = 0n;
  for (const f of snapshot.fees) {
    if (f.kind === "discount") continue;
    feeTotal += f.amount.amount;
    if (f.kind === "mandatory_fee") mandatoryTotal += f.amount.amount;
  }

  const accounted =
    base + (snapshot.shipping?.amount ?? 0n) + (snapshot.tax?.amount ?? 0n) + feeTotal;
  const unexplained = snapshot.total ? snapshot.total.amount - accounted : 0n;

  return {
    feeTotal,
    mandatoryTotal,
    unexplained,
    base,
    // Number() is safe here: both operands are bounded by the parser's sanity cap.
    dripRatio: Number(mandatoryTotal) / Number(base),
  };
}
