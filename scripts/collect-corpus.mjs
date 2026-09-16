/**
 * Collect real shopping-page text into a corpus for §18D labelling.
 *
 * Why this exists: every recall miss recorded in EVAL run 1 was a phrasing I invented that
 * no real site uses. The lexicons and the fixtures came out of the same imagination, so the
 * unit tests agreed with themselves and the field did not. A classifier cannot fix that with
 * better guessing either — it needs real sentences, which means a crawl.
 *
 *   npm run corpus:collect              # the default site set
 *   npm run corpus:collect -- --sites glossier.com,rei.com --pages 6
 *
 * Output: corpus/candidates.jsonl, one harvested text node per line.
 *
 * Three things this does deliberately:
 *
 *   It runs THE REAL HARVEST, esbuild-bundled from src/content/harvest.ts at collect time.
 *   A separate "good enough" text extractor here would train the classifier on a different
 *   distribution from the one it sees in production, which is a silent and very hard bug.
 *   Bundling at collect time rather than adding an entrypoint keeps it out of the shipped
 *   extension.
 *
 *   It scrubs before writing, not after. These are real pages, possibly browsed while signed
 *   in, and the corpus is far more likely to be shared or pasted than a fixture is.
 *
 *   It is polite: signed-out, top-level pages only, a delay between requests, a hard page
 *   cap per site, and it never submits a form or follows anything behind a login.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

/** Accepts both `--sites a,b` and `--sites=a,b`. The first version silently ignored the
 * space-separated form and quietly crawled the default list instead. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

/**
 * Spread across categories rather than picking the biggest retailers. Persuasion copy is
 * category-shaped — travel drips fees, fast fashion runs scarcity, electronics runs
 * reference prices — so a corpus of six marketplaces would teach the model one dialect.
 */
const DEFAULT_SITES = [
  // Travel and ticketing: the densest source of urgency, scarcity and drip copy anywhere.
  "booking.com",
  "expedia.com",
  "hotels.com",
  "priceline.com",
  "kayak.com",
  "agoda.com",
  "travelocity.com",
  "orbitz.com",
  "hotwire.com",
  "vrbo.com",
  "ticketmaster.com",
  "stubhub.com",
  "seatgeek.com",
  "vividseats.com",
  "eventbrite.com",
  "flyfrontier.com",
  "spirit.com",
  "allegiantair.com",
  // Fast fashion: scarcity badges, countdowns and instalment offers on almost every card.
  "shein.com",
  "temu.com",
  "fashionnova.com",
  "boohoo.com",
  "prettylittlething.us",
  "nastygal.com",
  "lulus.com",
  "romwe.com",
  "zaful.com",
  "cider.com",
  "forever21.com",
  // Marketplaces and big box: instalments, reference prices, live-activity notices.
  "ebay.com",
  "etsy.com",
  "wish.com",
  "aliexpress.com",
  "overstock.com",
  "wayfair.com",
  "newegg.com",
  "gamestop.com",
  "qvc.com",
  "hsn.com",
  "target.com",
  "kohls.com",
  // DTC and beauty: thresholds, preselected add-ons, softer copy — the negatives matter too.
  "glossier.com",
  "sephora.com",
  "ulta.com",
  "rei.com",
  "ikea.com",
  "uniqlo.com",
  "chewy.com",
  "petco.com",
  "zappos.com",
  "asos.com",
];

/**
 * The first collection ran twenty tame retailers and produced SIX snippets matching any
 * scarcity vocabulary out of 1093. That is not a crawler bug — REI does not run countdown
 * timers, and a corpus drawn from shops that do not use a technique cannot teach a model to
 * recognise it. The list above is deliberately weighted toward travel, ticketing and fast
 * fashion, which is where the literature says this copy concentrates and where the spot
 * check found it. The tame retailers stay, because a classifier trained only on shops that
 * shout will call an ordinary product page a dark pattern.
 */

