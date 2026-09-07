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

  it.skipIf(!available)("never requests a broad host pattern", () => {
    const all = [
      ...((manifest?.optional_host_permissions ?? []) as string[]),
      ...((manifest?.permissions ?? []) as string[]),
    ];
    for (const p of all) {
      expect(p).not.toBe("<all_urls>");
      expect(p).not.toMatch(/^\*:\/\/\*\//);
      expect(p).not.toMatch(/^https?:\/\/\*\/\*$/);
    }
  });

  it.skipIf(!available)("ships the detector bundle that gets registered at runtime", () => {
    expect(existsSync(".output/chrome-mv3/detector.js")).toBe(true);
  });
});
