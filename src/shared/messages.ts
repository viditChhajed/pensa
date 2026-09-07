/**
 * The content script <-> service worker protocol — TYPES ONLY, plus `send()`.
 *
 * The Zod schemas that validate these live in `messages.schema.ts` and are imported by the
 * service worker alone. That split is deliberate: validation belongs at the receiving end of
 * a trust boundary, and the worker is the only receiver. Importing the schemas here dragged
 * Zod into the content script and popup, which cost ~30 KB gzipped in bundles that never
 * validate anything.
 *
 * `messages.schema.ts` has a compile-time assertion that the schemas still match these types,
 * so the two files cannot drift apart silently.
 */
import type { DetectionCandidate, FunnelStage, PriceSnapshot, Salience, Settings } from "./schema";

export interface StagePayload {
  type: "stage";
  origin: string;
  pathTemplate: string;
  stage: FunnelStage;
  priceSnapshot?: PriceSnapshot;
}

export interface CandidateItem {
  candidate: DetectionCandidate;
  salience: Salience;
  passedGate: boolean;
}

export interface CandidatesPayload {
  type: "candidates";
  origin: string;
  pathTemplate: string;
  stage: FunnelStage;
  items: CandidateItem[];
  /** Resolved offer identity, so the worker can attach §18A temporal claims. */
  offerKey?: string;
}

export interface TriggerPayload {
  type: "trigger";
  origin: string;
  pathTemplate: string;
  stage: FunnelStage;
  kind: "add_to_cart" | "checkout_intent";
  labelHash: string;
  labelSample?: string;
}

/** A page's contribution to the §18A temporal history, keyed by resolved offer identity. */
export interface ObservationPayload {
  type: "observation";
  origin: string;
  offerKey: string;
  offerKeySource: "jsonld_id" | "sku" | "gtin" | "url_title_hash";
  observation: {
    timers: { containerPathHash: string; observedEndEpoch: number }[];
    stockCounts: number[];
    viewerCounts: number[];
    prices: { minor: string; currency: string }[];
    referencePrices: { minor: string }[];
  };
}

export interface QueryEnablement {
  type: "query-enablement";
  url: string;
}

export interface GetSummary {
  type: "get-summary";
}
export interface GetSettings {
  type: "get-settings";
}
export interface SetSettings {
  type: "set-settings";
  patch: Partial<Settings>;
}
export interface ClearData {
  type: "clear-data";
}
export interface Ping {
  type: "ping";
}

export type Message =
  | StagePayload
  | ObservationPayload
  | CandidatesPayload
  | TriggerPayload
  | QueryEnablement
  | GetSummary
  | GetSettings
  | SetSettings
  | ClearData
  | Ping;

/** What the worker sends back when a digest should be shown. */
export interface ShowDigest {
  type: "show-digest";
  items: { patternId: string; prompt: string; label: string }[];
}

export async function send<T = unknown>(msg: Message): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    // The worker may be asleep or the extension reloading. Never throw into a host page.
    return null;
  }
}
