/**
 * pricing.drip and basket.sneak, the two cross-stage detectors (plan T25).
 *
 * These do not live in `content/detectors/` because they are not page detectors. They take a
 * SessionLedger rather than a PageContext: the finding is a relationship between stages, and
 * no single page contains it. They remain pure functions for the same reason everything else
 * is, so they can be replayed over a recorded ledger without a browser.
 *
 * The strongest single finding this tool can produce is a mandatory fee first disclosed at
 * `payment` with a drip ratio above 0.15. That is the number worth reporting.
 */

import { createHash } from "@/content/detectors/hash";
import { reconcile } from "@/content/priceSummary";
import { addonKeysOf } from "@/shared/addons";
import { formatMinor } from "@/shared/money";
import {
  type DetectionCandidate,
  FUNNEL_ORDER,
  type FunnelStage,
  type LineItem,
  type SessionLedger,
} from "@/shared/schema";
import { firstDisclosureStage, orderedStages, userChoseAddon } from "./sessionLedger";

export const DRIP_DETECTOR_ID = "pricing.drip@1";
export const SNEAK_DETECTOR_ID = "basket.sneak@1";

/** A fee disclosed at or after this stage is "late", the shopper has already committed. */
const LATE_STAGE_MIN = FUNNEL_ORDER.cart;

export interface DripFinding {
  dripAmount: bigint;
  dripRatio: number;
  stageOfFirstDisclosure: FunnelStage;
  currency: string;
  lateFees: { label: string; amount: bigint; stage: FunnelStage }[];
}

/**
 * Compare what the price looked like at each stage. A fee that exists at checkout but did
 * not exist at the PDP was added along the way, and the stage it first appeared at is the
 * measurement.
 */
export function detectDrip(ledger: SessionLedger): DripFinding | null {
  const stages = orderedStages(ledger);
  if (stages.length < 2) return null;

  const latestStage = stages[stages.length - 1] as FunnelStage;
  const latest = ledger.stages[latestStage]?.priceSnapshot;
  if (!latest) return null;

  const earliest = stages.map((s) => ledger.stages[s]?.priceSnapshot).find((s) => s !== undefined);
  if (!earliest) return null;

  const known = new Set(earliest.fees.map((f) => f.labelHash));

  const lateFees: DripFinding["lateFees"] = [];
  let dripAmount = 0n;
  let earliestLate: FunnelStage | null = null;
  let currency = "USD";

  for (const fee of latest.fees) {
    if (fee.kind === "discount") continue;
    // A charge the shopper explicitly opted into is not drip pricing.
    // Add-ons are basket.sneak's question, not drip's. Drip is mandatory charges disclosed
    // late (taxonomy: "Mandatory charges disclosed after the first price"). This used to skip
    // only add-ons flagged `userAttributed`, a flag that was always false, so every add-on,
    // including ones the shopper picked, was counted as a drip fee AND as a sneaked item.
    if (fee.kind === "optional_addon") continue;
    if (known.has(fee.labelHash)) continue;

    const disclosedAt = firstDisclosureStage(ledger, fee.labelHash) ?? latestStage;
    if (FUNNEL_ORDER[disclosedAt] < LATE_STAGE_MIN) continue;

    dripAmount += fee.amount.amount;
    currency = fee.amount.currency;
    lateFees.push({
      label: fee.labelSample ?? "(unlabeled charge)",
      amount: fee.amount.amount,
      stage: disclosedAt,
    });

    if (earliestLate === null || FUNNEL_ORDER[disclosedAt] < FUNNEL_ORDER[earliestLate]) {
      earliestLate = disclosedAt;
    }
  }

  if (lateFees.length === 0 || earliestLate === null) return null;

  const recon = reconcile(latest);
  const base = recon?.base ?? latest.subtotal?.amount ?? latest.displayedPrice?.amount;
  if (base === undefined || base === 0n) return null;

  return {
    dripAmount,
    dripRatio: Number(dripAmount) / Number(base),
    stageOfFirstDisclosure: earliestLate,
    currency,
    lateFees,
  };
}

