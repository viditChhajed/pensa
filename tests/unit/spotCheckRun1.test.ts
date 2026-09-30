import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldAskFrequency } from "@/background/welcome";
import { anchoringDetector } from "@/content/detectors/anchoring";
import { scarcityDetector, scarcityFacts } from "@/content/detectors/scarcity";
import { pageTextStats, prominenceOf } from "@/content/prominence";
import { TriggerWatcher } from "@/content/triggers";
import { DigestCard, FREQUENCY_COPY, type FrequencyAnswer } from "@/content/ui/card";
import { contextualPrompt, withPairing } from "@/shared/copy/prompts";
import { DEFAULT_SETTINGS } from "@/shared/schema";
import { contextFrom } from "./helpers";

/**
 * Every change made from the first human spot-check (SPOT-CHECK-RUN.md, 2026-09-29).
 * Each describe block names the note it answers, and each assertion fails on the build the
 * run was done against.
 */

describe('anchors: "a 7.99 anchor for a 5.99 item isn\'t doing much"', () => {
  const best = (html: string) =>
    Math.max(0, ...anchoringDetector.run(contextFrom(html)).map((c) => c.rawScore));

  it("keeps a small gap off the card, but still records it", () => {
    const small = best(`<div><span>$5.99</span> <s>$7.99</s></div>`);
    expect(small).toBeLessThan(0.75);
    expect(small).toBeGreaterThanOrEqual(0.35);
  });

  it("needs the money gap too: 27% off an $11 item is $3", () => {
    expect(best(`<div><span>$8</span> <s>$11</s></div>`)).toBeLessThan(0.75);
  });

  it("surfaces the gaps the run rated worth it", () => {
    // booking: $100 for an $85 room. StubHub: $1,424 over $1,004. Etsy: more than double.
    expect(best(`<div><span>$85</span> <s>$100</s></div>`)).toBeGreaterThanOrEqual(0.75);
    expect(best(`<div><span>$1,004</span> <s>$1,424</s></div>`)).toBeGreaterThanOrEqual(0.75);
    expect(best(`<div><span>$120</span> <s>$269.76</s></div>`)).toBeGreaterThanOrEqual(0.75);
  });
});

describe('anchors: "show what the reference was against"', () => {
  const facts = (html: string) => anchoringDetector.run(contextFrom(html))[0]?.evidence.facts;

  it("carries both prices as the page wrote them, and the ratio", () => {
    expect(facts(`<div><span>$35</span> <s>$52</s></div>`)).toEqual({
      anchor: "$52",
      current: "$35",
      ratio: 1.5,
    });
  });

  it("words the card with the scale", () => {
    const f = facts(`<div><span>$35</span> <s>$52</s></div>`);
    expect(contextualPrompt("anchoring.reference_price", f)).toBe(
      "The page crossed out $52, 1.5 times the $35 you would pay. Without that number, would this item be worth the same to you?",
    );
  });

  it('says "more than double" when it is', () => {
    const f = facts(`<div><span>$120</span> <s>$269.76</s></div>`);
    expect(contextualPrompt("anchoring.reference_price", f)).toContain(
      "more than double the $120 you would pay",
    );
  });
});

describe('scarcity: "only 1 left at Polaris" needs its context', () => {
  it("reads the store a stock claim is scoped to", () => {
    expect(scarcityFacts("only 1 left at polaris for pickup today")).toEqual({
      count: 1,
      scope: "location",
      place: "Polaris",
    });
  });

  it("words the card with the store, as the note asked", () => {
    const f = scarcityFacts("only 1 left at polaris");
    expect(contextualPrompt("scarcity.stock", f)).toBe(
      "The page said only 1 was left at your nearby store, Polaris. Does knowing that change what the item is worth to you?",
    );
  });

  it("tells a price-scoped claim from a store-scoped one", () => {
    expect(scarcityFacts("only 3 rooms left at this price")).toEqual({ count: 3, scope: "price" });
    expect(contextualPrompt("scarcity.stock", { count: 3, scope: "price" })).toBe(
      "The page said only 3 were left at this price. Does knowing that change what the item is worth to you?",
    );
  });

  it('does not read "left at checkout" as a store', () => {
    expect(scarcityFacts("only 2 left at checkout")?.scope).toBeUndefined();
  });

  it("carries the facts on the detection itself, from the container", () => {
    const found = scarcityDetector.run(
      contextFrom(`<div><span>Only 1 left</span> at Polaris</div>`, { stage: "pdp" }),
    );
    expect(found[0]?.evidence.facts?.scope).toBe("location");
    expect(found[0]?.evidence.facts?.place).toBe("Polaris");
  });

  it('detects "Last tickets", the StubHub badge that produced nothing', () => {
    const found = scarcityDetector.run(contextFrom(`<span>Last tickets</span>`));
    expect(found).toHaveLength(1);
  });
});

describe("StubHub: picking a ticket listing is the decision", () => {
  const fires = (html: string): string | null => {
    document.body.innerHTML = html;
    let kind: string | null = null;
    const w = new TriggerWatcher(
      (e) => {
        kind = e.kind;
      },
      () => "browse",
    );
    const detach = w.attach(document);
    (document.querySelector("[data-t]") as HTMLElement).click();
    detach();
    return kind;
  };

  it("fires on StubHub's listing row, as named in its live markup", () => {
    expect(
      fires(`<a role="button" data-t aria-label="Section 409, Row 4, $1,243">A+ Ticket</a>`),
    ).toBe("checkout_intent");
    expect(fires(`<a role="button" data-t aria-label="Sec 104, Row AA, £320">x</a>`)).toBe(
      "checkout_intent",
    );
  });

  it("does not fire on products that merely contain the words", () => {
    expect(fires(`<a data-t>Row Boat Planter $45</a>`)).toBeNull();
    expect(fires(`<a data-t>Sectional Sofa $899</a>`)).toBeNull();
    // A seat location with no price is navigation, not a choice of what to buy.
    expect(fires(`<a data-t>Section 409 seating chart</a>`)).toBeNull();
  });
});

