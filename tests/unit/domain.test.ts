import { describe, expect, it } from "vitest";
import { registrableDomain } from "@/shared/domain";

/**
 * `domainMatchPattern` and its tests went with the per-site grant flow: nothing is requested
 * per domain any more. `registrableDomain` stays load-bearing in two places, the allowlist
 * category lookup (us.shein.com and www.shein.com are one retailer) and the name the popup
 * puts in front of a person, and the public-suffix case is the one that bites, because two
 * labels of "marksandspencer.co.uk" is "co.uk", which is all of Britain.
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
