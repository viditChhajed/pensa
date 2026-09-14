/**
 * IndexedDB round-trip in REAL Chromium (closing the gap the review flagged).
 *
 * `src/background/db.ts` and `recordOffer.ts` had ZERO coverage. Every §18A test to date was
 * synthetic replay of pure functions — `mergeObservation` then `temporalCandidates` — which
 * proves the arithmetic and nothing about persistence. The real accumulation path
 * (IndexedDB write -> read-back -> claim) is the part likeliest to break in a browser, and
 * it is the only place BigInt money is stored rather than passed.
 *
 * jsdom cannot cover this: it has no real IndexedDB and no structured-clone semantics for
 * BigInt. It has to run here.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  const build = mkdtempSync(join(tmpdir(), "vero-store-"));
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

/** Run inside an extension page, which shares the extension's IndexedDB origin. */
async function inExtensionPage<T>(fn: string): Promise<T> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const result = (await page.evaluate(fn)) as T;
  await page.close();
  return result;
}

test("BigInt money survives a real IndexedDB round trip", async () => {
  // structured clone DOES carry BigInt (unlike JSON) — which is exactly why money is stored
  // raw here but must be string-encoded on the messaging boundary. Proving it, not assuming.
  const out = await inExtensionPage<{ back: string; type: string }>(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("probe-bigint", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("s", { keyPath: "k" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction("s", "readwrite");
      tx.objectStore("s").put({ k: "a", minor: 9007199254740993n });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    const got = await new Promise((res, rej) => {
      const tx = db.transaction("s", "readonly");
      const rq = tx.objectStore("s").get("a");
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
    return { back: String(got.minor), type: typeof got.minor };
  })()`);

  expect(out.type).toBe("bigint");
  expect(out.back).toBe("9007199254740993");
});

test("the offers store accumulates across visits and yields a temporal claim", async () => {
  const HOUR = 3_600_000;

  // NOTE: the messages are sent from an EXTENSION PAGE, not from the service worker.
  // chrome.runtime.sendMessage does not deliver to the sender's own onMessage listener, so
  // driving this from sw.evaluate() silently delivered nothing — which is what the first
  // version of this test did, and it looked exactly like a broken write path.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  const acks = await page.evaluate(async (hour) => {
    const send = (msg: unknown) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

    const observation = (now: number) => ({
      timers: [{ containerPathHash: "b".repeat(64), observedEndEpoch: now + 2 * hour }],
      stockCounts: [] as number[],
      viewerCounts: [] as number[],
      prices: [] as { minor: string; currency: string }[],
      referencePrices: [] as { minor: string }[],
    });

    const a = await send({
      type: "observation",
      origin: "http://localhost",
      offerKey: "sku:E2E",
      offerKeySource: "sku",
      observation: observation(0),
    });
    const b = await send({
      type: "observation",
      origin: "http://localhost",
      offerKey: "sku:E2E",
      offerKeySource: "sku",
      observation: observation(3 * hour),
    });
    return [a, b];
  }, HOUR);

  // A rejected payload returns {ok:false}; assert acceptance before blaming persistence.
  expect(acks, `worker rejected the observation: ${JSON.stringify(acks)}`).toEqual([
    { ok: true },
    { ok: true },
  ]);

  await page.waitForTimeout(500);

  const stored = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("vero");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains("offers")) return { sightings: 0, timers: 0 };
    const rows: { offerKey: string; sightings: number; timerSightings: unknown[] }[] =
      await new Promise((res, rej) => {
        const tx = db.transaction("offers", "readonly");
        const rq = tx.objectStore("offers").getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
    const row = rows.find((r) => r.offerKey === "sku:E2E");
    return { sightings: row?.sightings ?? 0, timers: row?.timerSightings.length ?? 0 };
  });

  await page.close();

  // The point: two separate messages accumulated into ONE persisted record, read back from
  // real IndexedDB rather than from memory.
  expect(stored.sightings, "observations did not accumulate in IndexedDB").toBe(2);
  expect(stored.timers, "timer sightings were not persisted").toBe(2);
});

test("delete all my data — CLICKED FROM THE OPTIONS UI — empties IndexedDB", async () => {
  // Deliberately drives the real button rather than calling clear-data directly. The
  // underlying handler was already covered; what was not covered is whether the control the
  // user actually sees is wired to it. A privacy control that is not connected to its button
  // is indistinguishable, from the user's side, from having no control at all.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  // Seed data so the assertion cannot pass against an already-empty store.
  await page.evaluate(async () => {
    const send = (msg: unknown) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    await send({
      type: "observation",
      origin: "http://localhost",
      offerKey: "sku:DELETE-ME",
      offerKeySource: "sku",
      observation: {
        timers: [],
        stockCounts: [7],
        viewerCounts: [],
        prices: [],
        referencePrices: [],
      },
    });
  });
  await page.waitForTimeout(400);

  const before = await countOffers(page);
  expect(before, "nothing to delete — the test would pass vacuously").toBeGreaterThan(0);

  // The actual user action.
  await page.locator("#clear").click();
  await expect(page.locator("#cleared")).toBeVisible();
  await page.waitForTimeout(600);

  expect(await countOffers(page), "clear-data left rows behind").toBe(0);

  // Settings and session state must go too, not just the offers table.
  const leftovers = await page.evaluate(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return { localKeys: Object.keys(local), sessionKeys: Object.keys(session) };
  });
  expect(
    leftovers.localKeys,
    `chrome.storage.local not cleared: ${leftovers.localKeys}`,
  ).not.toContain("settings");
  expect(
    leftovers.sessionKeys.filter((k) => k.startsWith("ledger:")),
    "session ledgers survived the wipe",
  ).toEqual([]);

  await page.close();
});

async function countOffers(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("vero");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains("offers")) return 0;
    return await new Promise<number>((res, rej) => {
      const tx = db.transaction("offers", "readonly");
      const rq = tx.objectStore("offers").count();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  });
}

test("an accumulated history produces a temporal claim in the digest", async () => {
  /**
   * The link the previous test does not cover.
   *
   * That one proves observations accumulate in IndexedDB. This proves an accumulated history
   * actually reaches a digest — a different claim, and precisely the gap that hid
   * pricing.drip for the whole build: its store worked, its engine passed its unit tests, and
   * nothing connected the two.
   *
   * Uses the stock detector rather than the countdown one for a practical reason:
   * `detectEvergreenCountdown` deliberately ignores sightings less than 60 SECONDS apart,
   * since those are the same page view and teach it nothing. That rule is right in production
   * and would make this test wait a minute of real time to prove nothing extra about the link
   * under test. A stock count that rises has no such requirement, and travels exactly the
   * same path: observation message -> store -> readOffer -> temporalCandidates -> digest.
   *
   * Absent a restock, "only N left" should be non-increasing. Rising twice is the claim.
   */
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  const result = await page.evaluate(async () => {
    const send = (msg: unknown) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    const origin = "http://localhost";
    const offerKey = "sku:RESTOCKER";

    for (const n of [2, 5, 9]) {
      await send({
        type: "observation",
        origin,
        offerKey,
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

    // Ask for a digest with NO page candidates at all. Anything that comes back can only
    // have come from the history.
    return await send({
      type: "candidates",
      origin,
      pathTemplate: "/x",
      stage: "pdp",
      items: [],
      offerKey,
      placement: { maxCardItems: 4, pillFits: true },
    });
  });

  await page.waitForTimeout(600);

  const events = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("vero");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows: { patternId: string }[] = await new Promise((res) => {
      const q = db.transaction("events", "readonly").objectStore("events").getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => res([]);
    });
    return rows.map((r) => r.patternId);
  });

  await page.close();

  expect(
    events,
    `no temporal claim reached the digest. reply: ${JSON.stringify(result)}; events: ${JSON.stringify(events)}`,
  ).toContain("temporal.stock_nonmonotonic");
});
