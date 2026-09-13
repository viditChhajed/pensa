/**
 * The off switch, driven from the control the user actually sees.
 *
 * `disabledDetectors` was honoured by the digest from the day it was written, and for that
 * whole time no UI could set it: the §10 escape hatch — "raise thresholds or default-disable
 * anything noisy" — existed only in code nobody could reach. `tests/unit/settingsCoverage`
 * proves every shipped pattern is OFFERED a switch. This proves the switch is CONNECTED, and
 * that turning it off means what the settings page says it means: not shown, and not
 * recorded either.
 *
 * The distinction is the point. A control that merely hides a finding while a local database
 * keeps accumulating rows for it would be, from the user's side, the same kind of thing this
 * extension exists to point out.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { PATTERN_GROUPS } from "@/entrypoints/options/groups";

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  const build = mkdtempSync(join(tmpdir(), "patterns-settings-"));
  cpSync(resolve(".output/chrome-mv3"), build, { recursive: true });
  const mp = join(build, "manifest.json");
  const m = JSON.parse(readFileSync(mp, "utf8"));
  m.host_permissions = ["http://localhost/*"];
  writeFileSync(mp, JSON.stringify(m, null, 2));

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
});

test.afterAll(async () => {
  await context?.close();
});

/** Seed a rising stock history and ask for a digest with no page candidates at all. */
async function historyDigest(page: Page, offerKey: string): Promise<unknown> {
  return page.evaluate(async (key) => {
    const send = (msg: unknown) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    for (const n of [2, 5, 9]) {
      await send({
        type: "observation",
        origin: "http://localhost",
        offerKey: key,
        offerKeySource: "sku",
        observation: {
          timers: [],
          stockCounts: [n],
          viewerCounts: [],
          prices: [],
          referencePrices: [],
        },
      });
    }
    return await send({
      type: "candidates",
      origin: "http://localhost",
      pathTemplate: "/x",
      stage: "pdp",
      items: [],
      offerKey: key,
      placement: { maxCardItems: 4, pillFits: true },
    });
  }, offerKey);
}

async function recordedPatterns(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("persuasion-patterns");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains("events")) return [];
    const rows: { patternId: string }[] = await new Promise((res) => {
      const q = db.transaction("events", "readonly").objectStore("events").getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => res([]);
    });
    return rows.map((r) => r.patternId);
  });
}

test("every shipped pattern renders a switch, and all of them start on", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForSelector("#patterns input[data-pattern]");

  const expected = PATTERN_GROUPS.flatMap((g) => g.ids);
  const rendered = await page.$$eval("#patterns input[data-pattern]", (els) =>
    els.map((e) => ({
      id: (e as HTMLInputElement).dataset.pattern ?? "",
      on: (e as HTMLInputElement).checked,
    })),
  );

  expect(rendered.map((r) => r.id).sort(), "settings page did not render the shipped set").toEqual(
    [...expected].sort(),
  );
  // Default-on is the product decision; a default-off detector would be indistinguishable
  // from a broken one to anyone who never opens this page.
  expect(
    rendered.filter((r) => !r.on).map((r) => r.id),
    "something shipped switched off by default",
  ).toEqual([]);

  await page.close();
});

test("switching a pattern off — CLICKED FROM THE UI — stops it being shown AND recorded", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForSelector("#patterns input[data-pattern]");

  // Baseline first, so a later empty result cannot be mistaken for a path that never worked.
  const before = await historyDigest(page, "sku:SWITCH-BASELINE");
  await page.waitForTimeout(600);
  expect(
    JSON.stringify(before),
    "the digest never produced this claim even with the switch ON — the test would pass vacuously",
  ).toContain("temporal.stock_nonmonotonic");
  expect(await recordedPatterns(page)).toContain("temporal.stock_nonmonotonic");

  // Clear the slate so the post-switch assertion is about NEW rows, not surviving ones.
  await page.locator("#clear").click();
  await expect(page.locator("#cleared")).toBeVisible();
  await page.waitForTimeout(600);

  // Clearing data resets settings, so the page must be re-read before the click.
  await page.reload();
  await page.waitForSelector("#patterns input[data-pattern]");

  // The actual user action.
  const box = page.locator('#patterns input[data-pattern="temporal.stock_nonmonotonic"]');
  await box.uncheck();
  await page.waitForTimeout(400);

  const stored = await page.evaluate(
    async () =>
      await new Promise((res) =>
        chrome.runtime.sendMessage({ type: "get-settings" }, (s) => res(s)),
      ),
  );
  expect(
    (stored as { disabledDetectors?: string[] })?.disabledDetectors ?? [],
    "the checkbox did not reach the stored settings",
  ).toContain("temporal.stock_nonmonotonic");

  const after = await historyDigest(page, "sku:SWITCH-DISABLED");
  await page.waitForTimeout(600);

  expect(JSON.stringify(after), "a switched-off pattern was still shown").not.toContain(
    "temporal.stock_nonmonotonic",
  );
  expect(
    await recordedPatterns(page),
    "a switched-off pattern was still written to the local database",
  ).not.toContain("temporal.stock_nonmonotonic");

  await page.close();
});
