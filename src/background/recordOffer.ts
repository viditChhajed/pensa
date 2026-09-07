/**
 * Merge a page observation into the persistent per-offer history (plan §18A, worker side).
 *
 * Caps every array so a heavily-visited product cannot grow without bound, and keeps the
 * NEWEST samples — recent behaviour is what a claim is about.
 */

import type { PageObservation } from "@/content/observations";
import type { OfferObservation } from "@/shared/schema";
import { readOffer, writeOffer } from "./db";

const CAP_TIMERS = 64;
const CAP_STOCK = 64;
const CAP_PRICES = 64;
const CAP_VIEWERS = 128;

function tail<T>(arr: readonly T[], cap: number): T[] {
  return arr.length <= cap ? [...arr] : arr.slice(arr.length - cap);
}

export function mergeObservation(
  existing: OfferObservation | null,
  origin: string,
  offerKey: string,
  offerKeySource: OfferObservation["offerKeySource"],
  page: PageObservation,
  now: number,
): OfferObservation {
  const base: OfferObservation = existing ?? {
    origin,
    offerKey,
    offerKeySource,
    firstSeen: now,
    lastSeen: now,
    sightings: 0,
    observedPrices: [],
    observedReferencePrices: [],
    timerSightings: [],
    stockSightings: [],
    viewerCountSightings: [],
  };

  return {
    ...base,
    lastSeen: now,
    sightings: base.sightings + 1,
    timerSightings: tail(
      [
        ...base.timerSightings,
        ...page.timers.map((t) => ({
          ts: now,
          containerPathHash: t.containerPathHash,
          observedEndEpoch: t.observedEndEpoch,
        })),
      ],
      CAP_TIMERS,
    ),
    stockSightings: tail(
      [...base.stockSightings, ...page.stockCounts.map((n) => ({ ts: now, n }))],
      CAP_STOCK,
    ),
    viewerCountSightings: tail(
      [...base.viewerCountSightings, ...page.viewerCounts.map((n) => ({ ts: now, n }))],
      CAP_VIEWERS,
    ),
    observedPrices: tail(
      [
        ...base.observedPrices,
        ...page.prices.map((p) => ({ ts: now, minor: BigInt(p.minor), currency: p.currency })),
      ],
      CAP_PRICES,
    ),
    observedReferencePrices: tail(
      [
        ...base.observedReferencePrices,
        ...page.referencePrices.map((p) => ({ ts: now, minor: BigInt(p.minor) })),
      ],
      CAP_PRICES,
    ),
  };
}

/** Read-modify-write against the offers store. Returns the merged record. */
export async function recordObservation(
  origin: string,
  offerKey: string,
  offerKeySource: OfferObservation["offerKeySource"],
  page: PageObservation,
  now = Date.now(),
): Promise<OfferObservation> {
  const existing = await readOffer(origin, offerKey);
  const merged = mergeObservation(existing, origin, offerKey, offerKeySource, page, now);
  await writeOffer(merged);
  return merged;
}
