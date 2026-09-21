import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DETECTORS } from "@/content/detectors";
import {
  DERIVED_FROM_HISTORY,
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

/** One named output file, for assertions about WHERE something shipped. */
function fileText(name: string): string {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      if (n === name) hits.push(readFileSync(full, "utf8"));
      else if (!n.includes(".")) walk(full);
    }
  };
  walk(OUT);
  return hits.join("\n");
}

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
  it("ships exactly 15 detectors: 13 page + 2 cross-stage", () => {
    expect(SHIPPED_PAGE_DETECTORS).toHaveLength(13);
    expect(SHIPPED_CROSS_STAGE_DETECTORS).toHaveLength(2);
    expect(SHIPPED_DETECTOR_COUNT).toBe(15);
  });

  it("the runtime registry contains exactly the shipped page detectors", () => {
    expect(DETECTORS).toHaveLength(13);
    expect(DETECTORS.map((d) => d.patternId).sort()).toEqual([...SHIPPED_PAGE_DETECTORS].sort());
  });

  it("no deferred detector is in the runtime registry", () => {
    const registered = new Set(DETECTORS.map((d) => d.patternId as string));
    for (const id of DERIVED_FROM_HISTORY) {
      expect(registered.has(id), `${id} leaked into the shipped registry`).toBe(false);
    }
  });

  it("shipped and deferred sets do not overlap", () => {
    const shipped = new Set<string>([...SHIPPED_PAGE_DETECTORS, ...SHIPPED_CROSS_STAGE_DETECTORS]);
    for (const id of DERIVED_FROM_HISTORY) expect(shipped.has(id)).toBe(false);
  });
});

describe("built bundles", () => {
  /**
   * Absence of a build is a FAILURE, not a reason to skip — the same lesson the manifest
   * suite already learned the hard way, where a broken .output left seven assertions
   * silently skipped while the run reported green. These assertions are the only thing
   * keeping the shipped scope a property of the artifact rather than a claim in a comment,
   * and a scope check that quietly declines to run is worse than not having one.
   */
  it("has a build to check at all", () => {
    expect(
      built,
      `No build at ${OUT}. Run \`npm run build\` first — these assertions are the scope ` +
        "regression net and must never be skipped silently.",
    ).toBe(true);
  });

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

  it.skipIf(!built)("ships a registered detector for every pattern the scope file claims", () => {
    // Asserted on `<patternId>@1`, which is a string literal and survives minification.
    // An earlier version of this checked internal function names — `contrastAsymmetry`,
    // `relativeLuminance` — which the bundler renames, so it could only ever have passed by
    // accident.
    //
    // It also used to assert ABSENCE. Tier 2 and the §18A engine were held for "v1.1 during
    // store review", a schedule decision rather than a quality one: all of them were built
    // and tested alongside Tier 1, and the temporal history had been accumulating from the
    // first visit. flyfrontier's fare grid is a textbook decoy and produced zero detections
    // because the only detector that could see it was excluded from the bundle. The boundary
    // moved deliberately, and the test moved with it rather than being deleted.
    const js = bundleText();
    const missing = SHIPPED_PAGE_DETECTORS.filter((id) => !js.includes(`${id}@1`));
    expect(missing, `shipped but not in any bundle: ${missing.join(", ")}`).toEqual([]);
  });

  it.skipIf(!built)("derives temporal patterns in the worker, never in the page registry", () => {
    // These are claims about how something CHANGED between visits, so they cannot be
    // evaluated by a detector looking at one DOM. The engine belongs in the service worker,
    // reading the observation store; finding one registered in the content script would mean
    // someone had wired it as a page detector, which cannot work.
    const worker = fileText("background.js");
    const page = fileText("detector.js");

    for (const id of DERIVED_FROM_HISTORY) {
      expect(worker.includes(`${id}@1`), `${id} missing from the worker`).toBe(true);
      expect(page.includes(`${id}@1`), `${id} wrongly registered as a page detector`).toBe(false);
    }
  });

  it.skipIf(!built)("contain no n-gram classifier code", () => {
    // classifier.ts is scaffolding with no trained weights. Partial scoring must not ship.
    const js = bundleText();
    expect(js.includes("FEATURE_DIM"), "classifier leaked into the build").toBe(false);
    expect(js.includes("featurize"), "classifier leaked into the build").toBe(false);
  });
});