/** Below this, a fee is real but not worth interrupting anyone over. */
export const DRIP_SURFACE_RATIO = 0.05;

export function dripCandidate(
  ledger: SessionLedger,
  finding: DripFinding,
): DetectionCandidate | null {
  if (finding.dripRatio < DRIP_SURFACE_RATIO) return null;

  const summary = finding.lateFees
    .map((f) => `${f.label} ${formatMinor(f.amount, finding.currency)}`)
    .join("; ")
    .slice(0, 240);

  // Confidence rises with how late the disclosure was and how large the delta is.
  const lateness = FUNNEL_ORDER[finding.stageOfFirstDisclosure] / FUNNEL_ORDER.payment;
  const magnitude = Math.min(1, finding.dripRatio / 0.2);

  return {
    detectorId: DRIP_DETECTOR_ID,
    patternId: "pricing.drip",
    rawScore: Math.min(1, 0.5 + 0.25 * lateness + 0.25 * magnitude),
    subSignals: {
      lateness,
      magnitude,
      feeCount: finding.lateFees.length,
      dripRatio: finding.dripRatio,
    },
    evidence: {
      selectorPath: "(session-ledger)",
      textHash: createHash(summary),
      textSample: summary,
      matchedLexemes: finding.lateFees.map((f) => f.label.slice(0, 64)).slice(0, 24),
      boundingBox: { x: 0, y: 0, w: 0, h: 0 },
    },
    nodeRef: `(ledger:${ledger.origin})`,
  };
}

/**
 * basket.sneak, a cart line item with no matching add-to-cart from the shopper.
 *
 * Deliberately conservative. A shopper can add an item in a previous session, or on another
 * device, and the ledger would not know: so this only fires when the session recorded at
 * least one add of its own (proving the tracking works on this site) and the unattributed
 * line is an add-on rather than a product.
 */
export function detectSneak(ledger: SessionLedger): DetectionCandidate | null {
  if (ledger.userInitiatedAdds.length === 0) return null;

  const cartStage: FunnelStage | undefined = (["checkout", "payment", "cart"] as const).find(
    (s) => ledger.stages[s]?.priceSnapshot,
  );
  if (!cartStage) return null;

  const snapshot = ledger.stages[cartStage]?.priceSnapshot;
  if (!snapshot) return null;

  /**
   * An add-on line is the shopper's own if they ticked or clicked a control for that add-on
   * family this session, and did not undo it.
   *
   * The previous check compared hashes of ADD-TO-CART BUTTON labels ("add to bag") with hashes
   * of CART LINE labels ("accident protection plan"). Those can never be equal, and the other
   * half of the test was a flag hardcoded false, so every add-on in every cart was reported as
   * unrequested, including a gift wrap the shopper had just chosen.
   */
  const unattributed: LineItem[] = snapshot.fees.filter(
    (f) => f.kind === "optional_addon" && !userChoseAddon(ledger, addonKeysOf(f.labelSample ?? "")),
  );
  if (unattributed.length === 0) return null;

  const summary = unattributed
    .map((f) => f.labelSample ?? "(unlabeled item)")
    .join("; ")
    .slice(0, 240);

  return {
    detectorId: SNEAK_DETECTOR_ID,
    patternId: "basket.sneak",
    rawScore: Math.min(1, 0.6 + 0.1 * unattributed.length),
    subSignals: {
      unattributedCount: unattributed.length,
      addsObserved: ledger.userInitiatedAdds.length,
    },
    evidence: {
      selectorPath: "(session-ledger)",
      textHash: createHash(summary),
      textSample: summary,
      matchedLexemes: unattributed.map((f) => (f.labelSample ?? "").slice(0, 64)).slice(0, 24),
      boundingBox: { x: 0, y: 0, w: 0, h: 0 },
    },
    nodeRef: `(ledger:${ledger.origin})`,
  };
}
