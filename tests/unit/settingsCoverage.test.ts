import { describe, expect, it } from "vitest";
import { PATTERN_GROUPS } from "@/entrypoints/options/groups";
import {
  DERIVED_FROM_HISTORY,
  SHIPPED_CROSS_STAGE_DETECTORS,
  SHIPPED_PAGE_DETECTORS,
} from "@/shared/scope";
import { TAXONOMY } from "@/shared/taxonomy";

/**
 * Every shipped detector must have an off switch.
 *
 * `disabledDetectors` has been honoured by the digest since it was written, and for that
 * whole time nothing in the UI could set it — the escape hatch §10 relies on for "raise
 * thresholds or default-disable anything noisy" existed only in code the user could not
 * reach. This test exists so adding the seventeenth detector cannot silently re-create that:
 * a pattern that ships without appearing here is one a user cannot turn off, and a false
 * positive with no off switch is an uninstall.
 */
describe("settings cover what ships", () => {
  const offered = PATTERN_GROUPS.flatMap((g) => g.ids);

  it("offers a switch for every shipped and derived pattern", () => {
    const shipped = [
      ...SHIPPED_PAGE_DETECTORS,
      ...SHIPPED_CROSS_STAGE_DETECTORS,
      ...DERIVED_FROM_HISTORY,
    ];
    const missing = shipped.filter((id) => !offered.includes(id));
    expect(missing, `no off switch on the settings page for: ${missing.join(", ")}`).toEqual([]);
  });

  it("offers nothing that does not ship", () => {
    // The mirror failure, and the more embarrassing one: a switch for something that cannot
    // fire looks like a broken detector rather than an absent one.
    const shipped = new Set<string>([
      ...SHIPPED_PAGE_DETECTORS,
      ...SHIPPED_CROSS_STAGE_DETECTORS,
      ...DERIVED_FROM_HISTORY,
    ]);
    const phantom = offered.filter((id) => !shipped.has(id));
    expect(phantom, `settings page offers a switch for absent detectors: ${phantom}`).toEqual([]);
  });

  it("lists each pattern exactly once", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of offered) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes, "a pattern appears in two groups").toEqual([]);
  });

  it("can render a label and a mechanism for every switch", () => {
    // The row renders `entry.label` and `entry.mechanism`. A pattern id with no taxonomy
    // entry is skipped silently at render time, which would produce a missing switch rather
    // than a visible error.
    const unrenderable = offered.filter((id) => {
      const entry = TAXONOMY[id as keyof typeof TAXONOMY];
      return !entry || entry.label.length === 0 || entry.mechanism.length === 0;
    });
    expect(unrenderable, `no renderable taxonomy entry for: ${unrenderable}`).toEqual([]);
  });
});
