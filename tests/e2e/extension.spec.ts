/**
 * Real-browser verification (plan §7).
 *
 * Loads the ACTUAL built extension into real Chromium via a persistent context. Everything
 * before this file was jsdom, which computes no layout, no real styles, and no extension
 * runtime, so the whole class of bug the plan warns about (silent registration failures,
 * CSS bleed, forced synchronous layout) was structurally invisible until now.
 *
 * What this CANNOT cover, and why:
 *   - `chrome.permissions.request()` raises a NATIVE OS dialog, outside the page DOM and
 *     therefore undriveable by any browser automation. The gesture path (plan §1.4) needs
 *     a human. Everything downstream of a grant is covered here by granting through the
 *     extension's own APIs instead.
 *
 * Run: npm run test:e2e
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";

const EXTENSION_PATH = resolve(".output/chrome-mv3");

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error(`No build at ${EXTENSION_PATH}. Run: npm run build`);
  }

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  // The service worker's URL carries the extension id.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
});

test.describe("extension runtime", () => {
  test("service worker boots without throwing", async () => {
    const [sw] = context.serviceWorkers();
    expect(sw, "no service worker registered").toBeTruthy();
    expect(extensionId).toMatch(/^[a-z]{32}$/);
  });

  test("manifest as Chrome actually parsed it asks for https and nothing wider", async () => {
    const [sw] = context.serviceWorkers();
    const manifest = await sw?.evaluate(() => chrome.runtime.getManifest());

    /**
     * This assertion used to demand that `host_permissions` be EMPTY. The product decision
     * reversed: Pensa now asks for every https site at install and shows Chrome's warning.
     *
     * The assertion is still worth having, for a narrower reason. It pins the permission to
     * https exactly, not `<all_urls>`, not a scheme wildcard, so plain http pages and
     * non-web schemes stay outside what was granted, and a careless widening has to be
     * deliberate enough to edit this line.
     */
    expect(manifest?.host_permissions ?? []).toEqual(["https://*/" + "*"]);
    expect(manifest?.optional_host_permissions ?? []).toEqual([]);
    expect(manifest?.permissions).toEqual([
      "storage",
      "activeTab",
      // Added late, after the round-trip test revealed both alarms had been silent no-ops
      // for the whole build. It shows no install warning and grants no page or data access.
      "alarms",
    ]);
  });

  test("the declared content script carries the denylist as exclusions", async () => {
    /**
     * The load-bearing assertion of the new permission model.
     *
     * Once the broad permission is granted at install, `exclude_matches` is the only thing
     * that stops Chrome injecting Pensa into a bank. An empty or missing exclusion list would
     * not fail any other test in this suite, the extension would simply work, everywhere,
     * including where it must never run.
     */
    const [sw] = context.serviceWorkers();
    const manifest = await sw?.evaluate(() => chrome.runtime.getManifest());
    const scripts = manifest?.content_scripts ?? [];
    expect(scripts).toHaveLength(1);

    const excludes = scripts[0]?.exclude_matches ?? [];
    expect(excludes.length).toBeGreaterThan(50);

    // Whole hosts and their subdomains ARE expressible as match patterns, so these must be
    // refused by Chrome itself, before a line of Pensa's code runs on them.
    for (const host of ["chase.com", "bankofamerica.com", "irs.gov"]) {
      expect(
        excludes.includes(`https://*.${host}/*`),
        `${host} is not excluded from injection`,
      ).toBe(true);
    }

    /**
     * And the honest half, asserted so nobody later "fixes" it by widening a pattern.
     *
     * `mail.google.com` is denied, but it CANNOT appear here. The rule that catches it is
     * "a `mail.` label under any TLD", and a match pattern cannot express a wildcard TLD,
     * the only pattern that would cover it is `*.google.com`, which would also exclude every
     * other Google property and is a different rule from the one the denylist states.
     *
     * So Chrome does inject on it, and the runtime `isDenied()` check at the top of the
     * detector is what stops anything happening. That layer is not decoration; for this
     * whole class of rule it is the only thing there is.
     */
    expect(excludes.some((p) => p.includes("google"))).toBe(false);
  });

  test("holds the broad permission at install, without being asked", async () => {
    // Required, not optional: it is granted the moment the extension loads, with no prompt
    // and no popup interaction. That is the whole point of the change, so assert it.
    const [sw] = context.serviceWorkers();
    const granted = await sw?.evaluate(() => chrome.permissions.getAll());
    expect(granted?.origins ?? []).toContain("https://*/" + "*");
  });

  test("popup no longer offers enablement, because there is nothing to enable", async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator("h1")).toContainText("Pensa");
    // The grant button and the whole per-origin request flow are gone.
    await expect(page.locator("#enable")).toHaveCount(0);
    await page.close();
  });

  test("options page renders every control", async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(page.locator("#frequency input[type=radio]")).toHaveCount(4);
    await expect(page.locator("#telemetry")).not.toBeChecked();
    await expect(page.locator("#clear")).toBeVisible();
    await page.close();
  });
});

test.describe("grant -> register -> INJECT", () => {
  /**
   * The plan's §1.3 failure mode: `registerContentScripts` succeeding is not injection.
   * A registered script stays inert until the extension actually holds permission, and the
   * no-op looks identical to "the detector found nothing". Both halves are asserted.
   */
  test.skip("granting an origin registers the script AND injects it", async () => {
    // SKIPPED, and it must stay skipped: `chrome.permissions.request()` raises a NATIVE OS
    // dialog. It is not in the page DOM, so no browser automation can accept it, and calling
    // it from a service worker fails for want of a user gesture, which is itself a
    // real-browser confirmation of the plan's §1.4 finding.
    //
    // The path downstream of a grant IS covered, in injection.spec.ts, using a test-only
    // build that holds the origin at install. What remains unverifiable by machine is
    // exactly one link: that the popup button's click gesture survives to reach
    // request(). That needs a human, and MANUAL-VERIFICATION.md is the checklist for it.
    const [sw] = context.serviceWorkers();
    expect(sw).toBeTruthy();

    // Stand in for the native permission dialog, which automation cannot drive.
    const grantedOk = await sw?.evaluate(
      async () =>
        await new Promise<boolean>((res) => {
          chrome.permissions.request({ origins: ["https://example.com/*"] }, (g) => res(!!g));
        }),
    );
    expect(grantedOk, "optional permission not granted in automation").toBe(true);

    await sw?.evaluate(() => new Promise((r) => setTimeout(r, 1500)));

    const scripts = await sw?.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    expect(scripts?.length, "registration did not happen after grant").toBeGreaterThan(0);
    expect(scripts?.[0]?.matches).toContain("https://example.com/*");

    // Registration proven. Now prove INJECTION, which is a different fact.
    const page = await context.newPage();
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const injected = await page.evaluate(
      () => (globalThis as Record<string, unknown>).__pensaDetectorInjected__ === true,
    );
    expect(injected, "script registered but never injected, the §1.3 silent failure").toBe(true);
    await page.close();
  });
});
