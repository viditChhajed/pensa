import { describe, expect, it } from "vitest";
import { detectDrip, detectSneak, dripCandidate } from "@/background/dripPricing";
import { noteStage, noteUserAdd, noteUserChoice } from "@/background/sessionLedger";
import { createHash } from "@/content/detectors/hash";
import { classifyLineItem, extractPriceSnapshot, reconcile } from "@/content/priceSummary";
import type { LineItem, PriceSnapshot, SessionLedger } from "@/shared/schema";
import { contextFrom } from "./helpers";

const SESSION = "00000000-0000-4000-8000-000000000000";
const ORIGIN = "https://shop.example.com";

function usd(minor: bigint) {
  return { amount: minor, currency: "USD", confidence: 0.9 };
}

function fee(label: string, minor: bigint, kind: LineItem["kind"] = "mandatory_fee"): LineItem {
  return {
    labelHash: hashOf(label),
    labelSample: label,
    amount: usd(minor),
    kind,
    kindConfidence: 0.7,
  };
}

/** Mirror of the detector's hashing so the same fee lines up across stages. */
function hashOf(label: string): string {
  return createHash(label.toLowerCase());
}

function ledgerWith(stages: Partial<Record<string, PriceSnapshot>>): SessionLedger {
  let ledger: SessionLedger = {
    sessionId: SESSION,
    origin: ORIGIN,
    stages: {},
    userInitiatedAdds: [],
    userChoices: [],
    events: [],
    digestsShown: [],
  };
  for (const [stage, snap] of Object.entries(stages)) {
    ledger = noteStage(ledger, stage as never, snap, 1000);
  }
  return ledger;
}

describe("classifyLineItem", () => {
  it("recognises mandatory fees", () => {
    expect(classifyLineItem("Service fee").kind).toBe("mandatory_fee");
    expect(classifyLineItem("Resort fee").kind).toBe("mandatory_fee");
    expect(classifyLineItem("Order processing fee").kind).toBe("mandatory_fee");
  });

  it("separates optional add-ons from mandatory fees", () => {
    // The whole finding turns on this distinction.
    expect(classifyLineItem("2-year protection plan").kind).toBe("optional_addon");
    expect(classifyLineItem("Gift wrap").kind).toBe("optional_addon");
  });

  it("recognises tax and shipping", () => {
    expect(classifyLineItem("Sales tax").kind).toBe("tax");
    expect(classifyLineItem("Standard shipping").kind).toBe("shipping");
  });

  it("reports lower confidence on the fee/addon judgement than on tax", () => {
    expect(classifyLineItem("Service fee").confidence).toBeLessThan(
      classifyLineItem("Sales tax").confidence,
    );
  });

  it("falls back to unknown rather than guessing", () => {
    expect(classifyLineItem("Blue cotton shirt").kind).toBe("unknown");
  });
});

describe("reconcile", () => {
  it("computes the drip ratio from mandatory fees only", () => {
    const snap: PriceSnapshot = {
      subtotal: usd(10_000n),
      tax: usd(800n),
      fees: [fee("Service fee", 1500n), fee("Gift wrap", 500n, "optional_addon")],
      total: usd(12_800n),
      capturedAt: 0,
    };
    const r = reconcile(snap);
    expect(r?.mandatoryTotal).toBe(1500n);
    expect(r?.dripRatio).toBeCloseTo(0.15, 5);
  });

  it("surfaces an unexplained residual exactly, with no float drift", () => {
    const snap: PriceSnapshot = {
      subtotal: usd(3333n),
      fees: [],
      total: usd(4000n),
      capturedAt: 0,
    };
    expect(reconcile(snap)?.unexplained).toBe(667n);
  });

  it("returns null without a base price to compare against", () => {
    expect(reconcile({ fees: [], capturedAt: 0 })).toBeNull();
  });
});

