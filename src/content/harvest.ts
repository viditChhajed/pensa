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
/**
 * Hard ceiling, not the working limit. See HARVEST_BUDGET_MS.
 *
 * A fixed count was the wrong instrument, and measuring showed why: rei has 1437 qualifying
 * nodes and reads them in 55ms, while newegg has 3807 and takes 347ms. One number cannot
 * serve both — at 1200 rei was needlessly truncated, and without a limit newegg spent seven
 * times its whole frame budget in a single phase.
 */
const MAX_CANDIDATES = 4000;

/**
 * How long the batched layout/style phase may spend before it stops taking on more nodes.
 *
 * Every candidate costs a getBoundingClientRect and a getComputedStyle, both of which force
 * style resolution, and that phase is where nearly all of the harvest cost lives. Tying the
 * limit to time rather than to a count means a cheap page is read completely and an
 * expensive one degrades at a known cost instead of at an arbitrary node index.
 *
 * Known bias, stated rather than hidden: truncation follows document order, so what gets
 * dropped is the bottom of a long page. The salience gate already requires a node to have
 * been on screen, and the digest fires at cart and checkout where pages are shorter, so this
 * costs least where it matters most — but it is a real limitation and not a rounding error.
 */
const HARVEST_BUDGET_MS = 35;
/**
 * Computed styles, kept ACROSS passes. Plan §18C, the affordable half of it.
 *
 * `pass()` re-harvests the whole document every time, so a busy SPA re-resolves style for
 * thousands of unchanged elements continuously — measured at 1839ms on target.com, and the
 * reason the time budget above has to truncate newegg at roughly 2700 of its 3900 candidates.
 * A page that is blind past node 2700 stays blind, pass after pass, because every pass
 * starts from the same cold state and stops in the same place.
 *
 * Caching turns that into convergence: the nodes read last time are nearly free this time,
 * so the budget is spent on the ones that were skipped, and after two or three passes the
 * whole page has been seen.
 *
 * STYLES ONLY, and that is not a shortcut — it is the correctness boundary.
 * `getBoundingClientRect` is VIEWPORT-relative, so a cached box is wrong the instant the
 * page scrolls, with no mutation to invalidate it. Boxes are therefore re-read every pass;
 * they are also the cheap half, which is how this was found in the first place: budgeting
 * only the rects changed newegg's harvest by nothing at all.
 *
 * Invalidation is by dirty subtree (`invalidateStyles`, fed from the MutationObserver's
 * roots) plus an epoch counter for changes that produce no mutation record at all — a
 * resize re-evaluates every media query and is not something any element reports.
 */
interface CachedStyle {
  epoch: number;
  snap: StyleSnapshot;
}
const styleMemo = new WeakMap<Element, CachedStyle>();
let styleEpoch = 0;

/**
 * Forget the cached style for these elements and everything under them.
 *
 * The subtree, not just the root: `effectiveBackground` is resolved by walking ancestors, so
 * a background that changes on a wrapper invalidates every descendant's snapshot even though
 * only the wrapper mutated. Bounded by the size of what actually changed, which is the whole
 * point of dirty-root invalidation.
 */
export function invalidateStyles(roots: Iterable<Element>): void {
  /**
   * A total work budget, not a per-root size limit.
   *
   * The first version bailed to a global epoch bump whenever any single root had more than
   * 2000 descendants. On a loading retail page a high-up container is dirty almost every
   * batch, so that path fired continuously and the cache hit rate measured on newegg was
   * exactly ZERO across every pass — a cache that is flushed before it is ever read is worse
   * than no cache, because it costs a WeakMap write per node for nothing.
   *
   * Walking is cheap; `querySelectorAll("*")` over a few thousand elements is microseconds,
   * far less than re-resolving style for even a handful of them. So walk, and keep the
   * global flush only for the genuinely pathological case where the dirty set approaches the
   * whole document — at which point there is nothing worth preserving anyway.
   */
  let budget = 50_000;
  let rootCount = 0;
  let elementCount = 0;
  for (const root of roots) {
    rootCount++;
    styleMemo.delete(root);
    let descendants: NodeListOf<Element>;
    try {
      descendants = root.querySelectorAll("*");
    } catch {
      continue;
    }
    budget -= descendants.length;
    if (budget < 0) {
      // Loud, for the same reason the truncation warning is: a silent global flush and a
      // page that simply never repeats a node look identical from the outside, and the
      // first version of this fired on every batch without anything saying so.
      console.warn(
        `[vero] style cache flushed entirely — ${rootCount} dirty root(s) covering more ` +
          "than 50k elements between them",
      );
      styleEpoch++;
      harvestStats.invalidatedRoots = rootCount;
      harvestStats.invalidatedElements = -1;
      return;
    }
    elementCount += descendants.length;
    for (const el of descendants) styleMemo.delete(el);
  }
  harvestStats.invalidatedRoots = rootCount;
  harvestStats.invalidatedElements = elementCount;
}

