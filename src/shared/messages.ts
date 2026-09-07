/**
 * The content script <-> service worker protocol.
 *
 * Cross-context messages are a trust boundary, so every payload is Zod-validated on receipt.
 * The content script runs in a page the extension does not control; treating what arrives
 * from it as already-valid would be the same mistake as trusting page content.
 */
import { z } from "zod";
import {
  DetectionCandidate,
  FunnelStage,
  Origin,
  PathTemplate,
  PriceSnapshot,
  Salience,
  Settings,
  Sha256,
} from "./schema";

export const StagePayload = z.object({
  type: z.literal("stage"),
  origin: Origin,
  pathTemplate: PathTemplate,
  stage: FunnelStage,
  priceSnapshot: PriceSnapshot.optional(),
});

export const CandidatesPayload = z.object({
  type: z.literal("candidates"),
  origin: Origin,
  pathTemplate: PathTemplate,
  stage: FunnelStage,
  items: z
    .array(z.object({ candidate: DetectionCandidate, salience: Salience, passedGate: z.boolean() }))
    .max(200),
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

export const QueryEnablement = z.object({
  type: z.literal("query-enablement"),
  url: z.string().max(2048),
});

export const GetSummary = z.object({ type: z.literal("get-summary") });
export const GetSettings = z.object({ type: z.literal("get-settings") });
export const SetSettings = z.object({ type: z.literal("set-settings"), patch: Settings.partial() });
export const ClearData = z.object({ type: z.literal("clear-data") });
export const Ping = z.object({ type: z.literal("ping") });

export const Message = z.discriminatedUnion("type", [
  StagePayload,
  CandidatesPayload,
  TriggerPayload,
  QueryEnablement,
  GetSummary,
  GetSettings,
  SetSettings,
  ClearData,
  Ping,
]);
export type Message = z.infer<typeof Message>;

/** What the worker sends back when a digest should be shown. */
export const ShowDigest = z.object({
  type: z.literal("show-digest"),
  items: z.array(z.object({ patternId: z.string(), prompt: z.string(), label: z.string() })).max(4),
});
export type ShowDigest = z.infer<typeof ShowDigest>;

export async function send<T = unknown>(msg: Message): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    // The worker may be asleep or the extension reloading. Never throw into a host page.
    return null;
  }
}
