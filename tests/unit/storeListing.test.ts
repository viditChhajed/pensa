import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATTERN_GROUPS } from "@/entrypoints/options/groups";
import { TAXONOMY } from "@/shared/taxonomy";

/**
 * The store listing is the one document that is read by someone with the power to reject it,
 * and it is the document least likely to be re-read after the code changes under it.
 *
 * All three of these were live at once when this test was written:
 *   - "disappears by itself after 20 seconds" — the card's timer had been removed, because
 *     it vanished mid-sentence while people were reading it.
 *   - "will not show at all if there is nowhere it can sit without covering something you
 *     might want to click" — the placement rule had been changed to tier controls, so it
 *     does cover ordinary links, deliberately.
 *   - The permission justification described ~150 named origins while the manifest also
 *     declared the broad all-sites pattern, which is precisely the field a reviewer checks against the
 *     manifest.
 *
 * A wrong claim here is worse than a missing one. These assert the checkable parts.
 */

const LISTING = "STORE-LISTING.md";
const MANIFEST = ".output/chrome-mv3/manifest.json";
const listing = readFileSync(LISTING, "utf8");

describe("store listing describes what ships", () => {
  it("names every pattern the settings page offers a switch for", () => {
    // Matched on the taxonomy LABEL, which is the user-facing name the listing should use.
    // Two spellings of one thing is how a listing and a product drift apart.
    const offered = PATTERN_GROUPS.flatMap((g) => g.ids);
    const missing = offered.filter((id) => {
      const label = TAXONOMY[id as keyof typeof TAXONOMY]?.label ?? id;
      // Compare loosely: the listing writes prose ("Reference prices", "Countdown timers"),
      // not the taxonomy's singular label, so match on the distinctive head word.
      const head = label.split(" ")[0]?.toLowerCase() ?? "";
      return head.length > 0 && !listing.toLowerCase().includes(head);
    });
    expect(
      missing,
      `shipped but never mentioned in the store listing: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("makes no claim that the card times out", () => {
    // The card has no timer. `src/content/ui/card.ts` says so at the point of construction.
    const timerClaims = /disappears by itself|auto-dismiss|after \d+ seconds|times out/i;
    const hit = timerClaims.exec(listing);
    expect(hit?.[0], `the card has no timer, but the listing says "${hit?.[0]}"`).toBeUndefined();
  });

  it("makes no claim that the card never covers anything clickable", () => {
    // It covers ordinary controls on purpose — refusing to render otherwise suppressed 60%
    // of samples across six live retailers and the tester never saw a card at all.
    expect(
      /covering something you might\s+want to click/i.test(listing),
      "the listing promises a placement rule the product deliberately does not follow",
    ).toBe(false);
  });

  it.skipIf(!existsSync(MANIFEST))("justifies every host pattern the manifest declares", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      optional_host_permissions?: string[];
    };
    const optional = manifest.optional_host_permissions ?? [];

    // A broad pattern is the thing a reviewer asks about. If one is declared, the
    // justification section has to address it by name — not describe the named list alone.
    const broad = optional.filter((p) => /^https?:\/\/\*\/\*$/.test(p));
    for (const pattern of broad) {
      expect(
        listing.includes(pattern),
        `the manifest declares ${pattern} and the listing never mentions it — the ` +
          "permission justification would not match what the reviewer is reading",
      ).toBe(true);
    }
  });
});
