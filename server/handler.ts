/**
 * The telemetry sink (plan §11, §18G). Per-site prevalence (v2), plus page-view outcomes (v3).
 *
 * Written as `(Request) => Response` so it drops into Vercel Edge, Cloudflare Workers or
 * Deno Deploy unchanged, and is three lines from a Node server.
 *
 * The whole file is a re-implementation of limits the client already applies, and that
 * duplication is the point: a server that trusts its client is not enforcing anything.
 * Anyone can POST to a public URL, so every guarantee PRIVACY.md makes has to hold against a
 * modified extension, a curl command, or a bored person with the endpoint in their console.
 */

/** Mirrors TelemetryRecord in src/shared/schema.ts. Kept literal — see the note below. */
const FUNNEL_STAGES = new Set(["browse", "pdp", "cart", "checkout", "payment"]);
const CATEGORIES = new Set([
  "marketplace", "ota_travel", "airline", "ticketing", "fast_fashion", "subscription_box",
  "dtc", "food_delivery", "big_box", "electronics", "other",
]);

/**
 * The eight permitted keys, and nothing else.
 *
 * Deliberately NOT imported from the extension's schema. This runs on a different machine
 * with a different deploy cadence, and the failure that matters is the extension gaining a
 * field and the server accepting it because they share a definition. Two independent lists
 * that must agree will diverge loudly; one shared list diverges silently.
 *
 * v2 added `site` and replaced `hourBucket` with `dayBucket`. The version is checked on the
 * body, so a v1 client — which sends hour resolution and no site — is refused outright
 * rather than half-accepted into a table whose columns now mean something else.
 */
const ALLOWED_KEYS = [
  "patternId",
  "detectorId",
  "confidenceQuartile",
  "funnelStage",
  "site",
  "originCategory",
  "rulepackVersion",
  "dayBucket",
] as const;

/**
 * A bare registrable domain: labels of letters, digits and hyphens, at least one dot, no
 * scheme, no port, no path, no userinfo. Anything else is either a bug or an attempt to put
 * a URL — and whatever a URL carries — into a column meant to hold only a shop's name.
 */
const SITE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

export interface CountRow {
  patternId: string;
  detectorId: string;
  funnelStage: string;
  site: string;
  originCategory: string;
  rulepackVersion: string;
  dayBucket: number;
  quartile: number;
}

/**
 * The seven permitted keys of a page-view outcome (v3), and nothing else. Mirrors
 * OutcomeRecord in src/shared/schema.ts, independently, for the reason given above.
 */
const OUTCOME_KEYS = [
  "patternId",
  "funnelStage",
  "site",
  "originCategory",
  "rulepackVersion",
  "dayBucket",
  "addedToCart",
] as const;
const OUTCOME_STAGES = new Set(["browse", "pdp"]);
/** Pattern ids are `family.name`; `_page` is the per-view baseline. */
const OUTCOME_PATTERN = /^(_page|[a-z_]{1,32}\.[a-z_]{1,32})$/;

export interface OutcomeRow {
  patternId: string;
  funnelStage: string;
  site: string;
  originCategory: string;
  rulepackVersion: string;
  dayBucket: number;
  addedToCart: boolean;
}

/** Where aggregates go. Injected so the handler stays host- and database-agnostic. */
export interface Store {
  /** Add `n` to each row's counter and increment its reporter count by one. */
  increment(rows: CountRow[]): Promise<void>;
  /** Same, for page-view outcomes. */
  incrementOutcomes(rows: OutcomeRow[]): Promise<void>;
}

const MAX_RECORDS_PER_BATCH = 500;
/** A day bucket outside this window is a clock that is wrong or a body that is invented. */
const MAX_DAY_SKEW = 90;

function isValid(record: unknown): record is CountRow & { confidenceQuartile: number } {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Record<string, unknown>;

  // Exact key set. An extra field is not ignored, it is a rejection: the extension's record
  // type is `.strict()` precisely so an accidental addition throws rather than travelling,
  // and that control is worth nothing if the receiving end shrugs at it.
  const keys = Object.keys(r).sort();
  if (keys.length !== ALLOWED_KEYS.length) return false;
  for (const k of ALLOWED_KEYS) if (!(k in r)) return false;

  if (typeof r.patternId !== "string" || r.patternId.length > 64) return false;
  if (typeof r.detectorId !== "string" || r.detectorId.length > 64) return false;
  if (typeof r.rulepackVersion !== "string" || r.rulepackVersion.length > 32) return false;
  if (typeof r.funnelStage !== "string" || !FUNNEL_STAGES.has(r.funnelStage)) return false;
  if (typeof r.originCategory !== "string" || !CATEGORIES.has(r.originCategory)) return false;
  if (typeof r.site !== "string" || r.site.length > 253 || !SITE.test(r.site)) return false;
  if (r.confidenceQuartile !== 1 && r.confidenceQuartile !== 2 && r.confidenceQuartile !== 3 && r.confidenceQuartile !== 4) {
    return false;
  }
  if (typeof r.dayBucket !== "number" || !Number.isInteger(r.dayBucket)) return false;

  const today = Math.floor(Date.now() / 86_400_000);
  if (Math.abs(today - r.dayBucket) > MAX_DAY_SKEW) return false;

  return true;
}

