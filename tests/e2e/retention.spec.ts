import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { stageLocalBuild } from "./localBuild";

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  const build = stageLocalBuild("vero-retain-", ["http://shop.example.com/*"]);

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
});

test.afterAll(async () => {
  await context?.close();
});

/**
 * Make the worker create the Dexie schema before the page tries to write to it.
 *
 * Dexie only runs its upgrade when something actually opens the database, so in a fresh
 * profile the `events` store does not exist yet and `indexedDB.open()` from the page returns
 * a version-less database with no stores. Seeding then fails with NotFoundError.
 *
 * This passed in isolation and failed in the full suite, which is the signature of a test
 * that depends on timing rather than on state: alone, something had already warmed the
 * database. `get-summary` reaches `readEvents` -> `getDb()`, so one call is enough, and this
 * polls rather than sleeping because "long enough" is how the same bug comes back.
 */
async function ensureSchema(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "get-summary" }, res)),
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<boolean>((res) => {
              const r = indexedDB.open("vero");
              r.onsuccess = () => res(r.result.objectStoreNames.contains("events"));
              r.onerror = () => res(false);
            }),
        ),
      { timeout: 10_000, message: "the worker never created the events store" },
    )
    .toBe(true);
}

/** Write events straight into the store, with ages a real session could never produce. */
async function seed(page: Page, ages: number[]): Promise<void> {
  await page.evaluate(async (dayOffsets) => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("vero");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    dayOffsets.forEach((days, i) => {
      store.put({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        sessionId: "11111111-1111-4111-8111-111111111111",
        origin: "https://www.booking.com",
        pathTemplate: "/x",
        detectorId: "scarcity.stock@1",
        patternId: "scarcity.stock",
        confidence: 0.85,
        confidenceBasis: "hand_set",
        salience: {
          visibleMs: 2000,
          viewportFraction: 0.5,
          scrollDepthAtFirstView: 0,
          ephemeral: false,
        },
        surfaced: i % 2 === 0,
        suppressionReason: i % 2 === 0 ? "none" : "placement_suppressed",
        funnelStage: "pdp",
        evidence: {
          selectorPath: `#n${i}`,
          textHash: String(i).padStart(64, "0"),
          matchedLexemes: ["only"],
          boundingBox: { x: 0, y: 0, w: 10, h: 10 },
        },
        rulepackVersion: "1",
        detectorVersion: "1",
        ts: Date.now() - days * 86_400_000,
      });
    });
    await new Promise<void>((res) => {
      tx.oncomplete = () => res();
    });
  }, ages);
}

async function countEvents(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("vero");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains("events")) return 0;
    return new Promise<number>((res) => {
      const q = db.transaction("events", "readonly").objectStore("events").count();
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(-1);
    });
  });
}

test("the summary counts detections, and splits noticed from shown", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await ensureSchema(page);
  // Clear first. `detected` is an exact count, so anything already in the store — including
  // rows the extension itself recorded while another spec ran — would make this flaky in one
  // direction only, which is the worst kind.
  await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "clear-data" }, res)),
  );
  await page.waitForTimeout(400);
  await seed(page, [0, 0, 0, 1, 1, 2]);

  const summary = (await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "get-summary" }, res)),
  )) as { rows: { patternId: string; detected: number; surfaced: number; origins: number }[] };

  const row = summary.rows.find((r) => r.patternId === "scarcity.stock");
  expect(row, "the store recorded nothing at all").toBeTruthy();

  // The Noticed/Shown split is the whole point of the summary: a detector with plenty of
  // "noticed" and little "shown" is working, and the gap is what says why you did not see it.
  // Only today's three are in the 24-hour window the options page asks for.
  expect(row?.detected).toBe(3);
  expect(row?.surfaced).toBeLessThan(row?.detected ?? 0);
  expect(row?.origins).toBe(1);

  await page.close();
});

test("events past the retention window are deleted BY THE REAL ALARM", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await ensureSchema(page);

  // Clear first, so this cannot pass on a store that was empty to begin with.
  await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "clear-data" }, res)),
  );
  await page.waitForTimeout(400);

  // Default retention is 30 days. Two inside, three well outside.
  await seed(page, [1, 29, 31, 90, 400]);
  expect(await countEvents(page), "seeding did not write").toBe(5);

  // Fire the housekeeping alarm itself rather than calling pruneEvents. That the function
  // works was never in doubt; whether anything ever calls it is exactly what failed.
  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.alarms.create("housekeeping", { when: Date.now() + 300 }));

  await expect
    .poll(() => countEvents(page), { timeout: 15_000, message: "nothing was pruned" })
    .toBe(2);

  await page.close();
});

test("the retention setting is honoured, not just the default", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await ensureSchema(page);
  await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "clear-data" }, res)),
  );
  await page.waitForTimeout(400);

  await page.evaluate(
    () =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ type: "set-settings", patch: { retentionDays: 7 } }, res),
      ),
  );
  await seed(page, [1, 5, 10, 40]);

  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.alarms.create("housekeeping", { when: Date.now() + 300 }));

  // A shorter window must delete more, or the setting is decorative.
  await expect.poll(() => countEvents(page), { timeout: 15_000 }).toBe(2);

  await page.evaluate(
    () =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ type: "set-settings", patch: { retentionDays: 30 } }, res),
      ),
  );
  await page.close();
});
