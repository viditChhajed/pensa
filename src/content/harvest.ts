/**
 * Candidate harvesting and the read phase (plan §18C, T9/T10).
 *
 * Phase 1 (here) does every DOM read there will ever be: one TreeWalker pass with a cheap
 * character-class prefilter, then a single batched sweep of getComputedStyle and
 * getBoundingClientRect. Phase 2 (the detectors) sees only plain objects.
 *
 * The batching matters: interleaving style reads with anything that could invalidate layout
 * is what produces forced synchronous reflow, and on a heavy PDP that is the difference
 * between 20ms and 400ms.
 */

import { originOf, pathTemplate } from "@/shared/urlScore";
import {
  type BoxSnapshot,
  type CandidateNode,
  CharClass,
  type DocumentMeta,
  type StyleSnapshot,
  type TextObservation,
} from "./types";

const MAX_TEXT = 400;
/**
 * Lowered from 3000 after measuring real pages. Every candidate costs a getBoundingClientRect
 * and a getComputedStyle, both of which force style resolution. A retail homepage has
 * thousands of elements and essentially none of the interesting ones are past the first
 * several hundred that pass the character-class prefilter.
 */
const MAX_CANDIDATES = 1200;
const MAX_PATH_DEPTH = 12;

/** Single characters that are cheap to test and imply a detector might care. */
const CURRENCY_CHARS = "$£€¥₹";

/**
 * Lexicon trigger letters. Deliberately coarse — the point is rejecting >95% of nodes for
 * almost no cost, not being precise. Precision is the detector's job.
 */
const TRIGGER_WORDS = [
  "only",
  "left",
  "stock",
  "hurry",
  "ends",
  "expires",
  "sold",
  "viewing",
  "people",
  "was",
  "msrp",
  "compare",
  "list",
  "orig",
  "save",
  "off",
  "deal",
  "reserved",
  "held",
  "away from",
  "add",
  "unlock",
  "spend",
  "free shipping",
  "interest-free",
  "payments of",
  "no thanks",
  "i don",
  "i'd rather",
  "almost gone",
  "selling fast",
  "in carts",
  // Purchase-toast copy carries no digit or currency glyph, so without these words the
  // prefilter rejects "Sarah in Denver just bought this" before any detector sees it.
  "bought",
  "purchased",
  "ordered",
  "booked",
  "just",
  "someone",
  "claimed",
  "signed up",
  // Goal-gradient and BNPL copy that can appear with no currency symbol.
  "qualify",
  "to go",
  "installment",
  "instalment",
  "interest free",
  "per month",
];

export function classifyText(text: string): number {
  let mask = CharClass.None;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c >= "0" && c <= "9") mask |= CharClass.Digit;
    else if (CURRENCY_CHARS.includes(c)) mask |= CharClass.Currency;
    else if (c === ":") mask |= CharClass.Colon;
    else if (c === "%") mask |= CharClass.Percent;
  }
  const lower = text.toLowerCase();
  for (const w of TRIGGER_WORDS) {
    if (lower.includes(w)) {
      mask |= CharClass.LexiconTrigger;
      break;
    }
  }
  return mask;
}

