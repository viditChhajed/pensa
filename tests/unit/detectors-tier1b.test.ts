import { describe, expect, it } from "vitest";
import { bnplDetector } from "@/content/detectors/bnpl";
import { confirmshamingDetector } from "@/content/detectors/confirmshaming";
import { goalGradientDetector } from "@/content/detectors/goalGradient";
import { socialProofDetector } from "@/content/detectors/socialProof";
import { contextFrom, markEphemeral } from "./helpers";

describe("social_proof.live_activity", () => {
  it("fires on a live viewer counter", () => {
    const ctx = contextFrom(`<p>23 people are viewing this right now</p>`);
    const out = socialProofDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.counterCopy).toBe(1);
  });

  it("fires on a recent-sales counter", () => {
    const ctx = contextFrom(`<p>17 sold in the last 24 hours</p>`);
    expect(socialProofDetector.run(ctx)).toHaveLength(1);
  });

  it("fires on an ephemeral purchase toast", () => {
    const ctx = contextFrom(`<div class="toast">Sarah in Denver just bought this</div>`, {
      patch: (n) => markEphemeral(n, 0, 8000),
    });
    const out = socialProofDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.ephemeralToast).toBe(1);
  });

  it("does NOT fire on the same toast copy when the node is static", () => {
    // A permanent testimonial is not manufactured live activity. The timing IS the signal.
    const ctx = contextFrom(`<div>Sarah in Denver just bought this</div>`);
    expect(socialProofDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on a review count", () => {
    const ctx = contextFrom(`<p>1,203 reviews</p>`);
    expect(socialProofDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on a search result count", () => {
    const ctx = contextFrom(`<p>482 products found</p>`);
    expect(socialProofDetector.run(ctx)).toHaveLength(0);
  });
});

describe("confirmshaming.decline_copy", () => {
  it("fires on first-person self-deprecating decline copy", () => {
    const ctx = contextFrom(
      `<div role="dialog"><button>No thanks, I don't want to save money</button></div>`,
    );
    const out = confirmshamingDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.firstPerson).toBe(1);
  });

  it('fires on "I\'d rather pay full price"', () => {
    const ctx = contextFrom(`<button>I'd rather pay full price</button>`);
    expect(confirmshamingDetector.run(ctx)).toHaveLength(1);
  });

  it('does NOT fire on a plain "No thanks"', () => {
    // Firing on every dismissal button on the web is the fastest way to get uninstalled.
    const ctx = contextFrom(`<button>No thanks</button>`);
    expect(confirmshamingDetector.run(ctx)).toHaveLength(0);
  });

  it('does NOT fire on "Maybe later" or "Dismiss"', () => {
    expect(confirmshamingDetector.run(contextFrom(`<button>Maybe later</button>`))).toHaveLength(0);
    expect(confirmshamingDetector.run(contextFrom(`<button>Dismiss</button>`))).toHaveLength(0);
  });

  it("does NOT fire on ordinary marketing prose that is not a control", () => {
    const ctx = contextFrom(`<p>Our customers save money every day.</p>`);
    expect(confirmshamingDetector.run(ctx)).toHaveLength(0);
  });
});

describe("goal_gradient.threshold", () => {
  it("fires on a personalised remainder", () => {
    const ctx = contextFrom(`<p>You're $12.50 away from free shipping</p>`, { stage: "cart" });
    const out = goalGradientDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.personalisedRemainder).toBe(1);
  });

  it('fires on "Add $20 more to unlock free delivery"', () => {
    const ctx = contextFrom(`<p>Add $20.00 more to unlock free delivery</p>`, { stage: "cart" });
    expect(goalGradientDetector.run(ctx)).toHaveLength(1);
  });

  it("does NOT fire on a bare shipping policy statement", () => {
    // "Free shipping over $50" is a policy, not a goal gradient: no progress, no remainder.
    const ctx = contextFrom(`<p>Free shipping on orders over $50</p>`, { stage: "cart" });
    expect(goalGradientDetector.run(ctx)).toHaveLength(0);
  });

  it("fires on threshold copy WITH a progress bar", () => {
    const ctx = contextFrom(
      `<div>Free shipping<div role="progressbar" aria-valuenow="60"></div></div>`,
      { stage: "cart" },
    );
    expect(goalGradientDetector.run(ctx).length).toBeGreaterThanOrEqual(1);
  });
});

describe("bnpl.installments", () => {
  it("fires on interest-free installment copy", () => {
    const ctx = contextFrom(`<p>or 4 interest-free payments of $24.99 with Klarna</p>`);
    const out = bnplDetector.run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.subSignals.providerNamed).toBe(1);
  });

  it('fires on "as low as $12/mo"', () => {
    const ctx = contextFrom(`<p>As low as $12/mo</p>`);
    expect(bnplDetector.run(ctx)).toHaveLength(1);
  });

  it("fires on a provider iframe with no copy", () => {
    const ctx = contextFrom(`<a href="https://www.affirm.com/apply">Learn more</a>`);
    expect(bnplDetector.run(ctx)).toHaveLength(1);
  });

  it('does NOT fire on the word "zip" in an address form', () => {
    // A provider name alone is not enough — "Zip" is also a postcode field label.
    const ctx = contextFrom(`<label>Zip code</label>`, { stage: "checkout" });
    expect(bnplDetector.run(ctx)).toHaveLength(0);
  });

  it("does NOT fire on an ordinary total", () => {
    const ctx = contextFrom(`<p>Total: $99.96</p>`, { stage: "checkout" });
    expect(bnplDetector.run(ctx)).toHaveLength(0);
  });
});
