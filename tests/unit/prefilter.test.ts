import { describe, expect, it } from "vitest";
import { classifyText, harvest } from "@/content/harvest";
import { CharClass } from "@/content/types";
import { TRAINABLE } from "../../scripts/label-queue.mjs";

/**
 * Can the extension even SEE this text?
 *
 * `classifyText` rejects >95% of nodes before any detector runs, which is what makes the
 * harvest affordable. It is also the place a pattern can die silently: a node the prefilter
 * drops is a node no detector is ever offered, so a perfectly good detector with a perfectly
 * good lexicon fires on nothing and there is no error anywhere.
 *
 * That has now happened three times, each found by someone probing a phrase by hand:
 *
 *   "I understand purchasing options separately may result in a higher overall price"
 *, no digit, no currency glyph, no trigger word. confirmshaming never saw it.
 *   "Premium seats, going fast"
 *, same. A shipped scarcity pattern that could not fire.
 *   "Summer sale ending soon"
 *, the list had "ends", and `includes("ends")` does not match "ending".
 *
 * So this test asserts the prefilter against the canonical positive copy each pattern claims
 * to catch, taken from the labelling tool's own examples, the ones shown to a human as
 * "yes, like this". If the tool tells someone a phrase is a positive example, the extension
 * had better be able to see it.
 */

describe("the prefilter admits the copy the detectors are built for", () => {
  for (const pattern of TRAINABLE) {
    for (const example of pattern.yes) {
      it(`${pattern.id}: ${JSON.stringify(example)}`, () => {
        expect(
          classifyText(example),
          "rejected before any detector ran, no detector can fire on this",
        ).not.toBe(CharClass.None);
      });
    }
  }
});

describe("and the harvest actually produces a node for it", () => {
  // classifyText passing is necessary but not sufficient: the TreeWalker also requires direct
  // text and a non-rejected tag. This is the end-to-end version of the same question.
  for (const pattern of TRAINABLE) {
    for (const example of pattern.yes) {
      it(`${pattern.id}: ${JSON.stringify(example)}`, () => {
        document.body.innerHTML = `<div class="x">${example}</div>`;
        const nodes = harvest(document);
        expect(
          nodes.map((n) => n.normalizedText),
          "harvest produced no candidate for copy a detector is built to catch",
        ).toContainEqual(expect.stringContaining(example.toLowerCase().slice(0, 12)));
      });
    }
  }
});

describe("and it still rejects the ordinary page", () => {
  // The prefilter earns its cost by saying no. If widening it to catch deadline copy also
  // admitted every navigation label, the harvest budget would be spent on chrome.
  const CHROME = [
    "Camp Chairs",
    "All Tops",
    "Shop by category",
    "Customer service",
    "About us",
    "Careers",
    "Invisible Shield",
    "Little Kid",
  ];
  for (const text of CHROME) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(classifyText(text)).toBe(CharClass.None);
    });
  }
});
