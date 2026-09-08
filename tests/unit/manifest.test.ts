import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The permission-model regression net (plan §1.2, §7 Day-1 verification).
 * If any of these fail, the extension would ship an install prompt listing 150 sites.
 */
const MANIFEST = ".output/chrome-mv3/manifest.json";

describe("built manifest", () => {
  const available = existsSync(MANIFEST);
  const manifest = available
    ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>)
    : null;

  it.skipIf(!available)("declares no required host permissions", () => {
    const hosts = (manifest?.host_permissions ?? []) as string[];
    expect(hosts).toEqual([]);
  });

  it.skipIf(!available)("declares no manifest content scripts", () => {
    const scripts = (manifest?.content_scripts ?? []) as unknown[];
    expect(scripts).toEqual([]);
  });

  it.skipIf(!available)("requests only the four justified permissions", () => {
    expect(manifest?.permissions).toEqual([
      "storage",
      "scripting",
      "activeTab",
      "declarativeContent",
    ]);
  });

  it.skipIf(!available)("never requests a broad pattern as a REQUIRED permission", () => {
    // Required = granted at install, with a warning listing every site. Never acceptable.
    for (const p of (manifest?.permissions ?? []) as string[]) {
      expect(p).not.toBe("<all_urls>");
      expect(p).not.toMatch(/^\*:\/\/\*\//);
      expect(p).not.toMatch(/^https?:\/\/\*\/\*$/);
    }
  });

  it.skipIf(!available)("allows https://*/* as OPTIONAL, and nothing broader", () => {
    // Optional = granted one origin at a time behind a user gesture, no install warning.
    // This is what lets the popup offer enablement on a site outside the curated list;
    // without it chrome.permissions.request fails silently and the button does nothing.
    const optional = (manifest?.optional_host_permissions ?? []) as string[];
    expect(optional).toContain("https://*/*");
    for (const p of optional) {
      expect(p, "<all_urls> is broader than needed").not.toBe("<all_urls>");
      expect(p, "http:// must not be granted").not.toBe("http://*/*");
      expect(p).not.toBe("*://*/*");
    }
  });

  it.skipIf(!available)("keeps the curated list alongside the broad pattern", () => {
    // The curated domains still drive the icon and the commerce score.
    const optional = (manifest?.optional_host_permissions ?? []) as string[];
    expect(optional.length).toBeGreaterThan(100);
    expect(optional).toContain("https://*.booking.com/*");
  });

  it.skipIf(!available)("ships the detector bundle that gets registered at runtime", () => {
    expect(existsSync(".output/chrome-mv3/detector.js")).toBe(true);
  });
});
