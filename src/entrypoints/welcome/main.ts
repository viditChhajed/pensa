/**
 * The install page: what Pensa does, and the one question worth asking at install.
 *
 * The sharing setting used to live only in Settings, which almost nobody opens, so the
 * research it exists for got nothing. Asking here, once, at the moment someone has just
 * chosen to install, is the honest version of the same request: stated in full, with both
 * answers weighted the same and neither preselected.
 *
 * Closing this tab answers nothing, deliberately. `telemetryConsentAskedAt` is only set by an
 * actual click, so someone who never saw this page still gets the one-time question on their
 * first card (see CONSENT_COPY in src/content/ui/card.ts). Not on Firefox: its consent prompt
 * cannot open from a shop's page, so there this page and Settings are the only places asking.
 */
import { releaseSharingPermission, requestSharingPermission } from "@/shared/browser";
import { send } from "@/shared/messages";

const answers = document.getElementById("answers") as HTMLElement;
const result = document.getElementById("result") as HTMLElement;

answers.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button.answer");
  if (!btn) return;
  const yes = btn.dataset.consent === "true";

  // Firefox asks its own question before anything is shared, and only inside this click, so
  // the request goes out before the first await. Chrome and Edge answer yes immediately.
  const permitted = yes ? requestSharingPermission() : releaseSharingPermission().then(() => false);

  for (const b of answers.querySelectorAll("button")) b.disabled = true;

  void permitted.then((allowed) => {
    const on = yes && allowed;
    result.textContent = on
      ? "Thank you. Sharing is on, and you can turn it off in Settings at any time."
      : yes
        ? "Firefox's permission was not given, so nothing will be shared. You can turn it on later in Settings."
        : "Understood. Nothing will be shared, and you can turn it on later in Settings.";

    return send({
      type: "set-settings",
      patch: { telemetryConsent: on, telemetryConsentAskedAt: Date.now() },
    });
  });
});

document.getElementById("options")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
