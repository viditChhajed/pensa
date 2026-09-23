/**
 * The install page and the question it carries.
 *
 * The sharing setting lived only in Settings, which almost nobody opens. This asks once, at
 * install. What these pin down: it opens by itself on a fresh install, it changes nothing
 * until a button is pressed, the two answers are the same control (Pensa's own
 * `interference.visual_asymmetry` would flag anything else), and an answer here means the
 * first card does not ask again.
 */
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { stageLocalBuild } from "./localBuild";

let context: BrowserContext;
let extensionId: string;
let welcome: Page;

test.beforeAll(async () => {
  const build = stageLocalBuild("pensa-welcome-");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
    viewport: { width: 1280, height: 800 },
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  extensionId = new URL(sw.url()).host;

  // Opened by onInstalled, not by the test.
  const found = context.pages().find((p) => p.url().includes("welcome.html"));
  welcome = found ?? (await context.waitForEvent("page", { timeout: 15_000 }));
  await welcome.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await context?.close();
});

async function settings(): Promise<{
  telemetryConsent: boolean;
  telemetryConsentAskedAt?: number;
}> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const out = await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "get-settings" }, (r) => res(r))),
  );
  await page.close();
  return out as { telemetryConsent: boolean; telemetryConsentAskedAt?: number };
}

test("a fresh install opens the welcome page by itself", async () => {
  expect(welcome.url()).toContain("welcome.html");
  await expect(welcome.locator("h1")).toHaveText(
    "Do you opt in to sharing anonymous data to help a high schooler's research project?",
  );
});

test("it asks rather than assumes: nothing is set until a button is pressed", async () => {
  const before = await settings();
  expect(before.telemetryConsent).toBe(false);
  expect(before.telemetryConsentAskedAt).toBeUndefined();

  // Neither answer is preselected, and nothing is focused.
  const focused = await welcome.evaluate(() => document.activeElement?.tagName ?? "");
  expect(focused).not.toBe("BUTTON");
});

test("the two answers are the same control", async () => {
  const buttons = welcome.locator("button.answer");
  await expect(buttons).toHaveCount(2);
  await expect(buttons.nth(0)).toHaveText(/Yes/);
  await expect(buttons.nth(1)).toHaveText(/No/);

  const [yes, no] = await Promise.all([buttons.nth(0).boundingBox(), buttons.nth(1).boundingBox()]);
  expect(Math.round(yes?.width ?? 0)).toBe(Math.round(no?.width ?? 1));
  expect(Math.round(yes?.height ?? 0)).toBe(Math.round(no?.height ?? 1));

  // Same rendered weight and colour, so neither reads as the expected answer.
  const style = (i: number) =>
    buttons.nth(i).evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.fontWeight, s.color, s.backgroundColor, s.borderColor].join("|");
    });
  expect(await style(0)).toBe(await style(1));
});

test("answering yes turns sharing on and records that the question was asked", async () => {
  // Store-sized (1280x800), so the listing can show how consent is asked.
  await welcome.screenshot({ path: "store/screenshots/05-welcome.png", scale: "css" });
  await welcome.locator('button.answer[data-consent="true"]').click();
  await expect(welcome.locator("#result")).toContainText("Sharing is on");

  await expect.poll(async () => (await settings()).telemetryConsent).toBe(true);
  expect((await settings()).telemetryConsentAskedAt).toBeGreaterThan(0);
});

test("the detail is one click away, and closed until asked for", async () => {
  const details = welcome.locator("details");
  expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
  await expect(welcome.locator("summary")).toHaveText("More details");

  await welcome.locator("summary").click();
  const text = (await welcome.locator(".detail").innerText()).toLowerCase();
  for (const promise of ["the shop's domain", "whether you clicked add to cart", "the date"]) {
    expect(text, `missing from the details: ${promise}`).toContain(promise);
  }
  for (const never of ["your name", "any price", "not a shop"]) {
    expect(text, `missing from the details: ${never}`).toContain(never);
  }
});
