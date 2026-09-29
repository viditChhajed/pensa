import { describe, expect, it } from "vitest";
import { shouldOpenWelcome, stripAnswered } from "@/background/welcome";
import { DEFAULT_SETTINGS } from "@/shared/schema";

/**
 * When the install card is offered.
 *
 * The rule used to be the install EVENT ("reason === install"), so a reloaded unpacked build
 * or a version update never asked and the question silently never appeared. It is now the
 * ANSWER, which is the thing that actually matters and cannot nag someone who declined.
 */
describe("the install card is offered until the question is answered", () => {
  it("offers it to someone who has never answered", () => {
    expect(shouldOpenWelcome(DEFAULT_SETTINGS)).toBe(true);
  });

  it("stops once they answer, whichever way they answered", () => {
    const answeredYes = { ...DEFAULT_SETTINGS, telemetryConsent: true, telemetryConsentAskedAt: 1 };
    const answeredNo = { ...DEFAULT_SETTINGS, telemetryConsent: false, telemetryConsentAskedAt: 1 };
    expect(shouldOpenWelcome(answeredYes)).toBe(false);
    expect(shouldOpenWelcome(answeredNo), "a declined question must never be asked again").toBe(
      false,
    );
  });

  it("offers it again to someone who is sharing but was never asked", () => {
    // Switched on from Settings before the card existed: the record of being asked is what
    // closes the question, and this person has not seen it.
    const onButUnasked = { ...DEFAULT_SETTINGS, telemetryConsent: true };
    expect(shouldOpenWelcome(onButUnasked)).toBe(true);
  });
});

describe("a carried-over card never re-asks an answered question", () => {
  const reply = {
    type: "show-digest" as const,
    items: [{ patternId: "scarcity.stock", prompt: "?", label: "x" }],
    mode: "card" as const,
    askConsent: true,
    askFrequency: true,
  };

  it("strips the sharing question once it has been answered", () => {
    // The failure it prevents: answer Yes, leave within 1.5s, see the question again on the
    // next page, close it, and the close counts as No, overwriting the Yes.
    const out = stripAnswered(reply, { ...DEFAULT_SETTINGS, telemetryConsentAskedAt: 1 });
    expect(out.askConsent).toBeUndefined();
    expect(out.items).toEqual(reply.items);
  });

  it("strips the frequency question once it has been answered", () => {
    const out = stripAnswered(reply, { ...DEFAULT_SETTINGS, frequencyAskedAt: 1 });
    expect(out.askFrequency).toBeUndefined();
  });

  it("keeps a question nobody has answered yet", () => {
    const out = stripAnswered(reply, DEFAULT_SETTINGS);
    expect(out.askConsent).toBe(true);
    expect(out.askFrequency).toBe(true);
  });
});
