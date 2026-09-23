/**
 * Is this page a shop? Answered from the PAGE, not from its address.
 *
 * What this replaces. The old model asked the user to enable Pensa site by site, and the
 * popup explained itself with a URL score, "nothing commerce-shaped in /chat/67039775…,
 * so you may see nothing here". That line was answering a question nobody asked, on a page
 * that was obviously not a shop, using the only evidence available at the time: a string.
 * You cannot inspect a page to decide whether to ask permission to inspect the page, so
 * before the grant the address was all there was.
 *
 * That constraint is gone. Pensa now holds the permission at install, so by the time this
 * runs the document is right there. A URL heuristic is strictly worse than reading the
 * thing, and it is wrong in both directions: `/chat/…` is not commerce, but neither is
 * `/products/engineering-blog`, and plenty of real storefronts live at paths no pattern
 * predicts.
 *
 * So: read the page, decide, and if it is not a shop, shut down and record nothing.
 *
 * WHAT COUNTS AS EVIDENCE, and why it is weighted this way. The strong signals are the ones
 * a non-shop has no reason to fake, Product/Offer JSON-LD exists to be read by shopping
 * crawlers, and a cart line item with a quantity stepper and a remove button is furniture
 * that only a cart has. The weak signals are shapes a blog or a news site can produce by
 * accident: a price-shaped string, the word "cart" in a nav.
 *
 * DIRECTION OF ERROR. A false negative costs one page of missed detections. A false positive
 * costs a card interrupting someone on a page that was never selling anything, which is the
 * failure that gets an extension uninstalled, and, now that Pensa reads every https page,
 * the failure that would make it feel like spyware. So the threshold is set to need real
 * evidence, and every ambiguous case resolves to "not a shop".
 */
import type { DocumentMeta } from "./types";

/** Reached on any page carrying genuine shop structure. Hand-set; see EVAL.md on thresholds. */
export const COMMERCE_THRESHOLD = 1;

export interface CommerceVerdict {
  readonly isCommerce: boolean;
  readonly score: number;
  /** Which signals fired, for the popup and for the "why did nothing happen" question. */
  readonly reasons: readonly string[];
}

/**
 * Schema.org types that mean someone is selling something. `Product` alone is not enough,
 * a review site marks up Products too, so an Offer, or a price, has to come with it. That
 * check lives in `hasProductJsonLd`, which the harvester already computes.
 */
function jsonLdSellsSomething(blocks: readonly unknown[]): boolean {
  const SELLING = new Set(["Offer", "AggregateOffer", "Order", "ShoppingCart", "CheckoutPage"]);
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 6 || node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((n) => walk(n, depth + 1));
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && SELLING.has(t))) return true;
    // `offers` on a Product is the single most reliable "this is for sale" marker there is.
    if ("offers" in obj || "priceCurrency" in obj) return true;
    return Object.values(obj).some((v) => walk(v, depth + 1));
  };
  return blocks.some((b) => walk(b, 0));
}

/**
 * Score the page. Anything at or above COMMERCE_THRESHOLD is treated as a shop.
 *
 * Structured data and cart furniture are each sufficient on their own, because both are
 * expensive to produce by accident. Everything else has to combine with something.
 */
export function classifyCommerce(meta: DocumentMeta): CommerceVerdict {
  const reasons: string[] = [];
  let score = 0;

  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(reason);
  };

  // --- Sufficient on their own -------------------------------------------------------
  if (meta.hasProductJsonLd) add(1, "a product with a price in structured data");
  else if (jsonLdSellsSomething(meta.jsonLd)) add(1, "an offer in structured data");

  if (meta.ogType === "product" || meta.ogType === "product.item") add(1, "og:type is product");

  // A priced row with a quantity stepper or a remove control is cart furniture. Nothing that
  // is not a cart builds this.
  if (meta.cartLineItems > 0 && (meta.hasQuantityControl || meta.hasRemoveControl)) {
    add(1, "cart rows with quantity or remove controls");
  }

  if (meta.hasTotalRow && meta.moneySummaryRows >= 2) add(1, "an order total and its breakdown");
  if (meta.placeOrderCtaCount > 0) add(1, "a place-order control");
  if (meta.hasStepIndicator && meta.checkoutCtaCount > 0) add(1, "a checkout step indicator");

  /**
   * Selling without a cart.
   *
   * Everything above assumes a retail cart: a product page, priced rows with steppers, an order
   * summary. Travel, lodging and ticketing have none of those, and the first version of this gate
   * scored booking.com, kayak.com, eventbrite.com and ticketmaster.com at exactly ZERO, Pensa was
   * silent on all four, which is where drip pricing and dated urgency live most heavily.
   *
   * A booking control plus a price is the equivalent structure; per-unit pricing ("$189/night")
   * is enough on its own, being specific enough that prose quoting a price cannot produce it.
   */
  if (meta.perUnitPriceRows > 0) add(1, "prices quoted per night, person or ticket");

  /**
   * A page full of prices is a shop window, whatever furniture it lacks.
   *
   * Measured before choosing the numbers, because the whole risk here is calling a news site a
   * shop: booking.com's home page shows 105 price strings and an Eventbrite city listing 105,
   * while nytimes.com shows 6 (its own subscription offers) and a Wikipedia article on "Price"
   * shows none. Twenty is far above the prose band and far below the listing band.
   */
  if (meta.pricedTextCount >= 20) add(1, "a page full of prices");
  else if (meta.pricedTextCount >= 8) add(0.5, "several prices");
  /**
   * A booking control counts only beside money. On its own it was worth half a signal, which
   * added to the half already given for a checkout control, so a travel ARTICLE with a "Book
   * now" button and a "Proceed to the next article" link scored exactly 1.0 and was judged a
   * shop. Two weak signals that are both just button wording are not evidence of a shop.
   */
  if (meta.bookingCtaCount > 0 && (meta.moneySummaryRows > 0 || meta.pricedTextCount >= 4)) {
    add(1, "a booking control beside prices");
  }

  // --- Need company -------------------------------------------------------------------
  // An add-to-cart control is strong, but the phrase appears in blog posts about commerce
  // and in nav chrome on marketing sites, so on its own it is half a signal.
  if (meta.addToCartCtaCount > 0) add(0.5, "an add-to-cart control");
  if (meta.checkoutCtaCount > 0) add(0.5, "a checkout control");
  if (meta.moneySummaryRows > 0) add(0.5, "priced summary rows");

  return { isCommerce: score >= COMMERCE_THRESHOLD, score, reasons };
}
