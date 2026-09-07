/**
 * The detector contract.
 *
 * A detector is `(ctx: PageContext) => DetectionCandidate[]`. It never touches the DOM,
 * never mutates state, never calls the network. Everything it could want to know about a
 * node is already a plain value on `CandidateNode`, collected during the read phase.
 *
 * That constraint is not stylistic. It is what makes the same detector bundle runnable in
 * Node against a serialized DOM, and it is what makes layout thrashing structurally
 * impossible rather than merely discouraged: by the time a detector runs, there is no
 * layout left to read.
 */
import type { DetectionCandidate, FunnelStage } from "@/shared/schema";

/** Cheap character-class bitmask, computed once per text node during harvest. */
export enum CharClass {
  None = 0,
  Digit = 1 << 0,
  Currency = 1 << 1,
  Colon = 1 << 2,
  Percent = 1 << 3,
  LexiconTrigger = 1 << 4,
}

export interface StyleSnapshot {
  fontWeight: number;
  fontSizePx: number;
  textDecorationLine: string;
  color: string;
  backgroundColor: string;
  /** Resolved by walking ancestors through transparent backgrounds (§18E). */
  effectiveBackground: string;
  display: string;
  visibility: string;
  opacity: number;
}

export interface BoxSnapshot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One observation of a node's text at a point in time. Feeds the countdown detector. */
export interface TextObservation {
  t: number;
  text: string;
}

export interface CandidateNode {
  /** Index into `PageContext.candidates`. Stable for the life of one context. */
  readonly idx: number;
  readonly tagName: string;
  readonly role: string | null;
  /** Accessible name, computed during the read phase (aria-label, alt, text, …). */
  readonly accessibleName: string;
  /** Raw text content, whitespace-collapsed, capped. */
  readonly text: string;
  /** Lowercased, punctuation-normalized. What lexicon matching runs against. */
  readonly normalizedText: string;
  readonly charClass: number;
  readonly selectorPath: string;
  readonly style: StyleSnapshot;
  readonly box: BoxSnapshot;
  /** Attribute subset detectors are allowed to see. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly parentIdx: number | null;
  /**
   * Nearest ancestor ELEMENT, whether or not it is itself a candidate. Most wrappers
   * (`<div class="price">`, `<label>`) carry no qualifying text of their own and so never
   * become candidates — but they are exactly the grouping key detectors need, and the text
   * they contain is exactly the context a control's label lives in.
   */
  readonly containerPath: string | null;
  readonly containerText: string;
  /** A <progress> or [role=progressbar] anywhere inside. Usually not itself a candidate. */
  readonly hasProgressDescendant: boolean;
  readonly childIdxs: readonly number[];
  /** Populated only for nodes observed changing. Empty for the vast majority. */
  readonly textHistory: readonly TextObservation[];
  /** Node was inserted after initial harvest, and removed again within 15s. */
  readonly ephemeral: boolean;
  readonly insertedAt: number | null;
  readonly removedAt: number | null;
}

export interface DocumentMeta {
  readonly origin: string;
  readonly pathTemplate: string;
  readonly title: string;
  readonly ogType: string | null;
  /** Parsed JSON-LD blocks. Unparseable blocks are dropped, not thrown on. */
  readonly jsonLd: readonly unknown[];
  readonly hasCcNumberField: boolean;
  readonly hasPostalCodeField: boolean;
  readonly hasAddressCluster: boolean;
  readonly hasOrderSummaryTriple: boolean;
}

/**
 * Time-dependent facts the observer accumulates. Detectors are pure and have no clock, so
 * anything about *when* something happened has to arrive as a value, the same way
 * `textHistory` carries a countdown's decrement.
 */
export interface PageSignals {
  /** Modal/interstitial insertions observed this page-session. Drives nagging. */
  modalInsertionCount: number;
  /** Timestamps (performance.now) of each modal insertion. */
  modalsInsertedAt: readonly number[];
  /** Last mouseleave toward the top of the viewport, or visibilitychange to hidden. */
  lastExitIntentAt: number | null;
  /** selectorPaths of modals inserted within the exit-intent window. */
  exitIntentModals: readonly string[];
}

export interface PageContext {
  readonly candidates: readonly CandidateNode[];
  readonly meta: DocumentMeta;
  readonly funnelStage: FunnelStage;
  readonly signals: PageSignals;
  /** Milliseconds since the context was created. Detectors must not read the clock. */
  readonly now: number;
  /** Viewport, for viewportFraction arithmetic. */
  readonly viewport: { w: number; h: number };
}

export interface Detector {
  readonly id: string;
  readonly patternId: DetectionCandidate["patternId"];
  /** Stages this detector runs on. Stage-gating cuts typical per-page work by half. */
  readonly stages: readonly FunnelStage[];
  /** Pure. Given the same context, always the same output. */
  run(ctx: PageContext): DetectionCandidate[];
}
