/**
 * Funnel stage classifier, content-first.
 *
 * The previous version scored URL path tokens at 0.5-0.6, which meant the URL decided the
 * answer and everything else was decoration. In the field it was right once in four:
 *
 *   - Shopify keeps /products/<slug> on its bag drawer, so a cart with a subtotal, a
 *     quantity stepper, a Remove link and a Checkout button classified as `pdp`.
 *   - Ticketmaster keeps /event/<id> on a page with a quantity stepper, a SUBTOTAL and a
 *     Reserve Tickets button. Also `pdp`.
 *   - Frontier's fare-selection and upsell pages classified as `browse`.
 *
 * That is not a gap in the URL list, it is the wrong input. Retailers route by product for
 * good reasons and nothing obliges them to change the path when the page becomes a cart.
 *
 * So: STRUCTURE decides, URL breaks ties. A page with repeated priced rows carrying
 * quantity controls is a cart whatever its path says, and negative evidence counts, a page
 * with a quantity stepper and a Remove control is not a product page no matter how much
 * Product JSON-LD it carries.
 *
 * This matters beyond tidiness: `pricing.drip` compares price snapshots ACROSS stages, so a
 * flow that never appears to leave one stage disables the highest-value detector in the
 * product entirely.
 */
import type { FunnelStage } from "@/shared/schema";
import type { DocumentMeta } from "./types";

type Scores = Record<FunnelStage, number>;

/**
 * URL contributes at most ~0.2, enough to separate two structurally identical pages,
 * never enough to overrule what is actually on the page.
 */
const URL_WEIGHT = 0.2;

const PATH_SIGNALS: readonly (readonly [RegExp, FunnelStage])[] = [
  [/\/payment|\/billing/i, "payment"],
  [/\/checkout|\/place-?order/i, "checkout"],
  [/\/(cart|basket|bag)(\/|$|\?)/i, "cart"],
  [/\/(products?|item|itm|dp|pd)\//i, "pdp"],
  [/\/p\/[^/]+/i, "pdp"],
  [/\/(collections?|category|c|search|s)(\/|\?|$)/i, "browse"],
];

export interface StageExplanation {
  stage: FunnelStage;
  scores: Scores;
  reasons: string[];
}

/** Classify, and say why. The reasons exist so a wrong call can be diagnosed from a log. */
export function explainStage(url: string, meta: DocumentMeta): StageExplanation {
  const scores: Scores = { browse: 0.15, pdp: 0, cart: 0, checkout: 0, payment: 0 };
  const reasons: string[] = [];

  const add = (stage: FunnelStage, amount: number, why: string): void => {
    scores[stage] += amount;
    reasons.push(`${stage} +${amount.toFixed(2)} ${why}`);
  };

  // ---- payment: the least ambiguous signal on the web ----
  if (meta.hasCcNumberField) add("payment", 0.9, "card-number field");
  if (meta.placeOrderCtaCount > 0) add("payment", 0.35, "place-order CTA");

  // ---- checkout ----
  if (meta.hasAddressCluster) add("checkout", 0.5, "address field cluster");
  // Identity fields count only alongside money. A newsletter signup in a footer has a name
  // and an email too, and on its own that would make every page with one look like checkout.
  if (meta.hasContactCluster && (meta.moneySummaryRows >= 1 || meta.hasTotalRow)) {
    add("checkout", 0.45, "contact fields with a money summary");
  }
  if (meta.hasPostalCodeField) add("checkout", 0.2, "postal-code field");
  if (meta.hasStepIndicator) add("checkout", 0.4, "checkout step indicator");
  if (meta.placeOrderCtaCount > 0) add("checkout", 0.25, "place-order CTA");

  // ---- cart ----
  // The defining shape: repeated priced rows you can change the quantity of or delete.
  if (meta.cartLineItems >= 1) {
    add(
      "cart",
      Math.min(0.6, 0.35 + 0.12 * meta.cartLineItems),
      `${meta.cartLineItems} line item(s)`,
    );
  }
  if (meta.hasQuantityControl && meta.hasRemoveControl) {
    add("cart", 0.35, "quantity + remove controls");
  }
  if (meta.moneySummaryRows >= 2) {
    add("cart", 0.3, `${meta.moneySummaryRows} money-summary rows`);
    add("checkout", 0.2, "money summary");
  }
  if (meta.hasTotalRow) add("cart", 0.2, "order-total row");
  if (meta.checkoutCtaCount > 0 && meta.addToCartCtaCount === 0) {
    add("cart", 0.25, "checkout CTA and no add-to-cart");
  }

  // ---- pdp ----
  if (meta.hasProductJsonLd) add("pdp", 0.4, "Product/Offer JSON-LD");
  if (meta.ogType === "product") add("pdp", 0.35, "og:type=product");
  // A single add-to-cart is a product page; a grid of them is a listing.
  if (meta.addToCartCtaCount === 1) add("pdp", 0.4, "exactly one add-to-cart");
  else if (meta.addToCartCtaCount >= 4)
    add("browse", 0.35, `${meta.addToCartCtaCount} add-to-cart CTAs`);

  // ---- negative evidence ----
  // Shopify bag drawers and Ticketmaster's selector both carry Product markup while being
  // carts. Editable line items beat schema.
  if (meta.cartLineItems >= 1 && meta.hasRemoveControl) {
    scores.pdp -= 0.5;
    reasons.push("pdp -0.50 editable line items present");
    scores.browse -= 0.3;
    reasons.push("browse -0.30 editable line items present");
  }
  if (meta.hasCcNumberField) {
    scores.pdp -= 0.4;
    scores.browse -= 0.4;
    reasons.push("pdp/browse -0.40 card field present");
  }

  // ---- URL: tiebreaker only ----
  let pathname = "/";
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* keep default */
  }
  for (const [re, stage] of PATH_SIGNALS) {
    if (re.test(pathname)) {
      add(stage, URL_WEIGHT, `url ${re.source}`);
      break; // one URL vote, not a stack of them
    }
  }

  let best: FunnelStage = "browse";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [stage, value] of Object.entries(scores) as [FunnelStage, number][]) {
    if (value > bestScore) {
      bestScore = value;
      best = stage;
    }
  }

  return { stage: best, scores, reasons };
}

export function classifyStage(url: string, meta: DocumentMeta): FunnelStage {
  return explainStage(url, meta).stage;
}
