/**
 * Temporal verification engine (plan §18A) — the highest-value module.
 *
 * Every other tool in this space judges a page in isolation. This one remembers. Claims that
 * no single-page analysis can make:
 *
 *   - A countdown whose deadline moves forward on every visit is not a fixed point in time.
 *   - A "only N left" counter that rises, or resets identically on reload, is not tracking
 *     one inventory.
 *   - A "was $X" where $X has never been the observed price has no observed basis.
 *   - Viewer counts drawn from a narrow band, or invariant across time of day, behave like
 *     generated numbers rather than measurements.
 *
 * Two properties make this worth the complexity: it needs no server and no consent beyond
 * install, and it gets stronger the longer someone uses the extension — which is also a
 * retention mechanism, since the tool is more useful in month two than on day one.
 *
 * Everything here is a pure function over an OfferObservation so it can be replayed against
 * a recorded history. By construction none of it produces output on a first sighting.
 */
import { createHash } from "@/content/detectors/hash";
import type { DetectionCandidate, OfferObservation } from "@/shared/schema";

/** Below this many sightings, say nothing. Two points is a line, not a pattern. */
export const MIN_SIGHTINGS = 2;
/** Chi-square needs samples before it means anything (plan §18A). */
export const MIN_VIEWER_SAMPLES = 20;

function evidence(summary: string, path = "(temporal)") {
  return {
    selectorPath: path,
    textHash: createHash(summary),
    textSample: summary,
    matchedLexemes: [] as string[],
    boundingBox: { x: 0, y: 0, w: 0, h: 0 },
  };
}

/**
 * Evergreen countdown.
 *
 * A real deadline is a fixed epoch: observed 10 minutes later, it is 10 minutes closer. An
 * evergreen timer's end epoch advances with the clock, so `Δend / Δobserved` sits near 1.
 * A ratio near 0 is a genuine fixed deadline.
 */
export function detectEvergreenCountdown(obs: OfferObservation): DetectionCandidate | null {
  const sightings = obs.timerSightings;
  if (sightings.length < MIN_SIGHTINGS) return null;

  // Group by timer container: a page may hold several unrelated timers.
  const byContainer = new Map<string, typeof sightings>();
  for (const s of sightings) {
    const arr = byContainer.get(s.containerPathHash);
    if (arr) (arr as (typeof sightings)[number][]).push(s);
    else byContainer.set(s.containerPathHash, [s]);
  }

  for (const [, group] of byContainer) {
    if (group.length < MIN_SIGHTINGS) continue;
    const ordered = [...group].sort((a, b) => a.ts - b.ts);

    let advancing = 0;
    let comparisons = 0;
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      if (!prev || !cur) continue;
      const dObserved = cur.ts - prev.ts;
      if (dObserved < 60_000) continue; // same page view; nothing to learn
      const dEnd = cur.observedEndEpoch - prev.observedEndEpoch;
      comparisons++;
      // Ratio near 1 means the deadline moved forward exactly as much as the clock did.
      const ratio = dEnd / dObserved;
      if (ratio > 0.7 && ratio < 1.4) advancing++;
    }

    if (comparisons === 0 || advancing === 0) continue;

    const confidence = Math.min(0.95, 0.6 + 0.15 * advancing);
    const summary = `deadline advanced on ${advancing} of ${comparisons} revisits`;

    return {
      detectorId: "temporal.evergreen_countdown@1",
      patternId: "temporal.evergreen_countdown",
      rawScore: confidence,
      subSignals: { advancingSightings: advancing, comparisons, sightings: obs.sightings },
      evidence: evidence(summary),
      nodeRef: "(temporal)",
    };
  }

  return null;
}

/**
 * Stock monotonicity.
 *
 * Absent a restock, "only N left" should be non-increasing. An increase is not proof of
 * anything on its own — restocks happen — so the signal is repetition: multiple increases,
 * or a value that has been identically the same for many days while being presented as
 * scarce.
 */
export function detectStockAnomaly(obs: OfferObservation): DetectionCandidate | null {
  const s = [...obs.stockSightings].sort((a, b) => a.ts - b.ts);
  if (s.length < MIN_SIGHTINGS) return null;

  let increases = 0;
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1];
    const cur = s[i];
    if (prev && cur && cur.n > prev.n) increases++;
  }

  const values = s.map((x) => x.n);
  const first = values[0] as number;
  const allSame = values.every((v) => v === first);
  const spanDays = ((s[s.length - 1]?.ts ?? 0) - (s[0]?.ts ?? 0)) / 86_400_000;
  const frozenLong = allSame && spanDays >= 7 && s.length >= 3;

  if (increases < 2 && !frozenLong) return null;

  const summary = frozenLong
    ? `count held at ${first} across ${Math.round(spanDays)} days`
    : `count rose on ${increases} occasions`;

  return {
    detectorId: "temporal.stock_nonmonotonic@1",
    patternId: "temporal.stock_nonmonotonic",
    rawScore: Math.min(0.9, 0.55 + 0.12 * (increases + (frozenLong ? 2 : 0))),
    subSignals: { increases, frozenLong: frozenLong ? 1 : 0, samples: s.length },
    evidence: evidence(summary),
    nodeRef: "(temporal)",
  };
}

