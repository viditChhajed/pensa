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
 * Empty is the shipped default until an endpoint is actually deployed. `flush()` treats it
 * as "hold everything", so switching consent on against an unset endpoint accumulates
 * locally and sends nothing, rather than failing quietly against a dead URL.
 */
export const TELEMETRY_ENDPOINT = "";
