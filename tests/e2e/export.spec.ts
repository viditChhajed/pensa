/**
 * The export control, driven from the UI a person actually clicks (plan T31).
 *
 * The events table has been the prevalence substrate since day one and there was no way to
 * get anything out of it, so "the data is being collected" was true and useless. What this
 * asserts is the part that makes it useful: the button exists, it is wired, it produces a
 * real file, and the file parses into rows that carry the fields prevalence work needs.
 *
 * Driving the button rather than calling `export-events` directly, for the same reason the
 * delete test does: the handler was the easy half. A control that is not connected to its
 * handler is, from the user's side, indistinguishable from having no control at all.
 */
import { readFileSync } from "node:fs";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { stageLocalBuild } from "./localBuild";

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  const build = stageLocalBuild("pensa-export-");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  extensionId = new URL(sw.url()).hostname;
});

test.afterAll(async () => {
  await context?.close();
});

/** Dexie creates the store lazily; one worker round trip is enough to force the upgrade. */
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
              const r = indexedDB.open("pensa");
              r.onsuccess = () => res(r.result.objectStoreNames.contains("events"));
              r.onerror = () => res(false);
            }),
        ),
      { timeout: 10_000, message: "the worker never created the events store" },
    )
    .toBe(true);
}

async function seed(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("pensa");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction("events", "readwrite");
    const store = tx.objectStore("events");
    for (let i = 0; i < count; i++) {
      store.put({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        sessionId: "11111111-1111-4111-8111-111111111111",
        origin: i % 2 === 0 ? "https://www.booking.com" : "https://www.ulta.com",
        pathTemplate: "/p/:slug",
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
          textSample: "Only 3 left at this price",
          matchedLexemes: ["only", "left"],
          boundingBox: { x: 0, y: 0, w: 10, h: 10 },
        },
        rulepackVersion: "1",
        detectorVersion: "1",
        ts: Date.now() - i * 60_000,
      });
    }
    await new Promise<void>((res) => {
      tx.oncomplete = () => res();
    });
  }, n);
}

test("Export my data — CLICKED FROM THE OPTIONS UI — downloads parseable JSONL", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await ensureSchema(page);
  await seed(page, 6);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.click("#export"),
  ]);

  expect(download.suggestedFilename()).toMatch(/^pensa-events-\d{4}-\d{2}-\d{2}\.jsonl$/);

  const path = await download.path();
  expect(path, "the download produced no file on disk").toBeTruthy();
  const text = readFileSync(path as string, "utf8");

  const lines = text.trim().split("\n");
  expect(lines).toHaveLength(6);

  // One JSON object per line is the whole point of the format — assert it parses line by
  // line, not as a blob, because that is how jq and pandas will read it.
  const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const r of rows) {
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining([
        "ts",
        "origin",
        "pathTemplate",
        "patternId",
        "funnelStage",
        "confidence",
        "surfaced",
        "suppressionReason",
      ]),
    );
  }

  // The origin is retained deliberately: without it per-site prevalence cannot be computed,
  // and this file never leaves the device unless a person moves it. The telemetry record is
  // the one that strips it.
  expect(new Set(rows.map((r) => r.origin)).size).toBe(2);
  expect(rows.some((r) => r.surfaced === false)).toBe(true);
  expect(rows.some((r) => r.suppressionReason === "placement_suppressed")).toBe(true);

  // The confirmation line has to be true, not merely reassuring.
  await expect(page.locator("#exported")).toContainText("6 detection(s) across 2 site(s)");
  await page.close();
});

test("exporting an empty store says so rather than downloading nothing", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await ensureSchema(page);
  await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "clear-data" }, res)),
  );

  await page.click("#export");
  await expect(page.locator("#exported")).toContainText("nothing to export");
  await page.close();
});
