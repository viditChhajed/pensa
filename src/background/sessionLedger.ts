/**
 * Per-origin, cross-navigation evidence accumulation (plan T23).
 *
 * Everything genuinely interesting about e-commerce persuasion is cross-stage: a fee first
 * disclosed at payment, an item in the cart nobody added. No single page can show either,
 * so the ledger is what turns a page-at-a-time detector set into something that can say
 * "this appeared later than the price did."
 *
 * Lives in the service worker, keyed by origin. Service workers die, so it persists to
 * `chrome.storage.session` — which is cleared when the browser closes, which is the right
 * lifetime for a shopping session.
 */
import {
  type DetectionEvent,
  FUNNEL_ORDER,
  type FunnelStage,
  type PriceSnapshot,
  type SessionLedger,
  type UserInitiatedAdd,
} from "@/shared/schema";

const STORAGE_PREFIX = "ledger:";

/** BigInt survives structured clone but not JSON, and storage.session uses JSON. */
type Jsonish = Record<string, unknown>;

function encodeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") return { __bigint: value.toString() };
  if (Array.isArray(value)) return value.map(encodeBigInts);
  if (value && typeof value === "object") {
    const out: Jsonish = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeBigInts(v);
    return out;
  }
  return value;
}

function decodeBigInts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBigInts);
  if (value && typeof value === "object") {
    const rec = value as Jsonish;
    if (typeof rec.__bigint === "string") return BigInt(rec.__bigint);
    const out: Jsonish = {};
    for (const [k, v] of Object.entries(rec)) out[k] = decodeBigInts(v);
    return out;
  }
  return value;
}

function emptyLedger(sessionId: string, origin: string): SessionLedger {
  return {
    sessionId,
    origin,
    stages: {},
    userInitiatedAdds: [],
    events: [],
    digestsShown: [],
  };
}

export async function loadLedger(sessionId: string, origin: string): Promise<SessionLedger> {
  const key = STORAGE_PREFIX + origin;
  const raw = await chrome.storage.session.get(key);
  const stored = raw[key];
  if (!stored) return emptyLedger(sessionId, origin);

  const decoded = decodeBigInts(stored) as SessionLedger;
  // A ledger from a previous session id is not this session's; start fresh.
  if (decoded.sessionId !== sessionId) return emptyLedger(sessionId, origin);
  return decoded;
}

export async function saveLedger(ledger: SessionLedger): Promise<void> {
  const key = STORAGE_PREFIX + ledger.origin;
  await chrome.storage.session.set({ [key]: encodeBigInts(ledger) });
}

/**
 * Record entry into a funnel stage along with what the prices looked like there.
 *
 * A stage is only recorded ONCE per session — the first sighting. Re-recording on every
 * re-render would overwrite the PDP price with the cart price and erase the very delta the
 * drip detector exists to find.
 */
export function noteStage(
  ledger: SessionLedger,
  stage: FunnelStage,
  snapshot: PriceSnapshot | undefined,
  now = Date.now(),
): SessionLedger {
  const existing = ledger.stages[stage];
  if (existing) {
    // Fill in a snapshot only if the first sighting had none.
    if (!existing.priceSnapshot && snapshot) {
      return {
        ...ledger,
        stages: { ...ledger.stages, [stage]: { ...existing, priceSnapshot: snapshot } },
      };
    }
    return ledger;
  }
  return {
    ...ledger,
    stages: {
      ...ledger.stages,
      [stage]: snapshot ? { enteredAt: now, priceSnapshot: snapshot } : { enteredAt: now },
    },
  };
}

export function noteUserAdd(ledger: SessionLedger, add: UserInitiatedAdd): SessionLedger {
  return { ...ledger, userInitiatedAdds: [...ledger.userInitiatedAdds, add].slice(-50) };
}

export function noteEvents(ledger: SessionLedger, events: DetectionEvent[]): SessionLedger {
  return { ...ledger, events: [...ledger.events, ...events].slice(-500) };
}

export function noteDigest(
  ledger: SessionLedger,
  stage: FunnelStage,
  patternIds: string[],
  now = Date.now(),
): SessionLedger {
  return {
    ...ledger,
    digestsShown: [
      ...ledger.digestsShown,
      {
        stage,
        ts: now,
        patternIds: patternIds as SessionLedger["digestsShown"][number]["patternIds"],
      },
    ],
  };
}

/** Stages seen so far, in funnel order. */
export function orderedStages(ledger: SessionLedger): FunnelStage[] {
  return (Object.keys(ledger.stages) as FunnelStage[]).sort(
    (a, b) => FUNNEL_ORDER[a] - FUNNEL_ORDER[b],
  );
}

/** The earliest stage at which a given fee label was seen. Drives `stageOfFirstDisclosure`. */
export function firstDisclosureStage(ledger: SessionLedger, labelHash: string): FunnelStage | null {
  for (const stage of orderedStages(ledger)) {
    const snap = ledger.stages[stage]?.priceSnapshot;
    if (!snap) continue;
    if (snap.fees.some((f) => f.labelHash === labelHash)) return stage;
  }
  return null;
}

export async function clearLedgers(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(STORAGE_PREFIX));
  if (keys.length > 0) await chrome.storage.session.remove(keys);
}
