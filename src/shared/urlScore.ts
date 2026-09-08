/**
 * Stage-1 commerce classifier (plan §14.3). URL ONLY — this runs with zero page access,
 * because without host permission there is no DOM to inspect. That is the whole constraint:
 * you cannot read a page to decide whether to ask for permission to read the page.
 *
 * The denylist is evaluated FIRST and is absolute. No commerce score can override it.
 * A false positive here means inviting someone to grant page access on their bank or their
 * doctor's portal, which is the worst outcome this product can produce.
 */

import allowlistJson from "../../rulepacks/allowlist.v1.json";
import denylistJson from "../../rulepacks/denylist.v1.json";
import { registrableDomain } from "./domain";
import type { OriginCategory } from "./schema";

/**
 * The rulepacks are OUR OWN build artifacts, inlined by the bundler and fixed at compile
 * time. They are not a runtime trust boundary, so validating them here bought nothing and
 * cost ~30 KB gzipped: it dragged Zod into the content script and the popup, both of which
 * otherwise need none of it. Shape is asserted in `tests/unit/rulepacks.test.ts` instead,
 * which is where a build-time fact belongs.
 */
const denylist = denylistJson as {
  hostSuffixes: string[];
  hostPatterns: string[];
  schemes: string[];
};
const allowlist = allowlistJson as {
  version: string;
  entries: { origin: string; category: OriginCategory; note?: string }[];
};

const denyPatterns = denylist.hostPatterns.map((p) => new RegExp(p, "i"));

/**
 * Keyed by REGISTRABLE DOMAIN, not exact origin.
 *
 * Exact-origin matching meant us.shein.com was unrecognised while www.shein.com was known,
 * and the popup told the user that Shein "does not look like a shopping site". Permissions
 * were already granted per domain; this lookup had been left behind on origins, so the two
 * halves disagreed about what site you were on.
 */
const DOMAIN_TO_CATEGORY = new Map<string, OriginCategory>(
  allowlist.entries.map((e) => [registrableDomain(new URL(e.origin).hostname), e.category]),
);

export const ALLOWLIST_ORIGINS: readonly string[] = allowlist.entries.map((e) => e.origin);
export const ALLOWLIST_VERSION = allowlist.version;

export function categoryForOrigin(origin: string): OriginCategory | undefined {
  try {
    return DOMAIN_TO_CATEGORY.get(registrableDomain(new URL(origin).hostname));
  } catch {
    return undefined;
  }
}

/** True for any subdomain of an allowlisted domain: us.shein.com, secure.booking.com. */
export function isAllowlisted(origin: string): boolean {
  return categoryForOrigin(origin) !== undefined;
}

/** Registrable domains of every allowlisted entry, for declarativeContent rules. */
export const ALLOWLIST_DOMAINS: readonly string[] = [...DOMAIN_TO_CATEGORY.keys()];

/** Absolute suppression. Checked before anything else, and never overridden. */
export function isDenied(url: URL): boolean {
  if (denylist.schemes.includes(url.protocol)) return true;

  const host = url.hostname.toLowerCase();
  for (const suffix of denylist.hostSuffixes) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  for (const re of denyPatterns) {
    if (re.test(host)) return true;
  }
  return false;
}

