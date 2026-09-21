/**
 * Measure the detector's CPU cost, per phase, on real storefronts.
 *
 * This exists because a guess about what is slow produced the wrong fix once already. The
 * candidate limit was a fixed count (1200) chosen without measurement; running this showed
 * rei has 1437 qualifying nodes and reads them in 55ms while newegg has 3807 and takes
 * 347ms, so one count could only ever be too low for one page and too high for the other.
 * It also showed that budgeting getBoundingClientRect changed nothing, because
 * getComputedStyle was the actual expense and ran in a later pass.
 *
 * Usage:  npm run build && node scripts/measure-perf.mjs
 *
 * Note the manifest rewrite below: the shipped build declares no host_permissions by design
 * (see plan §1.2), so a headless run would never inject. This grants https://*\/* to the
 * COPY in a temp dir only — the build in .output is not modified, and nothing here is what
 * users install.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const SITES = [
  ["newegg", "https://www.newegg.com/"],
  ["rei", "https://www.rei.com/"],
  ["ikea", "https://www.ikea.com/us/en/"],
  ["target", "https://www.target.com/"],
];

const buildDir = mkdtempSync(join(tmpdir(), "pp-perf-"));
cpSync(resolve(".output/chrome-mv3"), buildDir, { recursive: true });
const manifestPath = join(buildDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = ["https://*/*"];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [
    `--disable-extensions-except=${buildDir}`,
    `--load-extension=${buildDir}`,
    "--disable-blink-features=AutomationControlled",
  ],
  viewport: { width: 1280, height: 800 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
await sw.evaluate(() => new Promise((r) => setTimeout(r, 1500)));

for (const [name, url] of SITES) {
  const page = await ctx.newPage();
  const lines = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[pensa] pass ") || t.includes("[pensa] harvest budget")) lines.push(t);
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
    await page.waitForTimeout(9000);
  } catch {
    console.log(`${name.padEnd(8)} unreachable`);
    await page.close();
    continue;
  }

  // Report the WORST pass, not the average. The budget is a per-pass promise about the main
  // thread, and an average hides the pass that actually janked the page.
  const worst = lines
    .map((l) =>
      /used (\d+)ms CPU.*meta (\d+)ms, harvest (\d+)ms, detectors (\d+)ms, (\d+) cand/.exec(l),
    )
    .filter(Boolean)
    .map((g) => ({ cpu: +g[1], meta: +g[2], harv: +g[3], det: +g[4], cand: +g[5] }))
    .sort((a, b) => b.cpu - a.cpu)[0];

  console.log(
    worst
      ? `${name.padEnd(8)} CPU ${String(worst.cpu).padStart(4)}ms = ` +
          `meta ${String(worst.meta).padStart(3)} + harvest ${String(worst.harv).padStart(3)} + ` +
          `det ${String(worst.det).padStart(3)}  (${worst.cand} candidates)`
      : `${name.padEnd(8)} under budget (no pass exceeded PERF_BUDGET_MS)`,
  );
  for (const l of lines.filter((l) => l.includes("harvest budget"))) {
    console.log(`         ${l.replace("[pensa] ", "")}`);
  }
  await page.close();
}

await ctx.close();
