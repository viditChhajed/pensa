/**
 * The four Chrome Web Store screenshots, produced by driving the shipped build.
 *
 *   node scripts/screenshots.mjs [--site forever21.com] [--fixture] [--out store/screenshots]
 *
 * These were believed impossible to automate for one specific reason: the card only appears
 * on a site the user has GRANTED, and the grant flow raises a native permission dialog that
 * no automation can accept. `scripts/spot-check.mjs` already answered that — copy the build
 * to a temp dir, patch the COPY's manifest, and load it with `--load-extension`. Everything
 * here is downstream of that trick, so the launch code is deliberately the same.
 *
 * Two manifest edits are made to the copy, both in that spirit, and both worth naming:
 *
 *   - `host_permissions` is set to ONE site — exactly the `https://*.<domain>/*` pattern a
 *     real grant produces — rather than the wildcard spot-check uses. That is what makes the
 *     four images one coherent and true story: a single site was enabled, a card appeared on
 *     it, its settings page lists it, and the popup still OFFERS enablement on a different
 *     site, which it would not do if everything were granted.
 *   - `permissions` gains `tabs`. The popup learns which site it is being asked about from
 *     `chrome.tabs.query`, and in production the right to read that URL comes from
 *     `activeTab` — granted only when the user clicks the toolbar button, which is the one
 *     gesture automation cannot make. Without this the popup renders "No page to check."
 *     and the shot is of nothing. The popup's own code and markup are untouched.
 *
 * Honesty constraints, since these images are a sales claim:
 *   - Nothing is drawn by this script except the neutral backdrop the popup is centred on.
 *     Every pixel of product UI is a screenshot of the running extension.
 *   - The card shot is taken on a live retailer. There is a fixture fallback (`--fixture`,
 *     or automatically when no live site cooperates) and the run says which it used, because
 *     a fixture page passed off as a retailer would be a lie.
 *   - The seeded summary rows are small and lopsided on purpose. A table showing hundreds of
 *     catches, or one where everything found was shown, would misrepresent the product.
 *
 * Consent banners are DECLINED, never accepted — including through a "manage preferences"
 * dialog when the banner offers no direct refusal, which is how Shopify's does it. Marketing
 * modals are closed, which is not consent and is what any shopper does.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const WIDTH = 1280;
const HEIGHT = 800;
const BUILD = resolve(".output/chrome-mv3");
const PAGES = resolve("tests/e2e/pages");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const OUT = resolve(typeof args.out === "string" ? args.out : "store/screenshots");

/**
 * Shopify storefronts, because the bag drawer is the shape the digest was built against and
 * `/products.json` names a product that is on sale TODAY.
 *
 * Hard-coded product URLs rot: of four written by hand, three 404'd within a fortnight.
 * Asking the storefront what it currently sells costs one fetch and cannot go stale.
 */
const LIVE_CANDIDATES = ["forever21.com", "glossier.com", "untuckit.com", "everlane.com"];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const shot = (name) => join(OUT, name);
const wait = (page, ms) => page.waitForTimeout(ms);

/**
 * Copy the build somewhere writable and patch the copy. `.output` is never touched.
 *
 * The shipped manifest already holds the broad https permission, so a live-retailer run needs no host
 * permission patched in at all — the screenshots show the permission a user actually grants.
 * Two patches remain, both for the capture harness rather than the product:
 *
 *   `tabs`, because the popup learns its page from `chrome.tabs.query` and in production that
 *   right comes from `activeTab`, which only a real toolbar click grants.
 *
 *   `fixtureOrigin`, for the fallback only. The fixture is served over plain http from a host
 *   the denylist does not refuse (localhost IS refused, deliberately), so both the permission
 *   and the declared content script's `matches` have to be widened to it — widening only the
 *   permission buys the right to read a page nothing is injected into.
 */
function stageBuild(fixtureOrigin) {
  const dir = mkdtempSync(join(tmpdir(), "pensa-shots-"));
  cpSync(BUILD, dir, { recursive: true });
  const mp = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(mp, "utf8"));
  if (fixtureOrigin) {
    manifest.host_permissions = [fixtureOrigin];
    for (const cs of manifest.content_scripts ?? []) cs.matches = [fixtureOrigin];
  }
  if (!manifest.permissions.includes("tabs")) manifest.permissions.push("tabs");
  writeFileSync(mp, JSON.stringify(manifest, null, 2));
  return dir;
}

