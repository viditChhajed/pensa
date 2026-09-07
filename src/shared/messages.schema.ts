/**
 * Runtime validation for the message protocol. Imported by the SERVICE WORKER ONLY.
 *
 * The worker is the only receiver, so it is the only place a trust boundary exists. Keeping
 * these schemas out of `messages.ts` keeps Zod out of the content script and popup bundles.
 *
 * The `satisfies` assertion at the bottom fails to compile if the schemas drift from the
 * hand-written types in `messages.ts`, which is what makes the split safe.
 */
import { z } from "zod";
import type * as M from "./messages";
import {
  DetectionCandidate,
  FunnelStage,
  Origin,
  PathTemplate,
  Salience,
  Settings,
  Sha256,
} from "./schema";

const WireMoney = z.object({
  minor: z.string().regex(/^-?\d{1,18}$/),
  currency: z.string().length(3),
  confidence: z.number().min(0).max(1),
});

/** Money crosses the boundary as a decimal STRING — JSON has no BigInt. See wire.ts. */
const WirePriceSnapshot = z.object({
  displayedPrice: WireMoney.optional(),
  subtotal: WireMoney.optional(),
  shipping: WireMoney.optional(),
  tax: WireMoney.optional(),
  total: WireMoney.optional(),
  fees: z
    .array(
      z.object({
        labelHash: Sha256,
        labelSample: z.string().max(120).optional(),
        amount: WireMoney,
        kind: z.enum([
          "product",
          "shipping",
          "tax",
          "mandatory_fee",
          "optional_addon",
          "discount",
          "unknown",
        ]),
        kindConfidence: z.number().min(0).max(1),
        userAttributed: z.boolean(),
      }),
    )
    .max(40),
  capturedAt: z.number().int(),
});

export const StagePayload = z.object({
  type: z.literal("stage"),
  origin: Origin,
  pathTemplate: PathTemplate,
  stage: FunnelStage,
  priceSnapshot: WirePriceSnapshot.optional(),
});

export const CandidatesPayload = z.object({
  type: z.literal("candidates"),
  origin: Origin,
  pathTemplate: PathTemplate,
  stage: FunnelStage,
  items: z
    .array(z.object({ candidate: DetectionCandidate, salience: Salience, passedGate: z.boolean() }))
    .max(200),
  offerKey: z.string().max(128).optional(),
});

export const TriggerPayload = z.object({
  type: z.literal("trigger"),
  origin: Origin,
  pathTemplate: PathTemplate,
  stage: FunnelStage,
  kind: z.enum(["add_to_cart", "checkout_intent"]),
  labelHash: Sha256,
  labelSample: z.string().max(120).optional(),
});

export const ObservationPayload = z.object({
  type: z.literal("observation"),
  origin: Origin,
  offerKey: z.string().max(128),
  offerKeySource: z.enum(["jsonld_id", "sku", "gtin", "url_title_hash"]),
  observation: z.object({
    // Money crosses this boundary as a decimal STRING: BigInt has no JSON representation,
    // and chrome.runtime.sendMessage serialises as JSON.
    timers: z
      .array(z.object({ containerPathHash: Sha256, observedEndEpoch: z.number().int() }))
      .max(8),
    stockCounts: z.array(z.number().int()).max(8),
    viewerCounts: z.array(z.number().int()).max(8),
    prices: z
      .array(z.object({ minor: z.string().regex(/^\d{1,15}$/), currency: z.string().length(3) }))
      .max(8),
    referencePrices: z.array(z.object({ minor: z.string().regex(/^\d{1,15}$/) })).max(8),
  }),
});

export const QueryEnablement = z.object({
  type: z.literal("query-enablement"),
  url: z.string().max(2048),
});

export const GetSummary = z.object({ type: z.literal("get-summary") });
export const GetSettings = z.object({ type: z.literal("get-settings") });
export const SetSettings = z.object({
  type: z.literal("set-settings"),
  patch: Settings.partial(),
});
export const ClearData = z.object({ type: z.literal("clear-data") });
export const Ping = z.object({ type: z.literal("ping") });

export const Message = z.discriminatedUnion("type", [
  StagePayload,
  ObservationPayload,
  CandidatesPayload,
  TriggerPayload,
  QueryEnablement,
  GetSummary,
  GetSettings,
  SetSettings,
  ClearData,
  Ping,
]);

/**
 * Compile-time guard against drift. If a schema stops producing the hand-written type in
 * `messages.ts`, this line stops compiling.
 */
type _SchemaMatchesTypes = z.infer<typeof Message> extends M.Message ? true : never;
const _assertMatch: _SchemaMatchesTypes = true;
void _assertMatch;
