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
const MAX_CANDIDATES = 3000;
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
 * Walk ancestors until a non-transparent background is found. Gradients report as
 * `rgba(0,0,0,0)` for background-color, so they fall through to the parent — imperfect,
 * and §18E is where that gets handled properly.
 */
function effectiveBackground(el: Element, styleOf: (e: Element) => CSSStyleDeclaration): string {
  let node: Element | null = el;
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
  const containerTexts: string[] = selected.map((el) =>
    normalizeText(joinedText(el.parentElement)),
  );

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
    const text = collapse(el.textContent ?? "");
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

  const bodyText = collapse(doc.body?.textContent ?? "").toLowerCase();
  const hasSummary =
    bodyText.includes("subtotal") &&
    bodyText.includes("total") &&
    (bodyText.includes("tax") || bodyText.includes("shipping"));

  return {
    origin: safeOrigin(url),
    pathTemplate: pathTemplate(url),
    title: collapse(doc.title ?? ""),
    ogType,
    jsonLd,
    hasCcNumberField: hasCc,
    hasPostalCodeField: hasPostal,
    hasAddressCluster: addressFields >= 2,
    hasOrderSummaryTriple: hasSummary,
  };
}

function safeOrigin(url: string): string {
  try {
    return originOf(url);
  } catch {
    return "https://invalid.invalid";
  }
}