export function normalizeText(raw: string): string {
  return raw.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

export function collapse(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

/** Depth-capped, nth-of-type CSS path. Stable enough to re-find a node; short enough to store. */
export function selectorPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < MAX_PATH_DEPTH) {
    let part = node.tagName.toLowerCase();
    const id = node.getAttribute("id");
    if (id && /^[a-zA-Z][\w-]*$/.test(id)) {
      parts.unshift(`#${id}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node?.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
    depth++;
  }
  return parts.join(">");
}

const ATTRS_OF_INTEREST = [
  "type",
  "checked",
  "aria-checked",
  "aria-label",
  "aria-hidden",
  "role",
  "id",
  "data-testid",
  "data-action",
  "data-test",
  "name",
  "value",
  "href",
  "src",
  "alt",
];

function attrSubset(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of ATTRS_OF_INTEREST) {
    const v = el.getAttribute(a);
    if (v !== null) out[a] = v.slice(0, 200);
  }
  if (el instanceof HTMLInputElement) {
    out.checked = String(el.checked);
    out.type = el.type;
    if (el.name) out.name = el.name;
  }
  return out;
}

/** aria-label > aria-labelledby > alt > value > trimmed text. Good enough, cheap. */
function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return collapse(aria);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ref = el.ownerDocument.getElementById(labelledBy);
    if (ref) return collapse(ref.textContent ?? "");
  }
  const alt = el.getAttribute("alt");
  if (alt) return collapse(alt);
  if (el instanceof HTMLInputElement && el.value) return collapse(el.value);
  return collapse(el.textContent ?? "");
}

/**
 * Resolve the background a node is painted against.
 *
 * The ancestor walk is DISABLED in v1, and the reason is a measured one. It called
 * getComputedStyle on up to 12 ancestors for every one of up to 3000 candidates — tens of
 * thousands of style resolutions per pass. Measured on real storefronts that produced passes
 * of 1839ms on target.com and a sustained ~100ms on ikea, against a 50ms budget.
 *
 * The only consumer that needs a true effective background is
 * `interference.visual_asymmetry`, which is DEFERRED to v1.1 and not in the shipped
 * registry. So v1 was paying the single largest cost in the harvest for a value nothing it
 * ships actually reads.
 *
 * When §18E ships, restore the walk — but do it for the handful of paired accept/decline
 * controls that detector identifies, not for every candidate on the page.
 */
const WALK_ANCESTORS_FOR_BACKGROUND = false;

function effectiveBackground(el: Element, styleOf: (e: Element) => CSSStyleDeclaration): string {
  const own = styleOf(el).backgroundColor;
  const isTransparent = !own || own === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(own);
  if (!isTransparent) return own;

  if (!WALK_ANCESTORS_FOR_BACKGROUND) return "rgb(255, 255, 255)";

  let node: Element | null = el.parentElement;
  let hops = 0;
  while (node && hops < 12) {
    const bg = styleOf(node).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg)) return bg;
    node = node.parentElement;
    hops++;
  }
  return "rgb(255, 255, 255)";
}

export interface HarvestOptions {
  /** Nodes seen mutating, keyed by element. Supplied by the observer. */
  textHistories?: Map<Element, TextObservation[]>;
  ephemeral?: Map<Element, { insertedAt: number; removedAt: number | null }>;
  root?: ParentNode;
}

/**
 * The single DOM pass. Returns plain objects; after this returns, nothing else reads layout.
 */
export function harvest(doc: Document, opts: HarvestOptions = {}): CandidateNode[] {
  const root = opts.root ?? doc.body;
  if (!root) return [];

  // --- pass 1: select candidate elements, no style/layout reads at all ---
  const selected: Element[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node): number {
      const el = node as Element;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG") {
        return NodeFilter.FILTER_REJECT;
      }
      // Interactive controls are always candidates — defaults/confirmshaming need them.
      if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "A") {
        return NodeFilter.FILTER_ACCEPT;
      }
      if (tag === "DEL" || tag === "S" || tag === "STRIKE") return NodeFilter.FILTER_ACCEPT;

      // Only leaf-ish text carriers, so we do not accept every wrapper div on the page.
      const direct = directText(el);
      if (direct.length === 0) return NodeFilter.FILTER_SKIP;
      if (classifyText(direct) === CharClass.None) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode() && selected.length < MAX_CANDIDATES) {
    selected.push(walker.currentNode as Element);
  }

  // Ephemeral nodes may already be detached; include them explicitly.
  if (opts.ephemeral) {
    for (const el of opts.ephemeral.keys()) {
      if (!selected.includes(el) && selected.length < MAX_CANDIDATES) selected.push(el);
    }
  }

  // --- pass 2: batched layout + style reads. Nothing here writes to the DOM. ---
  const win = doc.defaultView ?? globalThis.window;
  const styleCache = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (e: Element): CSSStyleDeclaration => {
    let s = styleCache.get(e);
    if (!s) {
      s = win.getComputedStyle(e);
      styleCache.set(e, s);
    }
    return s;
  };

  const boxes: BoxSnapshot[] = selected.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // Container identity and text, read in the same batched phase as everything else.
  const containerPathCache = new Map<Element, string>();
  const containerPaths: (string | null)[] = selected.map((el) => {
    const parent = el.parentElement;
    if (!parent) return null;
    let p = containerPathCache.get(parent);
    if (p === undefined) {
      p = selectorPath(parent);
      containerPathCache.set(parent, p);
    }
    return p;
  });
  // `textContent` concatenates children with NO separator: a parent holding
  // <span>$12.00</span><span>25% off</span> yields "$12.0025% off", which runs the digits
  // together and defeats every word-boundary regex downstream. Join on element boundaries.
  //
  // MEMOISED BY PARENT. Candidates overwhelmingly share parents — a price row, a plan card,
  // a form label all produce several candidates under one element — and joinedText walks the
  // parent's whole subtree. Computing it per candidate re-walked the same subtrees over and
  // over and was the dominant cost of the pass: measured at 1839ms on target.com against a
  // 50ms budget.
  const containerTextCache = new Map<Element, string>();
  /**
   * Nearest labelled-row ancestor, bounded to 3 levels and cached per element.
   *
   * Bounded because the point is the row, not the page: widen it and a price pairs with the
   * entire cart. Cached because joinedText is O(subtree), and calling it per candidate per
   * level unguarded is exactly the quadratic pattern that made this phase the most expensive
   * one in a pass.
   */
  const ROW_LOOKUP_LEVELS = 3;
  const PRICE_GLYPH = /[$£€¥₹]\s?\d/;
  const rowTextCache = new Map<Element, string>();
  const joinedCached = (el: Element): string => {
    let t = rowTextCache.get(el);
    if (t === undefined) {
      t = normalizeText(joinedText(el));
      rowTextCache.set(el, t);
    }
    return t;
  };
  /** Text with prices and punctuation stripped. Empty means "this is only a price". */
  const withoutPrice = (t: string): string =>
    t.replace(/[$£€¥₹]\s?[\d.,]+/g, "").replace(/[\d.,\s\-–—:•]/g, "");

  const rowTexts: string[] = selected.map((el) => {
    // Only bare prices ever need this, and they are a small minority of candidates. Walking
    // ancestors for every candidate cost ~30ms of harvest on newegg for values nothing read.
    const own = joinedCached(el);
    if (own.length === 0 || own.length > 40) return "";
    if (!PRICE_GLYPH.test(own)) return "";
    if (withoutPrice(own).length > 0) return "";

    let node = el.parentElement;
    for (let i = 0; node && i < ROW_LOOKUP_LEVELS; i++, node = node.parentElement) {
      const t = joinedCached(node);
      if (t.length === 0 || t.length > 140) continue;
      if (!PRICE_GLYPH.test(t)) continue;
      // Something besides the price: that is the label.
      if (withoutPrice(t).length > 0) return t;
    }
    return "";
  });

  const containerTexts: string[] = selected.map((el) => {
    const parent = el.parentElement;
    if (!parent) return "";
    let t = containerTextCache.get(parent);
    if (t === undefined) {
      t = normalizeText(joinedText(parent));
      containerTextCache.set(parent, t);
    }
    return t;
  });

  // Whether a progress element sits inside this node. A wrapper's progress bar is usually
  // NOT itself a candidate (it has no text), so detectors cannot find it via childIdxs.
  const hasProgress: boolean[] = selected.map(
    (el) => el.querySelector('progress, [role="progressbar"]') !== null,
  );

  const styles: StyleSnapshot[] = selected.map((el) => {
    const cs = styleOf(el);
    return {
      fontWeight: Number.parseInt(cs.fontWeight, 10) || 400,
      fontSizePx: Number.parseFloat(cs.fontSize) || 16,
      textDecorationLine: cs.textDecorationLine || cs.textDecoration || "none",
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      effectiveBackground: effectiveBackground(el, styleOf),
      display: cs.display,
      visibility: cs.visibility,
      opacity: Number.parseFloat(cs.opacity) || 1,
    };
  });

  // --- pass 3: assemble plain objects. Zero DOM access below this line. ---
  const indexOf = new Map<Element, number>();
  selected.forEach((el, i) => {
    indexOf.set(el, i);
  });

  return selected.map((el, i) => {
    // joinedText, NOT textContent. The Day-1 fix covered containerText and left this
    // field carrying the identical flaw: textContent concatenates descendants with no
    // separator, so a container reads as "Customers Also Viewed10#KnitEssentials-15%..."
    // and any word-boundary regex over it is meaningless. That produced charm's
    // unreadable evidence during the spot-check.
    const text = joinedText(el);
    const eph = opts.ephemeral?.get(el);
    const childIdxs: number[] = [];
    for (const child of el.children) {
      const ci = indexOf.get(child);
      if (ci !== undefined) childIdxs.push(ci);
    }
    return {
      idx: i,
      tagName: el.tagName,
      role: el.getAttribute("role"),
      accessibleName: accessibleName(el),
      text,
      normalizedText: normalizeText(text),
      charClass: classifyText(text),
      selectorPath: selectorPath(el),
      style: styles[i] as StyleSnapshot,
      box: boxes[i] as BoxSnapshot,
      attrs: attrSubset(el),
      parentIdx: el.parentElement ? (indexOf.get(el.parentElement) ?? null) : null,
      containerPath: el.parentElement ? (containerPaths[i] ?? null) : null,
      containerText: containerTexts[i] ?? "",
      rowText: rowTexts[i] ?? "",
      hasProgressDescendant: hasProgress[i] ?? false,
      childIdxs,
      textHistory: opts.textHistories?.get(el) ?? [],
      ephemeral: eph !== undefined && eph.removedAt !== null,
      insertedAt: eph?.insertedAt ?? null,
      removedAt: eph?.removedAt ?? null,
    } satisfies CandidateNode;
  });
}

/** Text of an element's children, separated so adjacent nodes do not merge into one token. */
function joinedText(el: Element | null): string {
  if (!el) return "";
  const parts: string[] = [];
  for (const n of el.childNodes) {
    if (n.nodeType === 3) parts.push(n.nodeValue ?? "");
    else if (n.nodeType === 1) parts.push((n as Element).textContent ?? "");
  }
  return collapse(parts.join(" "));
}

/** Text belonging directly to this element, not to its descendants. */
function directText(el: Element): string {
  let out = "";
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += n.nodeValue ?? "";
  }
  return collapse(out);
}

/** Document-level facts the funnel classifier and several detectors need. */
export function readDocumentMeta(doc: Document, url: string): DocumentMeta {
  const jsonLd: unknown[] = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      jsonLd.push(JSON.parse(script.textContent ?? ""));
    } catch {
      // Malformed JSON-LD is extremely common. Skip it; never throw on someone else's page.
    }
  }

  const ogType = doc.querySelector('meta[property="og:type"]')?.getAttribute("content") ?? null;
  const hasCc = doc.querySelector('input[autocomplete~="cc-number"]') !== null;
  const hasPostal = doc.querySelector('input[autocomplete~="postal-code"]') !== null;
  const addressFields = doc.querySelectorAll(
    'input[autocomplete~="address-line1"], input[autocomplete~="address-level2"], input[autocomplete~="country"]',
  ).length;

  const structural = readStructuralSignals(doc);

  return {
    origin: safeOrigin(url),
    pathTemplate: pathTemplate(url),
    title: collapse(doc.title ?? ""),
    ogType,
    jsonLd,
    hasCcNumberField: hasCc,
    hasPostalCodeField: hasPostal,
    hasAddressCluster: addressFields >= 2,
    ...structural,
  };
}

const PRICE_SHAPED = /[$£€¥₹]\s?\d/;
// Broadened after the Frontier fare page produced zero summary rows: "Taxes and fees" is
// not matched by /\btax\b/, and "Trip total" is not in any airline-free label list.
const MONEY_LABEL =
  /\b(sub-?totals?|totals?|amount due|you pay|taxe?s?|vat|gst|fees?|shipping|delivery|savings?|discounts?|promotions?|retail price|estimated price|handling|charges?)\b/i;
const TOTAL_LABEL = /\b(totals?|amount due|you pay)\b/i;
const REMOVE_CTL = /^(remove|delete|trash|bin|×|✕|x)$/i;
const QTY_HINT = /\b(qty|quantity)\b/i;

/**
 * What the page IS, structurally.
 *
 * Every signal here is deliberately independent of the URL. A page with repeated priced
 * rows carrying quantity steppers and remove buttons is a cart whether it lives at /cart,
 * /products/body-spritz or /event/0500648A9C927EA6 — and all three of those were seen in
 * the field.
 */
function readStructuralSignals(doc: Document) {
  let cartLineItems = 0;
  let moneySummaryRows = 0;
  let hasTotalRow = false;
  let hasQuantityControl = false;
  let hasRemoveControl = false;
  let addToCartCtaCount = 0;
  let checkoutCtaCount = 0;
  let placeOrderCtaCount = 0;

  // Quantity controls: a number input, a qty-named select, or a stepper pair.
  if (
    doc.querySelector(
      'input[type="number"], select[name*="qty" i], select[name*="quant" i], ' +
        '[data-testid*="qty" i], [aria-label*="quantity" i], [class*="quantity" i] button',
    )
  ) {
    hasQuantityControl = true;
  }

  for (const el of doc.querySelectorAll('button, a, [role="button"]')) {
    const name = collapse(el.getAttribute("aria-label") ?? el.textContent ?? "").toLowerCase();
    if (name.length === 0 || name.length > 60) continue;
    if (REMOVE_CTL.test(name.trim())) hasRemoveControl = true;
    if (/\bremove\b|\bdelete\b/.test(name)) hasRemoveControl = true;
    if (/\badd to (cart|bag|basket|order)\b|\bbuy now\b|\badd to my bag\b/.test(name)) {
      addToCartCtaCount++;
    }
    if (
      /\bcheckout\b|\bcheck out\b|\bproceed to\b|\bcontinue to (payment|checkout)\b|\breserve\b/.test(
        name,
      )
    ) {
      checkoutCtaCount++;
    }
    if (/\bplace order\b|\bpay now\b|\bcomplete (order|purchase)\b|\bsubmit order\b/.test(name)) {
      placeOrderCtaCount++;
    }
  }

  // ---- one bottom-up text pass, shared by both scans below ----
  //
  // These two scans used to call joinedText (and, for line items, querySelectorAll) once per
  // element over essentially the whole document. Both are O(subtree) per element, so the
  // scans were quadratic and readDocumentMeta became the single most expensive phase of a
  // pass — measured at 96ms on ikea against a 50ms budget for the entire pass.
  //
  // Computing every element's joined text once, children before parents, makes it linear.
  // Text is capped because nothing here cares about a string longer than a cart row.
  const MAX_ROW_TEXT = 420;
  const textOf = new Map<Element, string>();
  const post: Element[] = [];
  const walker = doc.createTreeWalker(doc.body ?? doc, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) post.push(n as Element);

  for (let i = post.length - 1; i >= 0; i--) {
    const el = post[i] as Element;
    // Same shape as joinedText: element boundaries become spaces, so "$12.00" and "25% off"
    // in sibling nodes never glue into "$12.0025% off".
    const parts: string[] = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 3) parts.push(child.nodeValue ?? "");
      else if (child.nodeType === 1) parts.push(textOf.get(child as Element) ?? "");
      if (parts.length > 60) break;
    }
    textOf.set(el, collapse(parts.join(" ")).slice(0, MAX_ROW_TEXT));
  }

  /** Mark an element and its bounded ancestry, for "does this row contain one" questions. */
  const markUp = (el: Element, into: Set<Element>, levels = 6): void => {
    let node: Element | null = el;
    for (let i = 0; node && i < levels; i++) {
      into.add(node);
      node = node.parentElement;
    }
  };

  const hasQtyWithin = new Set<Element>();
  for (const el of doc.querySelectorAll(
    'input[type="number"], select[name*="qty" i], select[name*="quant" i], [aria-label*="quantity" i]',
  )) {
    markUp(el, hasQtyWithin);
  }
  const hasRemoveWithin = new Set<Element>();
  for (const el of doc.querySelectorAll('button, a, [role="button"]')) {
    const n = collapse(el.getAttribute("aria-label") ?? el.textContent ?? "").toLowerCase();
    if (/\bremove\b|\bdelete\b/.test(n) || REMOVE_CTL.test(n.trim())) markUp(el, hasRemoveWithin);
  }

  // Money-summary rows: a short element carrying a money label AND a price.
  for (const el of post) {
    const t = textOf.get(el) ?? "";
    if (t.length === 0 || t.length > 90) continue;
    if (!PRICE_SHAPED.test(t)) continue;
    if (!MONEY_LABEL.test(t)) continue;
    // Only count leaf-ish rows so a wrapper is not counted alongside its children.
    if (el.querySelector("div, li, tr, section")) continue;
    moneySummaryRows++;
    if (TOTAL_LABEL.test(t)) hasTotalRow = true;
  }

  // Cart line items: the INNERMOST row carrying a price together with a quantity control or
  // a remove affordance.
  //
  // "Innermost" must be judged on the FULL predicate, not on "contains a price": Shopify
  // nests the price in its own div inside the row, so a price-only test discarded the real
  // row as a wrapper and kept a leaf that had no controls. Live result was cartLineItems: 0
  // on a visibly open cart, which left the stage at `pdp`.
  const ROW_TAGS = new Set(["LI", "TR", "DIV", "ARTICLE"]);
  const isLineItem = (el: Element): boolean => {
    if (!ROW_TAGS.has(el.tagName)) return false;
    const t = textOf.get(el) ?? "";
    if (t.length === 0 || t.length > 400) return false;
    if (!PRICE_SHAPED.test(t)) return false;
    return hasQtyWithin.has(el) || QTY_HINT.test(t) || hasRemoveWithin.has(el);
  };

  const rows = post.filter(isLineItem);
  const hasRowInside = new Set<Element>();
  for (const row of rows) {
    let node = row.parentElement;
    while (node) {
      hasRowInside.add(node);
      node = node.parentElement;
    }
  }
  for (const row of rows) {
    if (!hasRowInside.has(row)) cartLineItems++;
  }

  // Step chrome: "Cart > Place Order > Pay > Order Complete".
  const bodyText = collapse(doc.body?.textContent ?? "").toLowerCase();
  // Any breadcrumb-ish sequence of two funnel words. The previous version enumerated exact
  // pairs and matched none of the four flows in the spot-check.
  const STEP_WORD =
    "(cart|bag|basket|flights?|bundle|seats?|extras|shipping|delivery|details|review|payment|checkout|place order|confirm)";
  const hasStepIndicator = new RegExp(
    `${STEP_WORD}\\s*[>\u203a\u00bb\u2192|\u2022]\\s*${STEP_WORD}`,
  ).test(bodyText);

  return {
    cartLineItems: Math.min(cartLineItems, 50),
    moneySummaryRows: Math.min(moneySummaryRows, 20),
    hasTotalRow,
    hasQuantityControl,
    hasRemoveControl,
    hasStepIndicator,
    addToCartCtaCount: Math.min(addToCartCtaCount, 50),
    checkoutCtaCount: Math.min(checkoutCtaCount, 20),
    placeOrderCtaCount: Math.min(placeOrderCtaCount, 20),
    hasProductJsonLd: hasProductSchema(doc),
  };
}

function hasProductSchema(doc: Document): boolean {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      if (containsProductType(JSON.parse(script.textContent ?? ""), 0)) return true;
    } catch {
      /* malformed JSON-LD is extremely common; never throw on someone else's page */
    }
  }
  return false;
}

function containsProductType(node: unknown, depth: number): boolean {
  if (depth > 5 || node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => containsProductType(n, depth + 1));
  const rec = node as Record<string, unknown>;
  const t = rec["@type"];
  if (t === "Product" || t === "Offer") return true;
  if (Array.isArray(t) && t.some((x) => x === "Product" || x === "Offer")) return true;
  return Object.values(rec).some((v) => containsProductType(v, depth + 1));
}

function safeOrigin(url: string): string {
  try {
    return originOf(url);
  } catch {
    return "https://invalid.invalid";
  }
}
