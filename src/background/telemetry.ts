/**
 * Anonymous prevalence telemetry (plan §11, §16, §18G).
 *
 * The product is two things at once: a tool for one shopper, and an instrument for measuring
 * how common these techniques actually are. The second half only exists if counts leave the
 * device, and until now nothing did — the record SHAPE was built and nothing transmitted.
 *
 * What leaves, and nothing else (`TelemetryRecord` is `.strict()`, so an unknown key throws
 * rather than passing through — that is a privacy control, not a style rule):
 *
 *     pattern id, detector id, a confidence QUARTILE, funnel stage,
 *     the allowlist CATEGORY of the site, rulepack version, the epoch HOUR
 *
 * Absent by construction: the origin, the path, the session id, any page text, any price,
 * any precise timestamp, anything user-identifying. A record says "someone saw a countdown
 * on a travel site in hour 486,123" and cannot say who, where, or on what.
 *
 * Three rules this module exists to enforce:
 *
 *   Nothing is even RECORDED without consent. Not queued-then-discarded — a queue that fills
 *   up while consent is off is a queue that leaks the moment someone turns it on, and the
 *   person switching it on is consenting to future sharing, not retroactive.
 *
 *   Nothing is sent for a site not on the allowlist. The category tag is what makes a record
 *   anonymous; an unrecognised site has no category, and sending `other` for it would make
 *   the rarest sites the most identifiable.
 *
 *   Nothing is sent below the k-anonymity floor (§18G). A cohort is (pattern, stage,
 *   category, hour), and a single report from a cohort of one is a fingerprint no matter how
 *   few fields it carries. Batches wait until they are worth sending.
 */
import { getDb } from "@/background/db";
import { TELEMETRY_ENDPOINT } from "@/shared/constants";
import type { DetectionEvent, Settings } from "@/shared/schema";
import { TelemetryRecord } from "@/shared/schema";
import { ALLOWLIST_VERSION, categoryForOrigin } from "@/shared/urlScore";

/** Hold a batch until it is this big, so no record is the only one of its kind in flight. */
export const MIN_BATCH = 25;
/** …but not forever. A slow week should still report. */
export const MAX_BATCH_AGE_MS = 24 * 60 * 60 * 1000;
/** Never grow without bound if the endpoint is down or unset. */
export const QUEUE_CAP = 5000;
/** §18G: a cohort smaller than this is a fingerprint. Enforced here AND server-side. */
export const K_FLOOR = 20;

export interface QueuedRecord {
  /** Autoincrement. Dexie needs a key; it never leaves the device. */
  id?: number;
  queuedAt: number;
  record: TelemetryRecord;
}

/**
 * Parse rows on the way out of IndexedDB — never cast them.
 *
 * The codebase rule is that nothing persisted is trusted on read-back, and it earns its keep
 * hardest here: a row written by an older version, or hand-edited, must not reach a network
 * request just because it was in the right table. Anything that fails to parse is dropped,
 * and the id comes back with it so the caller can delete it.
 */
function parseQueued(rows: { id?: number; queuedAt: number; record: unknown }[]): {
  valid: QueuedRecord[];
  corruptIds: number[];
} {
  const valid: QueuedRecord[] = [];
  const corruptIds: number[] = [];
  for (const row of rows) {
    const parsed = TelemetryRecord.safeParse(row.record);
    if (parsed.success) valid.push({ id: row.id, queuedAt: row.queuedAt, record: parsed.data });
    else if (row.id !== undefined) corruptIds.push(row.id);
  }
  return { valid, corruptIds };
}

function hourBucket(ts: number): number {
  return Math.floor(ts / 3_600_000);
}

function quartileOf(confidence: number): 1 | 2 | 3 | 4 {
  if (confidence < 0.25) return 1;
  if (confidence < 0.5) return 2;
  if (confidence < 0.75) return 3;
  return 4;
}

/** The cohort a record belongs to for the k-anonymity floor. Never transmitted as a key. */
export function cohortOf(r: TelemetryRecord): string {
  return `${r.patternId}|${r.funnelStage}|${r.originCategory}|${r.hourBucket}`;
}

/**
 * Turn a detection into a transmittable record, or refuse.
 *
 * Returns null rather than a partial record for anything that cannot be anonymised — an
 * unrecognised origin most often. A caller that wants to send something anyway has to add a
 * field here deliberately, in a function whose whole subject is what may not be sent.
 */
