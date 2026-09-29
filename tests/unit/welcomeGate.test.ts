import { describe, expect, it } from "vitest";
import { shouldOpenWelcome } from "@/background/welcome";
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
