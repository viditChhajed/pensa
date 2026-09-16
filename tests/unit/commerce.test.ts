/**
 * The commerce gate: does this page sell anything?
 *
 * Driven through the real `readDocumentMeta`, not by hand-building a DocumentMeta, because
 * the gate is only as good as the structural reader underneath it and a hand-built fixture
 * would test the scoring while assuming away the hard part.
 */
import { describe, expect, it } from "vitest";
import { classifyCommerce } from "@/content/commerce";
import { readDocumentMeta } from "@/content/harvest";

/**
 * Uses the suite's jsdom global rather than constructing a JSDOM, matching the other unit
 * tests. The url is a parameter to `readDocumentMeta`, so the document's own location does
 * not need to move.
 */
function verdict(html: string, url = "https://shop.example.com/x") {
  document.body.innerHTML = html;
  return classifyCommerce(readDocumentMeta(document, url));
}

describe("pages that are not shops", () => {
  /**
   * The one that prompted this. The popup used to announce "nothing commerce-shaped in
   * /chat/67039775-1f20-47fe-9e59-ebb9fd9a77b7" — a verdict on a STRING. The page itself is
   * unambiguous, and now it is the page that is read.
   */
  it("a chat app is not a shop", () => {
    const v = verdict(
      `<main><h1>Conversation</h1>
       <div class="msg">how much did that cost?</div>
       <div class="msg">about $40 I think</div>
       <button>Send</button></main>`,
      "https://claude.ai/chat/67039775-1f20-47fe-9e59-ebb9fd9a77b7",
    );
    expect(v.isCommerce, v.reasons.join(" | ")).toBe(false);
  });

  it("a news article mentioning prices is not a shop", () => {
    const v = verdict(
      `<article><h1>Inflation hits groceries</h1>
       <p>Eggs rose to $6.99 a dozen, up from $4.49 last year.</p>
       <p>Analysts expect a 20% increase.</p></article>`,
      "https://news.example.com/2026/09/inflation",
    );
    expect(v.isCommerce, v.reasons.join(" | ")).toBe(false);
  });

  it("a blog post ABOUT add-to-cart buttons is not a shop", () => {
    // Half a signal is deliberately not enough. This is the shape that would fire if
    // add-to-cart alone were sufficient.
    const v = verdict(
      `<article><h1>Designing the add to cart button</h1>
       <p>A good add to cart control should be obvious.</p></article>`,
      "https://uxblog.example.com/add-to-cart",
    );
    expect(v.isCommerce, v.reasons.join(" | ")).toBe(false);
  });

  it("a docs page under /products/ is not a shop", () => {
    // A URL heuristic would have called this commerce. That is the whole point.
    const v = verdict(
      `<article><h1>Products API</h1><p>GET /v1/products returns a list.</p></article>`,
      "https://developer.example.com/products/api",
    );
    expect(v.isCommerce, v.reasons.join(" | ")).toBe(false);
  });
});

describe("pages that are shops", () => {
  it("a product page with Product+offers JSON-LD", () => {
    const v = verdict(
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Balm Dotcom",
        offers: { "@type": "Offer", price: "12.00", priceCurrency: "USD" },
      })}</script>
      <h1>Balm Dotcom</h1><span>$12.00</span><button>Add to bag</button>`,
    );
    expect(v.isCommerce, v.reasons.join(" | ")).toBe(true);
  });

  it("a cart with priced rows and quantity controls, and no structured data at all", () => {
    const v = verdict(
      `<div class="line"><span>Striped Joggers</span><span>$24.99</span>
         <input type="number" value="1" aria-label="Quantity"><button>Remove</button></div>
       <div><span>Subtotal</span><span>$24.99</span></div>
       <div><span>Shipping</span><span>$5.00</span></div>
       <div><span>Order total</span><span>$29.99</span></div>
       <button>Checkout</button>`,
      "https://shop.example.com/cart",
    );
    expect(v.isCommerce, v.reasons.join(" | ")).toBe(true);
  });

  it("a checkout with a place-order control", () => {
    const v = verdict(
      `<div><span>Total</span><span>$81.20</span></div>
       <button>Place order</button>`,
      "https://shop.example.com/checkout",
    );
    expect(v.isCommerce, v.reasons.join(" | ")).toBe(true);
  });
});

describe("the verdict explains itself", () => {
  it("names the signals it found", () => {
    const v = verdict(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        offers: { "@type": "Offer", price: "9.99", priceCurrency: "USD" },
      })}</script><button>Add to cart</button>`,
    );
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.reasons.join(" ")).toMatch(/structured data|product/i);
  });

  it("a non-shop reports no reasons rather than a bare number", () => {
    const v = verdict(`<p>Hello there.</p>`, "https://example.com/about");
    expect(v.score).toBe(0);
    expect(v.reasons).toEqual([]);
  });
});
