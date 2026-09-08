/**
 * Registrable-domain helper.
 *
 * Granting `https://www.booking.com/*` does NOT cover `secure.booking.com`, which is where
 * booking.com actually takes payment. Found in manual testing: the extension went dead at
 * exactly the funnel stage the cross-stage detectors exist for, and the user was asked to
 * grant a second time mid-checkout.
 *
 * So permissions are requested per registrable domain (`https://*.booking.com/*`) rather
 * than per exact origin. That is broader, and deliberately so: it is the same operator, and
 * the alternative is a tool that cannot see checkout.
 */

/** Public suffixes that take three labels rather than two. Not exhaustive; covers the allowlist. */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.za",
  "com.br", "com.mx", "com.ar", "co.jp", "co.in",
  "com.sg", "com.hk", "com.tr", "co.kr",
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

/** The match pattern to request for a hostname: covers the domain and every subdomain. */
export function domainMatchPattern(hostname: string): string {
  return `https://*.${registrableDomain(hostname)}/*`;
}
