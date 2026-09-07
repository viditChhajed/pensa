/**
 * Offer identity resolution (plan T24, §18B).
 *
 * The same product has to be recognisable across PDP -> cart -> checkout even though the
 * URL changes and an SPA re-renders everything. Resolution order, most to least reliable:
 *
 *   1. JSON-LD `@id` / `productID` / `sku` / `gtin*` — authoritative when present
 *   2. Structured markup attributes (`data-sku`, `itemprop=sku`)
 *   3. A hash of the URL path template plus the product title
 *
 * The fallback is deliberately last. Titles get truncated differently at each stage
 * ("Blue Cotton Shirt - Medium" on the PDP, "Blue Cotton Shirt" in the cart), so trigram
 * similarity handles the comparison rather than equality.
 */
import { createHash } from "./detectors/hash";
import type { DocumentMeta } from "./types";

export type OfferKeySource = "jsonld_id" | "sku" | "gtin" | "url_title_hash";

export interface ResolvedOffer {
  offerKey: string;
  source: OfferKeySource;
  title: string;
}

interface JsonLdNode {
  "@type"?: unknown;
  "@id"?: unknown;
  sku?: unknown;
  productID?: unknown;
  gtin?: unknown;
  gtin13?: unknown;
  gtin12?: unknown;
  gtin8?: unknown;
  mpn?: unknown;
  name?: unknown;
  [k: string]: unknown;
}

function isProductNode(node: JsonLdNode): boolean {
  const t = node["@type"];
  if (t === "Product" || t === "Offer") return true;
  return Array.isArray(t) && t.some((x) => x === "Product" || x === "Offer");
}

/** Depth-bounded walk. JSON-LD nests arbitrarily and some sites emit huge graphs. */
function findProductNodes(root: unknown, depth = 0, out: JsonLdNode[] = []): JsonLdNode[] {
  if (depth > 5 || root === null || typeof root !== "object") return out;
  if (Array.isArray(root)) {
    for (const item of root) findProductNodes(item, depth + 1, out);
    return out;
  }
  const node = root as JsonLdNode;
  if (isProductNode(node)) out.push(node);
  for (const v of Object.values(node)) findProductNodes(v, depth + 1, out);
  return out;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim().slice(0, 128);
  if (typeof v === "number") return String(v);
  return null;
}

export function resolveOffer(meta: DocumentMeta, doc?: Document): ResolvedOffer | null {
  const products = meta.jsonLd.flatMap((b) => findProductNodes(b));

  for (const p of products) {
    const title = str(p.name) ?? meta.title;

    const gtin = str(p.gtin13) ?? str(p.gtin12) ?? str(p.gtin8) ?? str(p.gtin);
    if (gtin) return { offerKey: `gtin:${gtin}`, source: "gtin", title };

    const sku = str(p.sku) ?? str(p.productID) ?? str(p.mpn);
    if (sku) return { offerKey: `sku:${sku}`, source: "sku", title };

    const id = str(p["@id"]);
    if (id) return { offerKey: `id:${createHash(id).slice(0, 24)}`, source: "jsonld_id", title };
  }

  if (doc) {
    const el = doc.querySelector("[itemprop='sku'], [data-sku], [data-product-id]");
    const sku =
      el?.getAttribute("content") ??
      el?.getAttribute("data-sku") ??
      el?.getAttribute("data-product-id") ??
      el?.textContent?.trim();
    if (sku && sku.length > 0 && sku.length < 64) {
      return { offerKey: `sku:${sku}`, source: "sku", title: meta.title };
    }
  }

  if (meta.title.length === 0) return null;
  const basis = `${meta.pathTemplate}|${normalizeTitle(meta.title)}`;
  return {
    offerKey: `h:${createHash(basis).slice(0, 24)}`,
    source: "url_title_hash",
    title: meta.title,
  };
}

/** Strip site-name suffixes and separators so titles compare across stages. */
export function normalizeTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .split(/\s+[|\-–—]\s+/)[0]
      ?.replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/**
 * Jaccard similarity over character trigrams. Used to match a cart line item back to the
 * product that was added, where the two titles are rarely byte-identical.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;

  const ta = trigrams(na);
  const tb = trigrams(nb);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Plan §18B specifies 0.85; that is strict enough to avoid pairing sibling variants. */
export const TITLE_MATCH_THRESHOLD = 0.85;
