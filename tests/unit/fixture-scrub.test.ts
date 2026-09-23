import { describe, expect, it } from "vitest";
import { findPii, isLuhnValid, normalise, scrub } from "../../scripts/fixture-lib";

/**
 * The scrub is a privacy control, not a formatting convenience, so it is tested rather than
 * trusted. Fixtures come from real retailer pages and can contain the capturer's own data
 * (if signed in) and third parties' regardless, reviewer names, avatars, Q&A authors.
 * Committing that is trivial to do and impossible to fully undo.
 */

describe("Luhn guard", () => {
  it("accepts a real card-shaped number", () => {
    expect(isLuhnValid("4111111111111111")).toBe(true);
    expect(isLuhnValid("4111 1111 1111 1111")).toBe(true);
  });

  it("rejects a 16-digit order number that is not a card", () => {
    // Order numbers are frequently 16 digits. Redacting them all would corrupt fixtures.
    expect(isLuhnValid("1234567890123456")).toBe(false);
  });

  it("rejects runs that are too short or too long", () => {
    expect(isLuhnValid("411111111111")).toBe(false);
    expect(isLuhnValid("41111111111111111111")).toBe(false);
  });
});

describe("scrub", () => {
  it("redacts an email address", () => {
    const { output, hits } = scrub("<p>Order confirmation sent to jane.doe@gmail.com</p>");
    expect(output).not.toContain("jane.doe@gmail.com");
    expect(output).toContain("[email redacted]");
    expect(hits.map((h) => h.rule)).toContain("email");
  });

  it("actually REPLACES a Luhn-valid card number, not merely reports it", () => {
    // Regression: an earlier version reported the hit while leaving the digits in the file,
    // because the replacement re-entered a stateful global regex. Reporting success while
    // the data stays put is the worst failure mode a privacy control can have.
    const { output, hits } = scrub("<p>Card 5500 0000 0000 0004</p>");
    expect(hits.map((h) => h.rule)).toContain("card-number");
    expect(output).not.toMatch(/5500\s*0000\s*0000\s*0004/);
    expect(output).toContain("[card redacted]");
  });

  it("redacts an order number, which is an account identifier", () => {
    const { output } = scrub("<p>order 1234567890123456</p>");
    expect(output).not.toContain("1234567890123456");
    expect(output).toContain("[token redacted]");
  });

  it("leaves a bare 16-digit number that is not card-shaped and not account-adjacent", () => {
    const { output } = scrub("<p>SKU 1234567890123456 fits most models</p>");
    expect(output).toContain("1234567890123456");
  });

  it("redacts phone numbers and SSNs", () => {
    expect(scrub("<p>Call (415) 555-2671</p>").output).toContain("[phone redacted]");
    expect(scrub("<p>SSN 123-45-6789</p>").output).toContain("[ssn redacted]");
  });

  it("redacts a street address", () => {
    const { output } = scrub("<p>Ship to 1600 Pennsylvania Avenue</p>");
    expect(output).toContain("[address redacted]");
    expect(output).not.toContain("Pennsylvania Avenue");
  });

  it("redacts session cookies, JWTs and bearer tokens", () => {
    expect(scrub("sessionid=abc123def456ghi").output).toContain("[cookie redacted]");
    expect(
      scrub("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r")
        .output,
    ).toContain("[jwt redacted]");
    expect(scrub("Authorization: Bearer sk_live_abcdefghijklmnop").output).toContain(
      "[bearer redacted]",
    );
  });

  it("redacts a reviewer's name from JSON-LD", () => {
    // Third-party personal data is still personal data, even though it is not the capturer's.
    const input = `<script type="application/ld+json">{"author":{"@type":"Person","name":"Sarah Miller"}}</script>`;
    const { output } = scrub(input);
    expect(output).not.toContain("Sarah Miller");
    expect(output).toContain("[name redacted]");
  });

  it("leaves ordinary product content untouched", () => {
    // Over-redaction that eats prices would quietly break every price detector's fixtures.
    const input = "<div><del>$89.99</del><span>$49.99</span><p>Only 3 left in stock</p></div>";
    expect(scrub(input).output).toBe(input);
  });

  it("is IDEMPOTENT, a scrubbed file must re-scan clean", () => {
    // The CI gate fails on any hit. If a placeholder matched the rule that produced it,
    // every correctly-scrubbed fixture would fail forever and the gate would get switched
    // off. "4111 1111 1111 1111" is itself Luhn-valid, which is exactly that trap.
    const dirty = [
      "<p>jane@gmail.com</p>",
      "<p>Card 5500 0000 0000 0004</p>",
      "<p>Call (415) 555-2671</p>",
      "<p>SSN 123-45-6789</p>",
      "<p>Ship to 1600 Pennsylvania Avenue</p>",
      "<p>sessionid=abc123def456ghi</p>",
      "<p>order 1234567890123456</p>",
      "<p>Authorization: Bearer sk_live_abcdefghijklmnop</p>",
      `<script type="application/ld+json">{"author":{"name":"Sarah Miller"}}</script>`,
    ].join("\n");

    const once = scrub(dirty).output;
    expect(findPii(once), "a scrubbed file still trips the CI gate").toEqual([]);
    expect(scrub(once).output).toBe(once);
  });

  it("reports every hit so a human can read the diff", () => {
    const hits = findPii("<p>a@b.com and (415) 555-2671</p>");
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("normalise", () => {
  it("strips scripts but KEEPS JSON-LD, which detectors read", () => {
    const input = `<script>alert(1)</script><script type="application/ld+json">{"@type":"Product"}</script>`;
    const out = normalise(input);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain('"@type":"Product"');
  });

  it("removes inline event handlers so a fixture can never execute", () => {
    const out = normalise(`<button onclick="steal()" onmouseover='x()'>Buy</button>`);
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onmouseover");
  });

  it("makes remote references inert but keeps data: URIs", () => {
    const out = normalise(
      `<img src="https://cdn.example.com/a.jpg"><img src="data:image/gif;base64,R0lGOD">`,
    );
    expect(out).toContain('src="about:blank"');
    expect(out).toContain("data:image/gif;base64,R0lGOD");
  });

  it("freezes future epochs so countdown fixtures are deterministic", () => {
    const out = normalise(`{"endsAt":1893456000000}`, { freezeClockTo: 1_800_000_000_000 });
    expect(out).toContain("1800000000000");
    expect(out).not.toContain("1893456000000");
  });

  it("does not mangle prices while freezing clocks", () => {
    // A 13-digit epoch and a price must not be confused for one another.
    const out = normalise(`<span>$49.99</span><span>1893456000000</span>`, {
      freezeClockTo: 1_800_000_000_000,
    });
    expect(out).toContain("$49.99");
  });

  it("collapses oversized base64 images", () => {
    const big = `data:image/png;base64,${"A".repeat(5000)}`;
    const out = normalise(`<img src="${big}">`);
    expect(out.length).toBeLessThan(1000);
  });
});