/** Drop every cached style. For changes no element reports: resize, zoom, print. */
export function invalidateAllStyles(): void {
  styleEpoch++;
}

/** Test seam: how many of the last pass's style reads came from cache. */
export const harvestStats = {
  cached: 0,
  cold: 0,
  truncatedAt: -1,
  /** Last invalidateStyles call: how much was dropped. -1 elements means a global flush. */
  invalidatedRoots: 0,
  invalidatedElements: 0,
};

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
  // Self-incriminating acknowledgements: "I understand purchasing options separately may
  // result in a higher overall price." Nothing in that sentence is a digit, a currency glyph
  // or any word above, so the prefilter dropped the node and confirmshaming never saw it.
  "i understand",
  "i acknowledge",
  "i accept",
  "almost gone",
  "selling fast",
  "in carts",
  // These are shipped scarcity patterns whose text carries no digit, no currency glyph and
  // none of the words above — so the prefilter rejected the node and the detector never saw
  // it. The pattern existed and could not fire, which is the same shape of dead code that
  // hid pricing.drip. Found by probing "Premium seats, going fast", which scored nothing.
  "going fast",
  "supplies last",
  "limited quantity",
  "limited availability",
  "last chance",
  "few left",
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
  /**
   * Deadline copy stated in words. "ends" was here; "ending" was not, and `includes("ends")`
   * does not match "ending" — so "Summer sale ending soon" was rejected by the prefilter and
   * no detector ever saw it.
   *
   * That is the third time this list has been wrong in the same way, each time found by
   * probing a phrase by hand. `tests/unit/prefilter.test.ts` now asserts every piece of
   * canonical positive copy survives this function, so the next omission fails a test
   * instead of waiting to be noticed.
   */
  "ending",
  "expiring",
  "closes",
  "sale",
  "offer",
  "tonight",
  "final hours",
  "don't miss",
  "act now",
  "back in stock",
  /**
   * "Buy now, pay later" and "will fill up fast" both scored ZERO, and neither was a
   * detector bug — the prefilter dropped the node before any detector was offered it.
   * Neither phrase has a digit, a currency glyph or any word above. "buy now, pay later" is
   * the category's own name.
   *
   * Fourth occurrence of this exact failure. `tests/unit/prefilter.test.ts` guards the
   * canonical examples, so these are now in that list too — a lexeme added to a detector
   * without a matching example here is a lexeme that can still never fire.
   */
  "pay later",
  "pay over time",
  "fill up fast",
  "selling out",
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
/**
 * Resolving a true painted background costs a getComputedStyle per ancestor. Doing it for
 * every candidate meant tens of thousands of style resolutions per pass and was the single
 * largest cost in the harvest — measured at 1839ms on target.com.
 *
 * But `interference.visual_asymmetry` genuinely needs it: contrast against a transparent
 * element resolves to the wrong colour, and its whole claim is that one button is far more
 * prominent than the other. So the walk is back, restricted to what that detector actually
 * pairs — interactive controls — which is a few dozen nodes rather than a thousand.
 */
const BACKGROUND_WALK_MAX_HOPS = 8;

function needsBackgroundWalk(el: Element): boolean {
  const tag = el.tagName;
  return (
    tag === "BUTTON" ||
    tag === "A" ||
    tag === "INPUT" ||
    tag === "LABEL" ||
    el.getAttribute("role") === "button" ||
    el.getAttribute("role") === "link"
  );
}

