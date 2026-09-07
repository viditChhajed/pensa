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

/** The 9 page detectors that run inside the content script. */
export const SHIPPED_PAGE_DETECTORS = [
  "anchoring.reference_price",
  "pricing.charm",
  "scarcity.stock",
  "urgency.countdown",
  "defaults.preselected",
  "social_proof.live_activity",
  "confirmshaming.decline_copy",
  "goal_gradient.threshold",
  "bnpl.installments",
] as const;

/**
 * The 2 cross-stage detectors. These live in the service worker and take a SessionLedger
 * rather than a PageContext, so they are not in the content-script registry.
 */
export const SHIPPED_CROSS_STAGE_DETECTORS = ["pricing.drip", "basket.sneak"] as const;

/** Everything active in the submitted build: 9 + 2 = 11. */
export const SHIPPED_DETECTORS = [
  ...SHIPPED_PAGE_DETECTORS,
  ...SHIPPED_CROSS_STAGE_DETECTORS,
] as const;

export const SHIPPED_DETECTOR_COUNT = SHIPPED_DETECTORS.length;

/** Built, tested, and deliberately NOT shipped in v1. Held for v1.1 during store review. */
export const DEFERRED_TO_V1_1 = [
  "interference.visual_asymmetry",
  "decoy.asymmetric_dominance",
  "nagging.repeat_interstitial",
  "framing.savings_ratio",
  "loss_aversion.exit_intent",
  "temporal.evergreen_countdown",
  "temporal.stock_nonmonotonic",
  "temporal.reference_price_ungrounded",
  "temporal.social_proof_synthetic",
] as const;