const PATH_TOKENS: readonly (readonly [RegExp, number])[] = [
  [/\/checkout(\/|$)/i, 0.45],
  [/\/(cart|basket|bag)(\/|$)/i, 0.45],
  [/\/(products?|item|itm|dp|pd)\//i, 0.3],
  [/\/p\/[^/]+/i, 0.3],
  [/\/collections?\//i, 0.2],
  [/\/(shop|store)(\/|$)/i, 0.2],
  [/\/(order|orders)(\/|$)/i, 0.25],
  [/\/(booking|book|reserve|reservation)(\/|$)/i, 0.3],
  [/\/tickets?(\/|$)/i, 0.3],
  [/\/(payment|billing)(\/|$)/i, 0.35],
];

const QUERY_KEYS: readonly (readonly [string, number])[] = [
  ["sku", 0.25],
  ["variant", 0.25],
  ["productid", 0.3],
  ["product_id", 0.3],
  ["add-to-cart", 0.4],
  ["qty", 0.15],
  ["quantity", 0.15],
  ["itemid", 0.25],
];

const HOST_SIGNATURES: readonly (readonly [RegExp, number])[] = [
  [/\.myshopify\.com$/i, 0.45],
  [/^checkout\.stripe\.com$/i, 0.5],
  [/\.bigcartel\.com$/i, 0.45],
  [/\.squarespace\.com$/i, 0.2],
  [/^(shop|store|buy)\./i, 0.3],
  [/^(book|booking|reserve)\./i, 0.3],
  [/^(secure|checkout)\./i, 0.25],
];

export interface UrlScore {
  score: number;
  denied: boolean;
  allowlisted: boolean;
  signals: string[];
}

/**
 * Returns 0..1. Callers must treat `denied` as terminal — never prompt on it, whatever the
 * score says. Scoring an allowlisted origin still runs, so the icon reflects the page and
 * not merely the domain.
 */
export function scoreUrl(rawUrl: string): UrlScore {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { score: 0, denied: true, allowlisted: false, signals: ["unparseable"] };
  }

  if (isDenied(url)) {
    return { score: 0, denied: true, allowlisted: false, signals: ["denylist"] };
  }

  const signals: string[] = [];
  let score = 0;

  const origin = `${url.protocol}//${url.hostname}`;
  const allowlisted = isAllowlisted(origin);
  if (allowlisted) {
    score += 0.5;
    signals.push("allowlist");
  }

  for (const [re, w] of PATH_TOKENS) {
    if (re.test(url.pathname)) {
      score += w;
      signals.push(`path:${re.source}`);
    }
  }

  const params = new URLSearchParams(url.search);
  for (const [key, w] of QUERY_KEYS) {
    for (const present of params.keys()) {
      if (present.toLowerCase() === key) {
        score += w;
        signals.push(`query:${key}`);
        break;
      }
    }
  }

  for (const [re, w] of HOST_SIGNATURES) {
    if (re.test(url.hostname)) {
      score += w;
      signals.push(`host:${re.source}`);
    }
  }

  return { score: Math.min(1, score), denied: false, allowlisted, signals };
}

/**
 * The score's signals, in words a person can read.
 *
 * Lives here rather than in the popup so it can be tested without a DOM, and so the wording
 * cannot drift from the signal names that produce it.
 */
export function describeSignals(signals: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of signals) {
    let phrase: string;
    if (s === "allowlist") phrase = "known retailer";
    else if (s.startsWith("path:")) phrase = "commerce URL path";
    else if (s.startsWith("query:")) phrase = `cart parameter (${s.slice("query:".length)})`;
    else if (s.startsWith("host:")) phrase = "commerce hostname";
    else continue;
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out;
}

/** Default prompt threshold. Adjusted per-user after ~30 local decisions (§14.3). */
export const DEFAULT_PROMPT_THRESHOLD = 0.45;

/** `https://x.com/a/b?c=1` -> `https://x.com`. Throws on anything unparseable. */
export function originOf(rawUrl: string): string {
  const u = new URL(rawUrl);
  return `${u.protocol}//${u.hostname}`;
}

/**
 * `/products/blue-shirt-12345?variant=7` -> `/products/:slug`
 * Digits, uuids and long slugs are redacted. Never returns a query string.
 */
export function pathTemplate(rawUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return "/";
  }
  const segments = pathname.split("/").filter(Boolean).slice(0, 6);
  const templated = segments.map((seg) => {
    if (/^\d+$/.test(seg)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
    if (/\d{4,}/.test(seg)) return ":slug";
    if (seg.length > 24) return ":slug";
    return seg.toLowerCase();
  });
  return `/${templated.join("/")}`;
}
