/**
 * Zod at every trust boundary: IndexedDB reads, rule-pack loads, cross-context messages,
 * and any future telemetry payload. Nothing persisted is trusted on read-back.
 *
 * Zod 4 notes (verified against zod@4.5.4):
 *   - `z.record(k, v)` with an enum key demands EVERY key. Use `z.partialRecord` for
 *     sparse maps like `SessionLedger.stages`.
 *   - `z.record(...).partial()` does not exist.
 */
import { z } from "zod";
import { PATTERN_IDS } from "./taxonomy";

// --------------------------------- primitives ---------------------------------

export const FunnelStage = z.enum(["browse", "pdp", "cart", "checkout", "payment"]);
export type FunnelStage = z.infer<typeof FunnelStage>;

/** Funnel order, for "did this fee appear at a later stage than the price?" comparisons. */
export const FUNNEL_ORDER: Record<FunnelStage, number> = {
  browse: 0,
  pdp: 1,
  cart: 2,
  checkout: 3,
  payment: 4,
};

export const PatternId = z.enum(PATTERN_IDS);
export type PatternId = z.infer<typeof PatternId>;

/** Scheme + host only. A path or query string here is a privacy bug, not a formatting one. */
export const Origin = z
  .string()
  .regex(/^https?:\/\/[^/?#]+$/, "origin must be scheme + host, with no path or query");

/** Digits and slugs redacted: `/p/:id`. Never a raw path, never a query string. */
export const PathTemplate = z
  .string()
  .max(120)
  .regex(/^\/[^?#]*$/, "path template must start with / and carry no query or fragment");

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Money is minor units as bigint. Never a float, ever — `0.1 + 0.2` reconciliation errors
 * would silently corrupt every drip-pricing finding. BigInt is structured-clone-safe, so
 * IndexedDB stores it directly; it is excluded from every telemetry payload, so the fact
 * that `JSON.stringify` cannot serialize it never comes up.
 */
export const Money = z.object({
  amount: z.bigint(),
  currency: z.string().length(3),
  confidence: z.number().min(0).max(1),
});
export type Money = z.infer<typeof Money>;

// --------------------------------- line items ---------------------------------

export const LineItemKind = z.enum([
  "product",
  "shipping",
  "tax",
  "mandatory_fee",
  "optional_addon",
  "discount",
  "unknown",
]);
export type LineItemKind = z.infer<typeof LineItemKind>;

export const LineItem = z.object({
  labelHash: Sha256,
  /** Local only. Stripped before anything leaves the device. */
  labelSample: z.string().max(120).optional(),
  amount: Money,
  kind: LineItemKind,
  kindConfidence: z.number().min(0).max(1),
  /** Matched to a `userInitiatedAdds` entry. False on a cart line = basket.sneak candidate. */
  userAttributed: z.boolean(),
});
export type LineItem = z.infer<typeof LineItem>;

export const PriceSnapshot = z.object({
  displayedPrice: Money.optional(),
  subtotal: Money.optional(),
  fees: z.array(LineItem).default([]),
  shipping: Money.optional(),
  tax: Money.optional(),
  total: Money.optional(),
  capturedAt: z.number().int(),
});
export type PriceSnapshot = z.infer<typeof PriceSnapshot>;

// --------------------------------- evidence ---------------------------------

export const ComputedStyleEvidence = z
  .object({
    contrastRatio: z.number().min(1).max(21).optional(),
    fontWeight: z.number().int().min(1).max(1000).optional(),
    renderedArea: z.number().nonnegative().optional(),
    textDecoration: z.string().max(64).optional(),
    fontSizePx: z.number().positive().optional(),
    /** Resolved by walking ancestors through transparency (§18E). */
    effectiveBackground: z.string().max(32).optional(),
  })
  .partial();
export type ComputedStyleEvidence = z.infer<typeof ComputedStyleEvidence>;

export const Evidence = z.object({
  /** Depth-capped CSS path. Stable enough to re-find a node, short enough to store. */
  selectorPath: z.string().max(512),
  /** SHA-256 of NORMALIZED matched text — the hash, not the text. */
  textHash: Sha256,
  /** LOCAL ONLY. Never included in any egress payload. */
  textSample: z.string().max(240).optional(),
  matchedLexemes: z.array(z.string().max(64)).max(24),
  computedStyle: ComputedStyleEvidence.optional(),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
});
export type Evidence = z.infer<typeof Evidence>;

export const Salience = z.object({
  visibleMs: z.number().nonnegative(),
  viewportFraction: z.number().min(0).max(1),
  scrollDepthAtFirstView: z.number().min(0).max(1),
  /** Self-removing node (a toast) — gates at 400ms rather than 800ms. */
  ephemeral: z.boolean().default(false),
});
export type Salience = z.infer<typeof Salience>;

// --------------------------------- detection ---------------------------------

/**
 * The pre-persistence output of a pure detector. No id, no sessionId, no origin — a
 * detector cannot know those, which is exactly what keeps it a pure function over a
 * serialized DOM and therefore runnable in Node.
 */
export const DetectionCandidate = z.object({
  detectorId: z.string().max(64),
  patternId: PatternId,
  rawScore: z.number().min(0).max(1),
  /** Named sub-signals. Weights live in the rule pack, so they are data, not code. */
  subSignals: z.record(z.string().max(48), z.number()),
  evidence: Evidence,
  /** selectorPath of the node, so the observer can attach an IntersectionObserver. */
  nodeRef: z.string().max(512),
});
export type DetectionCandidate = z.infer<typeof DetectionCandidate>;

export const SuppressionReason = z.enum([
  "none",
  "below_salience_gate",
  "below_threshold",
  "debounced",
  "dedup_family",
  "user_disabled",
  "digest_full",
]);
export type SuppressionReason = z.infer<typeof SuppressionReason>;

export const DetectionEvent = z.object({
  id: z.uuid(),
  /** Rotates daily. Local only, never transmitted. */
  sessionId: z.uuid(),
  origin: Origin,
  pathTemplate: PathTemplate,
  detectorId: z.string().max(64),
  patternId: PatternId,
  confidence: z.number().min(0).max(1),
  /**
   * Honest provenance. v1 thresholds are hand-set from the §10 spot-check, NOT
   * Platt-fitted. This field exists so no future reader mistakes one for the other.
   */
  confidenceBasis: z.enum(["hand_set", "platt_scaled"]).default("hand_set"),
  salience: Salience,
  /** Detected is not surfaced. Both are first-class; the gap is the research signal. */
  surfaced: z.boolean(),
  suppressionReason: SuppressionReason.default("none"),
  funnelStage: FunnelStage,
  evidence: Evidence,
  rulepackVersion: z.string().max(32),
  detectorVersion: z.string().max(32),
  ts: z.number().int(),
});
export type DetectionEvent = z.infer<typeof DetectionEvent>;

// --------------------------------- session ---------------------------------

export const UserInitiatedAdd = z.object({
  ts: z.number().int(),
  labelHash: Sha256,
  labelSample: z.string().max(120).optional(),
  offerKey: z.string().max(128).optional(),
  /** A post-click cart signal was observed (badge mutation or cart-endpoint request). */
  confirmed: z.boolean().default(false),
});
export type UserInitiatedAdd = z.infer<typeof UserInitiatedAdd>;

export const StageRecord = z.object({
  enteredAt: z.number().int(),
  priceSnapshot: PriceSnapshot.optional(),
});

export const SessionLedger = z.object({
  sessionId: z.uuid(),
  origin: Origin,
  /** Sparse: most sessions never reach `payment`. */
  stages: z.partialRecord(FunnelStage, StageRecord),
  userInitiatedAdds: z.array(UserInitiatedAdd).default([]),
  events: z.array(DetectionEvent).default([]),
  digestsShown: z
    .array(
      z.object({
        stage: FunnelStage,
        ts: z.number().int(),
        patternIds: z.array(PatternId),
      }),
    )
    .default([]),
});
export type SessionLedger = z.infer<typeof SessionLedger>;

// --------------------------- temporal store (§18A) ---------------------------

export const OfferKeySource = z.enum(["jsonld_id", "sku", "gtin", "url_title_hash"]);
export type OfferKeySource = z.infer<typeof OfferKeySource>;

/**
 * Keyed [origin, offerKey]. 5k records, LRU eviction, 90-day TTL. Every value is numeric
 * or hashed — no free text reaches this store, because it is the longest-lived thing on disk.
 */
export const OfferObservation = z.object({
  origin: Origin,
  offerKey: z.string().max(128),
  offerKeySource: OfferKeySource,
  firstSeen: z.number().int(),
  lastSeen: z.number().int(),
  sightings: z.number().int().nonnegative(),
  observedPrices: z
    .array(z.object({ ts: z.number().int(), minor: z.bigint(), currency: z.string().length(3) }))
    .max(64)
    .default([]),
  observedReferencePrices: z
    .array(z.object({ ts: z.number().int(), minor: z.bigint() }))
    .max(64)
    .default([]),
  timerSightings: z
    .array(
      z.object({
        ts: z.number().int(),
        containerPathHash: Sha256,
        observedEndEpoch: z.number().int(),
      }),
    )
    .max(64)
    .default([]),
  stockSightings: z
    .array(z.object({ ts: z.number().int(), n: z.number().int() }))
    .max(64)
    .default([]),
  viewerCountSightings: z
    .array(z.object({ ts: z.number().int(), n: z.number().int() }))
    .max(128)
    .default([]),
});
export type OfferObservation = z.infer<typeof OfferObservation>;

// --------------------------------- telemetry ---------------------------------

/**
 * The §11 egress shape. Built now; transmitted by nothing in v1.
 *
 * Note what is absent, and keep it absent: no origin, no path, no sessionId, no text,
 * no money, no precise timestamp. `.strict()` here is a privacy control — an unknown key
 * on this object is a leak, so it should throw rather than pass through.
 */
export const TelemetryRecord = z
  .object({
    patternId: PatternId,
    detectorId: z.string().max(64),
    confidenceQuartile: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    funnelStage: FunnelStage,
    /** The allowlist category tag, NOT the origin. */
    originCategory: z.string().max(32),
    rulepackVersion: z.string().max(32),
    /** Epoch hours, not milliseconds. */
    hourBucket: z.number().int(),
    /** §18G k-anonymity bucket. Nothing surfaces below k=20 distinct reporters. */
    kCohort: z.string().max(16).optional(),
  })
  .strict();
export type TelemetryRecord = z.infer<typeof TelemetryRecord>;

// --------------------------------- rule packs ---------------------------------

export const DetectorConfig = z.object({
  enabled: z.boolean(),
  /** Above this, a candidate may be surfaced to the user. Precision-biased. */
  surfaceThreshold: z.number().min(0).max(1).default(0.75),
  /** Above this, a candidate is logged locally. Recall-biased. */
  logThreshold: z.number().min(0).max(1).default(0.35),
  weights: z.record(z.string(), z.number()),
  lexemes: z.array(z.string()).default([]),
});
export type DetectorConfig = z.infer<typeof DetectorConfig>;

export const RulePack = z
  .object({
    version: z.string().max(32),
    /** §10 governs over §8: v1 thresholds are hand-set, not fitted. */
    calibration: z.literal("hand_set"),
    detectors: z.record(z.string(), DetectorConfig),
  })
  .strict();
export type RulePack = z.infer<typeof RulePack>;

export const OriginCategory = z.enum([
  "marketplace",
  "ota_travel",
  "airline",
  "ticketing",
  "fast_fashion",
  "subscription_box",
  "dtc",
  "food_delivery",
  "big_box",
  "electronics",
  "other",
]);
export type OriginCategory = z.infer<typeof OriginCategory>;

export const AllowlistEntry = z.object({
  origin: Origin,
  category: OriginCategory,
  note: z.string().max(200).optional(),
});
export type AllowlistEntry = z.infer<typeof AllowlistEntry>;

export const AllowlistFile = z.object({
  version: z.string().max(32),
  _frame: z.record(z.string(), z.string()).optional(),
  entries: z.array(AllowlistEntry),
});
export type AllowlistFile = z.infer<typeof AllowlistFile>;

export const DenylistFile = z.object({
  version: z.string().max(32),
  _frame: z.record(z.string(), z.string()).optional(),
  hostSuffixes: z.array(z.string()),
  hostPatterns: z.array(z.string()),
  schemes: z.array(z.string()),
});
export type DenylistFile = z.infer<typeof DenylistFile>;

// --------------------------------- settings ---------------------------------

export const DigestFrequency = z.enum(["every_checkout", "once_per_site", "weekly_only", "off"]);
export type DigestFrequency = z.infer<typeof DigestFrequency>;

export const Settings = z.object({
  digestFrequency: DigestFrequency.default("every_checkout"),
  /** Off by default. Not a preselected checkbox — see §11. */
  telemetryConsent: z.boolean().default(false),
  telemetryConsentAskedAt: z.number().int().optional(),
  disabledDetectors: z.array(z.string()).default([]),
  retentionDays: z.number().int().min(1).max(365).default(30),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = Settings.parse({});
