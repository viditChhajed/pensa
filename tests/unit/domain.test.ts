import { describe, expect, it } from "vitest";
import { domainMatchPattern, registrableDomain } from "@/shared/domain";

/**
 * Regression net for a flaw found in manual testing: a grant for www.booking.com did not
 * cover secure.booking.com, so the extension went blind at checkout — exactly where the
 * cross-stage detectors (pricing.drip, basket.sneak) do their only work.
 */
describe("registrableDomain", () => {
  it("strips subdomains", () => {
    expect(registrableDomain("www.booking.com")).toBe("booking.com");
    expect(registrableDomain("secure.booking.com")).toBe("booking.com");
    expect(registrableDomain("tjmaxx.tjx.com")).toBe("tjx.com");
    expect(registrableDomain("www2.hm.com")).toBe("hm.com");
  });

  it("handles a bare domain", () => {
    expect(registrableDomain("etsy.com")).toBe("etsy.com");
  });

  it("keeps three labels for two-part public suffixes", () => {
    // Two labels would give "co.uk", which as a match pattern would cover all of Britain.
    expect(registrableDomain("www.marksandspencer.co.uk")).toBe("marksandspencer.co.uk");
    expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
  });

  it("is case-insensitive and tolerates a trailing dot", () => {
    expect(registrableDomain("WWW.Booking.COM.")).toBe("booking.com");
  });
});

describe("domainMatchPattern", () => {
  it("covers the checkout subdomain from one grant", () => {
    const pattern = domainMatchPattern("www.booking.com");
    expect(pattern).toBe("https://*.booking.com/*");
  });

  it("never produces a pattern that spans a public suffix", () => {
    for (const host of [
      "www.booking.com",
      "www.marksandspencer.co.uk",
      "shop.example.com.au",
      "etsy.com",
    ]) {
      const p = domainMatchPattern(host);
      expect(p).not.toBe("https://*.com/*");
      expect(p).not.toBe("https://*.co.uk/*");
      expect(p).not.toBe("https://*.com.au/*");
      expect(p.split(".").length).toBeGreaterThanOrEqual(3);
    }
  });
});