export function toRecord(event: DetectionEvent): TelemetryRecord | null {
  const originCategory = categoryForOrigin(event.origin);
  if (!originCategory) return null;

  const candidate = {
    patternId: event.patternId,
    detectorId: event.detectorId,
    confidenceQuartile: quartileOf(event.confidence),
    funnelStage: event.funnelStage,
    originCategory,
    rulepackVersion: ALLOWLIST_VERSION,
    hourBucket: hourBucket(event.ts),
  };

  // Parsed, not cast. `.strict()` is the control that keeps an accidentally-added field from
  // reaching the wire, and it only fires if something actually parses.
  const parsed = TelemetryRecord.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Queue what may be queued. Silent no-op without consent, by design.
 *
 * `surfaced` is deliberately NOT a field: whether a card was displayed depends on this
 * person's frequency setting and on where their cursor happened to be, which is behaviour
 * rather than prevalence, and prevalence is the only thing this is measuring.
 */
export async function enqueue(events: DetectionEvent[], settings: Settings): Promise<number> {
  if (!settings.telemetryConsent) return 0;

  const rows: QueuedRecord[] = [];
  const now = Date.now();
  for (const event of events) {
    if (settings.disabledDetectors.includes(event.patternId)) continue;
    const record = toRecord(event);
    if (record) rows.push({ queuedAt: now, record });
  }
  if (rows.length === 0) return 0;

  const db = getDb();
  await db.telemetry.bulkAdd(rows);

  // Oldest first if capped. A full queue means the endpoint has been unreachable for a long
  // time, and in that case the newest counts are the ones still worth having.
  const total = await db.telemetry.count();
  if (total > QUEUE_CAP) {
    const excess = await db.telemetry
      .orderBy("queuedAt")
      .limit(total - QUEUE_CAP)
      .primaryKeys();
    await db.telemetry.bulkDelete(excess);
  }
  return rows.length;
}

export interface FlushResult {
  sent: number;
  held: number;
  reason: "sent" | "no_consent" | "no_endpoint" | "too_small" | "below_k" | "failed";
}

/**
 * Send what is ready. Called on a schedule, never on a page event — a request timed to a
 * detection tells an observer when you were shopping even if it says nothing about where.
 */
export async function flush(
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
): Promise<FlushResult> {
  const db = getDb();

  if (!settings.telemetryConsent) {
    // Consent withdrawn: the queue goes too. Keeping it would mean a later re-enable sends
    // data gathered during a period the person had said no to.
    await db.telemetry.clear();
    return { sent: 0, held: 0, reason: "no_consent" };
  }

  const { valid: queued, corruptIds } = parseQueued(
    await db.telemetry.orderBy("queuedAt").toArray(),
  );
  if (corruptIds.length > 0) {
    console.warn(`[patterns] dropped ${corruptIds.length} unparseable telemetry row(s)`);
    await db.telemetry.bulkDelete(corruptIds);
  }
  if (queued.length === 0) return { sent: 0, held: 0, reason: "too_small" };

  if (TELEMETRY_ENDPOINT.length === 0) {
    return { sent: 0, held: queued.length, reason: "no_endpoint" };
  }

  const oldest = queued[0]?.queuedAt ?? Date.now();
  const stale = Date.now() - oldest > MAX_BATCH_AGE_MS;
  if (queued.length < MIN_BATCH && !stale) {
    return { sent: 0, held: queued.length, reason: "too_small" };
  }

  /**
   * The k-anonymity floor, applied before anything leaves rather than trusted to the server.
   *
   * A cohort of one is a fingerprint however few fields it carries: one report of
   * `decoy.asymmetric_dominance` on `airline` in hour N, from a population of one, is that
   * person's afternoon. Records below the floor stay queued — later visits usually lift them
   * over it, and if they never do, the cap eventually drops them unsent, which is correct.
   */
  const byCohort = new Map<string, QueuedRecord[]>();
  for (const row of queued) {
    const key = cohortOf(row.record);
    const list = byCohort.get(key) ?? [];
    list.push(row);
    byCohort.set(key, list);
  }

  const ready: QueuedRecord[] = [];
  let held = 0;
  for (const rows of byCohort.values()) {
    if (rows.length >= K_FLOOR) ready.push(...rows);
    else held += rows.length;
  }

  if (ready.length === 0) return { sent: 0, held, reason: "below_k" };

  try {
    const res = await fetchImpl(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No credentials, no cookies, no custom headers. A header is a field, and the point of
      // this payload is that it has no fields beyond the seven listed at the top.
      credentials: "omit",
      body: JSON.stringify({ v: 1, records: ready.map((r) => r.record) }),
    });
    if (!res.ok) return { sent: 0, held: queued.length, reason: "failed" };
  } catch {
    // Offline, blocked, or the endpoint is gone. Keep the queue; try again later.
    return { sent: 0, held: queued.length, reason: "failed" };
  }

  await db.telemetry.bulkDelete(
    ready.map((r) => r.id).filter((id): id is number => id !== undefined),
  );
  return { sent: ready.length, held, reason: "sent" };
}

/**
 * Exactly what would be sent right now, for the settings page.
 *
 * Asking someone to consent to "anonymous statistics" without showing them the rows is
 * asking them to trust a sentence. This product's entire argument is that a claim you cannot
 * check is worth less than one you can.
 */
/** Drop everything queued. Called the moment consent is withdrawn, and by clear-all-data. */
export async function discardQueue(): Promise<void> {
  await getDb().telemetry.clear();
}

export async function pendingRecords(limit = 200): Promise<TelemetryRecord[]> {
  const rows = await getDb().telemetry.orderBy("queuedAt").reverse().limit(limit).toArray();
  return parseQueued(rows).valid.map((r) => r.record);
}
