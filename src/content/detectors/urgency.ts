/**
 * urgency.countdown
 *
 * A countdown is a node whose text CHANGES over time in a clock shape. A single frozen
 * frame cannot express that, which is why `CandidateNode.textHistory` exists and why
 * countdown fixtures are captured as two snapshots ~3s apart.
 *
 * Detecting a static "12:30" would fire on every store-hours listing and every video
 * duration on the page, so a clock-shaped string alone scores nothing — the decrement is
 * the signal.
 */

import type { DetectionCandidate } from "@/shared/schema";
import type { CandidateNode, Detector, PageContext } from "../types";
import { candidate, matchLexemes, visibleCandidates } from "./util";

const CLOCK_RE = /\b(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\b/;

const LEXEMES = [
  "ends in",
  "ending in",
  "deal ends",
  "sale ends",
  "offer ends",
  "hurry",
  "expires",
  "time left",
  "left to buy",
  "reserved for",
  "held for",
  "expires in",
  "ends today",
] as const;

const WEIGHTS: Record<string, number> = {
  decrementing: 0.55,
  clockShape: 0.2,
  lexeme: 0.25,
  cartHold: 0.15,
};

function clockToSeconds(text: string): number | null {
  const m = CLOCK_RE.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] !== undefined ? Number(m[3]) : null;
  return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
}

/** Two or more observations, strictly decreasing, at roughly 1Hz. */
function isDecrementing(n: CandidateNode): boolean {
  const obs = n.textHistory
    .map((o) => ({ t: o.t, sec: clockToSeconds(o.text) }))
    .filter((o): o is { t: number; sec: number } => o.sec !== null);

  if (obs.length < 2) return false;

  let decreases = 0;
  for (let i = 1; i < obs.length; i++) {
    const prev = obs[i - 1] as { t: number; sec: number };
    const cur = obs[i] as { t: number; sec: number };
    const dSec = prev.sec - cur.sec;
    const dT = (cur.t - prev.t) / 1000;
    if (dSec > 0 && dT > 0 && dSec / dT > 0.3 && dSec / dT < 4) decreases++;
  }
  return decreases >= 1;
}

export const urgencyDetector: Detector = {
  id: "urgency.countdown@1",
  patternId: "urgency.countdown",
  stages: ["pdp", "cart", "checkout", "browse"],

  run(ctx: PageContext): DetectionCandidate[] {
    const out: DetectionCandidate[] = [];

    for (const n of visibleCandidates(ctx)) {
      const t = n.normalizedText;
      if (t.length > 200) continue;

      const hasClock = CLOCK_RE.test(t);
      const lexemeHits = matchLexemes(n, LEXEMES);
      if (!hasClock && lexemeHits.length === 0) continue;

      const decrementing = isDecrementing(n);
      // Without an observed decrement, a clock shape alone is not a countdown.
      if (!decrementing && lexemeHits.length === 0) continue;

      const cartHold = /\breserved for\b|\bheld for\b|\bcart expires\b/.test(t) ? 1 : 0;

      out.push(
        candidate(
          urgencyDetector.id,
          "urgency.countdown",
          n,
          {
            decrementing: decrementing ? 1 : 0,
            clockShape: hasClock ? 1 : 0,
            lexeme: lexemeHits.length > 0 ? 1 : 0,
            cartHold,
          },
          WEIGHTS,
          lexemeHits,
        ),
      );
    }

    return out;
  },
};
