/**
 * The telemetry sink (plan §11, §18G). NOT DEPLOYED — see server/README.md.
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
 * The seven permitted keys, and nothing else.
 *
 * Deliberately NOT imported from the extension's schema. This runs on a different machine
 * with a different deploy cadence, and the failure that matters is the extension gaining a
 * field and the server accepting it because they share a definition. Two independent lists
 * that must agree will diverge loudly; one shared list diverges silently.
 */
const ALLOWED_KEYS = [
  "patternId",
  "detectorId",
  "confidenceQuartile",
  "funnelStage",
  "originCategory",
  "rulepackVersion",
  "hourBucket",
] as const;

export interface CountRow {
  patternId: string;
  detectorId: string;
  funnelStage: string;
  originCategory: string;
  rulepackVersion: string;
  hourBucket: number;
  quartile: number;
}

/** Where aggregates go. Injected so the handler stays host- and database-agnostic. */
export interface Store {
  /** Add `n` to each row's counter and increment its reporter count by one. */
  increment(rows: CountRow[]): Promise<void>;
}

const MAX_RECORDS_PER_BATCH = 500;
/** An hour bucket outside this window is a clock that is wrong or a body that is invented. */
const MAX_HOUR_SKEW = 24 * 90;

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
  if (r.confidenceQuartile !== 1 && r.confidenceQuartile !== 2 && r.confidenceQuartile !== 3 && r.confidenceQuartile !== 4) {
    return false;
  }
  if (typeof r.hourBucket !== "number" || !Number.isInteger(r.hourBucket)) return false;

  const nowHour = Math.floor(Date.now() / 3_600_000);
  if (Math.abs(nowHour - r.hourBucket) > MAX_HOUR_SKEW) return false;

  return true;
}

export async function handle(req: Request, store: Store): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });

  /**
   * The single most important line in this file: the IP is never read, never logged, never
   * stored, and never used as a key.
   *
   * An IP plus an hour bucket plus a site category re-identifies a person, and it would
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
  const { v, records } = body as { v?: unknown; records?: unknown };
  if (v !== 1) return new Response(null, { status: 400 });
  if (!Array.isArray(records)) return new Response(null, { status: 400 });
  if (records.length === 0 || records.length > MAX_RECORDS_PER_BATCH) {
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
      originCategory: record.originCategory,
      rulepackVersion: record.rulepackVersion,
      hourBucket: record.hourBucket,
      quartile: record.confidenceQuartile,
    });
  }

  await store.increment(rows);

  // No body. Anything returned is a channel back to the client, and there is nothing the
  // client needs to know — not even how many rows were accepted, which would let a caller
  // probe the store one record at a time.
  return new Response(null, { status: 204 });
}
