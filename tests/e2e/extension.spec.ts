/**
 * Real-browser verification (plan §7).
 *
 * Loads the ACTUAL built extension into real Chromium via a persistent context. Everything
 * before this file was jsdom, which computes no layout, no real styles, and no extension
 * runtime — so the whole class of bug the plan warns about (silent registration failures,
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

  test("manifest as Chrome actually parsed it has no host permissions", async () => {
    const [sw] = context.serviceWorkers();
    const manifest = await sw?.evaluate(() => chrome.runtime.getManifest());
    // Not the file on disk — what the browser loaded.
    expect(manifest?.host_permissions ?? []).toEqual([]);
    expect(manifest?.content_scripts ?? []).toEqual([]);
    expect(manifest?.permissions).toEqual([
      "storage",
      "scripting",
      "activeTab",
      "declarativeContent",
      // Added late, after the round-trip test revealed both alarms had been silent no-ops
      // for the whole build. It shows no install warning and grants no page or data access.
      "alarms",
    ]);
    expect((manifest?.optional_host_permissions ?? []).length).toBeGreaterThan(100);
  });

  test("holds no host permissions at install", async () => {
    const [sw] = context.serviceWorkers();
    const granted = await sw?.evaluate(() => chrome.permissions.getAll());
    expect(granted?.origins ?? []).toEqual([]);
  });

  test("registers NO content script while no origin is granted", async () => {
    // Registration without permission would be an inert no-op that looks like success.
    const [sw] = context.serviceWorkers();
    const scripts = await sw?.evaluate(() =>
      chrome.scripting.getRegisteredContentScripts().catch(() => []),
    );
    expect(scripts ?? []).toEqual([]);
  });

  test("popup renders and offers enablement", async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator("h1")).toContainText("Persuasion Patterns");
    await expect(page.locator("#enable")).toBeAttached();
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
    // it from a service worker fails for want of a user gesture — which is itself a
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
      () => (globalThis as Record<string, unknown>).__patternsDetectorInjected__ === true,
    );
    expect(injected, "script registered but never injected — the §1.3 silent failure").toBe(true);
    await page.close();
  });
});
