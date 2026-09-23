import { describe, expect, it } from "vitest";
import { scarcityDetector } from "@/content/detectors/scarcity";
import { contextFrom } from "./helpers";

/**
 * Detectors must read a SENTENCE, and sites do not keep sentences in one element.
 *
 * EVAL run 1 ranked this the second most expensive defect in the product, "detectors reason
 * at the wrong node granularity", and it was still live. Measured before the fix:
 *
 *   "Only 3 left at this price"          flat 0.85   split across spans: NO DETECTION AT ALL
 *   "or 4 interest-free payments of $X"  flat 0.85   amount in a sibling span: 0.70, under
 *                                                    the 0.75 threshold, twice in the field
 *
 * Neither is a lexicon gap. The lexicons match the copy exactly. The detector simply never
 * saw the whole sentence, because a number was bolded or animated in its own element, which
 * is how retailers render precisely the numbers these detectors care about.
 *
 * The fallback is deliberately shallow: the IMMEDIATE parent's joined text, one claim per
 * parent, never for a parent already matched on its own text. Walking further up would
 * eventually pair any number with any words on the page, and a detector that always finds
 * its own evidence is not a detector. The negative cases below are what hold that line.
 */

const split = (html: string) => contextFrom(`<div class="wrap">${html}</div>`);
const best = (hits: { rawScore: number }[]) => Math.max(0, ...hits.map((h) => h.rawScore));

describe("scarcity reads a sentence split across elements", () => {
  const SHAPES: [string, string][] = [
    ["one element", "Only 3 left at this price"],
    ["bolded count", "Only <b>3</b> left at this price"],
    ["span per fragment", "<span>Only </span><span>3</span><span> left at this price</span>"],
    [
      "styled count",
      '<span>Only </span><span class="n" style="color:red">2</span><span> left!</span>',
    ],
  ];

  for (const [name, html] of SHAPES) {
    it(`fires on ${name}`, () => {
      const hits = scarcityDetector.run(split(html));
      expect(hits.length, `${name}: no detection`).toBe(1);
      expect(best(hits), `${name}: scored below the 0.75 surface threshold`).toBeGreaterThanOrEqual(
        0.75,
      );
    });
  }

  it("reports the sentence as evidence, not the fragment it attached to", () => {
    // The whole point of the card is that it quotes what the page said. Attributing a split
    // match to the <span>3</span> and quoting "3" turns the question into a riddle.
    const hits = scarcityDetector.run(
      split("<span>Only </span><span>3</span><span> left at this price</span>"),
    );
    expect(hits[0]?.evidence.textSample ?? "").toContain("left at this price");
  });

  it("does not report the same sentence twice", () => {
    // The first version of the fallback did: the wrapper matched on its own joined text and
    // the bolded number then matched again through its parent.
    expect(scarcityDetector.run(split("Only <b>3</b> left in stock"))).toHaveLength(1);
  });

  it("still refuses a variant count that happens to share a parent", () => {
    // The exact false positive §8 warns causes uninstalls. The exclusion is checked against
    // whatever text was matched, so widening the read must not widen past it.
    expect(
      scarcityDetector.run(split("<span>Only </span><span>2</span><span> sizes left</span>")),
    ).toEqual([]);
  });

  it("does not pair a bare number with words from an unrelated sibling", () => {
    // Two separate statements under one wrapper. Joined they read like a stock message; they
    // are not one, and a fallback that walked further up the tree would claim they were.
    const ctx = contextFrom(
      `<div><div class="a"><span>3</span></div><div class="b">left-hand drive available</div></div>`,
    );
    expect(scarcityDetector.run(ctx)).toEqual([]);
  });
});
