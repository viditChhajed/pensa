/**
 * The denylist, plus the two URL helpers the content script needs.
 *
 * `isDenied()` decides whether the detector runs at all. Vero holds access to every https
 * site at install, so the worst case here is not an awkward prompt but the extension reading
 * a patient portal. It is called from the top of the content script and from the popup, and
 * both must keep calling it.
 *
 * This file is imported by the CONTENT SCRIPT, so everything in it ships on every page load.
 * It used to also build the shop-category table at import time and carry a URL-scoring
 * classifier from the per-site permission model. The classifier was no longer called from
 * anywhere, and the category table is only needed in the worker, so both are gone from here:
 * category lookup lives in `category.ts`, which the page never loads.
 */

import denylistJson from "../../rulepacks/denylist.v1.json";
import { toExcludeMatches } from "./denylistPatterns";

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

const denyPatterns = denylist.hostPatterns.map((p) => new RegExp(p, "i"));

/**
 * What the denylist looks like once it is split into "Chrome enforces this" and "we do".
 *
 * Exported from here rather than recomputed by each caller so that the settings page, the
 * build hook and `isDenied()` are all describing one list. `matches` is what ships as the
 * content script's `exclude_matches`; `inexpressible` is everything a match pattern cannot
 * say, which is covered only by `isDenied()` below.
 */
export const DENYLIST_COVERAGE = toExcludeMatches(denylist);

/**
 * Absolute suppression. Checked before anything else, and never overridden.
 *
 * This is the RUNTIME half of a two-layer guarantee. The manifest's `exclude_matches` stops
 * Chrome injecting on the hosts a match pattern can name; everything else in the denylist —
 * every regex with a wildcard inside a DNS label or no TLD anchor — reaches this function
 * and nothing else. See `denylistPatterns.ts` for exactly which is which.
 */
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
