import { describe, expect, it } from "vitest";
import { describeSignals, scoreUrl } from "@/shared/urlScore";

/**
 * The popup shows the heuristic's own reading so a silent extension can be diagnosed: a
 * score with signals means the URL check ran and found nothing commerce-shaped; no score
 * line at all means the popup never got that far. These assert the wording stays tied to
 * the signals that produce it.
 */
describe("describeSignals", () => {
  it("names an allowlisted retailer", () => {
    expect(describeSignals(scoreUrl("https://www.shein.com/").signals)).toContain("known retailer");
  });

  it("names a commerce path on a site nobody curated", () => {
    const words = describeSignals(scoreUrl("https://cool-indie-shop.com/products/mug").signals);
    expect(words).toContain("commerce URL path");
    expect(words).not.toContain("known retailer");
  });

  it("names a cart query parameter with the parameter itself", () => {
    expect(describeSignals(scoreUrl("https://someshop.com/i?add-to-cart=9").signals)).toContain(
      "cart parameter (add-to-cart)",
    );
  });

  it("returns nothing for a denied URL, which the popup never reaches anyway", () => {
    // Reserved and denylisted hosts short-circuit to a single "denylist" signal. The popup
    // returns before renderScore in that case; this pins that the mapping stays silent
    // rather than inventing a phrase for it.
    expect(describeSignals(scoreUrl("https://anything.test/products/x").signals)).toEqual([]);
  });

  it("returns nothing for a URL with no commerce shape at all", () => {
    // This is the case the popup must not describe as a verdict on the site: it is a
    // statement about a string, and the check never reads the page.
    expect(describeSignals(scoreUrl("https://someblog.com/about").signals)).toEqual([]);
  });

  it("does not repeat a phrase when several signals map to it", () => {
    const words = describeSignals(["path:a", "path:b", "host:c", "host:d"]);
    expect(words).toEqual(["commerce URL path", "commerce hostname"]);
  });
});