describe("a deadline and a crossed-out price together", () => {
  const item = (patternId: string) => ({ patternId, label: patternId, prompt: "?" });

  it("adds the pairing line when both are on the card", () => {
    const out = withPairing([item("anchoring.reference_price"), item("urgency.countdown")], 4);
    expect(out.map((i) => i.patternId)).toContain("combo.deadline_and_anchor");
  });

  it("never displaces a finding to make room", () => {
    const full = [
      item("anchoring.reference_price"),
      item("urgency.countdown"),
      item("scarcity.stock"),
      item("pricing.charm"),
    ];
    expect(withPairing(full, 4)).toHaveLength(4);
  });

  it("does nothing for either one alone", () => {
    expect(withPairing([item("urgency.countdown")], 4)).toHaveLength(1);
  });
});

describe('"how often" is asked on the card, not buried in Settings', () => {
  it("asks once, and never on the same card as the sharing question", () => {
    expect(shouldAskFrequency(DEFAULT_SETTINGS, false)).toBe(true);
    expect(shouldAskFrequency(DEFAULT_SETTINGS, true)).toBe(false);
    expect(shouldAskFrequency({ ...DEFAULT_SETTINGS, frequencyAskedAt: 1 }, false)).toBe(false);
  });

  let root: ShadowRoot | null = null;
  const realAttach = Element.prototype.attachShadow;
  beforeEach(() => {
    root = null;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ) {
      root = realAttach.call(this, init);
      return root;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const n of document.documentElement.querySelectorAll("[id^='pp-']")) n.remove();
  });

  const show = (askConsent = false) => {
    const answers: FrequencyAnswer[] = [];
    const card = new DigestCard();
    card.show([{ patternId: "scarcity.stock", label: "Limited stock", prompt: "?" }], {
      askConsent,
      onConsent: () => {},
      askFrequency: true,
      onFrequency: (a) => answers.push(a),
    });
    return { card, answers };
  };

  it("offers the three settings as the same control, none focused or preselected", () => {
    show();
    const buttons = [...(root?.querySelectorAll<HTMLButtonElement>("[data-frequency]") ?? [])];
    expect(buttons.map((b) => b.dataset.frequency)).toEqual(
      FREQUENCY_COPY.options.map((o) => o.value),
    );
    expect(new Set(buttons.map((b) => b.className))).toEqual(new Set(["answer"]));
    expect(buttons.includes(root?.activeElement as HTMLButtonElement)).toBe(false);
  });

  it("records the choice once", () => {
    const { answers } = show();
    root?.querySelector<HTMLButtonElement>('[data-frequency="once_per_site"]')?.click();
    expect(answers).toEqual(["once_per_site"]);
    expect(root?.querySelector(".consent")?.textContent).toBe(FREQUENCY_COPY.thanks.once_per_site);
  });

  it("treats closing the card as keeping the setting, and asks nothing more", () => {
    const { card, answers } = show();
    card.dismiss();
    card.dismiss();
    expect(answers).toEqual([null]);
  });

  it("stays off a card that is asking about sharing", () => {
    show(true);
    expect(root?.querySelector("[data-frequency]")).toBeNull();
  });
});

describe('fine print: "written very small, I didn\'t even notice it"', () => {
  // Built from real measurements taken on the live sites, not invented values.
  const node = (fontSizePx: number, fontWeight: number, effectiveBackground: string) =>
    ({
      text: "x",
      style: { fontSizePx, fontWeight, effectiveBackground },
    }) as unknown as import("@/content/types").CandidateNode;
  const WHITE = "rgb(255, 255, 255)";
  const PILL = "rgb(254, 226, 226)";

  it("reads the page's own text size and background", () => {
    const page = [
      node(12, 400, WHITE),
      node(12, 400, WHITE),
      node(13, 400, WHITE),
      node(16, 700, WHITE),
    ];
    expect(pageTextStats(page)).toEqual({ medianFontPx: 13, pageBackground: WHITE });
  });

  it("keeps StubHub's badges: 12px, weight 500, on a 12px page, in a red pill", () => {
    const stats = { medianFontPx: 12, pageBackground: WHITE };
    expect(prominenceOf(node(12, 500, PILL), stats).prominent).toBe(true);
    // Even out of the pill, the same size as the page's text is not fine print.
    expect(prominenceOf(node(12, 500, WHITE), stats).prominent).toBe(true);
  });

  it("drops plain text smaller than the page around it", () => {
    const stats = { medianFontPx: 14, pageBackground: WHITE };
    const fine = prominenceOf(node(11, 400, WHITE), stats);
    expect(fine.prominent).toBe(false);
    expect(fine.relativeSize).toBe(0.79);
  });

  it("keeps small text a page chose to emphasise, by weight or by a background", () => {
    const stats = { medianFontPx: 14, pageBackground: WHITE };
    expect(prominenceOf(node(11, 700, WHITE), stats).prominent).toBe(true);
    expect(prominenceOf(node(11, 400, PILL), stats).prominent).toBe(true);
  });

  it("does not call Shein's whole page fine print because the page is small", () => {
    // Measured: median 12-13px, price and title 14px. Relative, not absolute.
    const stats = { medianFontPx: 12, pageBackground: WHITE };
    expect(prominenceOf(node(12, 400, WHITE), stats).prominent).toBe(true);
  });
});
