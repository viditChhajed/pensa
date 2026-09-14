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
import { putEvents, readOffer, readSettings } from "./db";
import { buildDigest, type RankInput, shouldShowDigest } from "./digest";
import { detectDrip, detectSneak, dripCandidate } from "./dripPricing";
import { loadLedger, noteDigest, noteEvents, saveLedger } from "./sessionLedger";
import { enqueue } from "./telemetry";
import { temporalCandidates } from "./temporal";

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
  /**
   * The text that actually matched, shown on the card.
   *
   * "One choice was made for you in advance. Is it the one you want?" is unanswerable
   * without saying WHICH choice. A prompt the reader cannot connect to anything on the page
   * is not a Socratic question, it is a riddle — and the whole design principle here is
   * observe and question, which requires naming the observation.
   *
   * Local only. It came from the page the reader is looking at, and it is stripped from
   * every telemetry shape (see TelemetryRecord in schema.ts).
   */
  evidence?: string;
  /**
   * Why the pattern works, and the source for that claim.
   *
   * The product's stated principle is observe and question, never accuse. A question with
   * nothing behind it is just an insinuation — the reader has no way to check whether the
   * effect is real or whether the tool is editorialising. Every taxonomy entry already
   * carries a one-line mechanism and a full citation to the literature; they were simply
   * never surfaced anywhere a reader could see them.
   *
   * Sent from the worker rather than looked up page-side: the taxonomy is ~18KB and is not
   * in the content bundle, and a few hundred bytes per shown item is much cheaper than
   * shipping the whole table into every page.
   */
  mechanism?: string;
  citation?: string;
}

export interface PlacementCapacity {
  maxCardItems: number;
  pillFits: boolean;
}

export interface DigestDecision {
  items: DigestItem[];
  mode: "card" | "pill" | "suppressed";
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
  capacity?: PlacementCapacity,
): Promise<DigestDecision> {
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

  // §18A temporal claims. These are the highest-severity entries in the taxonomy and the
  // only ones no single-page tool can make: a countdown whose deadline moves forward on
  // every visit, a stock counter that rises, a "was" price never actually charged.
  //
  // They were held back as "v1.1 during store review" alongside Tier 2. The engine, its
  // store and its tests all shipped from day one and the observation history has been
  // accumulating since the first visit — so the claims were sitting one import away from
  // working, on data the extension had already collected. Nothing about them needed more
  // time; they needed connecting.
  //
  // By construction they produce nothing on a first sighting (MIN_SIGHTINGS), so the cost of
  // being wrong is bounded: a shopper who visits an offer once will never see one.
  if (offerKey) {
    try {
      const observation = await readOffer(origin, offerKey);
      if (observation) {
        for (const c of temporalCandidates(observation)) {
          // A temporal claim has no on-screen node — it is a statement about history, not
          // about this render — so it cannot have dwell. Credited like the cross-stage
          // findings above, which are in the same position.
          pool.push({ candidate: c, visibleMs: 2000, passedGate: true });
        }
      }
    } catch (err) {
      // A broken history must never take down the whole digest.
      console.error("[vero] temporal claims failed", err);
    }
  }

  const result = buildDigest(pool, {
    surfaceThreshold: 0.75,
    disabledDetectors: new Set(settings.disabledDetectors),
  });

  const freq = await loadFrequencyState();
  const gate = shouldShowDigest(settings.digestFrequency, origin, stage, {
    shownThisSession: freq.shown,
    originsShown: freq.origins,
  });

  // How much the page can actually display, measured page-side before ranking. Absent
  // capacity means an older content script; assume a full card rather than suppressing.
  const cap: PlacementCapacity = capacity ?? { maxCardItems: 4, pillFits: true };
  const displayable = result.items.slice(0, Math.max(0, cap.maxCardItems));
  const mode: DigestDecision["mode"] =
    displayable.length > 0
      ? "card"
      : cap.pillFits && result.items.length > 0
        ? "pill"
        : "suppressed";

  // A pill shows a count, not prompts, so nothing is individually surfaced in that mode.
  const shownIds = new Set(mode === "card" ? displayable.map((i) => i.patternId) : []);

  const now = Date.now();
  const events: DetectionEvent[] = [];

  for (const decision of result.decisions) {
    const source = pool.find((p) => p.candidate.patternId === decision.patternId);
    if (!source) continue;
    // A pattern the user switched off is not recorded at all, not merely withheld from the
    // card. The settings page promises exactly that, and a local database quietly
    // accumulating rows for something someone asked us to stop watching for would make that
    // promise false — in a product whose whole claim is that it does not do things behind
    // your back.
    if (!decision.surfaced && decision.reason === "user_disabled") continue;
    // `surfaced` must mean "the user saw this", not "we intended to show it". Previously it
    // was set before the card attempted placement, so a suppressed digest still recorded
    // surfaced:true and the popup's Noticed/Shown split was wrong.
    const rankedIn = decision.surfaced && gate.show;
    const surfaced = rankedIn && shownIds.has(decision.patternId);
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
      suppressionReason: surfaced
        ? "none"
        : rankedIn
          ? "placement_suppressed"
          : decision.surfaced
            ? gate.reason
            : decision.reason,
      funnelStage: stage,
      evidence: source.candidate.evidence,
      rulepackVersion: ALLOWLIST_VERSION,
      detectorVersion: DETECTOR_VERSION,
      ts: now,
    });
  }

  ledger = noteEvents(ledger, events);
  await putEvents(events);

  /**
   * Queue anonymous counts, if and only if consent is on. `enqueue` is a no-op otherwise —
   * not queue-then-discard, because a queue that fills while consent is off is a queue that
   * leaks the moment someone turns it on, and switching it on consents to future sharing,
   * not to everything that happened before.
   *
   * Sending is on a clock elsewhere, deliberately: a request timed to a detection reveals
   * when this person was shopping even though the payload cannot say where.
   */
  try {
    await enqueue(events, settings);
  } catch (err) {
    // Prevalence counting must never be able to break a digest.
    console.error("[vero] telemetry enqueue failed", err);
  }

  if (!gate.show || result.items.length === 0 || mode === "suppressed") {
    await saveLedger(ledger);
    return { items: [], mode: "suppressed" };
  }

  const used = await usedPrompts();
  const items: DigestItem[] = [];
  for (const ranked of mode === "card" ? displayable : result.items.slice(0, 1)) {
    const prompt = pickPrompt(ranked.patternId as PatternId, used);
    if (!prompt) continue;
    used.add(prompt);
    // The matched text, trimmed to something a card can hold. A checkbox has no text of its
    // own, so fall back to its accessible name via the lexemes that matched it.
    const src = pool.find((p) => p.candidate.patternId === ranked.patternId);
    const sample = (src?.candidate.evidence.textSample ?? "").replace(/\s+/g, " ").trim();
    const lexemes = src?.candidate.evidence.matchedLexemes ?? [];
    const evidence =
      sample.length > 0
        ? sample.slice(0, 120)
        : lexemes.length > 0
          ? lexemes.slice(0, 3).join(", ").slice(0, 120)
          : undefined;

    const entry = TAXONOMY[ranked.patternId as PatternId];
    items.push({
      patternId: ranked.patternId,
      prompt,
      label: entry.label,
      mechanism: entry.mechanism,
      citation: entry.citation,
      ...(evidence ? { evidence } : {}),
    });
  }

  if (items.length === 0) {
    await saveLedger(ledger);
    return { items: [], mode: "suppressed" };
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

  return { items, mode };
}

export type { SessionLedger };
