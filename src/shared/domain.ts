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

/** Public suffixes that take three labels rather than two. Not exhaustive; covers the allowlist. */
const TWO_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.za",
  "com.br",
  "com.mx",
  "com.ar",
  "co.jp",
  "co.in",
  "com.sg",
  "com.hk",
  "com.tr",
  "co.kr",
]);

/** `www.booking.com` -> `booking.com`; `tjmaxx.tjx.com` -> `tjx.com`; `a.co.uk` -> `a.co.uk`. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
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
