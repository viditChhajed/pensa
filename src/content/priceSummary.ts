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
import { ADDON_REGEXES } from "@/shared/addons";
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
      // Lodging and short-let fees, added before testing choicehotels. These are the
      // best-known drip charges in the industry — a destination fee is the one the FTC and
      // several state AGs have actually litigated over — and every one of them classified
      // as `unknown`, reaching fees[] only via the summary-row fallback rather than being
      // recognised for what it is.
      /\bdestination fee\b/,
      /\bamenity fee\b/,
      /\bcleaning fee\b/,
      /\bservice charge\b/,
      /\bparking fee\b/,
      /\boccupancy fee\b/,
      /\burban fee\b/,
      /\bhotel fee\b/,
      /\bhost fee\b/,
      // A blended "taxes and fees" line is a fee line: the fees are hidden inside it, and
      // when the whole line only appears at the last step that is drip pricing regardless of
      // how much of it is tax. Bare "tax" stays classified as tax, below.
      /\btaxes?\s*(?:and|&|\+)\s*fees?\b/,
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
  // Shared with the page's choice listener and the worker's attribution check, so all three
  // agree on what an add-on is. See src/shared/addons.ts.
  ["optional_addon", ADDON_REGEXES],
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

  // A fee can be reached by more than one candidate in awkward markup; count it once.
  const seenFees = new Set<string>();

  for (const n of ctx.candidates) {
    const text = n.text;
    if (text.length === 0 || text.length > 120) continue;

    const prices = parsePrices(text);
    if (prices.length !== 1) continue;
    let price = prices[0] as ParsedPrice;

    let label = labelOf(text, price);
    let labelFromAncestor = false;

    if (label.trim().length === 0) {
      // THE reason pricing.drip never fired on any site.
      //
      // A summary row is almost always two sibling elements — `<span>Subtotal</span>` and
      // `<span>$40.00</span>` — and harvest only accepts elements with DIRECT text, so the
      // row itself is never a candidate. The label span carries no digit or currency and
      // fails the prefilter. Only the bare amount survives, and reading one candidate's text
      // can never see a label that lives in its sibling. Subtotal, total and every fee came
      // back empty on a page that plainly displayed all of them.
      //
      // containerText is the parent's joined text, which is exactly that row. Requiring it
      // to hold a single price keeps a whole cart block from being read as one line item.
      // rowText first: it is the nearest ancestor that actually reads like a row, which
      // handles `<span class="amt"><b>$6.00</b></span>` where the label is two levels up.
      // containerText is the fallback for the simpler one-level case.
      labelFromAncestor = true;
      for (const scope of [n.rowText, n.containerText]) {
        if (scope.length === 0 || scope.length > 140) continue;
        const scopePrices = parsePrices(scope);
        if (scopePrices.length !== 1) continue;
        const scopeLabel = labelOf(scope, scopePrices[0] as ParsedPrice);
        if (scopeLabel.trim().length === 0) continue;
        label = scopeLabel;
        price = scopePrices[0] as ParsedPrice;
        break;
      }
    }

    const lower = label.toLowerCase();
    if (label.trim().length === 0) {
      // A bare price with no label anywhere near it: the headline product price on a PDP.
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
      // A label borrowed from an ancestor is a guess, and on a product page the ancestor is
      // often just the product's own name ("Ticket $40.00"). If that guess does not classify
      // and does not sit in a money summary, it was not a fee — it was the headline price,
      // and dropping it silently costs drip the base it reconciles against.
      if (kind === "unknown" && labelFromAncestor && !looksLikeSummaryRow(n, ctx)) {
        if (!largestProductPrice || price.amount > largestProductPrice.amount) {
          largestProductPrice = money(price);
        }
        continue;
      }

      const dedupeKey = `${lower}|${price.amount}`;
      if ((kind !== "unknown" || looksLikeSummaryRow(n, ctx)) && !seenFees.has(dedupeKey)) {
        seenFees.add(dedupeKey);
        fees.push({
          labelHash: createHash(lower),
          labelSample: label,
          amount: money(price),
          kind,
          kindConfidence: confidence,
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
  // Was hasOrderSummaryTriple, which demanded subtotal AND total AND tax/shipping and so
  // failed on Ticketmaster (SUBTOTAL only) and Glossier ("Tax calculated in checkout", no
  // amount). Two labelled money rows is the shape an order summary actually has.
  if (ctx.meta.moneySummaryRows < 2) return false;
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
