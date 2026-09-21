/**
 * Browsing a shop is recorded, without a card and without clicking anything.
 *
 * Detections used to reach the event log ONLY when add-to-cart or checkout was clicked, so
 * everything a shop showed someone who looked and left was never written down — which made the
 * local summary, the export and the prevalence dataset all measures of the moment of adding to
 * cart rather than of what shops display.
 *
 * Two things are asserted, and the second matters as much as the first: rows appear from
 * browsing alone, and they do not multiply while the page sits open. A page runs many passes;
 * without per-page deduplication the log would grow for as long as a tab is left open.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { stageLocalBuild } from "./localBuild";

const PAGES = resolve("tests/e2e/pages");
const ORIGIN = "http://shop.example.com";
let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  const build = stageLocalBuild("pensa-passive-");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  extensionId = new URL(sw.url()).hostname;
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
});

test.afterAll(async () => {
  await context?.close();
});

interface Row {
  patternId: string;
  surfaced: boolean;
  suppressionReason: string;
  origin: string;
}

async function events(page: Page): Promise<Row[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("pensa");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains("events")) return [];
    return await new Promise<Row[]>((res, rej) => {
      const tx = db.transaction("events", "readonly");
      const rq = tx.objectStore("events").getAll();
      rq.onsuccess = () => res(rq.result as Row[]);
      rq.onerror = () => rej(rq.error);
    });
  });
}

test("browsing a shop records what it showed, once per piece of copy", async () => {
  const shop = await context.newPage();
  await shop.route("**/*", async (route) => {
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
  await shop.goto(`${ORIGIN}/cart-drawer.html`, { waitUntil: "domcontentloaded" });

  // Nothing is clicked. No add to cart, no checkout.
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/options.html`);

  await expect
    .poll(async () => (await events(reader)).length, {
      timeout: 20_000,
      message: "browsing produced no rows at all",
    })
    .toBeGreaterThan(0);

  const first = await events(reader);
  expect(first.every((r) => r.origin === ORIGIN)).toBe(true);
  // Nothing was shown, because nothing asked for a card.
  expect(first.every((r) => r.surfaced === false)).toBe(true);
  expect(first.some((r) => r.suppressionReason === "passive_scan")).toBe(true);

  // Let the page run several more passes, then confirm the log did not grow.
  await shop.waitForTimeout(6000);
  const second = await events(reader);
  expect(second.length, "rows multiplied while the page sat open").toBe(first.length);

  await shop.close();
  await reader.close();
});
