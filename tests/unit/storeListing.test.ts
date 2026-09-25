import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATTERN_GROUPS } from "@/entrypoints/options/groups";
import {
  DERIVED_FROM_HISTORY,
  SHIPPED_CROSS_STAGE_DETECTORS,
  SHIPPED_PAGE_DETECTORS,
} from "@/shared/scope";
import { TAXONOMY } from "@/shared/taxonomy";

/**
 * The store listing is the one document that is read by someone with the power to reject it,
 * and it is the document least likely to be re-read after the code changes under it.
 *
 * All three of these were live at once when this test was written:
 *   - "disappears by itself after 20 seconds", the card's timer had been removed, because
 *     it vanished mid-sentence while people were reading it.
 *   - "will not show at all if there is nowhere it can sit without covering something you
 *     might want to click", the placement rule had been changed to tier controls, so it
 *     does cover ordinary links, deliberately.
 *   - The permission justification described ~150 named origins while the manifest also
 *     declared the broad all-sites pattern, which is precisely the field a reviewer checks against the
 *     manifest.
 *
 * A wrong claim here is worse than a missing one. These assert the checkable parts.
 */

const LISTING = "STORE-LISTING.md";
const README = "README.md";
const MANIFEST = ".output/chrome-mv3/manifest.json";
const listing = readFileSync(LISTING, "utf8");
const readme = readFileSync(README, "utf8");

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
    // It covers ordinary controls on purpose, refusing to render otherwise suppressed 60%
    // of samples across six live retailers and the tester never saw a card at all.
    expect(
      /covering something you might\s+want to click/i.test(listing),
      "the listing promises a placement rule the product deliberately does not follow",
    ).toBe(false);
  });

  it.skipIf(!existsSync(MANIFEST))("names every host pattern the manifest REQUIRES", () => {
    /**
     * This used to check `optional_host_permissions`, because the broad pattern was optional
     * and the listing's job was to explain why an optional all-sites pattern was there.
     * It is required now, so the same check has more teeth, not less: this is the field a
     * reviewer opens the manifest to compare against, and a listing describing a curated
     * list of retailers beside a manifest asking for every https site is the single fastest
     * way to get an extension rejected, and it would deserve it.
     */
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      host_permissions?: string[];
      optional_host_permissions?: string[];
    };

    for (const pattern of manifest.host_permissions ?? []) {
      expect(
        listing.includes(pattern),
        `the manifest REQUIRES ${pattern} at install and the listing never mentions it, ` +
          "the permission justification would not match what the reviewer is reading",
      ).toBe(true);
    }

    expect(
      manifest.optional_host_permissions,
      "optional_host_permissions is back; the listing and the two-tier story went away with it",
    ).toBeUndefined();
  });

  it.skipIf(!existsSync(MANIFEST))("does not still promise a per-site opt-in", () => {
    /**
     * The claim most likely to survive the change and become a lie. The old listing had to
     * explain that Pensa reads nothing until you enable it site by site; the product now
     * holds every https site from the moment it is installed. A listing that still promises
     * the opposite is worse than one that says nothing.
     */
    const promises =
      /enable (it |pensa )?(on )?(each|every|per)[- ]site|site by site|only reads sites you (have )?enabled|nothing until you enable/i;
    const hit = promises.exec(listing);
    expect(
      hit?.[0],
      `the listing still promises per-site enablement ("${hit?.[0]}"), Pensa now holds ` +
        "https://*/* at install",
    ).toBeUndefined();
  });
});

/**
 * The README's status table is the project's front door, and it rots silently because
 * nothing reads it. It was simultaneously claiming 16 detectors and 9 "deferred to v1.1"
 * (the deferred ones had shipped), 233 unit tests (321), that the digest suppressed itself
 * on dense pages (12/12 samples now place a card), and that the extension had no icons.
 *
 * Counts go stale by the hour and are not worth a test. The SET of what ships does not, and
 * a README naming a detector that is not in the build, or omitting one that is, is the
 * failure that matters.
 */
