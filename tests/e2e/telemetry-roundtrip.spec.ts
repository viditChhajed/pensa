/**
 * The send path, end to end: real extension -> real HTTP -> the real sink handler.
 *
 * Every other telemetry test asserts something does NOT happen. That is the important half,
 * but it leaves the half that does happen completely unexercised — and a sender that has
 * never sent is a sender nobody has checked. `TELEMETRY_ENDPOINT` was hardcoded empty, so
 * the only way to exercise it was to edit the source, which is the same as not testing it.
 * It is a build-time value now, and this test builds with one.
 *
 * What it proves that a unit test cannot: that the batch survives JSON, chrome's alarm
 * plumbing and a real fetch from a service worker, and that what arrives is EXACTLY the
 * eight version-2 fields — checked by the same handler that would run in production, which
 * rejects anything else with a 422.
 */
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";
import { MIN_BATCH } from "@/shared/constants";
import { type CountRow, handle, type OutcomeRow } from "../../server/handler";
import { stageLocalBuild } from "./localBuild";

const PORT = 9911;
const ENDPOINT = `http://127.0.0.1:${PORT}/counts`;

let server: Server;
let context: BrowserContext;
let extensionId: string;

/** Everything the sink accepted, and every raw body it saw — including rejected ones. */
const stored: CountRow[] = [];
const storedOutcomes: OutcomeRow[] = [];
const bodies: unknown[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        bodies.push(JSON.parse(raw));
      } catch {
        bodies.push(raw);
      }
      // The SHIPPED handler, not a stub. A test sink that accepts anything would prove the
      // extension sent something and nothing about whether it was sendable.
      const response = await handle(
        new Request(ENDPOINT, {
          method: req.method ?? "POST",
          headers: { "content-type": req.headers["content-type"] ?? "" },
          body: raw,
        }),
        {
          increment: async (rows) => void stored.push(...rows),
          incrementOutcomes: async (rows) => void storedOutcomes.push(...rows),
        },
      );
      res.writeHead(response.status, { "access-control-allow-origin": "*" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));

  // Build WITH an endpoint. The default build has none, which is what every other test
  // relies on, so this one cannot share it.
  execFileSync("npm", ["run", "build"], {
    env: { ...process.env, TELEMETRY_ENDPOINT: ENDPOINT },
    stdio: "pipe",
  });

  // The sink is a permission, not a place to inject: the worker posts to it, no page there
  // is ever read.
  const build = stageLocalBuild(
    "vero-tele-",
    ["http://shop.example.com/*"],
    [`http://127.0.0.1:${PORT}/*`],
  );

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
  await new Promise<void>((r) => server?.close(() => r()));
  // Leave the tree in the state every other test expects: no endpoint.
  execFileSync("npm", ["run", "build"], {
    env: { ...process.env, TELEMETRY_ENDPOINT: "" },
    stdio: "pipe",
  });
});

