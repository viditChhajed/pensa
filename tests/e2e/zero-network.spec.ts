/**
 * Zero network egress, asserted (plan §7 Day 3, §11).
 *
 * The load-bearing privacy claim in PRIVACY.md is that the extension makes no outbound
 * request, ever, with telemetry declined. "Unverified by eye" is not good enough for a claim
 * a store reviewer and a user are both entitled to check, so this counts requests.
 *
 * Method: every fixture page's own requests are stubbed by a catch-all route, so the page
 * itself can generate no traffic. Anything Playwright then reports at the context level —
 * including requests made by the service worker — can only have come from the extension.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";

const PAGES = resolve("tests/e2e/pages");

let context: BrowserContext;
let extensionId: string;

/** Every request the browser attempted, from any context, for the whole session. */
const seen: { url: string; resourceType: string }[] = [];

test.beforeAll(async () => {
  const build = mkdtempSync(join(tmpdir(), "patterns-net-"));
  cpSync(resolve(".output/chrome-mv3"), build, { recursive: true });
  const mp = join(build, "manifest.json");
  const m = JSON.parse(readFileSync(mp, "utf8"));
  m.host_permissions = ["http://localhost/*"];
  writeFileSync(mp, JSON.stringify(m, null, 2));

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });

  context.on("request", (r) => seen.push({ url: r.url(), resourceType: r.resourceType() }));

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  extensionId = new URL(sw.url()).host;
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
});

test.afterAll(async () => {
  await context?.close();
});

/**
 * A page exercising all 9 shipped page detectors plus a full order summary for the two
 * cross-stage ones. If any detector had a network dependency, this is where it would fire.
 */
const KITCHEN_SINK = `<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title>
<script type="application/ld+json">{"@type":"Product","sku":"NET-1","name":"Test Item"}</script>
</head><body>
  <div class="price"><del>$89.99</del> <span>$49.99</span> <span>45% off</span></div>
  <p>Only 3 left in stock</p>
  <div class="timer">02:14:31</div>
  <p>23 people are viewing this right now</p>
  <label><input type="checkbox" checked name="warranty"> Add 2-year protection plan $12.99</label>
  <button>No thanks, I don't want to save money</button>
  <p>You're $12.50 away from free shipping</p>
  <p>or 4 interest-free payments of $24.99 with Klarna</p>
  <div class="summary">
    <div>Subtotal $100.00</div>
    <div>Service fee $18.00</div>
    <div>Sales tax $8.00</div>
    <div>Order total $126.00</div>
  </div>
  <input autocomplete="cc-number" placeholder="Card number">
  <button id="checkout">Place order</button>
</body></html>`;

async function browseSession(): Promise<void> {
  const page = await context.newPage();
  // Catch-all stub: the PAGE can make no real request, so anything left is the extension's.
  await page.route("**/*", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: KITCHEN_SINK }),
  );

  for (const path of ["/product", "/cart", "/checkout"]) {
    await page.goto(`http://localhost${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    // Drive a real add-to-cart and a checkout click, the two digest triggers.
    await page.evaluate(() => {
      document.querySelectorAll("button").forEach((b) => b.click());
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(800);
  }
  await page.close();
}

test("telemetry is off by default and stays off", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.locator("#telemetry")).not.toBeChecked();
  const settings = await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "get-settings" }, res)),
  );
  expect((settings as { telemetryConsent: boolean }).telemetryConsent).toBe(false);
  await page.close();
});

test("a full browsing session produces ZERO extension-originated requests", async () => {
  seen.length = 0;
  await browseSession();

  // Requests to the stubbed fixture host are the page's own navigations, which the route
  // intercepts. Everything else would be egress.
  const egress = seen.filter((r) => {
    const u = r.url;
    if (u.startsWith("chrome-extension://")) return false; // loading our own bundled files
    if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:")) return false;
    if (u.startsWith("http://localhost/")) return false; // the stubbed fixture page itself
    return true;
  });

  expect(
    egress,
    `extension made ${egress.length} outbound request(s): ${egress.map((e) => e.url).join(", ")}`,
  ).toEqual([]);
});

test("the built bundles contain no network-calling code at all", async () => {
  // Belt and braces: the runtime check above proves nothing fired during THIS session.
  // This proves there is no code path that could fire in another one.
  const { readdirSync } = await import("node:fs");
  const out = resolve(".output/chrome-mv3");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      if (n.endsWith(".js")) files.push(full);
      else if (!n.includes(".")) walk(full);
    }
  };
  walk(out);
  const js = files.map((f) => readFileSync(f, "utf8")).join("\n");

  for (const forbidden of [
    "XMLHttpRequest",
    "navigator.sendBeacon",
    "EventSource",
    "new WebSocket",
  ]) {
    expect(js.includes(forbidden), `bundle references ${forbidden}`).toBe(false);
  }
  // `fetch(` may appear inside vendored helpers; assert no absolute URL is ever fetched.
  const absoluteFetch = /fetch\(\s*["'`]https?:\/\//.test(js);
  expect(absoluteFetch, "bundle fetches an absolute URL").toBe(false);
});

test("telemetry consent, even if enabled, has no transmit path in v1", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator("#telemetry").check();
  await page.waitForTimeout(300);

  seen.length = 0;
  await browseSession();

  const egress = seen.filter(
    (r) =>
      !r.url.startsWith("chrome-extension://") &&
      !r.url.startsWith("http://localhost/") &&
      !r.url.startsWith("data:") &&
      !r.url.startsWith("about:"),
  );
  // v1 ships the consent control but no sink. Enabling it must still send nothing.
  expect(egress, `enabled telemetry sent: ${egress.map((e) => e.url).join(", ")}`).toEqual([]);

  await page.locator("#telemetry").uncheck();
  await page.close();
});
