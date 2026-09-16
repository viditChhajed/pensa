import { describe, expect, it } from "vitest";
import denylistJson from "../../rulepacks/denylist.v1.json";
import { type DenylistShape, toExcludeMatches } from "@/shared/denylistPatterns";
import { matchesPattern } from "@/shared/domain";
import { isDenied } from "@/shared/urlScore";

/**
 * This file replaces `grantable.test.ts`, which is wholly obsolete.
 *
 * That file was a regression net for a dead "Enable on this site" button: the popup offered
 * enablement on any non-denied page, but `chrome.permissions.request` can only grant what
 * `optional_host_permissions` declares, so on an undeclared site it returned false in
 * silence. There is no button, no request, no optional list and no `isGrantable` any more,
 * so every assertion in it was about machinery that no longer exists.
 *
 * What replaced it is the conversion the whole denylist guarantee now rests on: turning
 * denylist regexes into `exclude_matches`, which is the ONLY layer Chrome enforces for us.
 * `matchesPattern` survives too — the popup asks the worker whether the declared content
 * script matches this page, and that is the comparison behind the answer.
 */

const denylist = denylistJson as DenylistShape;
const { matches, inexpressible } = toExcludeMatches(denylist);

describe("matchesPattern", () => {
  it("matches the bare domain and any subdomain", () => {
    expect(matchesPattern("https://*.chase.com/*", new URL("https://chase.com/x"))).toBe(true);
    expect(matchesPattern("https://*.chase.com/*", new URL("https://www.chase.com/x"))).toBe(true);
    expect(matchesPattern("https://*.chase.com/*", new URL("https://secure.chase.com/pay"))).toBe(
      true,
    );
  });

  it("does NOT match a look-alike domain", () => {
    // The denylist's own note: an over-broad host rule silently kills legitimate sites.
    expect(matchesPattern("https://*.chase.com/*", new URL("https://purchase.com/"))).toBe(false);
    expect(matchesPattern("https://*.chase.com/*", new URL("https://chase.com.evil.net/"))).toBe(
      false,
    );
  });

  it("respects the scheme", () => {
    expect(matchesPattern("https://*.chase.com/*", new URL("http://www.chase.com/"))).toBe(false);
  });

  it("treats the all-hosts pattern as matching everything", () => {
    // This is how the popup decides whether the declared content script covers this page.
    for (const url of ["https://shop.example.com/cart", "https://a.b.c.example.org/"]) {
      expect(matchesPattern("https://*/*", new URL(url))).toBe(true);
    }
  });
});

describe("denylist -> exclude_matches", () => {
  it("produces only valid MV3 match patterns", () => {
    // An invalid pattern in exclude_matches makes Chrome refuse to load the extension at
    // all, so a malformed one is not a bad exclusion but a dead product.
    expect(matches.length).toBeGreaterThan(0);
    for (const p of matches) expect(p).toMatch(/^https:\/\/\*\.[a-z0-9.-]+\/\*$/);
  });

  it("converts the TLD suffixes", () => {
    for (const suffix of denylist.hostSuffixes) {
      expect(matches).toContain(`https://*.${suffix.replace(/^\./, "")}/*`);
    }
  });

  it("converts the label-plus-TLD regexes, including multi-TLD alternations", () => {
    // `(^|\.)(chase|...)\.com$` and `(^|\.)(facebook|x|...)\.(com|app|social)$`.
    for (const host of ["chase.com", "paypal.com", "cvs.com", "x.com", "tiktok.app"]) {
      expect(matches, `${host} is expressible and must be excluded by Chrome`).toContain(
        `https://*.${host}/*`,
      );
    }
  });

  it("refuses to approximate anything else, and reports it instead", () => {
    /**
     * The honest half. A match pattern cannot say "any label containing bank", "mychart
     * under any TLD", or "a secure. subdomain in front of a bank name" — so those are NOT
     * in exclude_matches, Chrome does inject on them, and only the runtime `isDenied()` at
     * the top of the detector stops anything happening.
     *
     * Asserted by example rather than by count: a count would go stale the first time
     * someone edits the rulepack, and the point is not how many there are but that these
     * specific shapes are known NOT to be covered by the manifest.
     */
    for (const pattern of [
      "(^|\\.)[a-z0-9-]*bank[a-z0-9-]*\\.",
      "(^|\\.)(mychart|epic|cerner|athenahealth|followmyhealth|healtheintent|patientportal|labcorp|questdiagnostics|quest|onemedical|zocdoc|teladoc|goodrx|carbonhealth)\\.",
      "^(secure|online|banking|ebanking|my)\\.(chase|bofa|bankofamerica|wellsfargo|citi|citibank|usbank|pnc|truist|capitalone|schwab|fidelity|vanguard|ally|discover|amex|americanexpress|synchrony|barclays|hsbc|santander|tdbank|regions|keybank|huntington|firstrepublic)\\.",
    ]) {
      expect(denylist.hostPatterns, "the rulepack changed under this test").toContain(pattern);
      expect(inexpressible, `${pattern} must be reported as regex-only, never approximated`)
        .toContain(pattern);
    }

    // And nothing quietly disappears: every hostPattern is either converted or reported.
    expect(inexpressible.length).toBeGreaterThan(0);
    expect(inexpressible.length).toBeLessThan(denylist.hostPatterns.length);
  });

  it("never excludes a host the denylist does not actually deny", () => {
    /**
     * The conversion is allowed to be over-broad relative to reality (the cross product of
     * a name alternation and a TLD alternation invents `bluesky.com`, which is fine — no
     * shopping happens there) but it must never be over-broad relative to the DENYLIST.
     * An exclusion for a host `isDenied()` would let through means Vero is silently absent
     * somewhere it claims to work, with nothing anywhere saying so.
     */
    for (const p of matches) {
      const host = p.replace(/^https:\/\/\*\./, "").replace(/\/\*$/, "");
      expect(isDenied(new URL(`https://www.${host}/`)), `www.${host} excluded, not denied`).toBe(
        true,
      );
      /**
       * The apex is checked only for multi-label hosts, and that is a real gap rather than a
       * convenience. `\.internal$` denies `foo.internal` and not the bare label `internal`,
       * but a match pattern cannot say "subdomains but not the apex" — `*.internal` covers
       * both. So the three bare-suffix rules (.local, .internal, .test) exclude one single
       * label hostname more than the denylist does. Single-label hosts are not reachable on
       * the public web, so this costs nothing; it is written down because the next person to
       * read a mismatch here should find it explained rather than have to derive it.
       */
      if (host.includes(".")) {
        expect(isDenied(new URL(`https://${host}/`)), `${host} excluded, not denied`).toBe(true);
      }
    }
  });

  it("leaves ordinary retailers alone", () => {
    for (const host of ["shop.example.com", "www.booking.com", "us.shein.com", "etsy.com"]) {
      expect(matches.some((p) => matchesPattern(p, new URL(`https://${host}/`)))).toBe(false);
      expect(isDenied(new URL(`https://${host}/`))).toBe(false);
    }
  });
});
