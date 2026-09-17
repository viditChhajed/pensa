import { describe, expect, it } from "vitest";
import { buildDigest, type RankInput, rankOne, shouldShowDigest } from "@/background/digest";
import type { DetectionCandidate } from "@/shared/schema";
import type { PatternId } from "@/shared/taxonomy";

function cand(
  patternId: PatternId,
  rawScore: number,
  detectorId = `${patternId}@1`,
): DetectionCandidate {
  return {
    detectorId,
    patternId,
    rawScore,
    subSignals: {},
    evidence: {
      selectorPath: "div",
      textHash: "a".repeat(64),
      matchedLexemes: [],
      boundingBox: { x: 0, y: 0, w: 10, h: 10 },
    },
    nodeRef: "div",
  };
}

function input(
  patternId: PatternId,
  score: number,
  visibleMs: number,
  passedGate = true,
): RankInput {
  return { candidate: cand(patternId, score), visibleMs, passedGate };
}

const OPTS = { surfaceThreshold: 0.75, disabledDetectors: new Set<string>() };

describe("rankOne", () => {
  it("scores zero dwell as zero, regardless of confidence", () => {
    expect(rankOne(cand("urgency.countdown", 1), 0)).toBe(0);
  });

  it("grows with dwell, but sub-linearly", () => {
    const short = rankOne(cand("urgency.countdown", 1), 1000);
    const long = rankOne(cand("urgency.countdown", 1), 10_000);
    expect(long).toBeGreaterThan(short);
    // 10x the dwell must NOT produce 10x the rank, or one long-lived banner buries everything.
    expect(long).toBeLessThan(short * 10);
  });

  it("weights a severe pattern above a trivial one at equal confidence and dwell", () => {
    const drip = rankOne(cand("pricing.drip", 0.9), 5000);
    const charm = rankOne(cand("pricing.charm", 0.9), 5000);
    expect(drip).toBeGreaterThan(charm);
  });
});

describe("buildDigest", () => {
  it("shows nothing when everything is below threshold", () => {
    const result = buildDigest([input("scarcity.stock", 0.5, 5000)], OPTS);
    expect(result.items).toHaveLength(0);
    expect(result.decisions[0]?.reason).toBe("below_threshold");
  });

  it("logs but does not surface a candidate that failed the salience gate", () => {
    // Detected is not surfaced. The gap is the research signal, so it must be recorded.
    const result = buildDigest([input("scarcity.stock", 0.9, 200, false)], OPTS);
    expect(result.items).toHaveLength(0);
    expect(result.decisions[0]).toMatchObject({
      surfaced: false,
      reason: "below_salience_gate",
    });
  });

  it("caps at four items", () => {
    const result = buildDigest(
      [
        input("scarcity.stock", 0.9, 5000),
        input("urgency.countdown", 0.9, 5000),
        input("defaults.preselected", 0.9, 5000),
        input("bnpl.installments", 0.9, 5000),
        input("goal_gradient.threshold", 0.9, 5000),
        input("social_proof.live_activity", 0.9, 5000),
      ],
      OPTS,
    );
    expect(result.items).toHaveLength(4);
    expect(result.decisions.some((d) => d.reason === "digest_full")).toBe(true);
  });

  it("keeps only the strongest member of a pattern family", () => {
    // anchoring and charm both fire on nearly every price tag; showing both reads as padding.
    const result = buildDigest(
      [input("pricing.charm", 0.8, 5000), input("pricing.drip", 0.95, 5000)],
      OPTS,
    );
    const families = result.items.map((i) => i.patternId);
    expect(families).toEqual(["pricing.drip"]);
    expect(result.decisions.some((d) => d.reason === "dedup_family")).toBe(true);
  });

  it("respects a user-disabled detector", () => {
    const result = buildDigest([input("scarcity.stock", 0.99, 9000)], {
      ...OPTS,
      disabledDetectors: new Set(["scarcity.stock"]),
    });
    expect(result.items).toHaveLength(0);
    expect(result.decisions[0]?.reason).toBe("user_disabled");
  });

  it("orders by rank, not by input order", () => {
    const result = buildDigest(
      [
        input("pricing.charm", 0.9, 8000),
        input("pricing.drip", 0.9, 8000),
        input("scarcity.stock", 0.9, 8000),
      ],
      OPTS,
    );
    const ranks = result.items.map((i) => i.rank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it("records a decision for every input", () => {
    const inputs = [input("scarcity.stock", 0.9, 5000), input("pricing.charm", 0.2, 5000)];
    const result = buildDigest(inputs, OPTS);
    expect(result.decisions.length).toBeGreaterThanOrEqual(inputs.length);
  });
});

describe("shouldShowDigest", () => {
  const empty = { shownThisSession: new Set<string>(), originsShown: new Set<string>() };

  it("shows on a fresh origin and stage", () => {
    expect(shouldShowDigest("every_checkout", "https://a.com", "checkout", empty).show).toBe(true);
  });

  it("never re-fires for the same origin and stage in a session", () => {
    const state = { ...empty, shownThisSession: new Set(["https://a.com:checkout"]) };
    const r = shouldShowDigest("every_checkout", "https://a.com", "checkout", state);
    expect(r.show).toBe(false);
    expect(r.reason).toBe("debounced");
  });

  it("still allows a different stage on the same origin", () => {
    const state = { ...empty, shownThisSession: new Set(["https://a.com:cart"]) };
    expect(shouldShowDigest("every_checkout", "https://a.com", "checkout", state).show).toBe(true);
  });

  it("once_per_site suppresses a second stage on the same origin", () => {
    const state = { ...empty, originsShown: new Set(["https://a.com"]) };
    expect(shouldShowDigest("once_per_site", "https://a.com", "checkout", state).show).toBe(false);
  });

  it("off suppresses everything", () => {
    expect(shouldShowDigest("off", "https://a.com", "checkout", empty).show).toBe(false);
  });

  it("never_interrupt suppresses the in-page digest", () => {
    expect(shouldShowDigest("never_interrupt", "https://a.com", "checkout", empty).show).toBe(
      false,
    );
  });
});
