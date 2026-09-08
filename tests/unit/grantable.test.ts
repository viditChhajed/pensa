import { describe, expect, it } from "vitest";
import { isGrantable, matchesPattern } from "@/shared/domain";

/**
 * Regression net for a dead button found in manual testing.
 *
 * The popup offered "Enable on this site" on any non-denied page, but
 * chrome.permissions.request only grants patterns declared in optional_host_permissions.
 * On an undeclared site it returns false silently, so the button did nothing and said
 * "Nothing changed" — twice, on two different sites, with no way to tell why.
 */
const DECLARED = ["https://*.booking.com/*", "https://*.etsy.com/*", "https://*.flyfrontier.com/*"];

describe("matchesPattern", () => {
  it("matches the bare domain and any subdomain", () => {
    expect(matchesPattern("https://*.booking.com/*", new URL("https://booking.com/x"))).toBe(true);
    expect(matchesPattern("https://*.booking.com/*", new URL("https://www.booking.com/x"))).toBe(true);
    // The whole reason for domain-wide grants: checkout lives on a different subdomain.
    expect(matchesPattern("https://*.booking.com/*", new URL("https://secure.booking.com/book"))).toBe(true);
  });

  it("does NOT match a look-alike domain", () => {
    // notbooking.com must not be caught by *.booking.com.
    expect(matchesPattern("https://*.booking.com/*", new URL("https://notbooking.com/"))).toBe(false);
    expect(matchesPattern("https://*.booking.com/*", new URL("https://booking.com.evil.net/"))).toBe(false);
  });

  it("respects the scheme", () => {
    expect(matchesPattern("https://*.etsy.com/*", new URL("http://www.etsy.com/"))).toBe(false);
  });
});

describe("isGrantable", () => {
  it("is true for a declared site", () => {
    expect(isGrantable(new URL("https://www.etsy.com/listing/1"), DECLARED)).toBe(true);
    expect(isGrantable(new URL("https://secure.booking.com/book.html"), DECLARED)).toBe(true);
  });

  it("is FALSE for an undeclared site, so no dead button is offered", () => {
    expect(isGrantable(new URL("https://www.frontier.com/"), DECLARED)).toBe(false);
    expect(isGrantable(new URL("https://example.com/"), DECLARED)).toBe(false);
  });
});