const sites = typeof args.sites === "string" ? args.sites.split(",") : DEFAULT_SITES;
const pagesPerSite = Number(args.pages ?? 5);
const delayMs = Number(args.delay ?? 1500);
const OUT_DIR = resolve("corpus");
/**
 * `--out` lets several crawlers run at once, each owning its own file.
 *
 * Sharding is by SITE, so no individual shop sees more traffic than a single-process run
 * gave it — the parallelism is across shops, never within one. Separate files because the
 * dedup set lives in memory per process: two processes appending to one file would each
 * think they had seen only their own lines. `corpus:merge` folds them together and dedupes
 * properly afterwards.
 */
const OUT = join(OUT_DIR, typeof args.out === "string" ? args.out : "candidates.jsonl");

// ---------------------------------------------------------------- scrub

/**
 * Applied to every string before it is written. Deliberately aggressive: a false positive
 * costs one training example, a false negative writes someone's email into a file.
 */
const SCRUB = [
  [/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, "user@example.test"],
  [/\+?\d[\d\s().-]{8,}\d/g, "+1-555-0100"],
  [
    /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Ln|Lane|Dr|Drive)\b/g,
    "1 Example St",
  ],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g, "SW1A 1AA"],
  [/\b\d{5}(?:-\d{4})?\b/g, "00000"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "4111111111111111"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>"],
  [/\b(?:order|account|member|customer)\s*#?\s*[A-Z0-9]{8,}\b/gi, "order #REDACTED"],
];

function scrub(text) {
  let out = text;
  for (const [re, replacement] of SCRUB) out = out.replace(re, replacement);
  return out;
}

// ---------------------------------------------------------------- harvest bundle

/**
 * Bundle the shipped harvest into an IIFE the page can run. `--format=iife` with a global
 * name gives `window.__ppHarvest.harvest(document)` with no module loader in the page.
 */
function buildHarvestBundle() {
  const dir = mkdtempSync(join(tmpdir(), "pp-corpus-"));
  const entry = join(dir, "entry.ts");
  const out = join(dir, "harvest.iife.js");
  writeFileSync(
    entry,
    `import { harvest } from "${resolve("src/content/harvest.ts").replace(/\\/g, "/")}";\nexport { harvest };\n`,
  );
  execFileSync(
    resolve("node_modules/.bin/esbuild"),
    [
      entry,
      "--bundle",
      "--format=iife",
      "--global-name=__ppHarvest",
      `--outfile=${out}`,
      // Without this the "@/..." imports INSIDE harvest.ts do not resolve: esbuild looks for
      // a tsconfig upward from the ENTRY file, and the entry lives in a temp directory.
      `--tsconfig=${resolve("tsconfig.json")}`,
      "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  const code = readFileSync(out, "utf8");
  rmSync(dir, { recursive: true, force: true });

  /**
   * Attach to the real global explicitly, and not by asking esbuild to.
   *
   * Playwright wraps an init script in a FUNCTION scope, so esbuild's `var __ppHarvest = …`
   * stays local to that wrapper and the page never sees it. The obvious fix —
   * `--global-name=globalThis.__ppHarvest` — is worse: esbuild emits a literal
   * `var globalThis;` first, which SHADOWS the real one, so the assignment lands on a fresh
   * local object and silently reaches nothing.
   *
   * Appending here works because this line is inside the same wrapper as the `var`.
   */
  return `${code}\n;globalThis.__ppHarvest = __ppHarvest;\n`;
}

const seenText = new Set();
let written = 0;

// ---------------------------------------------------------------- crawl

/**
 * Product pages first, category pages only as a route to them.
 *
 * The first run treated the two as equally interesting and came back with 1093 snippets, of
 * which SIX matched any scarcity vocabulary — because "Camp Chairs" and "All Tops" are what
 * category pages are made of. Scarcity badges, instalment offers and countdowns live on the
 * product page and in the cart. Crawling two levels to reach one is worth it; harvesting a
 * hundred category listings is not.
 */
/**
 * A "product" page, including the shapes travel and ticketing use.
 *
 * Booking, Agoda and Expedia have no /products/ anywhere — their detail pages are /hotel/,
 * /rooms/, /flights/ — so the crawl skipped every one of them and reported "no product link
 * from the homepage". That is precisely backwards: travel is where drip pricing lives, and
 * `pricing.drip` is the highest-severity detector in the taxonomy.
 *
 * Widening this does NOT widen what the crawl clicks. `addToCart` looks for an add-to-cart
 * control by name and finds none on a hotel page, so these get harvested and nothing is
 * added — which is the correct boundary anyway: "Reserve" on a travel site leads straight
 * into a form asking for a guest's name, and this crawl stops well before that.
 */
const PRODUCT_LINK =
  /\/(?:products?|item|itm|dp|pd|p|prod|sku|buy|hotel|hotels|rooms?|flights?|stays?|event|events|tickets?|listing)\//i;
const CATEGORY_LINK =
  /\/(?:collections?|category|categories|c|s|shop|sale|deals?|clearance|new)\b/i;

async function linksFrom(page, origin) {
  try {
    /**
     * Cap AFTER filtering, not before.
     *
     * `.slice(0, 200)` used to run on the raw href list, so a site whose product links sit
     * past the first 200 anchors lost all of them — zappos has 33 product links among 328
     * anchors and the crawl reported "no product link from the homepage" for it. Nav,
     * footer and account links come first on almost every retail homepage, which is exactly
     * the wrong 200 to keep.
     */
    return await page.$$eval(
      "a[href]",
      (els, o) =>
        [...new Set(els.map((e) => e.href))]
          .filter((h) => h.startsWith(o) && !h.includes("#") && !/\.(pdf|jpg|png|zip)$/i.test(h))
          .slice(0, 600),
      origin,
    );
  } catch {
    return [];
  }
}

/**
 * Scroll before harvesting. Lazy-loaded badges — "Only 3 left", "23 viewing" — are commonly
 * rendered on intersection, so a page read at scroll position zero is missing exactly the
 * copy this corpus exists to capture.
 */
async function scrollThrough(page) {
  try {
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      await page.evaluate((f) => scrollTo(0, document.body.scrollHeight * f), frac);
      await page.waitForTimeout(600);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(300);
  } catch {
    /* a page that refuses to scroll is still worth harvesting */
  }
}

/**
 * Cart and modal copy, which a page-fetching crawl can never reach.
 *
 * The first corpus found THREE confirmshaming instances in 15,822 snippets, and zero
 * evidence for pricing.drip or basket.sneak. That is not a detector problem: "no thanks, I
 * don't want to save money" lives in a newsletter modal, a drip fee appears only once a cart
 * has a subtotal, and a sneaked add-on exists only in a cart. Crawling product pages and then
 * asking why the cart detectors have no data is asking the wrong question.
 *
 * The boundary, and the reason this is a separate mode rather than the default: add to cart
 * and READ the cart. Nothing else. No account is created, no personal data is entered into
 * any field, no checkout is entered, no order is placed. Adding an item to a cart is what
 * every shopper does and leaves nothing behind but a session; entering an address is not,
 * and the crawl stops before it.
 */

/** Decline non-essential cookies where offered. Accept nothing. */
async function dismissConsent(page) {
  const DECLINE = [
    /^(?:reject|decline|refuse)\b/i,
    /only (?:necessary|essential|required)/i,
    /necessary (?:cookies )?only/i,
    /continue without accepting/i,
  ];
  try {
    for (const el of await page.$$('button, [role="button"], a')) {
      const name = ((await el.textContent()) ?? "").replace(/\s+/g, " ").trim();
      if (name.length === 0 || name.length > 60) continue;
      if (!DECLINE.some((re) => re.test(name))) continue;
      await el.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(600);
      return;
    }
  } catch {
    /* a consent banner that will not be dismissed is not a failed page */
  }
}

/**
 * Nudge the page into showing what it only shows under pressure.
 *
 * Newsletter and exit-intent modals are where confirmshaming lives, and both are triggered
 * by dwell or by the cursor leaving toward the top of the window. Both are things a real
 * visitor does; neither submits anything.
 */
async function provokeModals(page) {
  try {
    await page.waitForTimeout(2500);
    await page.mouse.move(640, 300);
    await page.mouse.move(640, 2);
    await page.waitForTimeout(1800);
  } catch {
    /* nothing to provoke */
  }
}

/**
 * Click add-to-cart, selecting a variant first if the button will not engage without one.
 *
 * Best-effort by design: a site that will not add without a login is a site this crawl
 * declines to push further on.
 */
async function addToCart(page) {
  /**
   * Located by ROLE and accessible name, not by scanning elements for text.
   *
   * The hand-rolled scan found nothing on target, kohls or chewy — all three real product
   * pages with a real button. Playwright's role locator resolves the accessible name the way
   * the browser computes it, which covers a button whose label lives in a nested span, an
   * aria-label, or a sibling. It also auto-waits and auto-scrolls, and "not found" on those
   * sites mostly meant "not laid out yet when I looked".
   */
  const atc = page
    .getByRole("button", { name: /add to (?:cart|bag|basket)/i })
    .or(page.getByRole("link", { name: /add to (?:cart|bag|basket)/i }))
    .filter({ visible: true });

  const tryClick = async () => {
    const n = await atc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 3); i++) {
      const ok = await atc
        .nth(i)
        .click({ timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        await page.waitForTimeout(3000);
        return true;
      }
    }
    return false;
  };

  try {
    // Bring it into view first. A sticky add-to-cart bar and a lazily hydrated button are
    // both common, and both are absent from the DOM at scroll position zero.
    await page.evaluate(() => scrollTo(0, 400)).catch(() => {});
    await page.waitForTimeout(1200);
    if (await tryClick()) return true;

    // Many product pages keep add-to-cart disabled until a size or colour is chosen.
    for (const sel of ["[data-size]", '[class*="swatch"] button', '[class*="size"] button']) {
      const swatch = page.locator(sel).filter({ visible: true }).first();
      if ((await swatch.count().catch(() => 0)) === 0) continue;
      await swatch.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1200);
      if (await tryClick()) return true;
    }
  } catch {
    /* not addable without more interaction than this crawl is willing to do */
  }
  return false;
}

/**
 * Shopify's documented cart permalink, which skips the UI entirely.
 *
 * Driving add-to-cart across arbitrary retailers turned out to be a tar pit: fifty sites
 * produced ONE cart. Target's product page has no add-to-cart control at all until a
 * fulfillment option is chosen, Chewy's first product link was a gift card, and every site
 * that fails needs its own bespoke handling — brittle, and a steady march toward driving
 * someone's checkout, which this crawl should not be doing.
 *
 * Shopify publishes a clean alternative: `/products.json` lists variants and `/cart/<id>:1`
 * creates a cart from one. Both are documented, public, unauthenticated endpoints. It covers
 * a smaller slice than it sounds — 5 of 15 fashion and DTC sites tested — but it needs no
 * clicking, no variant guessing, and no interaction the site has not published an API for.
 */
async function shopifyCart(page, origin) {
  try {
    const res = await page.request.get(`${origin}/products.json?limit=5`, { timeout: 12_000 });
    if (!res.ok()) return false;
    const body = await res.json().catch(() => null);
    const variant = body?.products
      ?.flatMap((prod) => prod.variants ?? [])
      .find((v) => v?.available !== false && v?.id);
    if (!variant) return false;

    await page.goto(`${origin}/cart/${variant.id}:1`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await page.waitForTimeout(2500);
    return true;
  } catch {
    return false;
  }
}

/** The usual cart paths. Read only — the crawl stops here and never enters checkout. */
const CART_PATHS = ["/cart", "/bag", "/basket", "/shopping-cart", "/shoppingcart"];

async function collectFrom(page, _url, site) {
  let nodes;
  try {
    nodes = await page.evaluate(() => {
      const out = [];
      for (const n of window.__ppHarvest.harvest(document)) {
        const text = (n.text ?? "").trim();
        if (text.length < 3 || text.length > 220) continue;
        out.push({
          text,
          role: n.role ?? null,
          /**
           * The element's own tag, from the DOM.
           *
           * This used to be `selectorPath.split(" > ").pop()`, and `selectorPath` joins with
           * ">" and no spaces — so the split never fired and the field held a path fragment
           * like "html>body>div", or nothing at all, for 80% of rows. Nobody noticed until a
           * detector that needs to know whether a node is a BUTTON could not be evaluated.
           */
          tag: n.tagName ?? "",
          fontWeight: n.style?.fontWeight ?? 400,
          fontSizePx: n.style?.fontSizePx ?? 16,
          strike: (n.style?.textDecorationLine ?? "").includes("line-through"),
          area: Math.round((n.box?.w ?? 0) * (n.box?.h ?? 0)),
        });
      }
      return out;
    });
  } catch {
    return 0;
  }

  let added = 0;
  const lines = [];
  for (const n of nodes) {
    const text = scrub(n.text);
    // Deduped on normalised text across the WHOLE corpus, not per page. Retail markup
    // repeats one string dozens of times — glossier renders the same price row thirteen
    // times — and labelling the same sentence thirteen times is thirteen times the work for
    // one example's worth of signal.
    const key = text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    if (seenText.has(key)) continue;
    seenText.add(key);
    lines.push(JSON.stringify({ ...n, text, site, key }));
    added++;
  }
  if (lines.length > 0) appendFileSync(OUT, `${lines.join("\n")}\n`);
  written += added;
  return added;
}

// ---------------------------------------------------------------- main

mkdirSync(OUT_DIR, { recursive: true });

/**
 * Cumulative by default; --fresh to start over.
 *
 * Truncating on every run means one crash twenty-one sites in throws away everything
 * collected so far — which is exactly what happened, and it happened on a run that had
 * already spent forty minutes. The dedupe key makes merging free, so there is no reason to
 * ever discard a crawl that cost real time and real requests to other people's servers.
 */
if (args.fresh) {
  writeFileSync(OUT, "");
} else if (existsSync(OUT)) {
  let kept = 0;
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      seenText.add(JSON.parse(line).key);
      kept++;
    } catch {
      /* a truncated last line from a hard kill is not worth losing the file over */
    }
  }
  if (kept > 0) console.log(`Resuming: ${kept} snippets already collected (--fresh to discard).`);
}

