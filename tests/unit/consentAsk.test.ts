import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_COPY, type ConsentAnswer, DigestCard } from "@/content/ui/card";

/**
 * The one-time sharing question on the first card.
 *
 * A tool that flags preselected boxes and lopsided buttons has to pass its own tests here, so
 * these check the things `defaults.preselected` and `interference.visual_asymmetry` look for:
 * no default answer, and two answers that are visually the same control.
 */

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

const items = [{ patternId: "urgency.countdown", label: "Countdown timer", prompt: "Would you?" }];

function show(askConsent: boolean) {
  const answers: ConsentAnswer[] = [];
  const card = new DigestCard();
  card.show(items, { askConsent, onConsent: (a) => answers.push(a) });
  return { card, answers };
}

describe("the sharing question", () => {
  it("is absent unless the worker asks for it", () => {
    show(false);
    expect(root?.querySelector(".consent")).toBeNull();
  });

  it("offers two answers that are the same control, and neither is focused", () => {
    show(true);
    const buttons = [...(root?.querySelectorAll<HTMLButtonElement>("button.answer") ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual([CONSENT_COPY.yes, CONSENT_COPY.no]);
    // Same class and nothing else: no primary/secondary, no inline style on either.
    expect(new Set(buttons.map((b) => b.className))).toEqual(new Set(["answer"]));
    expect(buttons.every((b) => !b.getAttribute("style"))).toBe(true);
    // Focus goes to the close control, as before — never to an answer.
    expect(buttons.includes(root?.activeElement as HTMLButtonElement)).toBe(false);
  });

  it("records yes once, then says so", () => {
    const { answers } = show(true);
    root?.querySelector<HTMLButtonElement>('[data-consent="true"]')?.click();
    expect(answers).toEqual([true]);
    expect(root?.querySelector(".consent")?.textContent).toBe(CONSENT_COPY.thanksYes);
  });

  it("records no once", () => {
    const { card, answers } = show(true);
    root?.querySelector<HTMLButtonElement>('[data-consent="false"]')?.click();
    card.dismiss();
    expect(answers).toEqual([false]);
  });

  it("treats closing the card without answering as an answer, so it is never asked again", () => {
    const { card, answers } = show(true);
    card.dismiss();
    card.dismiss();
    expect(answers).toEqual([null]);
  });

  it("says what is shared in the question itself, not behind a link", () => {
    const text = `${CONSENT_COPY.ask} ${CONSENT_COPY.detail}`;
    expect(text).toMatch(/shop/);
    expect(text).toMatch(/add(ed)? (an |the )?item to (your|their) cart/);
    expect(text).toMatch(/Never the page, the product, prices/);
    expect(text).toMatch(/Settings/);
  });
});
