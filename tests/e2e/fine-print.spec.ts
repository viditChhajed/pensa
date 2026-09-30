/**
 * Fine print does not become a card; a badge the page made prominent does.
 *
 * From the first human spot-check: Shein's "Almost sold out" was true and "written very small,
 * I didn't even notice it", yet it got a card. The rule (src/content/prominence.ts) is relative
 * to the page, because StubHub's wanted badges are just as small in pixels and stand out by
 * sitting in a pill. This proves real computed styles reach it, in both directions.
 */
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { closeWelcomeTab, stageLocalBuild } from "./localBuild";

let context: BrowserContext;

test.beforeAll(async () => {
  const build = stageLocalBuild("pensa-fine-");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
    viewport: { width: 1280, height: 800 },
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  await closeWelcomeTab(context);
  // Both one-time questions answered, so a card carries findings only.
  await sw.evaluate(() =>
    chrome.storage.local.set({
      settings: { telemetryConsentAskedAt: Date.now(), frequencyAskedAt: Date.now() },
    }),
  );
});

test.afterAll(async () => {
  await context?.close();
});

const page = (badge: string) => `<!doctype html><html><head><title>Wool Scarf</title>
  <script type="application/ld+json">{"@type":"Product","name":"Wool Scarf","offers":{"@type":"Offer","price":"48.00","priceCurrency":"USD"}}</script>
  <meta property="og:type" content="product">
  <style>body{font:16px system-ui;margin:24px;background:#fff} p{margin:8px 0}</style></head>
  <body><h1>Wool Scarf</h1><p>Soft merino, knitted in Scotland, one size.</p>
  <p>Hand wash cold and dry flat.</p><p>$48</p>${badge}
  <button id="atc" type="button">Add to cart</button></body></html>`;

async function open(name: string, badge: string): Promise<{ page: Page; logs: string[] }> {
  const p = await context.newPage();
  const logs: string[] = [];
  p.on("console", (m) => {
    if (m.text().includes("[pensa]")) logs.push(m.text());
  });
  await p.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === `/${name}`) {
      await route.fulfill({ status: 200, contentType: "text/html", body: page(badge) });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await p.goto(`http://shop.example.com/${name}`, { waitUntil: "domcontentloaded" });
  await p.bringToFront();
  return { page: p, logs };
}

const hasCard = (p: Page) =>
  p.evaluate(() => [...document.documentElement.children].some((e) => e.id?.startsWith("pp-")));

test("plain fine print is recorded but never becomes a card", async () => {
  const { page: p, logs } = await open(
    "fine.html",
    `<p style="font-size:11px;color:#777">Only 2 left in stock</p>`,
  );
  await p.waitForTimeout(3000);
  await p.click("#atc");
  // With nothing past the gate the trigger waits out its full window (TRIGGER_WINDOW_MS) for
  // something to qualify before it logs its decision, so wait for the line, not a fixed time.
  await expect
    .poll(() => logs.some((l) => l.includes("trigger add_to_cart")), { timeout: 15_000 })
    .toBe(true);
  await p.waitForTimeout(1000);
  const trigger = logs.find((l) => l.includes("trigger add_to_cart")) ?? "";
  expect(trigger, `the notice was not even detected. log:\n  ${logs.join("\n  ")}`).toContain(
    "scarcity.stock",
  );
  expect(trigger, "fine print passed the gate").toContain("gate=FAIL");
  expect(await hasCard(p), "fine print became a card").toBe(false);
  await p.close();
});

test("the same words in a small pill still become a card", async () => {
  const { page: p, logs } = await open(
    "pill.html",
    `<p><span style="font-size:12px;font-weight:500;background:#fee2e2;color:#b91c1c;padding:2px 8px;border-radius:9px">Only 2 left in stock</span></p>`,
  );
  await p.waitForTimeout(3000);
  await p.click("#atc");
  await expect
    .poll(() => hasCard(p), {
      timeout: 20_000,
      message: `no card for a pill badge. log:\n  ${logs.join("\n  ")}`,
    })
    .toBe(true);
  await p.close();
});
