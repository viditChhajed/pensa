import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DETECTORS } from "@/content/detectors";
import { DEFERRED_DETECTORS } from "@/content/detectors/deferred";
import {
  DEFERRED_TO_V1_1,
  SHIPPED_CROSS_STAGE_DETECTORS,
  SHIPPED_DETECTOR_COUNT,
  SHIPPED_PAGE_DETECTORS,
} from "@/shared/scope";

/**
 * The submitted build's scope, enforced rather than asserted in prose.
 *
 * Tier-2 page detectors and the §18A temporal engine were built ahead of schedule — real
 * scope drift against plan §13, which puts both in v1.1. These tests make the boundary a
 * property of the artifact: the deferred code must be absent from the BUILT BUNDLES, not
 * merely disabled by a flag a future edit could flip without noticing.
 */

const OUT = ".output/chrome-mv3";
const built = existsSync(OUT);

function bundleText(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      if (n.endsWith(".js")) files.push(full);
      else if (!n.includes(".")) walk(full);
    }
  };
  walk(OUT);
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

describe("v1 submission scope", () => {
  it("ships exactly 16 detectors: 14 page + 2 cross-stage", () => {
    expect(SHIPPED_PAGE_DETECTORS).toHaveLength(14);
    expect(SHIPPED_CROSS_STAGE_DETECTORS).toHaveLength(2);
    expect(SHIPPED_DETECTOR_COUNT).toBe(16);
  });

  it("the runtime registry contains exactly the shipped page detectors", () => {
    expect(DETECTORS).toHaveLength(14);
    expect(DETECTORS.map((d) => d.patternId).sort()).toEqual([...SHIPPED_PAGE_DETECTORS].sort());
  });

  it("no deferred detector is in the runtime registry", () => {
    const registered = new Set(DETECTORS.map((d) => d.patternId as string));
    for (const id of DEFERRED_TO_V1_1) {
      expect(registered.has(id), `${id} leaked into the shipped registry`).toBe(false);
    }
  });

  it("the deferred set is still built and tested, just not registered", () => {
    // Not deleted — v1.1 is a one-line change, and these have passing tests.
    expect(DEFERRED_DETECTORS).toHaveLength(5);
  });

  it("shipped and deferred sets do not overlap", () => {
    const shipped = new Set<string>([...SHIPPED_PAGE_DETECTORS, ...SHIPPED_CROSS_STAGE_DETECTORS]);
    for (const id of DEFERRED_TO_V1_1) expect(shipped.has(id)).toBe(false);
  });
});

describe("built bundles", () => {
  it.skipIf(!built)("contain every shipped page detector", () => {
    const js = bundleText();
    for (const id of SHIPPED_PAGE_DETECTORS) {
      expect(js.includes(id), `${id} missing from the build`).toBe(true);
    }
  });

  it.skipIf(!built)("contain the cross-stage detectors", () => {
    const js = bundleText();
    for (const id of SHIPPED_CROSS_STAGE_DETECTORS) {
      expect(js.includes(id), `${id} missing from the build`).toBe(true);
    }
  });

  it.skipIf(!built)("contain NO deferred detector IMPLEMENTATION", () => {
    // The real assertion, and it must be about CODE rather than pattern ids.
    //
    // Every deferred pattern id does still appear twice in the bundle: once in taxonomy.ts
    // and once in the copy pools. Both are inert data tables that ship whole, and neither
    // can produce a detection — nothing reads them without a registered detector. Asserting
    // on the ids therefore fails on correct code, which is how this test first behaved.
    //
    // A registered detector always contributes its versioned `<id>@1` detectorId and its
    // named sub-signal keys, so those are what absence is proven against.
    const js = bundleText();

    const leakedIds = DEFERRED_TO_V1_1.filter((id) => js.includes(`${id}@1`));
    expect(leakedIds, `deferred detectorIds in build: ${leakedIds.join(", ")}`).toEqual([]);

    const internals = [
      "contrastAsymmetry", // interference
      "badgeOnWorseUnitPrice", // decoy
      "rapidSuccession", // nagging
      "percentFramingFlatters", // framing
      "modalOnExit", // exit intent
      "detectEvergreenCountdown", // §18A
      "relativeLuminance", // §18E contrast maths
    ];
    const leakedCode = internals.filter((sym) => js.includes(sym));
    expect(leakedCode, `deferred implementation in build: ${leakedCode.join(", ")}`).toEqual([]);
  });

  it.skipIf(!built)("keeps deferred taxonomy and copy present but inert", () => {
    // Documents the above deliberately: the data ships (it is needed for v1.1 and costs
    // ~1KB), and is unreachable without a registered detector.
    const js = bundleText();
    expect(js.includes("interference.visual_asymmetry")).toBe(true);
    expect(js.includes("interference.visual_asymmetry@1")).toBe(false);
  });

  it.skipIf(!built)("contain no n-gram classifier code", () => {
    // classifier.ts is scaffolding with no trained weights. Partial scoring must not ship.
    const js = bundleText();
    expect(js.includes("FEATURE_DIM"), "classifier leaked into the build").toBe(false);
    expect(js.includes("featurize"), "classifier leaked into the build").toBe(false);
  });
});
