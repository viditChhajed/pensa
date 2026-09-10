/**
 * What the v1 submission actually ships.
 *
 * The plan (§13) scopes Tier-2 PAGE detectors and the §18A temporal engine to "post-
 * submission / v1.1 during review". Both were built early — real scope drift — so this file
 * makes the boundary a fact about the code rather than a claim in a status report.
 *
 * Enforcement is by EXCLUSION FROM THE IMPORT GRAPH, not a runtime flag: the deferred
 * modules live in `detectors/deferred.ts` and `background/temporal.ts`, and nothing an
 * entrypoint imports reaches them. They therefore cannot appear in a built bundle even by
 * accident, which a boolean flag could not guarantee. `tests/unit/scope.test.ts` asserts
 * their identifiers are absent from the build output.
 */

/**
 * The page detectors that run inside the content script.
 *
 * Tier 2 was originally held for "v1.1 during store review". That was a schedule decision,
 * not a quality one — all five were built and tested alongside Tier 1 — and the spot check
 * made its cost concrete: flyfrontier's fare grid is a textbook asymmetric-dominance decoy
 * and the extension produced zero detections on it, because the only detector that could see
 * it was excluded from the bundle.
 */
export const SHIPPED_PAGE_DETECTORS = [
  // Tier 1
  "anchoring.reference_price",
  "pricing.charm",
  "scarcity.stock",
  "urgency.countdown",
  "defaults.preselected",
  "social_proof.live_activity",
  "confirmshaming.decline_copy",
  "goal_gradient.threshold",
  "bnpl.installments",
  // Tier 2
  "interference.visual_asymmetry",
  "decoy.asymmetric_dominance",
  "nagging.repeat_interstitial",
  "framing.savings_ratio",
  "loss_aversion.exit_intent",
] as const;

/**
 * The 2 cross-stage detectors. These live in the service worker and take a SessionLedger
 * rather than a PageContext, so they are not in the content-script registry.
 */
export const SHIPPED_CROSS_STAGE_DETECTORS = ["pricing.drip", "basket.sneak"] as const;

export const SHIPPED_DETECTORS = [
  ...SHIPPED_PAGE_DETECTORS,
  ...SHIPPED_CROSS_STAGE_DETECTORS,
] as const;

export const SHIPPED_DETECTOR_COUNT = SHIPPED_DETECTORS.length;

/**
 * The §18A temporal patterns: still not in the page registry, and for a structural reason
 * rather than a scheduling one.
 *
 * These cannot be evaluated from a single page. Each one is a claim about how something
 * CHANGED between visits — a countdown that resets, a stock count that rises, a "was" price
 * never actually charged — so they are derived in the service worker from the observation
 * store, not by a detector looking at a DOM. The store ships and accumulates from the first
 * visit; see `background/temporal.ts`.
 */
export const DERIVED_FROM_HISTORY = [
  "temporal.evergreen_countdown",
  "temporal.stock_nonmonotonic",
  "temporal.reference_price_ungrounded",
  "temporal.social_proof_synthetic",
] as const;

/** Retained name for the scope tests, which assert these never reach the page registry. */
export const DEFERRED_TO_V1_1 = DERIVED_FROM_HISTORY;
