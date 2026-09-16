/**
 * Per-site prevalence telemetry (plan §11, §16, §18G), revised.
 *
 * The product is two things at once: a tool for one shopper, and an instrument for measuring
 * how common these techniques are. v1 of this module measured it by CATEGORY only — it could
 * say "countdowns are common on travel sites" and never "this site shows countdowns". The
 * owner decided per-site prevalence is worth collecting, so the record now names the shop.
 *
 * What leaves, and nothing else (`TelemetryRecord` is `.strict()`, so an unknown key throws
 * rather than passing through — that is a privacy control, not a style rule):
 *
 *     pattern id, detector id, a confidence QUARTILE, funnel stage,
 *     the shop's REGISTRABLE DOMAIN, its category, rulepack version, the epoch DAY
 *
 * Absent by construction: the path, the query, the full hostname, the session id, any page
 * text, any price, any precise time, and anything that identifies the person. A record says
 * "someone saw a countdown on shein.com on day 20,712" and cannot say who, on which page, or
 * when within the day.
 *
 * The rules this module enforces:
 *
 *   Nothing is even RECORDED without consent. Not queued-then-discarded — a queue that fills
 *   while consent is off is a queue that leaks the moment someone turns it on, and switching
 *   it on consents to future sharing, not retroactive.
 *
 *   Only shops can be named. A detection only exists on a page that passed the commerce gate,
 *   so a record's `site` is always somewhere that was selling something.
 *
 *   Sent on a clock, in batches, never on a detection — a request timed to a detection says
 *   when someone was shopping even when the payload cannot.
 *
 * What was REMOVED, and why it is not a weakening: v1 held any cohort with fewer than K
 * records in the local queue. That looked like k-anonymity and was not one — k-anonymity is
 * about k distinct PEOPLE sharing a quasi-identifier, and one person repeating a record
 * twenty times is still one person. It could not protect anybody, and at per-site
 * granularity it would have withheld essentially every record, leaving the dataset empty.
 * The floor that means something is the server's: `reporters` counts distinct batches, and
 * the `counts_public` view refuses cohorts below it.
 */
import { getDb } from "@/background/db";
import { MAX_BATCH_AGE_MS, MIN_BATCH, QUEUE_CAP, TELEMETRY_ENDPOINT } from "@/shared/constants";
import { registrableDomain } from "@/shared/domain";
import type { DetectionEvent, Settings } from "@/shared/schema";
import { TelemetryRecord } from "@/shared/schema";
import { ALLOWLIST_VERSION, categoryForOrigin } from "@/shared/urlScore";

export { MAX_BATCH_AGE_MS, MIN_BATCH, QUEUE_CAP, TELEMETRY_ENDPOINT };

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

function dayBucket(ts: number): number {
  return Math.floor(ts / 86_400_000);
}

function quartileOf(confidence: number): 1 | 2 | 3 | 4 {
  if (confidence < 0.25) return 1;
  if (confidence < 0.5) return 2;
  if (confidence < 0.75) return 3;
  return 4;
}

/**
 * Turn a detection into a transmittable record, or refuse.
 *
 * Returns null rather than a partial record for anything that cannot be anonymised — an
 * unrecognised origin most often. A caller that wants to send something anyway has to add a
 * field here deliberately, in a function whose whole subject is what may not be sent.
 */
export function toRecord(event: DetectionEvent): TelemetryRecord | null {
  let host: string;
  try {
    host = new URL(event.origin).hostname;
  } catch {
    return null;
  }
  // https only. The permission Vero holds is https, and a record naming an http origin could
  // only have come from a test build or a hand-written row.
  if (!event.origin.startsWith("https://")) return null;

  const candidate = {
    patternId: event.patternId,
    detectorId: event.detectorId,
    confidenceQuartile: quartileOf(event.confidence),
    funnelStage: event.funnelStage,
    site: registrableDomain(host),
    originCategory: categoryForOrigin(event.origin) ?? "other",
    rulepackVersion: ALLOWLIST_VERSION,
    dayBucket: dayBucket(event.ts),
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
  reason: "sent" | "no_consent" | "no_endpoint" | "too_small" | "failed";
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
    console.warn(`[vero] dropped ${corruptIds.length} unparseable telemetry row(s)`);
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

  const ready = queued;

  try {
    const res = await fetchImpl(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No credentials, no cookies, no custom headers. A header is a field, and the point of
      // this payload is that it has no fields beyond the eight listed at the top.
      credentials: "omit",
      // v2: the record names the site and buckets by day. The server rejects v1 bodies, so
      // an old build cannot keep sending the hour-resolution shape after this ships.
      body: JSON.stringify({ v: 2, records: ready.map((r) => r.record) }),
    });
    if (!res.ok) return { sent: 0, held: queued.length, reason: "failed" };
  } catch {
    // Offline, blocked, or the endpoint is gone. Keep the queue; try again later.
    return { sent: 0, held: queued.length, reason: "failed" };
  }

  await db.telemetry.bulkDelete(
    ready.map((r) => r.id).filter((id): id is number => id !== undefined),
  );
  return { sent: ready.length, held: 0, reason: "sent" };
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
