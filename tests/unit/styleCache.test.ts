import { beforeEach, describe, expect, it } from "vitest";
import { harvest, harvestStats, invalidateAllStyles, invalidateStyles } from "@/content/harvest";

/**
 * Plan §18C, the half that ships: computed style memoised across passes.
 *
 * Without it every pass starts cold, so the time budget stops at the same node every time
 * and a dense page stays permanently blind past it — newegg was read to roughly 2700 of its
 * 3900 candidates, pass after pass, forever. With it the second pass spends its budget on
 * what the first one skipped, and coverage converges instead of repeating.
 *
 * The tests that matter here are the invalidation ones. A cache that never goes stale is
 * easy; the failure mode of this one is serving a style from before the page changed, and
 * every detector that reads contrast, weight or strikethrough would then be scoring a layout
 * that no longer exists.
 */
describe("style memo across harvest passes", () => {
  beforeEach(() => {
    // Each test starts from a known-cold cache. Epoch bumping is the cheap global flush.
    invalidateAllStyles();
    document.body.innerHTML = "";
  });

  const page = `
    <div id="a"><span class="p">$19.99</span><span class="was">$29.99</span></div>
    <div id="b"><p>Only 3 left in stock</p></div>
  `;

  it("reads cold on the first pass and from cache on the second", () => {
    document.body.innerHTML = page;

    harvest(document);
    const firstCold = harvestStats.cold;
    expect(firstCold, "nothing was read at all").toBeGreaterThan(0);
    expect(harvestStats.cached).toBe(0);

    harvest(document);
    expect(harvestStats.cold, "the second pass re-read styles it already had").toBe(0);
    expect(harvestStats.cached).toBe(firstCold);
  });

  it("goes cold again for a dirty subtree, and only that subtree", () => {
    document.body.innerHTML = page;
    harvest(document);
    const total = harvestStats.cold;

    const a = document.getElementById("a");
    expect(a).not.toBeNull();
    if (a) invalidateStyles([a]);

    harvest(document);
    // #a and its two spans are cold; #b's subtree is untouched.
    expect(harvestStats.cold, "invalidation did not cover the subtree").toBeGreaterThan(0);
    expect(harvestStats.cold, "invalidation flushed more than the dirty subtree").toBeLessThan(
      total,
    );
    expect(harvestStats.cached).toBeGreaterThan(0);
  });

  it("invalidates descendants, not just the element that changed", () => {
    // `effectiveBackground` is resolved by walking ancestors, so a wrapper whose background
    // changes makes every descendant's cached snapshot wrong even though only the wrapper
    // mutated. Invalidating the root alone would leave those serving stale colours.
    // Both must be candidates for the assertion to mean anything. The wrapper needs direct
    // text that the character-class prefilter accepts — "Now " alone has no digits and no
    // currency mark, so the wrapper is never harvested and has nothing cached to invalidate.
    document.body.innerHTML = `<div id="w">Was $29.99 <span id="inner">$19.99</span></div>`;
    harvest(document);
    expect(harvestStats.cold).toBeGreaterThan(1);

    const w = document.getElementById("w");
    if (w) invalidateStyles([w]);
    harvest(document);

    expect(harvestStats.cached, "a descendant kept a style resolved through the old ancestor").toBe(
      0,
    );
  });

  it("drops everything on a global flush", () => {
    document.body.innerHTML = page;
    harvest(document);
    const total = harvestStats.cold;

    // What a resize does: no element reports it, so there is no dirty root to invalidate.
    invalidateAllStyles();
    harvest(document);

    expect(harvestStats.cached, "a global flush left entries behind").toBe(0);
    expect(harvestStats.cold).toBe(total);
  });

  it("never caches a box, because a scroll moves every one of them", () => {
    // THE correctness boundary of this cache. getBoundingClientRect is viewport-relative, so
    // a cached box is wrong the moment the page scrolls — and a scroll produces no mutation
    // record, so nothing would ever invalidate it. Boxes are re-read every pass even when
    // the style beside them came from cache.
    document.body.innerHTML = `<div id="a">$19.99</div>`;

    let top = 100;
    const el = document.getElementById("a");
    expect(el).not.toBeNull();
    if (el) {
      el.getBoundingClientRect = () =>
        ({ x: 0, y: top, width: 200, height: 24, top, left: 0, right: 200, bottom: top + 24 }) as DOMRect;
    }

    const first = harvest(document).find((n) => n.selectorPath.includes("a"));
    expect(first?.box.y).toBe(100);

    top = -400; // the user scrolled down; nothing mutated
    const second = harvest(document).find((n) => n.selectorPath.includes("a"));

    expect(harvestStats.cached, "styles should have come from cache here").toBeGreaterThan(0);
    expect(second?.box.y, "a stale box was served from cache after a scroll").toBe(-400);
  });
});
