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
import type { DetectionCandidate, FunnelStage, Salience, Settings } from "./schema";
import { findUnserializable, type WirePriceSnapshot } from "./wire";

export interface StagePayload {
  type: "stage";
  origin: string;
  pathTemplate: string;
  stage: FunnelStage;
  /** WIRE shape: money as decimal strings. JSON cannot carry BigInt. See wire.ts. */
  priceSnapshot?: WirePriceSnapshot;
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
  /**
   * How much this page can display, measured before ranking. The worker needs it up front
   * so the event log records what was actually shown rather than what it hoped to show.
   */
  placement?: { maxCardItems: number; pillFits: boolean };
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

/**
 * Is the detector script ACTUALLY registered and matching this page?
 *
 * "Watching example.com" in the popup only means the permission was granted. Registration is
 * a separate step that can fail on its own, and when it does the failure is logged to the
 * service worker console — which is not reachable from the page console where a tester is
 * looking. The symptom is a popup claiming to watch a site while nothing whatsoever runs on
 * it, with no way to tell the difference from "the detectors found nothing".
 */
export interface DiagnoseRegistration {
  type: "diagnose-registration";
  url: string;
}

export interface RegistrationReport {
  granted: boolean;
  registered: boolean;
  matchCount: number;
  error?: string;
}
export interface GetSettings {
  type: "get-settings";
}
export interface SetSettings {
  type: "set-settings";
  patch: Partial<Settings>;
}
/** Exactly what telemetry would send right now, for the settings page to display. */
export interface GetPendingTelemetry {
  type: "get-pending-telemetry";
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
  | DiagnoseRegistration
  | GetSettings
  | SetSettings
  | GetPendingTelemetry
  | ClearData
  | Ping;

/** What the worker sends back when a digest should be shown. */
export interface ShowDigest {
  type: "show-digest";
  items: {
    patternId: string;
    prompt: string;
    label: string;
    evidence?: string;
    mechanism?: string;
    citation?: string;
  }[];
  /** What the worker decided the page can hold. "suppressed" means render nothing. */
  mode: "card" | "pill" | "suppressed";
}

export async function send<T = unknown>(msg: Message): Promise<T | null> {
  // A message that CANNOT be serialised is a programming error, not a transient condition.
  // Conflating the two is what hid a dead cross-stage pipeline for the whole build: a
  // BigInt in the payload made sendMessage throw, the catch below swallowed it, and the
  // ledger silently never received a price snapshot.
  const problem = findUnserializable(msg);
  if (problem) {
    console.error(`[patterns] unsendable ${msg.type} message: ${problem}`);
    return null;
  }

  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch (err) {
    // A sleeping worker or a reloading extension is genuinely not an error, and those two
    // produce known messages. ANYTHING ELSE is a real fault, and swallowing all of them
    // alike is what made a dead pipeline look like an ordinary empty answer once already.
    const text = err instanceof Error ? err.message : String(err);
    const expected =
      text.includes("Receiving end does not exist") ||
      text.includes("Extension context invalidated");
    // NOT in that list: "message port closed before a response was received". That is the
    // signature of a handler that threw before replying, which is a real fault and was
    // briefly silenced here while chasing exactly that bug.
    if (!expected) console.error(`[patterns] send(${msg.type}) failed: ${text}`);
    return null;
  }
}
