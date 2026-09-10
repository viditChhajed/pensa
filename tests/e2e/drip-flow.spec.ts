/**
 * The cross-stage pipeline, end to end: PDP -> cart -> checkout, on one origin, in one
 * session, with fees that appear only at the last step.
 *
 * `pricing.drip` is the highest-severity pattern in the taxonomy and it has never fired —
 * not in any manual spot-check, and until now nothing exercised the whole chain it depends
 * on. That chain is long and every link has already broken at least once: the stage has to
 * be classified correctly (it was wrong 3 times in 4), a price snapshot has to be extracted
 * per stage, it has to survive the messaging boundary (a BigInt once made it throw
 * silently), the worker has to accumulate it into a per-origin ledger that outlives each
 * page, and the digest reply has to come back in the shape the page expects (it did not).
 *
 * Unit tests cover detectDrip against a hand-built ledger, which is exactly the kind of
 * green that hid the problem: the ledger it was given could not be produced by the code
 * that was supposed to produce it.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";

const BUILD = resolve(".output/chrome-mv3");
const PAGES = resolve("tests/e2e/pages");

let context: BrowserContext;

test.beforeAll(async () => {
  const testBuild = mkdtempSync(join(tmpdir(), "patterns-drip-"));
  cpSync(BUILD, testBuild, { recursive: true });
  const manifestPath = join(testBuild, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = ["http://localhost/*"];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${testBuild}`, `--load-extension=${testBuild}`],
    viewport: { width: 1280, height: 800 },
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
});

test.afterAll(async () => {
  await context?.close();
});

/** One page for the whole journey, so the origin and the session stay the same. */
async function openJourney(): Promise<{ page: Page; logs: string[] }> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("[patterns]")) logs.push(m.text());
  });
  await page.route("**/*", async (route) => {
    const name = new URL(route.request().url()).pathname.replace(/^\//, "");
    if (/^drip-[a-z]+\.html$/.test(name)) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: readFileSync(join(PAGES, name), "utf8"),
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  return { page, logs };
}

/** Everything the worker recorded, read straight out of IndexedDB. */
async function events(): Promise<{ patternId: string; stage: string; surfaced: boolean }[]> {
  const [sw] = context.serviceWorkers();
  if (!sw) return [];
  return (await sw.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("persuasion-patterns");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return await new Promise((res) => {
      const q = db.transaction("events", "readonly").objectStore("events").getAll();
      q.onsuccess = () =>
        res(
          q.result.map((e: Record<string, unknown>) => ({
            patternId: String(e.patternId),
            stage: String(e.funnelStage),
            surfaced: Boolean(e.surfaced),
          })),
        );
      q.onerror = () => res([]);
    });
  })) as { patternId: string; stage: string; surfaced: boolean }[];
}

test("fees disclosed only at checkout produce a pricing.drip finding", async () => {
  const { page, logs } = await openJourney();

  await page.goto("http://localhost/drip-pdp.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await page.waitForTimeout(2500);

  await page.goto("http://localhost/drip-cart.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  await page.goto("http://localhost/drip-checkout.html", { waitUntil: "domcontentloaded" });
  // Entering checkout is itself a trigger — no click required.
  await page.waitForTimeout(6000);

  const stageLines = logs.filter((l) => l.includes("stage ->")).join("\n");
  expect(stageLines, "never reached the checkout stage").toContain("stage -> checkout");

  const all = await events();
  const drip = all.filter((e) => e.patternId === "pricing.drip");
  expect(
    drip.length,
    `pricing.drip never fired.\nevents: ${JSON.stringify(all)}\nfull log:\n  ${logs.join("\n  ")}`,
  ).toBeGreaterThan(0);

  await page.close();
});
