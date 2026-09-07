/**
 * Session identity and the digest decision path (plan T26/T32 support).
 *
 * The session id rotates daily and never leaves the device. It exists so a day's browsing
 * can be grouped in the popup summary, not so anyone can be recognised — which is why it is
 * derived from the date rather than persisted forever, and why it is excluded from the
 * telemetry record shape entirely.
 */

import { DETECTOR_VERSION } from "@/shared/constants";
import { pickPrompt } from "@/shared/copy/prompts";
import type {
  DetectionCandidate,
  DetectionEvent,
  FunnelStage,
  Salience,
  SessionLedger,
} from "@/shared/schema";
import { type PatternId, TAXONOMY } from "@/shared/taxonomy";
import { ALLOWLIST_VERSION } from "@/shared/urlScore";
import { putEvents, readSettings } from "./db";
import { buildDigest, type RankInput, shouldShowDigest } from "./digest";
import { detectDrip, detectSneak, dripCandidate } from "./dripPricing";
import { loadLedger, noteDigest, noteEvents, saveLedger } from "./sessionLedger";

const SESSION_KEY = "session";

interface StoredSession {
  sessionId: string;
  day: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Rotates daily. Local only, never transmitted. */
export async function currentSessionId(): Promise<string> {
  const raw = await chrome.storage.local.get(SESSION_KEY);
  const stored = raw[SESSION_KEY] as StoredSession | undefined;
  const day = today();
  if (stored && stored.day === day) return stored.sessionId;

  const sessionId = crypto.randomUUID();
  await chrome.storage.local.set({ [SESSION_KEY]: { sessionId, day } satisfies StoredSession });
  return sessionId;
}

// Frequency state is per-worker-lifetime; storage.session backs it across worker restarts.
const FREQ_KEY = "digest-frequency-state";

async function loadFrequencyState(): Promise<{ shown: Set<string>; origins: Set<string> }> {
  const raw = await chrome.storage.session.get(FREQ_KEY);
  const v = raw[FREQ_KEY] as { shown?: string[]; origins?: string[] } | undefined;
  return { shown: new Set(v?.shown ?? []), origins: new Set(v?.origins ?? []) };
}

async function saveFrequencyState(s: { shown: Set<string>; origins: Set<string> }): Promise<void> {
  await chrome.storage.session.set({
    [FREQ_KEY]: { shown: [...s.shown], origins: [...s.origins] },
  });
}

export interface DigestItem {
  patternId: string;
  prompt: string;
  label: string;
}

const PROMPTS_SHOWN_KEY = "prompts-shown";

async function usedPrompts(): Promise<Set<string>> {
  const raw = await chrome.storage.session.get(PROMPTS_SHOWN_KEY);
  return new Set((raw[PROMPTS_SHOWN_KEY] as string[]) ?? []);
}

async function recordPrompts(used: Set<string>): Promise<void> {
  await chrome.storage.session.set({ [PROMPTS_SHOWN_KEY]: [...used].slice(-120) });
}

export interface CandidateInput {
  candidate: DetectionCandidate;
  salience: Salience;
  passedGate: boolean;
}

/**
 * Turn page candidates plus the cross-stage ledger findings into a digest, persist every
 * decision, and return what the content script should render.
 *
 * Every candidate is written to the event log whether or not it is shown. The detected /
 * surfaced gap is the prevalence measurement, so discarding the suppressed ones would throw
 * away the more interesting half of the data.
 */
export async function decideDigest(
  origin: string,
  pathTemplate: string,
  stage: FunnelStage,
  inputs: CandidateInput[],
  offerKey?: string,
): Promise<DigestItem[]> {
  const sessionId = await currentSessionId();
  const settings = await readSettings();
  let ledger = await loadLedger(sessionId, origin);

  // Cross-stage findings are added to the same ranking pool as page candidates.
  const pool: RankInput[] = inputs.map((i) => ({
    candidate: i.candidate,
    visibleMs: i.salience.visibleMs,
    passedGate: i.passedGate,
  }));

  const dripFinding = detectDrip(ledger);
  if (dripFinding) {
    const c = dripCandidate(ledger, dripFinding);
    // A cross-stage finding has no on-screen node, so it cannot have dwell. It is credited
    // with the gate and a nominal dwell — the shopper is looking at the total right now.
    if (c) pool.push({ candidate: c, visibleMs: 2000, passedGate: true });
  }

  const sneak = detectSneak(ledger);
  if (sneak) pool.push({ candidate: sneak, visibleMs: 2000, passedGate: true });

  // §18A temporal claims are NOT shipped in v1 (plan §13 scopes them to v1.1). The engine
  // and its store are built and tested; `background/temporal.ts` is deliberately not
  // imported here, so it cannot reach the bundle. Observations still accumulate, so the
  // history is already there when the claims are switched on.
  void offerKey;

  const result = buildDigest(pool, {
    surfaceThreshold: 0.75,
    disabledDetectors: new Set(settings.disabledDetectors),
  });

  const freq = await loadFrequencyState();
  const gate = shouldShowDigest(settings.digestFrequency, origin, stage, {
    shownThisSession: freq.shown,
    originsShown: freq.origins,
  });

  const now = Date.now();
  const events: DetectionEvent[] = [];

  for (const decision of result.decisions) {
    const source = pool.find((p) => p.candidate.patternId === decision.patternId);
    if (!source) continue;
    const surfaced = decision.surfaced && gate.show;
    events.push({
      id: crypto.randomUUID(),
      sessionId,
      origin,
      pathTemplate,
      detectorId: source.candidate.detectorId,
      patternId: source.candidate.patternId,
      confidence: source.candidate.rawScore,
      confidenceBasis: "hand_set",
      salience: {
        visibleMs: source.visibleMs,
        viewportFraction: 0,
        scrollDepthAtFirstView: 0,
        ephemeral: false,
      },
      surfaced,
      suppressionReason: surfaced ? "none" : decision.surfaced ? gate.reason : decision.reason,
      funnelStage: stage,
      evidence: source.candidate.evidence,
      rulepackVersion: ALLOWLIST_VERSION,
      detectorVersion: DETECTOR_VERSION,
      ts: now,
    });
  }

  ledger = noteEvents(ledger, events);
  await putEvents(events);

  if (!gate.show || result.items.length === 0) {
    await saveLedger(ledger);
    return [];
  }

  const used = await usedPrompts();
  const items: DigestItem[] = [];
  for (const ranked of result.items) {
    const prompt = pickPrompt(ranked.patternId as PatternId, used);
    if (!prompt) continue;
    used.add(prompt);
    items.push({
      patternId: ranked.patternId,
      prompt,
      label: TAXONOMY[ranked.patternId as PatternId].label,
    });
  }

  if (items.length === 0) {
    await saveLedger(ledger);
    return [];
  }

  freq.shown.add(`${origin}:${stage}`);
  freq.origins.add(origin);
  await saveFrequencyState(freq);
  await recordPrompts(used);

  ledger = noteDigest(
    ledger,
    stage,
    items.map((i) => i.patternId),
    now,
  );
  await saveLedger(ledger);

  return items;
}

export type { SessionLedger };