/**
 * Reference-price grounding.
 *
 * A "was $X / now $Y" where $Y is the only price ever observed means the higher number has
 * no observed basis — which is precisely what FTC pricing guidance and the UK CMA's
 * reference-pricing rules concern themselves with, and the reason this is the detector most
 * directly useful to a policy write-up.
 *
 * Stated carefully: we can say we never observed it, not that it never happened.
 */
export function detectUngroundedReference(obs: OfferObservation): DetectionCandidate | null {
  const refs = obs.observedReferencePrices;
  const prices = obs.observedPrices;
  if (refs.length < MIN_SIGHTINGS || prices.length < MIN_SIGHTINGS) return null;

  const spanDays = (obs.lastSeen - obs.firstSeen) / 86_400_000 || 0;
  if (spanDays < 7) return null; // too short a window to claim anything

  const distinctSale = new Set(prices.map((p) => p.minor.toString()));
  if (distinctSale.size !== 1) return null; // the price has moved; the anchor may be real

  const sale = prices[0]?.minor ?? 0n;
  // Was the reference price ever actually charged?
  const everCharged = refs.some((r) => r.minor === sale);
  if (everCharged) return null;

  const summary = `reference price not observed in ${Math.round(spanDays)} days of visits`;

  return {
    detectorId: "temporal.reference_price_ungrounded@1",
    patternId: "temporal.reference_price_ungrounded",
    rawScore: Math.min(0.95, 0.6 + Math.min(0.3, spanDays / 60)),
    subSignals: { spanDays, priceSamples: prices.length, refSamples: refs.length },
    evidence: evidence(summary),
    nodeRef: "(temporal)",
  };
}

/**
 * Social-proof plausibility.
 *
 * Chi-square goodness-of-fit against a uniform distribution over the observed range. A real
 * viewer count is bursty and time-of-day dependent; a generated one is near-uniform inside a
 * narrow band.
 *
 * Requires n >= 20 (plan §18A). Below that the test says nothing and neither do we.
 */
export function detectSyntheticSocialProof(obs: OfferObservation): DetectionCandidate | null {
  const samples = obs.viewerCountSightings.map((v) => v.n);
  if (samples.length < MIN_VIEWER_SAMPLES) return null;

  const min = Math.min(...samples);
  const max = Math.max(...samples);
  if (max <= min) {
    // Perfectly constant: not uniform-random, just fixed.
    return {
      detectorId: "temporal.social_proof_synthetic@1",
      patternId: "temporal.social_proof_synthetic",
      rawScore: 0.8,
      subSignals: { constant: 1, samples: samples.length, range: 0 },
      evidence: evidence(`count was ${min} on all ${samples.length} observations`),
      nodeRef: "(temporal)",
    };
  }

  // A tight band relative to its own magnitude is the practical signal.
  const range = max - min;
  const narrowBand = range <= Math.max(3, max * 0.25);

  const bins = Math.min(8, Math.max(2, Math.ceil(Math.sqrt(samples.length))));
  const counts = new Array<number>(bins).fill(0);
  for (const v of samples) {
    const idx = Math.min(bins - 1, Math.floor(((v - min) / (range + 1)) * bins));
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const expected = samples.length / bins;
  let chiSquare = 0;
  for (const c of counts) chiSquare += (c - expected) ** 2 / expected;

  // Low chi-square = suspiciously even spread across the range.
  const uniformish = chiSquare < bins;
  if (!uniformish && !narrowBand) return null;

  const summary = `${samples.length} observations spanned ${min}-${max}`;

  return {
    detectorId: "temporal.social_proof_synthetic@1",
    patternId: "temporal.social_proof_synthetic",
    rawScore: Math.min(0.85, 0.5 + (uniformish ? 0.2 : 0) + (narrowBand ? 0.2 : 0)),
    subSignals: {
      chiSquare,
      bins,
      samples: samples.length,
      narrowBand: narrowBand ? 1 : 0,
      uniformish: uniformish ? 1 : 0,
    },
    evidence: evidence(summary),
    nodeRef: "(temporal)",
  };
}

/** Every temporal claim available for one offer. Empty on a first sighting, by construction. */
export function temporalCandidates(obs: OfferObservation): DetectionCandidate[] {
  const out: DetectionCandidate[] = [];
  for (const fn of [
    detectEvergreenCountdown,
    detectStockAnomaly,
    detectUngroundedReference,
    detectSyntheticSocialProof,
  ]) {
    const c = fn(obs);
    if (c) out.push(c);
  }
  return out;
}
