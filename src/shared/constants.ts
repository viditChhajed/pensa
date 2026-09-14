/** Shared identifiers that must agree across the service worker and the build output. */

/** Output filename of the detector bundle (built via defineUnlistedScript, never in the manifest). */
export const CONTENT_SCRIPT_FILE = "detector.js";

/** Stable id for the runtime content-script registration. */
export const DETECTOR_SCRIPT_ID = "patterns-detector";

/** Bumped whenever detector logic changes in a way that affects scores. */
export const DETECTOR_VERSION = "0.1.0";

/** Guards against double injection when a page is re-registered mid-session. */
export const INJECTION_FLAG = "__patternsDetectorInjected__";

/** Salience gates (plan §5). */
export const SALIENCE_STATIC_MS = 800;
export const SALIENCE_EPHEMERAL_MS = 400;
export const SALIENCE_MIN_RATIO = 0.5;

/** Scheduler budget (plan §18C). */
export const IDLE_SLICE_MS = 8;

/** Injected at build time by wxt.config.ts. Lets a loaded extension identify itself. */
declare const __BUILD_STAMP__: string;
export const BUILD_STAMP: string =
  typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : "unknown";

/**
 * Where anonymous prevalence counts are POSTed. Empty means nowhere.
 *
 * It lives here, in the one module with no imports of its own, so the egress tests can read
 * the single source of truth without pulling in the allowlist JSON behind `urlScore` — and
 * so that "which addresses may this extension contact" is answerable by reading one line
 * rather than by tracing a call graph.
 *
 * Injected at build time from `TELEMETRY_ENDPOINT` (see wxt.config.ts), and EMPTY unless the
 * build sets it. `flush()` treats empty as "hold everything", so consent switched on against
 * an unset endpoint accumulates locally and sends nothing, rather than failing quietly
 * against a dead URL.
 */
declare const __TELEMETRY_ENDPOINT__: string;
export const TELEMETRY_ENDPOINT: string =
  typeof __TELEMETRY_ENDPOINT__ === "string" ? __TELEMETRY_ENDPOINT__ : "";

/**
 * Telemetry batching and anonymity limits.
 *
 * Here rather than in `background/telemetry.ts` for the same reason as the endpoint: this is
 * the one module with no imports, so a test — or a reviewer — can read the numbers that
 * govern what leaves the device without pulling in the allowlist JSON behind `urlScore`.
 * A limit nobody can cite is a limit nobody can check.
 */

/** Hold a batch until it is this big, so no record is the only one of its kind in flight. */
export const MIN_BATCH = 25;
/** …but not forever. A slow week should still report. */
export const MAX_BATCH_AGE_MS = 24 * 60 * 60 * 1000;
/** Never grow without bound if the endpoint is down or unset. */
export const QUEUE_CAP = 5000;
/**
 * §18G: a cohort smaller than this is a fingerprint, not a statistic.
 *
 * One report of `decoy.asymmetric_dominance` on `airline` in hour N, from a population of
 * one, is that person's afternoon — however few fields the record carries.
 */
export const K_FLOOR = 20;
