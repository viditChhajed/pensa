/**
 * The whole loop, end to end, in one test: candidate found -> gate passed -> digest built ->
 * worker replies -> card renders in the page.
 *
 * Every other test in this suite covers one link. That is exactly how the product shipped
 * for six manual sessions without ever showing a card: each link was green on its own while
 * the chain was broken in three places at once (stage misclassified, post-click wait too
 * short for an async drawer, and freshly-discovered nodes unable to satisfy a dwell gate).
 *
 * So this asserts the OUTCOME — a card host in the DOM — and not any intermediate step.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";

const BUILD = resolve(".output/chrome-mv3");
const PAGES = resolve("tests/e2e/pages");

let context: BrowserContext;

test.beforeAll(async () => {
  const testBuild = mkdtempSync(join(tmpdir(), "patterns-loop-"));
  cpSync(BUILD, testBuild, { recursive: true });
  const manifestPath = join(testBuild, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // The native permission dialog cannot be driven by automation, so the grant is baked in.
  // Everything downstream of a grant is what this test is about.
  manifest.host_permissions = ["http://localhost/*", "http://127.0.0.1/*"];
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

test.beforeEach(async () => {
  // One digest per origin per stage per session is correct product behaviour and ruinous
  // for test isolation: every test here uses the same origin and the same stage, so without
  // this the second and third are debounced by the first and fail as `mode=suppressed`.
  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.storage.session.clear());
});

async function openFixture(name: string): Promise<{ page: Page; logs: string[] }> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("[patterns]")) logs.push(m.text());
  });
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
  await page.goto(`http://localhost/${name}`, { waitUntil: "domcontentloaded" });
  return { page, logs };
}

/**
 * Wait for a card, and on failure fail with the extension's own log rather than a bare
 * timeout. The log is the diagnosis; a timeout is just the symptom.
 */
async function waitForCard(page: Page, logs: string[]): Promise<void> {
  try {
    await page.waitForFunction(
      () => [...document.documentElement.children].some((e) => e.id?.startsWith("pp-")),
      undefined,
      { timeout: 15_000 },
    );
  } catch {
    throw new Error(`no card rendered within 15s. extension log:\n  ${logs.join("\n  ")}`);
  }
}

/** Card hosts carry a random id, so match the prefix rather than a fixed selector. */
const cardHosts = (page: Page) =>
  page.evaluate(
    () => [...document.documentElement.children].filter((e) => e.id?.startsWith("pp-")).length,
  );

test("add to cart on a Shopify-shaped drawer renders a card", async () => {
  const { page, logs } = await openFixture("cart-drawer.html");
  await page.waitForTimeout(2500);

  expect(await cardHosts(page), "a card appeared before any trigger").toBe(0);

  await page.click("#atc");
  // The digest polls for up to 5s waiting for the drawer and for dwell to accrue.
  await waitForCard(page, logs);

  expect(await cardHosts(page), `no card. log:\n${logs.join("\n")}`).toBe(1);

  // It has to be readable, not merely present: a closed shadow root that rendered nothing
  // would still satisfy the host check above.
  const box = await page.evaluate(() => {
    const host = [...document.documentElement.children].find((e) => e.id?.startsWith("pp-"));
    const r = host?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
  expect(box, "card host had no box").not.toBeNull();
  expect(box?.w ?? 0).toBeGreaterThan(100);
  expect(box?.h ?? 0).toBeGreaterThan(30);

  await page.close();
});

test("the stage is classified as cart once the drawer opens", async () => {
  const { page, logs } = await openFixture("cart-drawer.html");
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await page.waitForTimeout(4000);

  const stageLines = logs.filter((l) => l.includes("stage ->"));
  expect(stageLines.join("\n"), "never reclassified as cart").toContain("stage -> cart");
  await page.close();
});

test("the card does not cover the checkout button", async () => {
  const { page, logs } = await openFixture("cart-drawer.html");
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await waitForCard(page, logs);

  const covered = await page.evaluate(() => {
    const host = [...document.documentElement.children].find((e) => e.id?.startsWith("pp-"));
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Checkout",
    );
    if (!btn) return "no checkout button in fixture";
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === host ? "COVERED" : "clear";
  });
  expect(covered).toBe("clear");
  await page.close();
});