console.log(`Bundling the shipped harvest…`);
const harvestCode = buildHarvestBundle();

/**
 * The browser is recreatable, because it dies.
 *
 * The first full run collected from twenty-one sites and then reported "unreachable" for the
 * remaining twenty-nine — including rei.com and glossier.com, which had been crawled
 * successfully minutes earlier in the same session. Twenty-nine sites do not independently
 * start blocking you in the same second. The browser had died on a heavy page (boohoo, 848
 * snippets) and every later goto threw into the same catch, which printed a message about
 * the SITE for a failure that had nothing to do with the site.
 *
 * A fresh context per site also keeps cookies and consent state from leaking between shops,
 * which is worth having on its own.
 */
let browser = await chromium.launch({ channel: "chromium" });

async function freshContext() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  await ctx.addInitScript({ content: harvestCode });
  return ctx;
}

async function ensureBrowser() {
  if (browser.isConnected()) return;
  console.log("  (browser died — restarting)");
  browser = await chromium.launch({ channel: "chromium" });
}

let context = await freshContext();

/**
 * Prove the bundle actually runs before crawling twenty sites with it.
 *
 * The first version reported "0 new snippets" for every site and exited 0, which is
 * indistinguishable from every site blocking the crawler — the cause was an unresolved
 * import alias. A collector that cannot collect must say so on the first page, not after
 * twenty, and this project has now been bitten by that same silent green four times.
 */
{
  const probe = await context.newPage();
  await probe.setContent(
    `<div class="p">Only 3 left in stock</div><div>or 4 payments of $8.75</div>`,
  );
  const found = await probe.evaluate(() =>
    typeof globalThis.__ppHarvest?.harvest === "function"
      ? globalThis.__ppHarvest.harvest(document).length
      : -1,
  );
  await probe.close();
  if (found < 1) {
    await browser.close();
    throw new Error(
      found === -1
        ? "the harvest bundle did not define __ppHarvest — the esbuild step produced something unusable"
        : "the harvest bundle loaded but found nothing on a page that plainly has candidates",
    );
  }
  console.log(`Harvest bundle OK (${found} candidates on the probe page).`);
}

