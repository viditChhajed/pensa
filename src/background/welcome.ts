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
 * same question for anyone who never sees this tab (see CONSENT_COPY in content/ui/card.ts).
 */
import type { Settings } from "@/shared/schema";

export function shouldOpenWelcome(settings: Settings): boolean {
  return settings.telemetryConsentAskedAt === undefined;
}
