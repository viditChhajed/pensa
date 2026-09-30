/**
 * Which browser this is, for the few places that have to say so or behave differently.
 *
 * One Chromium build serves Chrome and Edge (the Edge store takes the Chrome zip as it is), so
 * Edge is told apart at runtime. Firefox gets its own build, so that is decided at compile
 * time and the Chromium bundle carries none of the Firefox branch.
 */

// Compared as a string because a test can only stub env values as strings; the build writes
// a literal `true` or `false` here either way, so the other browser's branch still drops out.
export const IS_FIREFOX = String(import.meta.env?.FIREFOX) === "true";

export type BrowserName = "Chrome" | "Edge" | "Firefox";

export function browserName(): BrowserName {
  if (IS_FIREFOX) return "Firefox";
  const nav = globalThis.navigator as
    | (Navigator & { userAgentData?: { brands?: { brand: string }[] } })
    | undefined;
  if (nav?.userAgentData?.brands?.some((b) => b.brand === "Microsoft Edge")) return "Edge";
  if (/\bEdg\//.test(nav?.userAgent ?? "")) return "Edge";
  return "Chrome";
}

/** Where a person goes to see what this browser lets Pensa do, in words they can follow. */
export function siteAccessHint(): string {
  switch (browserName()) {
    case "Firefox":
      return "Check Pensa's permissions in about:addons";
    case "Edge":
      return "Check Site access for Pensa in edge://extensions";
    default:
      return "Check Site access for Pensa in chrome://extensions";
  }
}

/**
 * What Firefox's built-in consent calls the opt-in reports. Declared as OPTIONAL in the
 * manifest (wxt.config.ts), so Firefox itself asks before anything is shared:
 *
 *   browsingActivity - the shop's registrable domain in every record
 *   websiteContent   - which techniques that shop's pages displayed
 *   websiteActivity  - whether the add-to-cart (or Reserve) button was clicked
 *
 * Mozilla requires new add-ons to route opt-in collection through this prompt, so on Firefox
 * Pensa's own Yes is not enough on its own: sharing is on only while BOTH say yes.
 */
export const DATA_COLLECTION = ["browsingActivity", "websiteContent", "websiteActivity"] as const;

type DataCollectionPermissions = { data_collection: string[] };
type FirefoxPermissions = {
  request(p: DataCollectionPermissions): Promise<boolean>;
  remove(p: DataCollectionPermissions): Promise<boolean>;
  contains(p: DataCollectionPermissions): Promise<boolean>;
};
const firefoxPermissions = (): FirefoxPermissions =>
  chrome.permissions as unknown as FirefoxPermissions;

/**
 * Ask Firefox for the sharing permission. Chrome and Edge have no such prompt and answer yes.
 *
 * MUST be the first thing a click handler does. Firefox only shows the prompt inside a user
 * gesture, and the gesture is gone after the first `await`.
 */
export function requestSharingPermission(): Promise<boolean> {
  if (!IS_FIREFOX) return Promise.resolve(true);
  return firefoxPermissions()
    .request({ data_collection: [...DATA_COLLECTION] })
    .catch(() => false);
}

/** Give the permission back when the person says no, so about:addons shows the same answer. */
export function releaseSharingPermission(): Promise<void> {
  if (!IS_FIREFOX) return Promise.resolve();
  return firefoxPermissions()
    .remove({ data_collection: [...DATA_COLLECTION] })
    .then(() => undefined)
    .catch(() => undefined);
}

/** Whether Firefox currently allows the reports. Always true on Chrome and Edge. */
export function hasSharingPermission(): Promise<boolean> {
  if (!IS_FIREFOX) return Promise.resolve(true);
  return firefoxPermissions()
    .contains({ data_collection: [...DATA_COLLECTION] })
    .catch(() => false);
}

/** True when a permissions change event touched the sharing permission. */
export function touchesSharing(p: unknown): boolean {
  const dc = (p as Partial<DataCollectionPermissions> | undefined)?.data_collection ?? [];
  return dc.some((d) => (DATA_COLLECTION as readonly string[]).includes(d));
}
