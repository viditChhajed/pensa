/**
 * Whether to open the install card.
 *
 * This used to be `details.reason === "install"` and nothing else, which quietly did the wrong
 * thing: reloading an unpacked build, or a version update, reports a different reason, so the
 * card never opened and the question never got asked. Reported from the field as "it didn't
 * come up when I redownloaded".
 *
 * The rule is now about the ANSWER, not the event. Someone who has never answered is asked at
 * every opportunity; someone who has answered, either way, is never asked again. That is also
 * what makes it safe to call from more than one place: it cannot nag a person who said no.
 *
 * `telemetryConsentAskedAt` is set only by a real click, on the card or in Settings, so
 * closing the tab leaves it unset and the question comes back. The in-page card carries the
 * same question for anyone who never sees this tab (see CONSENT_COPY in content/ui/card.ts),
 * except on Firefox, where only an extension page can open Firefox's own consent prompt.
 */
import type { ShowDigest } from "@/shared/messages";
import type { Settings } from "@/shared/schema";

export function shouldOpenWelcome(settings: Settings): boolean {
  return settings.telemetryConsentAskedAt === undefined;
}

/**
 * Whether the card should carry the one-time "how often" question.
 *
 * Only on a card that is not already asking about sharing: two questions under the findings
 * turns a card into a form. Someone who has never answered the sharing question is asked
 * that first and this one on the next card.
 */
export function shouldAskFrequency(settings: Settings, askingConsent: boolean): boolean {
  return !askingConsent && settings.frequencyAskedAt === undefined;
}

/**
 * Remove any question from a carried-over card that has been answered since it was built.
 *
 * A card is held until a page confirms it stayed up, and shown on the next page of the shop
 * if not. It was held exactly as built, questions included, so a person who clicked "Yes"
 * and moved on within a second and a half saw the sharing question again on the next page;
 * and when a newer card replaced it, closing the stale one counted as "closed without
 * answering", which is a no, and silently overwrote the yes. Found by the e2e suite, not in
 * the field, but the path is ordinary: answer, then click Checkout.
 *
 * Answered is decided by the settings at the moment of showing, never by the card.
 */
export function stripAnswered(reply: ShowDigest, settings: Settings): ShowDigest {
  const out: ShowDigest = { ...reply };
  if (settings.telemetryConsentAskedAt !== undefined) delete out.askConsent;
  if (settings.frequencyAskedAt !== undefined) delete out.askFrequency;
  return out;
}
