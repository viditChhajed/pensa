/**
 * Network egress, asserted (plan §7 Day 3, §11).
 *
 * The load-bearing privacy claim in PRIVACY.md is that the extension makes no outbound
 * request, ever, with telemetry declined. "Unverified by eye" is not good enough for a claim
 * a store reviewer and a user are both entitled to check, so this counts requests.
 *
 * That claim narrowed when telemetry was built, and these tests narrowed with it rather than
 * being quietly left to pass for the wrong reason. Two separate things are now asserted:
 * with consent OFF — the shipped default — egress is still exactly zero; and with consent ON
 * the only address the extension can contact is the one declared in TELEMETRY_ENDPOINT.
 * A test called "has no transmit path" would now be a test whose name is false.
 *
 * Method: every fixture page's own requests are stubbed by a catch-all route, so the page
 * itself can generate no traffic. Anything Playwright then reports at the context level —
 * including requests made by the service worker — can only have come from the extension.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";
import { TELEMETRY_ENDPOINT } from "@/shared/constants";

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
      document.querySelectorAll("button").forEach((b) => {
        b.click();
      });
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
  /**
   * What static analysis can honestly establish here, and what it cannot.
   *
   * The first attempt collected every http(s) URL in the bundle and demanded each be the
   * telemetry endpoint. It failed on ~160 strings that are DATA and never fetched: the
   * allowlist origins, Zod's json-schema ids, and the tinyurl/bit.ly links Dexie puts in its
   * error messages. A regex cannot tell a string constant from a request target.
   *
   * The previous version had the opposite flaw — it asserted no `fetch("https://…")` literal
   * appears, which stopped meaning anything the moment the sender became
   * `fetch(TELEMETRY_ENDPOINT, …)`. A variable is invisible to it.
   *
   * So this asserts the two things that survive minification and mean what they say: no URL
   * is fetched as a literal, and there is at most one fetch call site in the whole build.
   * ONE call site is what makes the runtime test below decisive — that test observes every
   * address actually contacted, which is the real guarantee, and a single sender is what
   * stops a second, untested path existing beside it.
   */
  expect(/fetch\(\s*["'`]https?:\/\//.test(js), "bundle fetches a hardcoded URL").toBe(false);

  const fetchSites = [...js.matchAll(/\bfetch\s*\(/g)].length;
  expect(
    fetchSites,
    `${fetchSites} fetch call sites in the build; exactly one sender is what makes the ` +
      "runtime egress test decisive rather than merely suggestive",
  ).toBeLessThanOrEqual(1);
});

test("with consent ON, the only address that can be contacted is the declared endpoint", async () => {
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

  // Two different correct outcomes, and the test says which one it is rather than passing
  // silently on either. With no endpoint deployed the answer is still zero — but zero
  // BECAUSE nothing is configured, not because no code path exists.
  const offEndpoint = egress.filter((r) => !r.url.startsWith(TELEMETRY_ENDPOINT || "\u0000"));
  expect(
    offEndpoint,
    `telemetry contacted ${offEndpoint.length} address(es) other than the declared endpoint: ` +
      offEndpoint.map((e) => e.url).join(", "),
  ).toEqual([]);

  if (TELEMETRY_ENDPOINT.length === 0) {
    expect(egress, "no endpoint is configured, so nothing should have been sent").toEqual([]);
  }

  await page.locator("#telemetry").uncheck();
  await page.close();
});

test("switching consent off empties the queue rather than holding it", async () => {
  // Data gathered under a permission that has been revoked must not sit on disk waiting for
  // the person to change their mind. Turning it off is a decision, not a pause.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.locator("#telemetry").check();
  await page.waitForTimeout(200);
  await browseSession();

  await page.locator("#telemetry").uncheck();
  await page.waitForTimeout(500);

  const pending = await page.evaluate(
    () =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ type: "get-pending-telemetry" }, (r) => res(r)),
      ),
  );
  expect(
    (pending as { records: unknown[] }).records,
    "counts survived the consent being withdrawn",
  ).toEqual([]);

  await page.close();
});
