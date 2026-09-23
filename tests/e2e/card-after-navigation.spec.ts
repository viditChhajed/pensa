/**
 * An add-to-cart that navigates away must still end in a card.
 *
 * On a drawer site the card renders on the page that was clicked. On a site whose Add to Cart
 * is a form POST to a cart page, Amazon, WooCommerce, many Shopify themes, that page is
 * destroyed within a few hundred milliseconds of the click, and a card built after it has
 * nowhere to render.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { stageLocalBuild } from "./localBuild";

const PAGES = resolve("tests/e2e/pages");
let context: BrowserContext;

test.beforeAll(async () => {
  const build = stageLocalBuild("pensa-nav-");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
    viewport: { width: 1280, height: 800 },
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
});

test.afterAll(async () => {
  await context?.close();
});

async function open(start = "pdp-navigates.html"): Promise<{ page: Page; logs: string[] }> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("[pensa]")) logs.push(`${new URL(page.url()).pathname} ${m.text()}`);
  });
  await page.route("**/*", async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (["pdp-navigates.html", "cart-page.html", "cart-drawer.html"].includes(name)) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: readFileSync(join(PAGES, name), "utf8"),
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto(`http://shop.example.com/${start}`, { waitUntil: "domcontentloaded" });
  return { page, logs };
}

const hasCard = (page: Page) =>
  page.evaluate(() => [...document.documentElement.children].some((e) => e.id?.startsWith("pp-")));

test("a card appears after an add-to-cart that navigates to the cart page", async () => {
  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.storage.session.clear());
  const { page, logs } = await open();
  await page.waitForTimeout(2500); // the stock and viewer messages earn their dwell

  await Promise.all([page.waitForURL(/cart-page\.html/), page.click("#atc")]);

  await expect
    .poll(() => hasCard(page), {
      timeout: 20_000,
      message: `no card on the cart page. log:\n  ${logs.join("\n  ")}`,
    })
    .toBe(true);
  await page.close();
});

test("a card that WAS seen is not shown a second time on the next page", async () => {
  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.storage.session.clear());
  // A drawer site: the card renders on the page that was clicked, and stays.
  const { page, logs } = await open("cart-drawer.html");
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await expect.poll(() => hasCard(page), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(2500); // past the seen-confirmation

  await page.goto("http://shop.example.com/cart-page.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  expect(await hasCard(page), `card shown twice. log:\n  ${logs.join("\n  ")}`).toBe(false);
  await page.close();
});