function effectiveBackground(el: Element, styleOf: (e: Element) => CSSStyleDeclaration): string {
  const own = styleOf(el).backgroundColor;
  const isTransparent = !own || own === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(own);
  if (!isTransparent) return own;
  if (!needsBackgroundWalk(el)) return "rgb(255, 255, 255)";

  let node: Element | null = el.parentElement;
  let hops = 0;
  while (node && hops < BACKGROUND_WALK_MAX_HOPS) {
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

  // Layout AND style together, bounded by time rather than by count.
  //
  // Both in the same loop deliberately. getBoundingClientRect turns out to be cheap once
  // layout has been computed once; getComputedStyle is what actually costs — budgeting only
  // the rects changed newegg's harvest by nothing at all, because the expense was still
  // ahead in a separate pass. Measuring what is slow before limiting it is the whole point.
  //
  // Checked every 32 nodes: often enough to stop promptly, rarely enough that
  // performance.now() is not itself a cost.
  const readStarted = performance.now();
  const boxes: BoxSnapshot[] = [];
  const styles: StyleSnapshot[] = [];
  harvestStats.cached = 0;
  harvestStats.cold = 0;
  harvestStats.truncatedAt = -1;

  const readOne = (el: Element): void => {
    // Always re-read. Viewport-relative, so a cache would be wrong after any scroll.
    const r = el.getBoundingClientRect();
    boxes.push({ x: r.x, y: r.y, w: r.width, h: r.height });

    const memo = styleMemo.get(el);
    if (memo && memo.epoch === styleEpoch) {
      harvestStats.cached++;
      styles.push(memo.snap);
      return;
    }

    const cs = styleOf(el);
    const snap: StyleSnapshot = {
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
    harvestStats.cold++;
    styleMemo.set(el, { epoch: styleEpoch, snap });
    styles.push(snap);
  };

  let stoppedAt = -1;
  for (let i = 0; i < selected.length; i++) {
    if ((i & 31) === 0 && i > 0 && performance.now() - readStarted > HARVEST_BUDGET_MS) {
      stoppedAt = i;
      break;
    }
    readOne(selected[i] as Element);
  }

  harvestStats.truncatedAt = stoppedAt;
  if (stoppedAt >= 0) {
    // Drop what we cannot afford, so every parallel array below stays the same length and no
    // detector ever sees a candidate with no box.
    const dropped = selected.splice(stoppedAt);

    // Ephemeral nodes are exempt from the budget. They are appended after the tree walk, so
    // they sit at the very end of `selected` and a time limit would drop them first — and a
    // just-inserted toast or a countdown that rewrites itself is the single highest-value
    // thing on the page. Silencing `urgency.countdown` to save 2ms is the wrong trade, and
    // there are never many of them, so reading all of them cannot itself blow the budget.
    let rescued = 0;
    if (opts.ephemeral) {
      for (const el of dropped) {
        if (!opts.ephemeral.has(el)) continue;
        selected.push(el);
        readOne(el);
        rescued++;
      }
    }

    // Loud, because the consequence is that the page was only partly seen. A quiet
    // truncation looks exactly like a page that simply had fewer candidates.
    console.warn(
      `[vero] harvest budget (${HARVEST_BUDGET_MS}ms) hit at ${stoppedAt} of ` +
        `${stoppedAt + dropped.length} candidates — ${dropped.length - rescued} not read` +
        (rescued > 0 ? `, ${rescued} ephemeral node(s) read anyway` : "") +
        // Whether this page is converging matters more than the truncation itself: a rising
        // cache share means the next pass reaches further, and a flat one means it never
        // will.
        ` (styles ${harvestStats.cached} cached / ${harvestStats.cold} cold; last ` +
        `invalidation ${harvestStats.invalidatedRoots} root(s), ` +
        `${harvestStats.invalidatedElements === -1 ? "ALL" : harvestStats.invalidatedElements} elements)`,
    );
  }

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
  const contact = readContactFields(doc);
  const hasPostal =
    doc.querySelector('input[autocomplete~="postal-code"]') !== null || contact.postal;
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
    hasAddressCluster: addressFields >= 2 || contact.addressish >= 2,
    hasContactCluster: contact.name && contact.email,
    ...structural,
  };
}

/**
 * Who you are, not where to ship. Read from every attribute a field might carry its meaning
 * in, because `autocomplete` alone is not enough.
 *
 * Checkout detection used to require autocomplete="address-line1" and friends, which assumes
 * a SHIPPING checkout. booking.com's "Enter your details" is first name, last name, email
 * and country — a hotel booking has no street address — so its checkout page classified as
 * `browse`, the stage never changed, the checkout-intent trigger never fired, and no card
 * ever appeared. Travel, ticketing and digital goods all check out this way.
 */
function readContactFields(doc: Document): {
  name: boolean;
  email: boolean;
  postal: boolean;
  addressish: number;
} {
  let name = false;
  let email = false;
  let postal = false;
  let addressish = 0;

  for (const el of doc.querySelectorAll("input, select")) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "hidden" || type === "search" || type === "password") continue;
    const hint = [
      el.getAttribute("autocomplete"),
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (hint.length === 0 && type !== "email") continue;

    if (type === "email" || /\bemail\b|e-mail/.test(hint)) email = true;
    if (
      /first[\s_-]*name|last[\s_-]*name|given[\s_-]*name|family[\s_-]*name|surname|full[\s_-]*name/.test(
        hint,
      )
    ) {
      name = true;
    }
    if (/post(al)?[\s_-]*code|\bzip\b|\bpostcode\b/.test(hint)) postal = true;
    if (
      /address|street|\bcity\b|\btown\b|address-level|\bcountry\b|\bregion\b|\bstate\b/.test(hint)
    ) {
      addressish++;
    }
  }
  return { name, email, postal, addressish };
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
