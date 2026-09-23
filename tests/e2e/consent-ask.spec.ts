/**
 * The one-time sharing question and the add-to-cart outcome, in the real built extension.
 *
 * The card lives in a CLOSED shadow root, so neither page script nor Playwright locators can
 * see inside it, deliberately. The accessibility tree can, because that is what a screen
 * reader reads, so the buttons are found and pressed the way assistive technology would find
 * them: by role and name through CDP.
 *
 * https, not http: outcome rows only ever name an https shop (see `siteOf`), so an http
 * fixture would prove the ask and nothing about the outcome.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type BrowserContext,
  type CDPSession,
  chromium,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { stageLocalBuild } from "./localBuild";

const PAGES = resolve("tests/e2e/pages");
const ORIGIN = "https://shop.example.com";
let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  const build = stageLocalBuild("pensa-consent-", ["https://shop.example.com/*"]);
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
    viewport: { width: 1280, height: 800 },
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
});

test.afterAll(async () => {
  await context?.close();
});

async function openShop(): Promise<{ page: Page; logs: string[] }> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("[pensa]")) logs.push(m.text());
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/cart-drawer.html") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: readFileSync(join(PAGES, "cart-drawer.html"), "utf8"),
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto(`${ORIGIN}/cart-drawer.html`, { waitUntil: "domcontentloaded" });
  return { page, logs };
}

async function waitForCard(page: Page, logs: string[]): Promise<void> {
  try {
    await page.waitForFunction(
      () => [...document.documentElement.children].some((e) => e.id?.startsWith("pp-")),
      undefined,
      { timeout: 15_000 },
    );
  } catch {
    throw new Error(`no card within 15s. log:\n  ${logs.join("\n  ")}`);
  }
}

interface AXNode {
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
}

async function buttons(cdp: CDPSession): Promise<Map<string, number>> {
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
  const out = new Map<string, number>();
  for (const n of nodes) {
    if (n.role?.value === "button" && n.name?.value && n.backendDOMNodeId) {
      out.set(n.name.value, n.backendDOMNodeId);
    }
  }
  return out;
}

async function press(page: Page, cdp: CDPSession, backendNodeId: number): Promise<void> {
  const { model } = (await cdp.send("DOM.getBoxModel", { backendNodeId })) as {
    model: { content: number[] };
  };
  const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

async function worker<T>(msg: unknown): Promise<T> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const out = await page.evaluate(
    (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))),
    msg,
  );
  await page.close();
  return out as T;
}

test("the first card asks once, with equal answers, and 'Yes' turns sharing on", async () => {
  const before = await worker<{ telemetryConsent: boolean }>({ type: "get-settings" });
  expect(before.telemetryConsent, "sharing must start off").toBe(false);

  const { page, logs } = await openShop();
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await waitForCard(page, logs);

  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");
  const found = await buttons(cdp);
  const yes = found.get("Yes, share");
  expect(yes, `answers not in the card. buttons: ${[...found.keys()].join(", ")}`).toBeDefined();
  expect(found.get("No thanks")).toBeDefined();

  // Equal weight, measured in the rendered page rather than asserted from the stylesheet.
  const size = async (id: number) => {
    const { model } = (await cdp.send("DOM.getBoxModel", { backendNodeId: id })) as {
      model: { width: number; height: number };
    };
    return [model.width, model.height];
  };
  expect(await size(yes as number)).toEqual(await size(found.get("No thanks") as number));

  await press(page, cdp, yes as number);
  await expect
    .poll(
      async () =>
        (await worker<{ telemetryConsent: boolean }>({ type: "get-settings" })).telemetryConsent,
    )
    .toBe(true);
  const after = await worker<{ telemetryConsentAskedAt?: number }>({ type: "get-settings" });
  expect(after.telemetryConsentAskedAt).toBeGreaterThan(0);

  // The add that produced this card happened BEFORE consent, so nothing about it is queued.
  const pending = await worker<{ records: Record<string, unknown>[] }>({
    type: "get-pending-telemetry",
  });
  expect(pending.records.filter((r) => "addedToCart" in r)).toEqual([]);
  await page.close();
});

test("once answered, the next card does not ask again", async () => {
  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.storage.session.clear()); // let a second card show
  const { page, logs } = await openShop();
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await waitForCard(page, logs);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const found = await buttons(cdp);
  expect(found.has("Yes, share")).toBe(false);
  expect(found.has("No thanks")).toBe(false);
  await page.close();
});

test("with sharing on, an add-to-cart ends the page view as outcome rows", async () => {
  // Self-contained: off then on empties the queue, so only this test's view is in it.
  await worker({ type: "set-settings", patch: { telemetryConsent: false } });
  await worker({ type: "set-settings", patch: { telemetryConsent: true } });
  const { page, logs } = await openShop();
  await page.waitForTimeout(3000); // long enough for on-screen copy to clear the 800ms gate
  await page.click("#atc");
  await page.waitForTimeout(800);

  const pending = await worker<{ records: Record<string, unknown>[] }>({
    type: "get-pending-telemetry",
  });
  const outcomes = pending.records.filter((r) => "addedToCart" in r);
  expect(outcomes.length, `no outcome rows queued. log:\n  ${logs.join("\n  ")}`).toBeGreaterThan(
    0,
  );
  // One view: one baseline row, plus the one technique that was on screen before the click.
  expect(outcomes.map((r) => r.patternId).sort()).toEqual(["_page", "anchoring.reference_price"]);
  for (const r of outcomes) {
    expect(r.addedToCart).toBe(true);
    expect(r.site).toBe("example.com");
    expect(["browse", "pdp"]).toContain(r.funnelStage);
    expect(Object.keys(r)).toHaveLength(7);
  }
  await page.close();
});