describe("detectDrip", () => {
  it("flags a fee that appears only at checkout", () => {
    const ledger = ledgerWith({
      pdp: { displayedPrice: usd(10_000n), fees: [], capturedAt: 1 },
      cart: { subtotal: usd(10_000n), fees: [], capturedAt: 2 },
      checkout: {
        subtotal: usd(10_000n),
        fees: [fee("Service fee", 1800n)],
        total: usd(11_800n),
        capturedAt: 3,
      },
    });

    const finding = detectDrip(ledger);
    expect(finding).not.toBeNull();
    expect(finding?.dripAmount).toBe(1800n);
    expect(finding?.dripRatio).toBeCloseTo(0.18, 5);
    expect(finding?.stageOfFirstDisclosure).toBe("checkout");
  });

  it("does NOT flag a fee that was disclosed from the start", () => {
    const known = fee("Service fee", 1800n);
    const ledger = ledgerWith({
      pdp: { subtotal: usd(10_000n), fees: [known], capturedAt: 1 },
      checkout: { subtotal: usd(10_000n), fees: [known], total: usd(11_800n), capturedAt: 2 },
    });
    expect(detectDrip(ledger)).toBeNull();
  });

  it("never counts an add-on as a drip fee, chosen or not", () => {
    // Drip is MANDATORY charges disclosed late. Add-ons are basket.sneak's question. This
    // used to skip only add-ons flagged `userAttributed`, a flag that was always false, so a
    // gift wrap the shopper picked was reported as a fee added behind their back.
    const ledger = ledgerWith({
      pdp: { subtotal: usd(10_000n), fees: [], capturedAt: 1 },
      checkout: {
        subtotal: usd(10_000n),
        fees: [fee("Gift wrap", 500n, "optional_addon")],
        total: usd(10_500n),
        capturedAt: 2,
      },
    });
    expect(detectDrip(ledger)).toBeNull();
  });

  it("needs at least two stages to say anything", () => {
    const ledger = ledgerWith({
      checkout: { subtotal: usd(10_000n), fees: [fee("Service fee", 1800n)], capturedAt: 1 },
    });
    expect(detectDrip(ledger)).toBeNull();
  });

  it("does not surface a trivial fee", () => {
    const ledger = ledgerWith({
      pdp: { subtotal: usd(10_000n), fees: [], capturedAt: 1 },
      checkout: { subtotal: usd(10_000n), fees: [fee("Carrier fee", 20n)], capturedAt: 2 },
    });
    const finding = detectDrip(ledger);
    expect(finding).not.toBeNull();
    expect(dripCandidate(ledger, finding as never)).toBeNull();
  });

  it("scores a payment-stage disclosure above a cart-stage one", () => {
    const late = ledgerWith({
      pdp: { subtotal: usd(10_000n), fees: [], capturedAt: 1 },
      payment: { subtotal: usd(10_000n), fees: [fee("Service fee", 2000n)], capturedAt: 2 },
    });
    const early = ledgerWith({
      pdp: { subtotal: usd(10_000n), fees: [], capturedAt: 1 },
      cart: { subtotal: usd(10_000n), fees: [fee("Service fee", 2000n)], capturedAt: 2 },
    });

    const lateScore = dripCandidate(late, detectDrip(late) as never)?.rawScore ?? 0;
    const earlyScore = dripCandidate(early, detectDrip(early) as never)?.rawScore ?? 0;
    expect(lateScore).toBeGreaterThan(earlyScore);
  });

  it("never puts a price into the evidence hash input as a raw number", () => {
    const ledger = ledgerWith({
      pdp: { subtotal: usd(10_000n), fees: [], capturedAt: 1 },
      payment: { subtotal: usd(10_000n), fees: [fee("Service fee", 2000n)], capturedAt: 2 },
    });
    const c = dripCandidate(ledger, detectDrip(ledger) as never);
    expect(c?.evidence.textHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("detectSneak", () => {
  it("flags an unattributed add-on when the session did record adds", () => {
    let ledger = ledgerWith({
      cart: {
        subtotal: usd(10_000n),
        fees: [fee("Protection plan", 1299n, "optional_addon")],
        capturedAt: 2,
      },
    });
    ledger = noteUserAdd(ledger, {
      ts: 1,
      labelHash: hashOf("blue shirt"),
      labelSample: "Blue shirt",
      confirmed: true,
    });

    const c = detectSneak(ledger);
    expect(c).not.toBeNull();
    expect(c?.patternId).toBe("basket.sneak");
  });

  it("stays silent when no adds were observed at all", () => {
    // Without a recorded add, we cannot tell an unrequested item from one added last week.
    const ledger = ledgerWith({
      cart: {
        subtotal: usd(10_000n),
        fees: [fee("Protection plan", 1299n, "optional_addon")],
        capturedAt: 2,
      },
    });
    expect(detectSneak(ledger)).toBeNull();
  });

  const protectionCart = () =>
    noteUserAdd(
      ledgerWith({
        cart: {
          subtotal: usd(10_000n),
          fees: [fee("Accident Protection Plan", 1299n, "optional_addon")],
          capturedAt: 2,
        },
      }),
      { ts: 1, labelHash: hashOf("add to cart"), confirmed: true },
    );

  it("does not flag an add-on the shopper opted into", () => {
    // Attribution is by add-on FAMILY: ticking "Add 2-year protection" on the product page
    // makes the cart's "Accident Protection Plan" line the shopper's own.
    const ledger = noteUserChoice(protectionCart(), { ts: 5, key: "protection", selected: true });
    expect(detectSneak(ledger)).toBeNull();
  });

  it("DOES flag it if the shopper opted in and then back out", () => {
    // Latest choice wins. Unticking protection and still finding it in the cart is the finding.
    let ledger = noteUserChoice(protectionCart(), { ts: 5, key: "protection", selected: true });
    ledger = noteUserChoice(ledger, { ts: 9, key: "protection", selected: false });
    expect(detectSneak(ledger)).not.toBeNull();
  });

  it("does not let a choice about one add-on excuse a different one", () => {
    const ledger = noteUserChoice(protectionCart(), { ts: 5, key: "gift_wrap", selected: true });
    expect(detectSneak(ledger)).not.toBeNull();
  });

  it("is not fooled by the add-to-cart button label, which names no add-on", () => {
    // The old check compared this hash with the cart line's hash. They can never match, which
    // is why every add-on in every cart was reported as unrequested.
    expect(detectSneak(protectionCart())).not.toBeNull();
  });
});

describe("extractPriceSnapshot", () => {
  it("pulls subtotal, fee, tax and total out of an order summary", () => {
    const ctx = contextFrom(
      `<div class="summary">
         <div>Subtotal $100.00</div>
         <div>Service fee $18.00</div>
         <div>Sales tax $8.00</div>
         <div>Order total $126.00</div>
       </div>`,
      { stage: "checkout" },
    );
    const snap = extractPriceSnapshot(ctx, 0);
    expect(snap.subtotal?.amount).toBe(10_000n);
    expect(snap.tax?.amount).toBe(800n);
    expect(snap.total?.amount).toBe(12_600n);
    expect(snap.fees.some((f) => f.kind === "mandatory_fee")).toBe(true);
  });

  it("does not mistake the subtotal row for the total row", () => {
    const ctx = contextFrom(`<div><div>Subtotal $50.00</div><div>Total $60.00</div></div>`, {
      stage: "cart",
    });
    const snap = extractPriceSnapshot(ctx, 0);
    expect(snap.subtotal?.amount).toBe(5000n);
    expect(snap.total?.amount).toBe(6000n);
  });
});
