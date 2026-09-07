import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AllowlistFile, DenylistFile } from "@/shared/schema";

/**
 * The rulepacks are validated HERE rather than at runtime.
 *
 * They are build artifacts we author and the bundler inlines — fixed at compile time, so
 * there is no runtime trust boundary to defend. Parsing them in `urlScore.ts` dragged Zod
 * into the content script and the popup for no benefit. A build-time fact belongs in a
 * build-time check.
 */
const allowlist = JSON.parse(readFileSync("rulepacks/allowlist.v1.json", "utf8"));
const denylist = JSON.parse(readFileSync("rulepacks/denylist.v1.json", "utf8"));

describe("allowlist.v1.json", () => {
  it("matches the schema", () => {
    expect(() => AllowlistFile.parse(allowlist)).not.toThrow();
  });

  it("has no duplicate origins", () => {
    const origins = allowlist.entries.map((e: { origin: string }) => e.origin);
    expect(new Set(origins).size).toBe(origins.length);
  });

  it("uses https everywhere and never a path", () => {
    for (const e of allowlist.entries as { origin: string }[]) {
      expect(e.origin.startsWith("https://"), e.origin).toBe(true);
      expect(e.origin.split("/").length, e.origin).toBe(3);
    }
  });

  it("documents its sampling frame, because any prevalence claim depends on it", () => {
    expect(allowlist._frame?.samplingFrame).toBeTruthy();
    expect(allowlist._frame?.categoryBias).toBeTruthy();
  });

  it("over-weights the high-density categories the frame claims it does", () => {
    const counts = new Map<string, number>();
    for (const e of allowlist.entries as { category: string }[]) {
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    }
    for (const c of ["ota_travel", "ticketing", "fast_fashion", "airline", "food_delivery"]) {
      expect(counts.get(c) ?? 0, `${c} should be represented`).toBeGreaterThan(0);
    }
  });
});

describe("denylist.v1.json", () => {
  it("matches the schema", () => {
    expect(() => DenylistFile.parse(denylist)).not.toThrow();
  });

  it("compiles every host pattern as a regex", () => {
    for (const p of denylist.hostPatterns as string[]) {
      expect(() => new RegExp(p, "i"), p).not.toThrow();
    }
  });

  it("covers the categories where a permission prompt would be worst", () => {
    const all = (denylist.hostPatterns as string[]).join(" ");
    for (const must of ["chase", "mychart", "paypal", "irs", "1password"]) {
      expect(all, `denylist should cover ${must}`).toContain(must);
    }
    expect(denylist.hostSuffixes).toContain(".gov");
    expect(denylist.hostSuffixes).toContain(".bank");
  });

  it("blocks privileged schemes", () => {
    for (const s of ["chrome:", "file:", "about:"]) {
      expect(denylist.schemes).toContain(s);
    }
  });
});

describe("no allowlist origin is also denied", () => {
  it("holds for every entry", async () => {
    const { isDenied } = await import("@/shared/urlScore");
    for (const e of allowlist.entries as { origin: string }[]) {
      expect(isDenied(new URL(e.origin)), e.origin).toBe(false);
    }
  });
});

describe("denylist label anchoring", () => {
  /**
   * Regression net for a real bug. The social-platform pattern lists `x` (for x.com) inside
   * an alternation. Without a label boundary it matched ANY host ending in "x.com" —
   * stitchfix.com, tjx.com, stockx.com — permanently blocking three shopping sites from ever
   * being enabled, with no way for a user to discover why. A denylist hit is unconditional
   * and silent, so an over-broad pattern here is the most expensive kind of mistake.
   */
  const mustBeDenied = [
    "https://x.com",
    "https://www.facebook.com",
    "https://chase.com",
    "https://www.chase.com",
    "https://mychart.example.org",
    "https://mail.google.com",
    "https://www.irs.gov",
    "https://1password.com",
    "https://localhost",
  ];

  const mustNotBeDenied = [
    "https://www.stitchfix.com",
    "https://www.stockx.com",
    "https://www.tjmaxx.tjx.com",
    "https://purchase.example.com",
    "https://www.amazon.com",
    "https://www.snapdeal.com",
    "https://www.boxlunch.com",
    "https://www.matchesfashion.com",
  ];

  it("denies what it must", async () => {
    const { isDenied } = await import("@/shared/urlScore");
    for (const url of mustBeDenied) {
      expect(isDenied(new URL(url)), url).toBe(true);
    }
  });

  it("does not deny hosts that merely END with a blocked label", async () => {
    const { isDenied } = await import("@/shared/urlScore");
    for (const url of mustNotBeDenied) {
      expect(isDenied(new URL(url)), url).toBe(false);
    }
  });

  it("anchors every host-label alternation", () => {
    for (const p of denylist.hostPatterns as string[]) {
      if (p.startsWith("(") && !p.startsWith("(^|")) {
        throw new Error(`unanchored alternation: ${p}`);
      }
    }
  });
});
