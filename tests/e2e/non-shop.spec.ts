/**
 * A page that is not a shop leaves no trace, even when a shopping-shaped button is clicked.
 *
 * The add-to-cart/checkout listener used to be attached on every non-denied https page, and its
 * handler never checked whether the page had been judged a shop. So "Book now" or "Proceed to…"
 * on an ordinary article messaged the worker, wrote a session ledger holding the button's label,
 * and made the popup say the page was being checked. PRIVACY.md says a page that is not a shop is
 * never recorded; this is the test that makes that true.
 *
 * The positive control matters as much as the assertion: without it, a content script that
 * failed to inject at all would pass this test by doing nothing.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { stageLocalBuild } from "./localBuild";

const PAGES = resolve("tests/e2e/pages");
const ORIGIN = "http://shop.example.com";
let context: BrowserContext;

test.beforeAll(async () => {
  const build = stageLocalBuild("vero-nonshop-");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
});

test.afterAll(async () => {
  await context?.close();
});

async function open(name: string): Promise<{ page: Page; logs: string[] }> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/${name}`) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: readFileSync(join(PAGES, name), "utf8"),
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto(`${ORIGIN}/${name}`, { waitUntil: "domcontentloaded" });
  return { page, logs };
}

async function ledgerKeys(): Promise<string[]> {
  const [sw] = context.serviceWorkers();
  const all = (await sw?.evaluate(() => chrome.storage.session.get(null))) ?? {};
  return Object.keys(all).filter((k) => k.startsWith("ledger:"));
}

test("clicking Book now on a page that is not a shop records nothing", async () => {
  const { page, logs } = await open("not-a-shop.html");
  await expect
    .poll(() => logs.some((l) => l.includes("[vero] active on")), { timeout: 10_000 })
    .toBe(true);
  await page.waitForTimeout(1500);

  for (const id of ["#book", "#watch-video"]) await page.click(id);
  await page.getByRole("button", { name: "Proceed to the next article" }).click();
  await page.waitForTimeout(2500);

  expect(
    logs.some((l) => l.includes("commerce page")),
    "the article was judged a shop",
  ).toBe(false);
  expect(
    logs.some((l) => l.includes("[vero] trigger")),
    "a trigger fired on a non-shop",
  ).toBe(false);
  expect(await ledgerKeys()).toEqual([]);
  await page.close();
});

test("positive control: the same click on a real cart DOES reach the worker", async () => {
  const { page, logs } = await open("cart-drawer.html");
  await expect
    .poll(() => logs.some((l) => l.includes("commerce page")), { timeout: 10_000 })
    .toBe(true);
  await page
    .getByRole("button", { name: /add to (cart|bag)/i })
    .first()
    .click();
  await expect.poll(ledgerKeys, { timeout: 10_000 }).toContain(`ledger:${ORIGIN}`);
  await page.close();
});