function isValidOutcome(record: unknown): record is OutcomeRow {
  if (typeof record !== "object" || record === null) return false;
  const r = record as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== OUTCOME_KEYS.length) return false;
  for (const k of OUTCOME_KEYS) if (!(k in r)) return false;

  if (typeof r.patternId !== "string" || !OUTCOME_PATTERN.test(r.patternId)) return false;
  if (typeof r.funnelStage !== "string" || !OUTCOME_STAGES.has(r.funnelStage)) return false;
  if (typeof r.site !== "string" || r.site.length > 253 || !SITE.test(r.site)) return false;
  if (typeof r.originCategory !== "string" || !CATEGORIES.has(r.originCategory)) return false;
  if (typeof r.rulepackVersion !== "string" || r.rulepackVersion.length > 32) return false;
  if (typeof r.addedToCart !== "boolean") return false;
  if (typeof r.dayBucket !== "number" || !Number.isInteger(r.dayBucket)) return false;
  const today = Math.floor(Date.now() / 86_400_000);
  if (Math.abs(today - r.dayBucket) > MAX_DAY_SKEW) return false;
  return true;
}

export async function handle(req: Request, store: Store): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });

  /**
   * The single most important line in this file: the IP is never read, never logged, never
   * stored, and never used as a key.
   *
   * An IP beside a site name and a day re-identifies a person, and it would
   * arrive by default in most hosting platforms' access logs. Turning those off is a DEPLOY
   * step this file cannot perform, and it is in server/README.md because a comment here
   * cannot enforce it either. Nothing in this handler reads `req.headers` for anything but
   * the content type.
   */
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return new Response(null, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  if (typeof body !== "object" || body === null) return new Response(null, { status: 400 });
  // v2: prevalence counts only. v3: counts plus page-view outcomes in a separate array, which
  // may be empty on either side but not both. The limit is on the two together.
  const { v, records, outcomes = [] } = body as {
    v?: unknown;
    records?: unknown;
    outcomes?: unknown;
  };
  if (v !== 2 && v !== 3) return new Response(null, { status: 400 });
  if (!Array.isArray(records) || !Array.isArray(outcomes)) {
    return new Response(null, { status: 400 });
  }
  if (v === 2 && outcomes.length > 0) return new Response(null, { status: 400 });
  const total = records.length + outcomes.length;
  if (total === 0 || total > MAX_RECORDS_PER_BATCH) {
    return new Response(null, { status: 400 });
  }

  // All or nothing. A batch containing one malformed record is a batch from something that
  // is not the shipped extension, and accepting the rest of it is accepting data from an
  // unknown sender.
  const rows: CountRow[] = [];
  for (const record of records) {
    if (!isValid(record)) return new Response(null, { status: 422 });
    rows.push({
      patternId: record.patternId,
      detectorId: record.detectorId,
      funnelStage: record.funnelStage,
      site: record.site,
      originCategory: record.originCategory,
      rulepackVersion: record.rulepackVersion,
      dayBucket: record.dayBucket,
      quartile: record.confidenceQuartile,
    });
  }

  const outcomeRows: OutcomeRow[] = [];
  for (const o of outcomes) {
    if (!isValidOutcome(o)) return new Response(null, { status: 422 });
    outcomeRows.push({
      patternId: o.patternId,
      funnelStage: o.funnelStage,
      site: o.site,
      originCategory: o.originCategory,
      rulepackVersion: o.rulepackVersion,
      dayBucket: o.dayBucket,
      addedToCart: o.addedToCart,
    });
  }

  if (rows.length > 0) await store.increment(rows);
  if (outcomeRows.length > 0) await store.incrementOutcomes(outcomeRows);

  // No body. Anything returned is a channel back to the client, and there is nothing the
  // client needs to know — not even how many rows were accepted, which would let a caller
  // probe the store one record at a time.
  return new Response(null, { status: 204 });
}