test("a consented batch reaches the sink, and carries exactly eight fields", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator("#telemetry").check();
  await page.waitForTimeout(300);

  // Enough detections to clear the minimum batch size. Distinct evidence so nothing dedupes.
  const needed = MIN_BATCH + 5;
  await page.evaluate(async (n) => {
    const send = (msg: unknown) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    for (let i = 0; i < n; i++) {
      await send({
        type: "candidates",
        origin: "https://www.booking.com",
        pathTemplate: `/hotel/:slug`,
        stage: "pdp",
        items: [
          {
            candidate: {
              detectorId: "scarcity.stock@1",
              patternId: "scarcity.stock",
              rawScore: 0.85,
              subSignals: { numericStock: 1 },
              evidence: {
                selectorPath: `#n${i}`,
                textHash: String(i).padStart(64, "0"),
                matchedLexemes: ["only", "left"],
                boundingBox: { x: 0, y: 0, w: 100, h: 20 },
              },
              nodeRef: `#n${i}`,
            },
            salience: {
              visibleMs: 2000,
              viewportFraction: 0.5,
              scrollDepthAtFirstView: 0,
              ephemeral: false,
            },
            passedGate: true,
          },
        ],
        placement: { maxCardItems: 4, pillFits: true },
      });
    }
  }, needed);
  await page.waitForTimeout(800);

  // Fire the REAL alarm listener rather than reaching into the module, so the scheduled path
  // is what gets exercised — the six-hour timing is the thing that keeps a send from being
  // correlated with a detection, and it should not be bypassed by its own test.
  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.alarms.create("telemetry", { when: Date.now() + 500 }));
  await expect.poll(() => bodies.length, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);

  const body = bodies[0] as { v: number; records: Record<string, unknown>[] };
  expect(body.v).toBe(3);
  expect(body.records.length).toBeGreaterThanOrEqual(MIN_BATCH);

  // The sink returns 422 on an extra key, so anything in `stored` already passed the strict
  // check. Assert the shape here too, because a silently-empty store would otherwise read
  // as success.
  expect(stored.length, "the sink accepted nothing — it rejected the batch").toBeGreaterThan(0);
  for (const record of body.records) {
    expect(Object.keys(record).sort()).toEqual([
      "confidenceQuartile",
      "dayBucket",
      "detectorId",
      "funnelStage",
      "originCategory",
      "patternId",
      "rulepackVersion",
      "site",
    ]);
    // The site travels by design now — as the registrable domain and nothing finer.
    expect(record.site).toBe("booking.com");
  }

  // The absences, on the wire this time rather than on a constructed object. The site is
  // expected; the hostname, the path and the evidence are not.
  const wire = JSON.stringify(body);
  expect(wire).not.toContain("www.booking.com");
  expect(wire).not.toContain("/hotel/");
  expect(wire).not.toContain("#n1");
  expect(wire).not.toContain("hourBucket");

  // The queue is emptied by a successful send, or the next flush would send it all again.
  const pending = await page.evaluate(
    () =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ type: "get-pending-telemetry" }, (r) => res(r)),
      ),
  );
  expect((pending as { records: unknown[] }).records).toEqual([]);

  await page.close();
});

test("a page view's add-to-cart outcome reaches the sink as seven-field rows", async () => {
  bodies.length = 0;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  if (!(await page.locator("#telemetry").isChecked())) await page.locator("#telemetry").check();
  await page.waitForTimeout(300);

  // One view that showed two techniques and ended in an add, and enough filler views, ended
  // the same way, to clear the minimum batch.
  await page.evaluate(async (n) => {
    const send = (msg: unknown) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
    for (let i = 0; i < n; i++) {
      await send({
        type: "pageview",
        viewId: `view${String(i).padStart(8, "0")}`,
        origin: "https://www.shein.com",
        stage: "pdp",
        exposed: i === 0 ? ["urgency.countdown", "scarcity.stock"] : [],
        addedToCart: true,
      });
    }
  }, MIN_BATCH + 2);

  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.alarms.create("telemetry", { when: Date.now() + 500 }));
  await expect.poll(() => bodies.length, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);

  const body = bodies[0] as { v: number; outcomes: Record<string, unknown>[] };
  expect(body.v).toBe(3);
  expect(storedOutcomes.length, "the sink accepted no outcomes").toBeGreaterThan(0);
  for (const o of body.outcomes) {
    expect(Object.keys(o).sort()).toEqual([
      "addedToCart",
      "dayBucket",
      "funnelStage",
      "originCategory",
      "patternId",
      "rulepackVersion",
      "site",
    ]);
    expect(o.site).toBe("shein.com");
  }
  const patterns = body.outcomes.map((o) => o.patternId);
  expect(patterns.filter((p) => p === "_page")).toHaveLength(MIN_BATCH + 2);
  expect(patterns).toContain("urgency.countdown");
  expect(patterns).toContain("scarcity.stock");
  expect(JSON.stringify(body)).not.toContain("view0000");

  await page.close();
});
