import { getDomain } from "tldts";
/**
 * Registrable-domain helper.
 *
 * It existed because permissions were requested per domain: granting `www.booking.com` did
 * not cover `secure.booking.com`, which is where booking.com actually takes payment, so the
 * extension went dead at exactly the funnel stage the cross-stage detectors exist for and
 * asked for a second grant mid-checkout. Nothing is granted per site any more, so that
 * particular failure is gone along with `domainMatchPattern` itself.
 *
 * What is left is still needed twice over: the allowlist category lookup is keyed by
 * registrable domain (us.shein.com and www.shein.com are one retailer), and it is the name
 * the popup shows a person for the site they are on.
 */

/**
 * The shop a hostname belongs to: `us.shein.com` -> `shein.com`, `a.co.uk` -> `a.co.uk`,
 * `cool-shop.myshopify.com` -> `cool-shop.myshopify.com`.
 *
 * Backed by the Public Suffix List (via tldts), INCLUDING its private section. This used to be
 * "the last two labels unless they appear in a list of fourteen suffixes", which recorded
 * jumia.com.ng as the site `com.ng`, noon.com.sa as `com.sa`, and folded every store on
 * Shopify's default domain into one site called `myshopify.com`. For a dataset whose whole
 * purpose is per-site prevalence, that merged unrelated shops and invented sites that do not
 * exist. Private suffixes matter here: a store at cool-shop.myshopify.com is its own shop.
 *
 * Falls back to the lowercased hostname for anything the list cannot parse (IP addresses,
 * single-label hosts), so callers always get a string.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/**
 * Does `url` fall under a match pattern?
 *
 * It used to answer "can the popup offer to grant this?", back when there was something to
 * grant. There is not any more, and `isGrantable` went with the button. What survives is
 * the same string test applied to a different question: the popup asks the worker whether
 * the manifest's declared content script matches this page, and whether one of the
 * denylist-derived `exclude_matches` catches it first.
 *
 * Read the patterns from `chrome.runtime.getManifest()` rather than re-deriving them, so
 * the answer cannot drift from what Chrome actually loaded.
 */
export function matchesPattern(pattern: string, url: URL): boolean {
  const m = /^(\*|https?):\/\/(\*\.)?([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, wildcardSub, host] = m;

  if (scheme !== "*" && `${scheme}:` !== url.protocol) return false;
  if (host === "*") return true;
  if (!host) return false;

  const target = url.hostname.toLowerCase();
  const want = host.toLowerCase();
  return wildcardSub ? target === want || target.endsWith(`.${want}`) : target === want;
}
