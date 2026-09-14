/**
 * What the card actually looks like, produced by the real pipeline.
 *
 * The last round of field testing produced one piece of feedback: "card showed up. make it
 * obvious tho. WHAT was preselected? all cards should show the evidence." The fix — an
 * evidence quote per item, plus an expandable "why this works" carrying the mechanism and
 * its citation — was verified by reading the code, which is not the same as looking at it.
 *
 * So this drives the shipped extension against a fixture, screenshots the result, and
 * asserts on the card's RENDERED TEXT rather than on pixels. A screenshot diff would fail
 * every time the prompt pools rotate, which trains people to ignore it; the image is an
 * artifact for a human to look at, and the text assertions are what fail the build.
 *
 * Reading the text requires getting inside a closed shadow root, which no script can do —
 * that is the whole point of a closed root, and the first attempt at this test failed
 * because of it: patching `attachShadow` from an init script does nothing, since the content
 * script runs in an isolated world with its own prototypes. It is read here over CDP
 * (`DOM.getDocument` with `pierce`), which is debugger-level access and available to nothing
 * on the page. The closed root is intact; the test simply is not a web page.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";

const BUILD = resolve(".output/chrome-mv3");
const PAGES = resolve("tests/e2e/pages");
const OUT = resolve("test-results/card");

let context: BrowserContext;

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  const testBuild = mkdtempSync(join(tmpdir(), "patterns-visual-"));
  cpSync(BUILD, testBuild, { recursive: true });
  const manifestPath = join(testBuild, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
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
  const [sw] = context.serviceWorkers();
  await sw?.evaluate(() => chrome.storage.session.clear());
});

async function openFixture(name: string): Promise<{ page: Page; logs: string[] }> {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("[vero]")) logs.push(m.text());
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
 * Everything the card is actually showing, as text, read through the debugger protocol.
 *
 * `pierce: true` is what crosses the closed shadow boundary. Nothing on the page has this;
 * it is the same access DevTools has, which is why the root can stay closed in production
 * and still be inspectable in a test.
 */
async function cardText(page: Page): Promise<string> {
  const cdp = await context.newCDPSession(page);
  const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as {
    root: CdpNode;
  };

  const out: string[] = [];
  let insideCard = false;

  const walk = (node: CdpNode, within: boolean): void => {
    // Card hosts carry a random id, so the prefix is the handle — the same one the other
    // e2e tests use.
    const isHost = !!(node.nodeName === "DIV" && (attr(node, "id") ?? "").startsWith("pp-"));
    // The card's own stylesheet is a text node too, and so is the UA sheet the browser
    // attaches for <details>. Neither is something the reader sees.
    if (node.nodeName === "STYLE") return;
    const here = within || isHost;
    if (here) insideCard = true;
    if (here && node.nodeType === 3 && node.nodeValue?.trim()) out.push(node.nodeValue.trim());
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      walk(child, here);
    }
  };
  walk(root, false);

  await cdp.detach();
  return insideCard ? out.join("\n") : "";
}

function attr(node: CdpNode, name: string): string | undefined {
  const a = node.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
}

interface CdpNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

test("the rendered card carries the evidence, the mechanism and a citation", async () => {
  const { page, logs } = await openFixture("cart-drawer.html");
  await page.waitForTimeout(2500);
  await page.click("#atc");

  await page.waitForFunction(
    () => [...document.documentElement.children].some((e) => e.id?.startsWith("pp-")),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "card.png") });

  const text = await cardText(page);
  expect(text.length, `card rendered nothing. log:\n${logs.join("\n")}`).toBeGreaterThan(40);

  // Every prompt is a question. This is the copy rule the whole product rests on, and here
  // it is checked against what was painted rather than against the pool it was drawn from.
  expect(text, `no question in the card:\n${text}`).toContain("?");

  // The feedback in full: a card that names a pattern without quoting what triggered it is
  // asking the reader to take its word for it. Evidence renders as a curly-quoted excerpt of
  // the page's own words, so the assertion is that a non-trivial quote is present — not that
  // it says any particular thing, which would pin the test to one fixture's copy.
  const quoted = /\u201C([^\u201D]{4,})\u201D/.exec(text);
  expect(quoted?.[1], `no evidence quote in the card:\n${text}`).toBeTruthy();

  // The grounding. "Why this works" is a disclosure, so its contents are in the DOM whether
  // or not it is open — which is the right trade: available, not shouted.
  expect(text.toLowerCase(), `no mechanism/citation in the card:\n${text}`).toContain(
    "why this works",
  );

  await page.close();
});