describe("README describes what ships", () => {
  it("lists exactly the patterns that ship, in backticks", () => {
    const all = [
      ...SHIPPED_PAGE_DETECTORS,
      ...SHIPPED_CROSS_STAGE_DETECTORS,
      ...DERIVED_FROM_HISTORY,
    ];
    const missing = all.filter((id) => !readme.includes(`\`${id}\``));
    expect(missing, `ships but absent from the README: ${missing.join(", ")}`).toEqual([]);
  });

  it("states the right total", () => {
    const total =
      SHIPPED_PAGE_DETECTORS.length +
      SHIPPED_CROSS_STAGE_DETECTORS.length +
      DERIVED_FROM_HISTORY.length;
    expect(
      readme.includes(`**${total}**`),
      `the README does not state the shipped total of ${total}`,
    ).toBe(true);
  });

  it.skipIf(!existsSync(MANIFEST))(
    "does not claim icons are missing while they are declared",
    () => {
      const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
        icons?: Record<string, string>;
      };
      const declared = Object.keys(manifest.icons ?? {}).length > 0;
      if (!declared) return;
      for (const doc of [readme, listing]) {
        expect(
          /no icons|icons.{0,40}missing entirely/i.test(doc),
          "a doc says the icons are missing; the manifest declares them",
        ).toBe(false);
      }
    },
  );

  it("does not describe shipped detectors as deferred", () => {
    // The exact contradiction that was live: a table row saying 16 ship directly above a row
    // saying 9 of them are deferred to v1.1.
    const deferralClaim = /deferred to v1\.1\s*\|?\s*\**\s*\d/i;
    expect(
      deferralClaim.test(readme),
      "the README still counts shipped detectors as deferred to v1.1",
    ).toBe(false);
  });
});

/**
 * Cross-document consistency.
 *
 * Every one of these was wrong at least once: the docs described a per-site permission flow
 * two models ago, claimed the telemetry sink was undeployed while it was live, quoted a
 * short description that no longer matched the manifest, and named a detector that had been
 * deleted. Prose drifts silently; these are the parts that can be checked.
 */
describe("the docs agree with the build", () => {
  const DOCS = [
    "README.md",
    "STORE-LISTING.md",
    "PRIVACY.md",
    "MANUAL-VERIFICATION.md",
    "SPOT-CHECK.md",
    "server/README.md",
    "server/DEPLOY.md",
    "store/description.txt",
  ];
  const text = (f: string) => readFileSync(f, "utf8");

  it("quotes the manifest's own short description verbatim in the listing", () => {
    if (!existsSync(MANIFEST)) return;
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { description: string };
    expect(
      listing.includes(manifest.description),
      "STORE-LISTING.md quotes a short description the manifest does not have",
    ).toBe(true);
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  it("names the version that is actually built", () => {
    if (!existsSync(MANIFEST)) return;
    const { version } = JSON.parse(readFileSync(MANIFEST, "utf8")) as { version: string };
    expect(listing.includes(version), `STORE-LISTING.md never mentions ${version}`).toBe(true);
    expect(
      listing.includes(`pensa-${version}-chrome.zip`),
      `STORE-LISTING.md does not name the zip for ${version}`,
    ).toBe(true);
  });

  /**
   * A mention is fine when the sentence says the thing is gone. What must not survive is a doc
   * still describing it as how Pensa works, so the check is for an unmarked mention: the line
   * itself, or the one either side of it, has to carry a word that retires it.
   */
  const RETIRED =
    /no longer|not called|nothing calls|nowhere|never called|removed|gone|obsolete|deliberately absent|used to|there is no/i;
  function unmarkedMentions(doc: string, needle: string): string[] {
    const lines = readFileSync(doc, "utf8").split("\n");
    return lines.flatMap((line, i) => {
      if (!line.includes(needle)) return [];
      const around = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join(" ");
      return RETIRED.test(around) ? [] : [`${doc}:${i + 1}  ${line.trim().slice(0, 90)}`];
    });
  }

  it("does not name a detector that was removed, except to say it was", () => {
    // EVAL.md is exempt: it is a dated record of past runs, and says so at the top.
    const hits = DOCS.flatMap((d) => unmarkedMentions(d, "bnpl"));
    expect(hits, `the installment detector is described as current:\n${hits.join("\n")}`).toEqual(
      [],
    );
  });

  it("does not describe the per-site permission flow as current", () => {
    const hits = DOCS.flatMap((d) =>
      ["permissions.request", "Enable on this site", "declarativeContent"].flatMap((needle) =>
        unmarkedMentions(d, needle),
      ),
    );
    expect(hits, `a retired permission flow is described as current:\n${hits.join("\n")}`).toEqual(
      [],
    );
  });

  it("does not claim the sink is undeployed while an endpoint is documented", () => {
    for (const doc of DOCS) {
      const body = text(doc).toLowerCase();
      if (!body.includes("pensa-counts.viditchhajed.workers.dev")) continue;
      for (const stale of ["not deployed", "no server is connected"]) {
        expect(
          body.includes(stale),
          `${doc} says "${stale}" and also names the live endpoint`,
        ).toBe(false);
      }
    }
  });

  it("points at the current privacy policy, never the old one", () => {
    for (const doc of DOCS) {
      const body = text(doc);
      if (!body.includes("vero-docs")) continue;
      // The only legitimate mention is the redirect note, which must name the new URL too.
      expect(
        body.includes("pensa-docs"),
        `${doc} mentions vero-docs without the current pensa-docs URL`,
      ).toBe(true);
    }
  });
});
