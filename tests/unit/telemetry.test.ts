import { describe, expect, it } from "vitest";
import { cohortOf, K_FLOOR, toRecord } from "@/background/telemetry";
import { DEFAULT_SETTINGS, type DetectionEvent } from "@/shared/schema";

/**
 * What may leave the device, and what may not.
 *
 * These are not tests of a data pipeline, they are tests of a promise. `TelemetryRecord` is
 * `.strict()` precisely so an accidentally-added field throws rather than passing through,
 * and `toRecord` is the only place a detection becomes something transmittable — so it is
 * the one function where "we do not send X" has to be true rather than intended.
 */

const event = (over: Partial<DetectionEvent> = {}): DetectionEvent =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    origin: "https://www.booking.com",
    pathTemplate: "/hotel/:slug",
    detectorId: "scarcity.stock@1",
    patternId: "scarcity.stock",
    confidence: 0.85,
    confidenceBasis: "hand_set",
    salience: {
      visibleMs: 2000,
      viewportFraction: 0.5,
      scrollDepthAtFirstView: 0.1,
      ephemeral: false,
    },
    surfaced: true,
    suppressionReason: "none",
    funnelStage: "pdp",
    evidence: {
      selectorPath: "#a > div",
      textHash: "a".repeat(64),
      textSample: "Only 3 left at this price",
      matchedLexemes: ["only", "left"],
      boundingBox: { x: 0, y: 0, w: 100, h: 20 },
    },
    rulepackVersion: "1",
    detectorVersion: "1",
    ts: 1_750_000_000_000,
    ...over,
  }) as DetectionEvent;

describe("what a telemetry record carries", () => {
  it("carries exactly seven fields and no more", () => {
    const r = toRecord(event());
    expect(r).not.toBeNull();
    expect(Object.keys(r ?? {}).sort()).toEqual([
      "confidenceQuartile",
      "detectorId",
      "funnelStage",
      "hourBucket",
      "originCategory",
      "patternId",
      "rulepackVersion",
    ]);
  });

  it("carries no origin, no path, no session and no page text", () => {
    // The four things that would turn an anonymous count into a record of someone's
    // afternoon. Asserted on the serialised form, because that is what would be POSTed.
    const wire = JSON.stringify(toRecord(event()));
    expect(wire).not.toContain("booking.com");
    expect(wire).not.toContain("/hotel/");
    expect(wire).not.toContain("22222222");
    expect(wire).not.toContain("Only 3 left");
  });

  it("sends an hour, never a timestamp", () => {
    // Both inside hour 486111 — picked by arithmetic, not by eye. The first draft of this
    // used timestamps that straddled the boundary and failed, correctly.
    const r = toRecord(event({ ts: 1_750_000_000_000 }));
    const r2 = toRecord(event({ ts: 1_750_003_000_000 }));
    // Fifty minutes apart and indistinguishable. That is the point: a precise time is a
    // correlation key even when nothing else in the record is.
    expect(r?.hourBucket).toBe(r2?.hourBucket);
    expect(String(r?.hourBucket).length).toBeLessThan(String(Date.now()).length);
  });

  it("sends a confidence quartile, never the score", () => {
    expect(toRecord(event({ confidence: 0.81 }))?.confidenceQuartile).toBe(4);
    expect(toRecord(event({ confidence: 0.99 }))?.confidenceQuartile).toBe(4);
    expect(toRecord(event({ confidence: 0.1 }))?.confidenceQuartile).toBe(1);
  });

  it("refuses a site that has no allowlist category", () => {
    // The category is what makes the record anonymous. An unrecognised site has none, and
    // inventing `other` for it would make the rarest sites the MOST identifiable — the
    // opposite of what a category is for.
    expect(toRecord(event({ origin: "https://some-tiny-shop.example" }))).toBeNull();
  });

  it("reports the site category, not the site", () => {
    const r = toRecord(event({ origin: "https://www.booking.com" }));
    expect(r?.originCategory).toBeTruthy();
    expect(r?.originCategory).not.toContain("booking");
  });
});

describe("the k-anonymity floor", () => {
  it("groups by pattern, stage, category and hour — and nothing finer", () => {
    // Anything finer would make cohorts smaller, and a smaller cohort is a sharper
    // fingerprint. The grouping IS the anonymity.
    const a = toRecord(event({ ts: 1_750_000_000_000 }));
    const b = toRecord(event({ ts: 1_750_001_000_000, confidence: 0.3 }));
    expect(a && b && cohortOf(a) === cohortOf(b)).toBe(true);
  });

  it("separates different patterns into different cohorts", () => {
    const a = toRecord(event({ patternId: "scarcity.stock" }));
    const b = toRecord(event({ patternId: "urgency.countdown" }));
    expect(a && b && cohortOf(a) === cohortOf(b)).toBe(false);
  });

  it("keeps the floor high enough to be worth calling anonymity", () => {
    // §18G names k>=20. A floor of 2 or 3 satisfies the letter and none of the point.
    expect(K_FLOOR).toBeGreaterThanOrEqual(20);
  });
});

describe("consent", () => {
  it("is off in the shipped defaults", () => {
    // A tool that flags preselected checkboxes cannot ship with one.
    expect(DEFAULT_SETTINGS.telemetryConsent).toBe(false);
  });
});
