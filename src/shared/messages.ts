/**
 * The content script <-> service worker protocol, TYPES ONLY, plus `send()`.
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
import type { AddonKey } from "./addons";
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
  /**
   * `digest` (default) asks the worker to decide whether to show a card. `record` says these
   * were found while browsing: write them to the log and show nothing.
   */
  intent?: "digest" | "record";
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

/**
 * An add-on the shopper opted into or out of, with their own click or toggle.
 *
 * Carries a family key and a boolean, never the label text. See src/content/interactions.ts.
 */
export interface ChoicePayload {
  type: "choice";
  origin: string;
  choices: { key: AddonKey; selected: boolean }[];
}

/**
 * One product or listing page view, for the add-to-cart outcome measure.
 *
 * Sent when the view starts, again whenever another technique clears the salience gate, and
 * once more with `addedToCart: true` at the click. The worker ends the view there, or after it
 * goes idle. Carries technique ids and a boolean; never text, never the path. Dropped by the
 * worker unless sharing is on, see src/background/outcomes.ts.
 */
export interface PageViewPayload {
  type: "pageview";
  /** Random per page view, regenerated on navigation. Never leaves the device. */
  viewId: string;
  origin: string;
  stage: "browse" | "pdp";
  /** Techniques that passed the salience gate on this view so far. */
  exposed: string[];
  addedToCart: boolean;
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

export interface GetSummary {
  type: "get-summary";
}

/**
 * Is the detector script ACTUALLY registered and matching this page?
 *
 * "Watching example.com" in the popup only means the permission was granted. Registration is
 * a separate step that can fail on its own, and when it does the failure is logged to the
 * service worker console, which is not reachable from the page console where a tester is
 * looking. The symptom is a popup claiming to watch a site while nothing whatsoever runs on
 * it, with no way to tell the difference from "the detectors found nothing".
 */
export interface DiagnoseRegistration {
  type: "diagnose-registration";
  url: string;
}

export interface RegistrationReport {
  /** Does Chrome still hand us this origin? The user can narrow site access at any time. */
  granted: boolean;
  /** Does the declared content script match this URL, and is it not excluded? */
  registered: boolean;
  /** Is this one of the denylist hosts `exclude_matches` refuses outright? */
  excluded: boolean;
  /**
   * Has the detector decided this origin is actually a shop, this session?
   *
   * Derived from the presence of a session ledger, not from a stored verdict. The detector
   * only messages the worker AFTER its commerce gate passes, so a ledger entry means "this
   * was judged a shop" and its absence means "not judged one, or not judged yet". A page
   * that is not a shop is therefore reported by producing nothing at all, which is the only
   * way to answer the question without keeping a record of every page somebody visits.
   */
  active: boolean;
  error?: string;
}
/**
 * Hand back every stored detection row, for research rather than for display.
 *
 * `get-summary` returns counts. This returns the rows the counts were computed from, which
 * is what prevalence work actually needs: the pattern, where in the funnel it appeared, how
 * confident the detector was, whether it was ever shown, and why it was suppressed if not.
 */
export interface ExportEvents {
  type: "export-events";
}

/**
 * A card the worker decided to show, collected by the NEXT page on the same shop.
 *
 * On a site whose Add to Cart navigates to a cart page, the card is built for a page that is
 * already being torn down. The worker holds each card until a page confirms it stayed on
 * screen (`card-seen`); if none does, the next page on that origin takes it and shows it.
 */
export interface TakePendingCard {
  type: "take-pending-card";
  origin: string;
}
export interface CardSeen {
  type: "card-seen";
  origin: string;
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
  | ChoicePayload
  | PageViewPayload
  | TakePendingCard
  | CardSeen
  | GetSummary
  | DiagnoseRegistration
  | ExportEvents
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
  /**
   * Attach the one-time sharing question to this card. True at most until it is answered or
   * the card is closed, and only while sharing is off. See src/content/ui/card.ts.
   */
  askConsent?: boolean;
}

export async function send<T = unknown>(msg: Message): Promise<T | null> {
  // A message that CANNOT be serialised is a programming error, not a transient condition.
  // Conflating the two is what hid a dead cross-stage pipeline for the whole build: a
  // BigInt in the payload made sendMessage throw, the catch below swallowed it, and the
  // ledger silently never received a price snapshot.
  const problem = findUnserializable(msg);
  if (problem) {
    console.error(`[pensa] unsendable ${msg.type} message: ${problem}`);
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
    if (!expected) console.error(`[pensa] send(${msg.type}) failed: ${text}`);
    return null;
  }
}
