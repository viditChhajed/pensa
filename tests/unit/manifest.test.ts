import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import denylistJson from "../../rulepacks/denylist.v1.json";
import { type DenylistShape, toExcludeMatches } from "@/shared/denylistPatterns";
import { matchesPattern } from "@/shared/domain";

/**
 * The permission-model regression net, inverted.
 *
 * These assertions used to guard the opposite product: `host_permissions` had to be EMPTY,
 * because a declared host permission meant an install prompt listing 150 sites. Vero now
 * asks for `https://*` at install and accepts that prompt deliberately, so the old
 * assertions would fail every build — but the thing they were protecting was never "ask for
 * nothing", it was "never ship a reach nobody argued for, and never ship it without the
 * denylist attached". That is what is asserted now, and it is if anything more load-bearing:
 * under the old model a mistake here produced a scary prompt, under this one it produces an
 * extension reading a bank.
 */
const MANIFEST = ".output/chrome-mv3/manifest.json";
const denylist = denylistJson as DenylistShape;

describe("built manifest", () => {
  /**
   * Absence of a build is a FAILURE, not a reason to skip.
   *
   * These used to `skipIf` when no build was present — so an interrupted or forgotten
   * `wxt build` produced a green suite that had verified nothing about the permission
   * model. Observed: a broken .output left seven of these silently skipped while the run
   * reported all green.
   */
  const available = existsSync(MANIFEST);
  it("has a build to check at all", () => {
    expect(
      available,
      `No built manifest at ${MANIFEST}. Run \`npm run build\` first — these assertions ` +
        "are the permission-model regression net and must never be skipped silently.",
    ).toBe(true);
  });

  const manifest = available
    ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>)
    : null;

  it.skipIf(!available)("requires exactly one host pattern, and it is https-only", () => {
    // Exactly this, not a superset and not something broader that happens to include it.
    // `<all_urls>` and `*://*/*` would add file:, ftp: and data:; `http://*/*` would add
    // plaintext pages, where anything Vero can read is already readable in transit.
    expect(manifest?.host_permissions).toEqual(["https://*/*"]);
  });

  it.skipIf(!available)("declares no optional_host_permissions at all", () => {
    // The ~150 curated origins are meaningless once the broad pattern is required, and a
    // leftover optional list is a second answer to "what may this extension read".
    expect(manifest?.optional_host_permissions).toBeUndefined();
  });

  it.skipIf(!available)("requests only the four justified permissions", () => {
    // Exact, not a superset. Every entry has a written justification in wxt.config.ts, and
    // a permission that appears here without one is a permission nobody has argued for.
    //
    // `declarativeContent` is gone: it lit the toolbar icon on plausible shopping URLs back
    // when a lit icon meant "you can turn Vero on here". Nothing is turned on per site any
    // more, the action is enabled everywhere, and the popup opens on every page — so the
    // page rules decided nothing.
    expect(manifest?.permissions).toEqual(["storage", "scripting", "activeTab", "alarms"]);
  });

  it.skipIf(!available)("declares `alarms`, because the code has always assumed it", () => {
    /**
     * Its own test, because its absence was invisible for a whole build.
     *
     * `chrome.alarms?.create(...)` is written with optional chaining, so without the
     * permission `chrome.alarms` is `undefined` and both alarms became silent no-ops. The
     * 30-day event prune and the offer-store eviction had therefore NEVER run, which made
     * the retention promise in PRIVACY.md a promise with nothing behind it.
     */
    expect(
      (manifest?.permissions ?? []) as string[],
      "alarms is missing: housekeeping and telemetry flush will silently never run",
    ).toContain("alarms");
  });

  it.skipIf(!available)("never puts a host pattern in `permissions`", () => {
    for (const p of (manifest?.permissions ?? []) as string[]) {
      expect(p).not.toBe("<all_urls>");
      expect(p).not.toMatch(/:\/\//);
    }
  });

  describe("the declared content script", () => {
    const scripts = (manifest?.content_scripts ?? []) as {
      matches?: string[];
      exclude_matches?: string[];
      js?: string[];
    }[];

    it.skipIf(!available)("is declared in the manifest, exactly once", () => {
      // It used to be registered at runtime, per granted origin, because declaring one
      // implicitly granted its match patterns at install. That is no longer a cost worth
      // avoiding — the patterns are granted at install anyway — and a manifest entry cannot
      // fail to register in a service worker nobody is watching.
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.js).toEqual(["detector.js"]);
      expect(scripts[0]?.matches).toEqual(["https://*/*"]);
    });

    it.skipIf(!available)("ships a NON-EMPTY exclude_matches", () => {
      /**
       * The single most important line in this file.
       *
       * host_permissions is every https site. `exclude_matches` is the only part of the
       * denylist Chrome enforces on our behalf, and an empty one ships an extension that
       * loads its detector into banking, health, government and webmail pages. The build
       * hook throws on this too; it is asserted here as well because the hook and the
       * artifact are two different things and only one of them is what users install.
       */
      expect(scripts[0]?.exclude_matches ?? []).not.toHaveLength(0);
    });

    it.skipIf(!available)("excludes everything the denylist can express, and no less", () => {
      // Derived from the same rulepack the runtime check reads, so a denylist entry that is
      // expressible but somehow absent from the manifest fails here rather than shipping.
      const expected = toExcludeMatches(denylist).matches;
      expect(scripts[0]?.exclude_matches).toEqual(expected);
    });

    it.skipIf(!available)("actually refuses the hosts that matter", () => {
      // Named rather than derived: a conversion bug that dropped the bank rules would still
      // satisfy the equality above if the same bug ran on both sides.
      const excludes = scripts[0]?.exclude_matches ?? [];
      for (const url of [
        "https://www.chase.com/checkout",
        "https://secure.chase.com/",
        "https://www.paypal.com/cart",
        "https://irs.gov/pay",
        "https://my.university.edu/shop",
        "https://www.cvs.com/shop",
      ]) {
        expect(
          excludes.some((p) => matchesPattern(p, new URL(url))),
          `${url} is not excluded — Chrome would inject the detector there`,
        ).toBe(true);
      }
    });

    it.skipIf(!available)("does not exclude ordinary shopping sites", () => {
      const excludes = scripts[0]?.exclude_matches ?? [];
      for (const url of [
        "https://www.booking.com/checkout",
        "https://secure.booking.com/book",
        "https://us.shein.com/cart",
        "https://www.etsy.com/listing/1",
        "https://shop.example.com/cart",
      ]) {
        expect(
          excludes.some((p) => matchesPattern(p, new URL(url))),
          `${url} is excluded — Vero would be silently dead on a site it claims to cover`,
        ).toBe(false);
      }
    });
  });

  it.skipIf(!available)("ships the detector bundle the content script points at", () => {
    expect(existsSync(".output/chrome-mv3/detector.js")).toBe(true);
  });
});