async function launch(buildDir) {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${buildDir}`,
      `--load-extension=${buildDir}`,
      "--disable-blink-features=AutomationControlled",
    ],
    viewport: { width: WIDTH, height: HEIGHT },
    userAgent: UA,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
  // The worker registers the detector for granted origins on wake. Navigating before that
  // finishes gives a page with no content script and no explanation for the silence.
  await sw.evaluate(() => new Promise((r) => setTimeout(r, 1800)));
  return { ctx, sw, extensionId: new URL(sw.url()).host };
}

// ------------------------------- consent and modals -------------------------------

/** Only ever the refusing control. Nothing here matches "accept", and nothing ever will. */
const DECLINE =
  /^(reject|decline|refuse)( all| cookies| non-essential| optional)?$|^(only |strictly )?(necessary|essential)( cookies| only)?$|^no,? thanks$|^continue without/i;
/** Banners that hide their refusal one dialog deep. Shopify's is the common case. */
const PREFERENCES = /^(manage )?(preferences|cookie settings|cookie preferences|customi[sz]e)$/i;
/** Newsletter and welcome modals. Closing one is not consent — it is what a shopper does. */
const CLOSE = /^close( dialog| modal| popup)?$|^dismiss$/i;

async function labelledControls(page) {
  const out = [];
  for (const frame of page.frames()) {
    const handles = await frame
      .$$('button, [role="button"], a[role="button"], input[type="button"]')
      .catch(() => []);
    for (const h of handles.slice(0, 250)) {
      const label = await h
        .evaluate((e) => {
          const r = e.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) return null;
          return (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim();
        })
        .catch(() => null);
      if (label) out.push({ handle: h, label });
    }
  }
  return out;
}

async function clickFirst(page, controls, re) {
  for (const { handle, label } of controls) {
    if (!re.test(label)) continue;
    const ok = await handle
      .click({ timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      await wait(page, 800);
      return label;
    }
  }
  return null;
}

/**
 * Called more than once by design: the cookie bar is there on load, the newsletter modal
 * arrives five to ten seconds later, and a single sweep catches whichever happens to be up.
 * Both were standing in the first run of this script and both are in the way of the card.
 */
async function clearOverlays(page) {
  const controls = await labelledControls(page);
  await clickFirst(page, controls, CLOSE);
  if (await clickFirst(page, controls, DECLINE)) return;
  // No direct refusal on the bar itself: open the preference dialog and refuse there.
  if (await clickFirst(page, controls, PREFERENCES)) {
    const inDialog = await labelledControls(page);
    await clickFirst(page, inDialog, DECLINE);
    await clickFirst(page, await labelledControls(page), CLOSE);
  }
}

// ------------------------------- 01: the card -------------------------------

/**
 * A product with a real price. The first available variant on Glossier's feed is a $0
 * sample, and a card asking about a price of zero is a worse screenshot than no card.
 */
async function firstProductUrl(site) {
  const origin = `https://www.${site}`;
  const res = await fetch(`${origin}/products.json?limit=30`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  const body = await res.json();
  const product = (body.products ?? []).find((p) =>
    p.variants?.some((v) => v.available && Number(v.price) > 15),
  );
  return product ? `${origin}/products/${product.handle}` : null;
}

/** The same accessible-name test `src/content/triggers.ts` uses to recognise the click. */
const ATC_NAME = /\badd to (cart|bag|basket|order)\b|\badd item\b|\badd to my bag\b/i;

/**
 * The PDP's own add-to-cart, not an upsell tile's.
 *
 * A Shopify product page can carry twenty buttons reading "Add to bag" — one for the product
 * and nineteen for the "you might also like" grid. Widest wins: the primary CTA is the
 * full-width one under the price, and the tiles are small.
 */
async function clickAddToCart(page) {
  const handles = await page.$$('button, [role="button"], input[type="submit"]');
  const usable = [];
  for (const h of handles) {
    const info = await h
      .evaluate((e) => {
        const label = (e.getAttribute("aria-label") || e.value || e.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const r = e.getBoundingClientRect();
        return { label, width: r.width, height: r.height, disabled: e.disabled === true };
      })
      .catch(() => null);
    if (!info || info.disabled || info.width < 40 || info.height < 12) continue;
    if (!ATC_NAME.test(info.label)) continue;
    usable.push({ handle: h, ...info });
  }
  usable.sort((a, b) => b.width - a.width);

  for (const { handle, label } of usable.slice(0, 3)) {
    await handle.scrollIntoViewIfNeeded().catch(() => {});
    await wait(page, 500);
    const real = await handle
      .click({ timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (real) return label;
    // A leftover overlay makes Playwright refuse the click as "intercepted". Dispatching
    // the click on the element itself is still a genuine click on the genuine button — it
    // bubbles, the site's handler runs, and the extension's capture-phase listener sees it.
    // It is not a synthetic trigger; it just is not routed through the mouse.
    const dispatched = await handle
      .evaluate((e) => {
        e.click();
        return true;
      })
      .catch(() => false);
    if (dispatched) return `${label} (dispatched)`;
  }
  return null;
}

const CARD_PRESENT = () =>
  [...document.documentElement.children].some((e) => e.id?.startsWith("pp-"));

async function captureLiveCard(ctx, url) {
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => {
    if (m.text().includes("[pensa]")) logs.push(m.text());
  });
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!res || res.status() >= 400) throw new Error(`status ${res?.status()}`);
    await wait(page, 4000);
    await clearOverlays(page);
    // Detection needs the page on screen: the salience gate counts real dwell, so the top
    // of a long page holds nothing that has been looked at yet.
    await page.evaluate(() => scrollTo(0, 260));
    await wait(page, 5000);
    // Second sweep: the newsletter modal is on a timer and was not up during the first.
    await clearOverlays(page);
    await wait(page, 1500);

    const label = await clickAddToCart(page);
    if (!label) throw new Error("no usable add-to-cart control");
    console.log(`  clicked "${label}"`);

    // The digest polls for up to 5s for the drawer, then the worker ranks and replies.
    await page.waitForFunction(CARD_PRESENT, undefined, { timeout: 25_000 });
    // Let the drawer finish animating — a half-open drawer behind the card looks broken —
    // and sweep once more, since some modals only fire after an add-to-cart.
    await wait(page, 1500);
    await clearOverlays(page);
    await wait(page, 800);
    if (!(await page.evaluate(CARD_PRESENT))) throw new Error("card dismissed while clearing");

    await page.screenshot({ path: shot("01-card.png") });
    await page.close();
    return true;
  } catch (err) {
    console.log(`  ${String(err).split("\n")[0].slice(0, 130)}`);
    if (logs.length > 0) console.log(`    last log: ${logs.at(-1).slice(0, 150)}`);
    await page.close().catch(() => {});
    return false;
  }
}

/**
 * The fallback: this repo's own cart-drawer fixture, served over http.
 *
 * Same serving trick as `tests/e2e/digest-loop.spec.ts` — route everything, fulfil the one
 * path from disk. The card is real and the pipeline that produced it is real; the shop is
 * not, which is why the run prints it and the report has to repeat it.
 */
async function captureFixtureCard(ctx) {
  const name = "cart-drawer.html";
  const page = await ctx.newPage();
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
  await wait(page, 2500);
  await page.click("#atc");
  await page.waitForFunction(CARD_PRESENT, undefined, { timeout: 20_000 });
  await wait(page, 1200);
  await page.screenshot({ path: shot("01-card.png") });
  await page.close();
}

// --------------------------- 03 / 04: the settings page ---------------------------

/**
 * A day of ordinary browsing, written straight into the event store.
 *
 * Deliberately modest and deliberately lopsided. The whole point of the Noticed/Shown split
 * is that most of what is found is NOT shown, so a table where every row had been surfaced
 * would misrepresent the product, and three-figure counts would misrepresent a day. Every
 * pattern id here is one that actually ships. The real detections from the card run above
 * are in this table too — these rows sit alongside them, they do not replace them.
 */
const SEED = [
  ["anchoring.reference_price", "pdp", 0, true, "none"],
  ["anchoring.reference_price", "pdp", 0, false, "below_salience_gate"],
  ["anchoring.reference_price", "pdp", 1, false, "digest_full"],
  ["anchoring.reference_price", "cart", 1, true, "none"],
  ["scarcity.stock", "pdp", 0, true, "none"],
  ["scarcity.stock", "pdp", 2, false, "below_salience_gate"],
  ["scarcity.stock", "pdp", 2, false, "none"],
  ["urgency.countdown", "pdp", 1, true, "none"],
  ["urgency.countdown", "cart", 1, false, "placement_suppressed"],
  ["social_proof.live_activity", "pdp", 2, false, "below_salience_gate"],
  ["social_proof.live_activity", "pdp", 2, false, "dedup_family"],
  ["defaults.preselected", "checkout", 1, true, "none"],
  ["defaults.preselected", "checkout", 1, false, "digest_full"],
  ["bnpl.installments", "pdp", 0, false, "below_threshold"],
  ["bnpl.installments", "pdp", 2, true, "none"],
  ["goal_gradient.threshold", "cart", 0, false, "placement_suppressed"],
  ["confirmshaming.decline_copy", "checkout", 1, false, "below_salience_gate"],
];

/** Three origins, so the "Sites" column is a real count rather than a constant 1. */
const SEED_ORIGINS = ["https://shop.example", "https://store.example", "https://market.example"];

async function seedSummary(page) {
  // Dexie creates its object stores only when something opens the database, so ask the
  // worker for a summary first. Writing before that fails with NotFoundError — the exact
  // trap documented at length in tests/e2e/retention.spec.ts.
  await page.evaluate(
    () => new Promise((res) => chrome.runtime.sendMessage({ type: "get-summary" }, res)),
  );

  await page.evaluate(
    async ([rows, origins]) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open("vero");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const sessionId = crypto.randomUUID();
      const hex = () =>
        [...crypto.getRandomValues(new Uint8Array(32))]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      const tx = db.transaction("events", "readwrite");
      const store = tx.objectStore("events");
      rows.forEach(([patternId, funnelStage, originIndex, surfaced, suppressionReason], i) => {
        store.put({
          id: crypto.randomUUID(),
          sessionId,
          origin: origins[originIndex],
          pathTemplate: funnelStage === "pdp" ? "/p/:id" : `/${funnelStage}`,
          detectorId: patternId,
          patternId,
          confidence: 0.55 + ((i * 7) % 30) / 100,
          confidenceBasis: "hand_set",
          salience: {
            visibleMs: surfaced ? 2400 : 300,
            viewportFraction: 0.2,
            scrollDepthAtFirstView: 0.3,
            ephemeral: false,
          },
          surfaced,
          suppressionReason,
          funnelStage,
          evidence: {
            selectorPath: "main > div > span",
            textHash: hex(),
            matchedLexemes: [],
            boundingBox: { x: 0, y: 0, w: 120, h: 20 },
          },
          rulepackVersion: "1",
          detectorVersion: "1",
          // Spread over the last few hours, because the summary window is the last 24.
          ts: Date.now() - (i + 1) * 17 * 60 * 1000,
        });
      });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
    [SEED, SEED_ORIGINS],
  );
}

/**
 * Scroll to a y offset and shoot the whole viewport, so the image is the settings page at
 * the store's required size rather than a crop stretched up to it.
 */
async function shootAt(page, y, file) {
  await page.evaluate((top) => scrollTo(0, top), y);
  await wait(page, 500);
  await page.screenshot({ path: shot(file) });
}

/**
 * Nudge the fold so it lands between two switches rather than through the middle of one.
 *
 * A row sliced across its description line reads as a rendering fault. There is only ever a
 * few dozen pixels of slack — capped so the "Pensa" heading never leaves the top of the page,
 * which is the one thing the shot cannot afford to lose.
 */
async function switchFold(page) {
  return page.evaluate((height) => {
    const bottoms = [...document.querySelectorAll("#patterns label.row")].map(
      (e) => e.getBoundingClientRect().bottom + scrollY,
    );
    const last = bottoms.filter((b) => b <= height + 40).at(-1);
    if (last === undefined) return 0;
    return Math.max(0, Math.min(36, Math.ceil(last + 8 - height)));
  }, HEIGHT);
}

async function sectionTop(page, headingText) {
  const top = await page.evaluate((text) => {
    const h2 = [...document.querySelectorAll("h2")].find((e) => e.textContent?.trim() === text);
    const section = h2?.closest("section");
    return section ? section.getBoundingClientRect().top + scrollY : null;
  }, headingText);
  if (top === null) throw new Error(`no section headed "${headingText}"`);
  return top;
}

// ------------------------------- 02: the popup -------------------------------

/**
 * The popup, at a size a human can read, on a 1280x800 canvas.
 *
 * `sharp` is not a dependency and pulling in an image library to pad a PNG would be a poor
 * trade, so the browser does it: capture the popup, then render it as a data URI on a page
 * sized to exactly 1280x800 and shoot that. Nothing is resampled — the popup is rendered at
 * 2x through CSS `zoom` before capture, so the text in the final image is real 2x text
 * rather than a 320px-wide capture blown up and blurred.
 *
 * The popup is opened as a BACKGROUND tab on purpose. It learns which site it is being asked
 * about from `chrome.tabs.query({active: true})`, so a popup that is itself the active tab
 * would read its own chrome-extension:// URL. It is brought to the front only after `init()`
 * has resolved and the verdict line is on screen.
 *
 * It is shot on the SAME shop the card fired on, so it shows the real state: running, and
 * checking this page. It used to be shot on a second, ungranted site to show an "Enable on
 * this site" button — a button that no longer exists, so the old image depicted a product
 * that is not the one being submitted.
 */
async function capturePopup(ctx, sw, extensionId, shopUrl) {
  const shop = await ctx.newPage();
  await shop
    .goto(shopUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
    .catch(() => console.log(`  ${shopUrl} was slow to load; the popup still reads its URL`));
  await wait(shop, 2000);

  const opened = ctx.waitForEvent("page", { timeout: 20_000 });
  await sw.evaluate(
    (id) => chrome.tabs.create({ url: `chrome-extension://${id}/popup.html`, active: false }),
    extensionId,
  );
  const popup = await opened;
  await popup.waitForSelector(".detail.score", { timeout: 20_000 });

  await popup.bringToFront();
  // A clip cannot reach past the viewport, so a flat 2x zoom silently chopped the footer
  // off a popup 430px tall. Zoom as far as the 1280x800 canvas has room for and no further.
  const clip = await popup.evaluate(
    ([maxW, maxH]) => {
      const app = document.getElementById("app");
      const natural = app.getBoundingClientRect();
      const factor = Math.min(2, maxW / natural.width, maxH / natural.height);
      document.documentElement.style.zoom = String(factor);
      const r = app.getBoundingClientRect();
      return { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(r.height) };
    },
    [WIDTH - 320, HEIGHT - 120],
  );
  await wait(popup, 500);
  const raw = await popup.screenshot({ clip });
  await popup.close();
  await shop.close();

  const canvas = await ctx.newPage();
  await canvas.setContent(`<!doctype html><style>
    html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
    body{display:grid;place-items:center;
      background:linear-gradient(160deg,#f6f7fb 0%,#e9ecf4 100%)}
    img{display:block;border-radius:14px;
      box-shadow:0 18px 50px rgba(20,24,40,.16),0 2px 6px rgba(20,24,40,.10)}
  </style><img alt="" src="data:image/png;base64,${raw.toString("base64")}">`);
  await wait(canvas, 500);
  await canvas.screenshot({ path: shot("02-popup.png") });
  await canvas.close();
}

// ----------------------------------- run -----------------------------------

mkdirSync(OUT, { recursive: true });

/** Resolve a live product URL before launching: a candidate that cannot name one is not worth a browser. */
const candidates = args.site ? [String(args.site)] : LIVE_CANDIDATES;
const targets = [];
if (!args.fixture) {
  for (const site of candidates) {
    const url = await firstProductUrl(site).catch(() => null);
    if (url) targets.push({ site, url });
    else console.log(`${site}: no product feed, skipping`);
  }
}

let ctx = null;
let sw = null;
let extensionId = null;
let cardSource = null;
/** Where the popup is shot: the shop the card fired on, so it reports Pensa as running. */
let popupSite = null;

for (const { url } of targets) {
  console.log(`trying ${url}`);
  const staged = await launch(stageBuild());
  if (await captureLiveCard(staged.ctx, url)) {
    ({ ctx, sw, extensionId } = staged);
    cardSource = `live retailer — ${url}`;
    popupSite = url;
    break;
  }
  // One browser at a time: the machine is already running the spot-check fleet.
  await staged.ctx.close();
}

if (!ctx) {
  if (targets.length > 0) console.log("no live retailer cooperated — falling back to the fixture");
  const staged = await launch(stageBuild("http://shop.example.com/*"));
  ({ ctx, sw, extensionId } = staged);
  await captureFixtureCard(ctx);
  cardSource = "FIXTURE — tests/e2e/pages/cart-drawer.html over http://shop.example.com";
  popupSite = "http://shop.example.com/cart-drawer.html";
}

try {
  const options = await ctx.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await seedSummary(options);
  await options.reload();
  await options.waitForSelector("#patterns input[data-pattern]");
  await wait(options, 800);

  // A hair above the section, so the image reads as a page someone scrolled rather than one
  // that happens to begin at a rule.
  await shootAt(
    options,
    (await sectionTop(options, "What was noticed today")) - 24,
    "03-today.png",
  );
  // Near the very top, because the frequency control and the per-technique switches are two
  // sections apart and this is the only scroll position that honestly holds both. Pasting
  // two crops together would produce a page that does not exist.
  await shootAt(options, await switchFold(options), "04-settings.png");
  await options.close();

  await capturePopup(ctx, sw, extensionId, popupSite);
} finally {
  await ctx.close();
}

console.log(`\nwrote ${OUT}`);
for (const file of ["01-card.png", "02-popup.png", "03-today.png", "04-settings.png"]) {
  console.log(`  ${file}  ${(statSync(shot(file)).size / 1024).toFixed(0)} KB`);
}
console.log(`\n  01-card.png  ${cardSource}`);
console.log(`  02-popup.png  running on ${new URL(popupSite).hostname}`);
