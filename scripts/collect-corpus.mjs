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
const OUT = join(OUT_DIR, "candidates.jsonl");

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
const PRODUCT_LINK = /\/(?:products?|item|itm|dp|pd|p|prod|sku|buy)\//i;
const CATEGORY_LINK =
  /\/(?:collections?|category|categories|c|s|shop|sale|deals?|clearance|new)\b/i;

async function linksFrom(page, origin) {
  try {
    return await page.$$eval(
      "a[href]",
      (els, o) =>
        [...new Set(els.map((e) => e.href))]
          .filter((h) => h.startsWith(o) && !h.includes("#") && !/\.(pdf|jpg|png|zip)$/i.test(h))
          .slice(0, 200),
      origin,
    );
  } catch {
    return [];
  }
}

const seenText = new Set();
let written = 0;

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

async function collectFrom(page, url, site) {
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
          tag: n.selectorPath.split(" > ").pop() ?? "",
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
writeFileSync(OUT, "");

console.log(`Bundling the shipped harvest…`);
const harvestCode = buildHarvestBundle();

const browser = await chromium.launch({ channel: "chromium" });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
});
await context.addInitScript({ content: harvestCode });

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

for (const site of sites) {
  const origin = `https://www.${site.replace(/^www\./, "")}`;
  const page = await context.newPage();
  let got = 0;
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2500);
    await scrollThrough(page);
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
    console.log(`  ${site.padEnd(22)} ${String(got).padStart(5)} new snippets`);
  } catch {
    console.log(`  ${site.padEnd(22)} unreachable`);
  }
  await page.close();
}

await browser.close();
if (written === 0) {
  console.error(
    "\nEvery site returned nothing, and the bundle probe passed — so this is the network or " +
      "bot-blocking, not the collector. Retry with --sites naming fewer, smaller sites.",
  );
  process.exit(1);
}
console.log(`\n${written} unique snippets -> ${OUT}`);
console.log(`Next: npm run label`);
