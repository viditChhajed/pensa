/**
 * Precision audit against live shopping pages (plan §10).
 *
 *   node scripts/spot-check.mjs [--sites a,b] [--pages 4] [--out spot-check.jsonl]
 *
 * §10's gate is "more than ~4 false positives out of a detector's firings gets its threshold
 * raised or gets disabled by default". Answering that needs firings from REAL pages, with the
 * text each one matched, so a human, or something standing in for one, can say whether the
 * page actually showed that.
 *
 * What this is NOT: the manual spot-check. It loads the extension into Chromium with host
 * permissions patched in, because the grant flow raises a native dialog no automation can
 * accept, and it reads the detector's own log rather than watching a card appear. It captures
 * what FIRED, which is what precision is computed over, but a person browsing would also
 * notice what the extension said about a page they were actually reading, and that is a
 * different and better signal. Recorded in EVAL.md as an automated audit, never as the §10
 * human gate.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

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
    } else out[a.slice(2)] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

/**
 * Weighted toward the shops that actually use these techniques, plus tame ones.
 *
 * A precision audit run only on sites that shout would never surface the failure that
 * matters, firing on an ordinary page that is doing nothing.
 */
const DEFAULT_SITES = [
  "glossier.com",
  "rei.com",
  "ikea.com",
  "uniqlo.com",
  "zappos.com",
  "everlane.com",
  "shein.com",
  "temu.com",
  "boohoo.com",
  "prettylittlething.us",
  "forever21.com",
  "booking.com",
  "agoda.com",
  "kayak.com",
  "ticketmaster.com",
  "eventbrite.com",
  "newegg.com",
  "target.com",
  "ulta.com",
  "sephora.com",
  "chewy.com",
  "etsy.com",
];

const sites = typeof args.sites === "string" ? args.sites.split(",") : DEFAULT_SITES;
const pagesPerSite = Number(args.pages ?? 4);
const OUT = resolve("corpus", typeof args.out === "string" ? args.out : "spot-check.jsonl");

/** `[pensa] <stage>: N detection(s). id xN: "text [lexemes]" | id xN: "..."` */
const DETECTION_LINE =
  /^\[pensa\] (\w+): (\d+) detection\(s\)(?: \(\+\d+ repeat\(s\)[^)]*\))?\. (.*)$/;

function parseDetections(line) {
  const m = DETECTION_LINE.exec(line);
  if (!m) return null;
  const [, stage, , summary] = m;
  const out = [];
  for (const part of summary.split(" | ")) {
    const head = /^([a-z_]+\.[a-z_]+@\d+|[a-z_]+\.[a-z_]+) x(\d+): (.*)$/.exec(part.trim());
    if (!head) continue;
    const [, id, count, rest] = head;
    // Evidence samples are double-quoted and comma-separated; a trailing "+N more" is a tail.
    for (const q of rest.matchAll(/"([^"]*)"/g)) {
      out.push({ stage, patternId: id.replace(/@\d+$/, ""), count: Number(count), evidence: q[1] });
    }
  }
  return out;
}

const PRODUCT_LINK =
  /\/(?:products?|item|itm|dp|pd|p|prod|sku|buy|hotel|hotels|rooms?|flights?|stays?|event|events|tickets?|listing)\//i;

const build = mkdtempSync(join(tmpdir(), "pensa-spot-"));
cpSync(resolve(".output/chrome-mv3"), build, { recursive: true });
const mp = join(build, "manifest.json");
const manifest = JSON.parse(readFileSync(mp, "utf8"));
// The grant flow raises a native dialog no automation can accept. Patching the COPY in a
// temp dir is the only way to exercise what happens after a grant; .output is untouched and
// what users install still ships an empty host_permissions.
manifest.host_permissions = ["https://*/*"];
writeFileSync(mp, JSON.stringify(manifest, null, 2));

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [
    `--disable-extensions-except=${build}`,
    `--load-extension=${build}`,
    "--disable-blink-features=AutomationControlled",
  ],
  viewport: { width: 1280, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
await sw.evaluate(() => new Promise((r) => setTimeout(r, 1500)));

mkdirSync(resolve("corpus"), { recursive: true });
writeFileSync(OUT, "");
let firings = 0;
let pagesVisited = 0;

for (const site of sites) {
  const origin = `https://www.${site.replace(/^www\./, "")}`;
  const page = await ctx.newPage();
  const found = [];
  page.on("console", (m) => {
    const parsed = parseDetections(m.text());
    if (parsed) found.push(...parsed.map((d) => ({ ...d, url: page.url() })));
  });

  const visit = async (url) => {
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (!res || res.status() >= 400) return false;
      await page.waitForTimeout(2500);
      // Scroll: lazily rendered badges are exactly the copy this audit is about.
      for (const f of [0.3, 0.6, 1]) {
        await page.evaluate((d) => scrollTo(0, document.body.scrollHeight * d), f).catch(() => {});
        await page.waitForTimeout(1200);
      }
      pagesVisited++;
      return true;
    } catch {
      return false;
    }
  };

  if (await visit(origin)) {
    let links = [];
    try {
      links = await page.$$eval(
        "a[href]",
        (els, o) =>
          [...new Set(els.map((e) => e.href))].filter((h) => h.startsWith(o)).slice(0, 600),
        origin,
      );
    } catch {
      /* no links is not a failed site */
    }
    for (const link of links
      .filter((l) => PRODUCT_LINK.test(new URL(l).pathname))
      .slice(0, pagesPerSite)) {
      await page.waitForTimeout(1200);
      await visit(link);
    }
  }

  /**
   * One row per DISTINCT claim, not per log line.
   *
   * The detector logs its findings once per pass and a page left open runs many, so glossier
   * produced 37 identical rows for one "Regular price $84" badge. §10 counts false positives
   * out of a detector's FIRINGS, and a wrong claim repeated by the logger is one wrong claim
   *, counting it 37 times would make a single mistake look like a catastrophe and a single
   * correct detection look like a triumph.
   *
   * The event store is unaffected: events are written at digest time, not per pass. This is
   * a property of the audit harness, not of the product.
   */
  const distinct = new Map();
  for (const f of found) {
    const key = `${f.patternId}|${f.evidence}|${new URL(f.url).pathname}`;
    const prev = distinct.get(key);
    if (prev) prev.loggedTimes++;
    else distinct.set(key, { site, ...f, loggedTimes: 1 });
  }
  const rows = [...distinct.values()];

  if (rows.length > 0) {
    writeFileSync(OUT, `${rows.map((f) => JSON.stringify(f)).join("\n")}\n`, { flag: "a" });
  }
  firings += rows.length;
  console.log(
    `  ${site.padEnd(22)} ${String(rows.length).padStart(4)} distinct claim(s) from ` +
      `${found.length} log line(s)`,
  );
  await page.close();
}

await ctx.close();
console.log(`\n${firings} distinct claim(s) across ${pagesVisited} page(s) -> ${OUT}`);
