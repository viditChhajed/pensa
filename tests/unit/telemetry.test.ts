import { describe, expect, it } from "vitest";
import { toRecord } from "@/background/telemetry";
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
  it("carries exactly eight fields and no more", () => {
    const r = toRecord(event());
    expect(r).not.toBeNull();
    expect(Object.keys(r ?? {}).sort()).toEqual([
      "confidenceQuartile",
      "dayBucket",
      "detectorId",
      "funnelStage",
      "originCategory",
      "patternId",
      "rulepackVersion",
      "site",
    ]);
  });

  it("names the shop by registrable domain, and nothing finer", () => {
    // v2 sends the site on purpose — that is what per-site prevalence is. What it must not
    // send is anything below the registrable domain: the subdomain can be a tenant name, and
    // the path is which product somebody looked at.
    const r = toRecord(event({ origin: "https://secure.checkout.booking.com" }));
    expect(r?.site).toBe("booking.com");
  });

  it("carries no path, no session, no page text and no full hostname", () => {
    // Asserted on the serialised form, because that is what would be POSTed.
    const wire = JSON.stringify(toRecord(event({ origin: "https://www.booking.com" })));
    expect(wire).toContain('"site":"booking.com"');
    expect(wire).not.toContain("www.booking.com");
    expect(wire).not.toContain("/hotel/");
    expect(wire).not.toContain("22222222");
    expect(wire).not.toContain("Only 3 left");
    expect(wire).not.toContain("https://");
  });

  it("sends a day, never an hour or a timestamp", () => {
    // Coarsened from hours in the same change that added the site, and the two belong
    // together: a shop plus an exact hour is far more linkable to one person than a shop plus
    // a day, and a prevalence question loses nothing at daily resolution.
    const morning = Date.UTC(2026, 8, 16, 1, 0, 0);
    const night = Date.UTC(2026, 8, 16, 23, 0, 0);
    expect(toRecord(event({ ts: morning }))?.dayBucket).toBe(
      toRecord(event({ ts: night }))?.dayBucket,
    );
    expect(toRecord(event({ ts: night }))?.dayBucket).not.toBe(
      toRecord(event({ ts: night + 2 * 3_600_000 }))?.dayBucket,
    );
  });

  it("sends a confidence quartile, never the score", () => {
    expect(toRecord(event({ confidence: 0.81 }))?.confidenceQuartile).toBe(4);
    expect(toRecord(event({ confidence: 0.99 }))?.confidenceQuartile).toBe(4);
    expect(toRecord(event({ confidence: 0.1 }))?.confidenceQuartile).toBe(1);
  });

  it("includes shops the bundled list does not name, as category `other`", () => {
    // v1 refused these, because the category WAS the anonymity. The site is now sent
    // explicitly, so refusing unlisted shops would only drop the long tail of small stores —
    // which is where a lot of these techniques live.
    const r = toRecord(event({ origin: "https://some-tiny-shop.com" }));
    expect(r?.site).toBe("some-tiny-shop.com");
    expect(r?.originCategory).toBe("other");
  });

  it("refuses anything that is not https", () => {
    // Vero's permission is https. An http origin could only be a test build or a
    // hand-written row, and neither belongs in a dataset.
    expect(toRecord(event({ origin: "http://shop.example.com" }))).toBeNull();
  });
});

describe("consent", () => {
  it("is off in the shipped defaults", () => {
    // A tool that flags preselected checkboxes cannot ship with one.
    expect(DEFAULT_SETTINGS.telemetryConsent).toBe(false);
  });
});