/** `--cart` adds one item per site and reads the cart. See the note above addToCart. */
const CART_MODE = Boolean(args.cart);
let cartsReached = 0;
let consecutiveFailures = 0;

for (const site of sites) {
  const origin = `https://www.${site.replace(/^www\./, "")}`;

  await ensureBrowser();
  try {
    await context.close();
  } catch {
    /* already gone */
  }
  context = await freshContext();

  const page = await context.newPage();
  let got = 0;
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2500);
    if (CART_MODE) await dismissConsent(page);
    await scrollThrough(page);
    if (CART_MODE) {
      // Dwell on the homepage first: newsletter modals are timed, and the homepage is where
      // most sites fire them.
      await provokeModals(page);
    }
    got += await collectFrom(page, origin, site);

    // Two levels, product-first. Take whatever products the homepage exposes; if that is not
    // enough, walk through a category page to find more. Category pages are a route, and get
    // harvested on the way past rather than sought out.
    const home = await linksFrom(page, origin);
    const queue = home.filter((l) => PRODUCT_LINK.test(new URL(l).pathname)).slice(0, pagesPerSite);
    const categories = home.filter((l) => CATEGORY_LINK.test(new URL(l).pathname));

    const visit = async (link) => {
      await page.waitForTimeout(delayMs);
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await page.waitForTimeout(1800);
        await scrollThrough(page);
        got += await collectFrom(page, link, site);
        return true;
      } catch {
        return false;
      }
    };

    for (const cat of categories.slice(0, 3)) {
      if (queue.length >= pagesPerSite) break;
      if (!(await visit(cat))) continue;
      for (const d of await linksFrom(page, origin)) {
        if (queue.length >= pagesPerSite) break;
        if (PRODUCT_LINK.test(new URL(d).pathname) && !queue.includes(d)) queue.push(d);
      }
    }

    for (const link of queue) {
      try {
        await visit(link);
      } catch {
        /* one dead link is not a failed site */
      }
    }

    /**
     * The cart pass. Add one item, then read the cart — and stop.
     *
     * Only ONE item and only one product page attempted per site: enough to give a cart a
     * subtotal, a line item and whatever the site chooses to put beside them, without
     * hammering anyone's basket service for a corpus.
     */
    if (CART_MODE && queue.length === 0) {
      console.log(`    ${site}: no product link from the homepage — cart pass skipped`);
    }
    if (CART_MODE && queue.length > 0) {
      // Narrated, because every silent failure in this crawler has cost a whole run. "0 cart
      // pages reached" could mean no product link, a refused click, or a cart that loaded
      // empty, and those have three different fixes.
      try {
        await page.goto(queue[0], { waitUntil: "domcontentloaded", timeout: 25_000 });
        await page.waitForTimeout(2000);
        await dismissConsent(page);
        // Shopify first: it needs no clicking and cannot half-work.
        const viaShopify = await shopifyCart(page, origin);
        const added = viaShopify || (await addToCart(page));
        console.log(
          `    ${site}: cart via ${viaShopify ? "shopify permalink" : added ? "click" : "NOTHING"}`,
        );

        // Harvest wherever the click left us. Shopify-style drawers render the cart in
        // place, so this is often the cart itself and the only chance to see it.
        got += await collectFrom(page, page.url(), site);

        if (added) {
          for (const path of CART_PATHS) {
            await page.waitForTimeout(delayMs);
            try {
              const res = await page.goto(`${origin}${path}`, {
                waitUntil: "domcontentloaded",
                timeout: 20_000,
              });
              if (!res || res.status() >= 400) continue;
              await page.waitForTimeout(2000);
              await scrollThrough(page);
              got += await collectFrom(page, page.url(), site);

              /**
               * Decide "this is a populated cart" from the PAGE, not from how many snippets
               * were new.
               *
               * The first version counted newly-written snippets, which measures corpus
               * novelty rather than the page in front of it: glossier's cart deduped to zero
               * against text already collected from its drawer, and the run reported zero
               * carts reached while sitting on one.
               */
              const looksLikeACart = await page
                .evaluate(() => {
                  const t = (document.body?.innerText ?? "").toLowerCase();
                  const empty =
                    /your (?:cart|bag|basket) is empty|no items in your|cart is currently empty/.test(
                      t,
                    );
                  const money = /[$£€¥]\s?\d/.test(t);
                  // "Subtotal" is not universal: Everlane and Forever21 both build a real
                  // cart via the permalink and label it "Total". Requiring money AND a
                  // total-ish row AND no empty-cart message still excludes ordinary pages.
                  const summary =
                    /\b(?:sub-?total|order total|estimated total|cart total|bag total|total|proceed to checkout|your (?:cart|bag|basket))\b/.test(
                      t,
                    );
                  return !empty && money && summary;
                })
                .catch(() => false);

              console.log(`    ${site}: ${path} -> ${looksLikeACart ? "CART" : "not a cart"}`);
              if (looksLikeACart) {
                cartsReached++;
                break;
              }
            } catch {
              /* try the next cart path */
            }
          }
        }
      } catch (err) {
        console.log(
          `    ${site}: cart pass failed — ${String(err?.message ?? err)
            .split("\n")[0]
            .slice(0, 70)}`,
        );
      }
    }
    console.log(`  ${site.padEnd(22)} ${String(got).padStart(5)} new snippets`);
    consecutiveFailures = 0;
  } catch (err) {
    // Say WHICH failure. "unreachable" covered a bot block, a timeout and a dead browser
    // with one word, and the word was wrong for the one that mattered.
    const why = String(err?.message ?? err)
      .split("\n")[0]
      .slice(0, 90);
    console.log(`  ${site.padEnd(22)} failed — ${why}`);
    consecutiveFailures++;
    if (consecutiveFailures >= 3) {
      // Three in a row is not three unlucky sites. Force a clean browser before blaming the
      // fourth one.
      console.log("  (three failures in a row — recycling the browser)");
      try {
        await browser.close();
      } catch {
        /* already gone */
      }
      browser = await chromium.launch({ channel: "chromium" });
      context = await freshContext();
      consecutiveFailures = 0;
    }
  }
  try {
    await page.close();
  } catch {
    /* the page may have gone down with the browser */
  }
}

await browser.close();
if (written === 0) {
  console.error(
    "\nEvery site returned nothing, and the bundle probe passed — so this is the network or " +
      "bot-blocking, not the collector. Retry with --sites naming fewer, smaller sites.",
  );
  process.exit(1);
}
if (CART_MODE) console.log(`\n${cartsReached} cart page(s) reached.`);
console.log(`\n${written} unique snippets -> ${OUT}`);
console.log(`Next: npm run label`);
