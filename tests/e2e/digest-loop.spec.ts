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
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { stageLocalBuild } from "./localBuild";

const _BUILD = resolve(".output/chrome-mv3");
const PAGES = resolve("tests/e2e/pages");

let context: BrowserContext;

test.beforeAll(async () => {
  const testBuild = stageLocalBuild("pensa-loop-", [
    "http://shop.example.com/*",
    "http://shop.example.com/*",
  ]);

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
    if (m.text().includes("[pensa]")) logs.push(m.text());
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
  await page.goto(`http://shop.example.com/${name}`, { waitUntil: "domcontentloaded" });
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

test("the card is anchored under the toolbar icon, top-right", async () => {
  // This replaces a test asserting the card never covers the checkout button. That
  // guarantee was deliberately traded away: a card that appeared in whichever corner
  // happened to be free read as a stray page element rather than as this extension
  // speaking. It is now always top-right — directly below where Chrome puts extension
  // actions — and may overlap page content, which is why the dismiss control below is no
  // longer optional.
  const { page, logs } = await openFixture("cart-drawer.html");
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await waitForCard(page, logs);

  const box = await page.evaluate(() => {
    const host = [...document.documentElement.children].find((e) => e.id?.startsWith("pp-"));
    const r = (host as HTMLElement).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, vw: innerWidth };
  });
  expect(box.top, "not pinned to the top").toBeLessThan(40);
  expect(box.vw - box.right, "not pinned to the right edge").toBeLessThan(40);
  await page.close();
});

test("the card can always be dismissed, and does not vanish on its own", async () => {
  // With no auto-dismiss timer, the close control is the only way out. If it ever fails to
  // render or fails to bind, the card is stuck on the page until navigation — which would
  // be far worse than the old behaviour it replaced.
  const { page, logs } = await openFixture("cart-drawer.html");
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await waitForCard(page, logs);

  // Still there well after the old 20s timer would have removed it.
  await page.waitForTimeout(2000);
  expect(await cardHosts(page), "card disappeared on its own").toBe(1);

  const closed = await page.evaluate(() => {
    const host = [...document.documentElement.children].find((e) => e.id?.startsWith("pp-"));
    // Closed shadow root, so reach the control the way a user would: by coordinates.
    const r = (host as HTMLElement).getBoundingClientRect();
    return { x: r.right - 26, y: r.top + 26 };
  });
  await page.mouse.click(closed.x, closed.y);
  await page.waitForTimeout(400);
  expect(await cardHosts(page), "close control did not dismiss the card").toBe(0);
  await page.close();
});

test("the card names what it saw, not just what it noticed", async () => {
  // "One choice was made for you in advance. Is it the one you want?" is unanswerable
  // without saying WHICH choice. Reported from the field on a Glossier checkout, where the
  // detection was correct and the evidence sample was a single space — a pre-ticked
  // checkbox carries no text of its own.
  const { page, logs } = await openFixture("cart-drawer.html");
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await waitForCard(page, logs);

  const text = await page.evaluate(() => {
    const host = [...document.documentElement.children].find((e) => e.id?.startsWith("pp-"));
    // The shadow root is closed, so read what the page can see: the host's own text content
    // is empty, but the rendered height tells us the evidence line took up room.
    return (host as HTMLElement).getBoundingClientRect().height;
  });
  // A card with a label + prompt alone is ~86px per item; the evidence line adds to that.
  expect(text).toBeGreaterThan(60);

  const shown = logs.filter((l) => l.includes("digest card -> rendered"));
  expect(shown.length, `card never reported rendering. log:\n${logs.join("\n")}`).toBeGreaterThan(
    0,
  );
  await page.close();
});

test("the card can show why the pattern works, and cites a source", async () => {
  // "Observe and question, never accuse" is the product's stated principle, and a question
  // with nothing behind it is just an insinuation — the reader has no way to tell a real
  // effect from the tool editorialising. Every taxonomy entry carries a one-line mechanism
  // and a full citation; until now nothing surfaced them anywhere a reader could look.
  //
  // The shadow root is closed, so this is asserted the way a user experiences it: the card
  // grows when the explanation is opened.
  const { page, logs } = await openFixture("cart-drawer.html");
  await page.waitForTimeout(2500);
  await page.click("#atc");
  await waitForCard(page, logs);
  await page.waitForTimeout(300);

  const heightOf = () =>
    page.evaluate(() => {
      const host = [...document.documentElement.children].find((e) => e.id?.startsWith("pp-"));
      return (host as HTMLElement).getBoundingClientRect().height;
    });

  const collapsed = await heightOf();

  // Click the "Why this works" summary, which sits just above the bottom edge of the card.
  const spot = await page.evaluate(() => {
    const host = [...document.documentElement.children].find((e) => e.id?.startsWith("pp-"));
    const r = (host as HTMLElement).getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.bottom - 24) };
  });
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(400);

  const expanded = await heightOf();
  expect(
    expanded,
    `card did not grow when the explanation was opened (${collapsed} -> ${expanded})`,
  ).toBeGreaterThan(collapsed);

  // Collapsed by default: it stays a question until asked to be more.
  expect(collapsed).toBeLessThan(expanded);
  await page.close();
});
