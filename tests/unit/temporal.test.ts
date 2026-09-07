import { describe, expect, it } from "vitest";
import {
  detectEvergreenCountdown,
  detectStockAnomaly,
  detectSyntheticSocialProof,
  detectUngroundedReference,
  temporalCandidates,
} from "@/background/temporal";
import type { OfferObservation } from "@/shared/schema";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function obs(patch: Partial<OfferObservation> = {}): OfferObservation {
  return {
    origin: "https://shop.example.com",
    offerKey: "sku:ABC",
    offerKeySource: "sku",
    firstSeen: 0,
    lastSeen: 30 * DAY,
    sightings: 5,
    observedPrices: [],
    observedReferencePrices: [],
    timerSightings: [],
    stockSightings: [],
    viewerCountSightings: [],
    ...patch,
  };
}

const HASH = "a".repeat(64);

describe("evergreen countdown", () => {
  it("flags a deadline that advances with the clock", () => {
    // Seen 2 hours apart; the deadline moved forward by 2 hours. That is not a fixed point.
    const c = detectEvergreenCountdown(
      obs({
        timerSightings: [
          { ts: 0, containerPathHash: HASH, observedEndEpoch: 10 * HOUR },
          { ts: 2 * HOUR, containerPathHash: HASH, observedEndEpoch: 12 * HOUR },
        ],
      }),
    );
    expect(c).not.toBeNull();
    expect(c?.patternId).toBe("temporal.evergreen_countdown");
  });

  it("does NOT flag a genuine fixed deadline", () => {
    // Seen 2 hours apart; the same end epoch both times. The deadline is real.
    const c = detectEvergreenCountdown(
      obs({
        timerSightings: [
          { ts: 0, containerPathHash: HASH, observedEndEpoch: 10 * HOUR },
          { ts: 2 * HOUR, containerPathHash: HASH, observedEndEpoch: 10 * HOUR },
        ],
      }),
    );
    expect(c).toBeNull();
  });

  it("says nothing on a single sighting, by construction", () => {
    expect(
      detectEvergreenCountdown(
        obs({ timerSightings: [{ ts: 0, containerPathHash: HASH, observedEndEpoch: HOUR }] }),
      ),
    ).toBeNull();
  });

  it("ignores two readings from the same page view", () => {
    // Under a minute apart is the same visit; a ticking clock proves nothing about revisits.
    expect(
      detectEvergreenCountdown(
        obs({
          timerSightings: [
            { ts: 0, containerPathHash: HASH, observedEndEpoch: 10 * HOUR },
            { ts: 5000, containerPathHash: HASH, observedEndEpoch: 10 * HOUR + 5000 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("gains confidence with more advancing sightings", () => {
    const two = detectEvergreenCountdown(
      obs({
        timerSightings: [
          { ts: 0, containerPathHash: HASH, observedEndEpoch: 10 * HOUR },
          { ts: 2 * HOUR, containerPathHash: HASH, observedEndEpoch: 12 * HOUR },
        ],
      }),
    );
    const four = detectEvergreenCountdown(
      obs({
        timerSightings: [
          { ts: 0, containerPathHash: HASH, observedEndEpoch: 10 * HOUR },
          { ts: 2 * HOUR, containerPathHash: HASH, observedEndEpoch: 12 * HOUR },
          { ts: 4 * HOUR, containerPathHash: HASH, observedEndEpoch: 14 * HOUR },
          { ts: 6 * HOUR, containerPathHash: HASH, observedEndEpoch: 16 * HOUR },
        ],
      }),
    );
    expect(four?.rawScore ?? 0).toBeGreaterThan(two?.rawScore ?? 0);
  });
});

describe("stock monotonicity", () => {
  it("flags a count that repeatedly rises", () => {
    const c = detectStockAnomaly(
      obs({
        stockSightings: [
          { ts: 0, n: 3 },
          { ts: DAY, n: 7 },
          { ts: 2 * DAY, n: 2 },
          { ts: 3 * DAY, n: 9 },
        ],
      }),
    );
    expect(c).not.toBeNull();
    expect(c?.subSignals.increases).toBe(2);
  });

  it("does NOT flag a single restock", () => {
    // Restocks are ordinary. One increase proves nothing.
    expect(
      detectStockAnomaly(
        obs({
          stockSightings: [
            { ts: 0, n: 3 },
            { ts: DAY, n: 9 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("does NOT flag a normally depleting count", () => {
    expect(
      detectStockAnomaly(
        obs({
          stockSightings: [
            { ts: 0, n: 9 },
            { ts: DAY, n: 6 },
            { ts: 2 * DAY, n: 2 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("flags a count frozen at the same value for over a week", () => {
    const c = detectStockAnomaly(
      obs({
        stockSightings: [
          { ts: 0, n: 3 },
          { ts: 5 * DAY, n: 3 },
          { ts: 11 * DAY, n: 3 },
        ],
      }),
    );
    expect(c).not.toBeNull();
    expect(c?.subSignals.frozenLong).toBe(1);
  });
});

describe("reference price grounding", () => {
  it("flags a was-price never observed as the actual price", () => {
    const c = detectUngroundedReference(
      obs({
        firstSeen: 0,
        lastSeen: 30 * DAY,
        observedPrices: [
          { ts: 0, minor: 4999n, currency: "USD" },
          { ts: 15 * DAY, minor: 4999n, currency: "USD" },
          { ts: 30 * DAY, minor: 4999n, currency: "USD" },
        ],
        observedReferencePrices: [
          { ts: 0, minor: 9999n },
          { ts: 30 * DAY, minor: 9999n },
        ],
      }),
    );
    expect(c).not.toBeNull();
    expect(c?.patternId).toBe("temporal.reference_price_ungrounded");
  });

  it("does NOT flag when the price has actually moved", () => {
    expect(
      detectUngroundedReference(
        obs({
          lastSeen: 30 * DAY,
          observedPrices: [
            { ts: 0, minor: 9999n, currency: "USD" },
            { ts: 20 * DAY, minor: 4999n, currency: "USD" },
          ],
          observedReferencePrices: [
            { ts: 0, minor: 9999n },
            { ts: 20 * DAY, minor: 9999n },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("does NOT claim anything inside a one-week window", () => {
    // Too short to distinguish a permanent anchor from an ordinary sale.
    expect(
      detectUngroundedReference(
        obs({
          firstSeen: 0,
          lastSeen: 3 * DAY,
          observedPrices: [
            { ts: 0, minor: 4999n, currency: "USD" },
            { ts: 3 * DAY, minor: 4999n, currency: "USD" },
          ],
          observedReferencePrices: [
            { ts: 0, minor: 9999n },
            { ts: 3 * DAY, minor: 9999n },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("social proof plausibility", () => {
  it("says nothing below the sample floor", () => {
    // n >= 20 before the chi-square means anything (plan §18A).
    const few = Array.from({ length: 10 }, (_, i) => ({ ts: i * HOUR, n: 40 + i }));
    expect(detectSyntheticSocialProof(obs({ viewerCountSightings: few }))).toBeNull();
  });

  it("flags a perfectly constant count", () => {
    const constant = Array.from({ length: 25 }, (_, i) => ({ ts: i * HOUR, n: 47 }));
    const c = detectSyntheticSocialProof(obs({ viewerCountSightings: constant }));
    expect(c).not.toBeNull();
    expect(c?.subSignals.constant).toBe(1);
  });

  it("flags a count confined to a narrow band", () => {
    const narrow = Array.from({ length: 30 }, (_, i) => ({ ts: i * HOUR, n: 45 + (i % 3) }));
    expect(detectSyntheticSocialProof(obs({ viewerCountSightings: narrow }))).not.toBeNull();
  });

  it("does NOT flag a bursty, wide-ranging count", () => {
    // What a real viewer count looks like: quiet overnight, spikes in the evening.
    const real = [
      2, 3, 1, 0, 1, 4, 9, 18, 31, 44, 60, 71, 55, 40, 22, 12, 6, 3, 2, 1, 0, 1, 5, 30, 66,
    ].map((n, i) => ({ ts: i * HOUR, n }));
    expect(detectSyntheticSocialProof(obs({ viewerCountSightings: real }))).toBeNull();
  });
});

describe("temporalCandidates", () => {
  it("produces nothing on a first sighting, by construction", () => {
    expect(temporalCandidates(obs({ sightings: 1 }))).toEqual([]);
  });

  it("collects every independent claim for one offer", () => {
    const c = temporalCandidates(
      obs({
        timerSightings: [
          { ts: 0, containerPathHash: HASH, observedEndEpoch: 10 * HOUR },
          { ts: 2 * HOUR, containerPathHash: HASH, observedEndEpoch: 12 * HOUR },
        ],
        stockSightings: [
          { ts: 0, n: 3 },
          { ts: DAY, n: 7 },
          { ts: 2 * DAY, n: 2 },
          { ts: 3 * DAY, n: 9 },
        ],
      }),
    );
    expect(c.map((x) => x.patternId).sort()).toEqual([
      "temporal.evergreen_countdown",
      "temporal.stock_nonmonotonic",
    ]);
  });

  it("emits a valid sha256-shaped evidence hash", () => {
    const c = temporalCandidates(
      obs({
        stockSightings: [
          { ts: 0, n: 3 },
          { ts: DAY, n: 7 },
          { ts: 2 * DAY, n: 2 },
          { ts: 3 * DAY, n: 9 },
        ],
      }),
    );
    expect(c[0]?.evidence.textHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
