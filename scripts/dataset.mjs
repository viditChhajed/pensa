/**
 * Pull the cross-user prevalence dataset out of D1.
 *
 *   npm run dataset                       -> per-site table, written to dataset/
 *   npm run dataset -- --view pattern_reach
 *   npm run dataset -- --sql "select * from counts where site = 'shein.com'"
 *   npm run dataset -- --public            -> only the publishable cut (>= 20 batches)
 *
 * Reads through wrangler, so it uses your own Cloudflare login and nothing else. There is
 * deliberately no read endpoint on the worker: the sink accepts POSTs and answers nothing,
 * and the only way into the data is an account that already owns it. A public "stats" URL
 * would be a second attack surface for a dataset whose whole value is that it was collected
 * carefully.
 *
 * Output is JSONL, one row per line, for the same reason the in-extension export is: it
 * streams into jq, pandas and DuckDB without a parser holding the whole thing in memory,
 * and two pulls concatenate with `cat`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DATABASE = "vero-counts";
const CONFIG = resolve("server/cloudflare/wrangler.toml");

/** The views schema.sql defines. Anything else must be passed as --sql, on purpose. */
const VIEWS = new Set([
  "site_prevalence",
  "site_prevalence_public",
  "pattern_reach",
  "pattern_by_stage",
  "counts",
]);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

let sql;
let label;
if (typeof arg("sql") === "string") {
  sql = arg("sql");
  label = "query";
} else {
  const view = arg("public") ? "site_prevalence_public" : (arg("view") ?? "site_prevalence");
  if (!VIEWS.has(view)) {
    console.error(`Unknown view "${view}". Known: ${[...VIEWS].join(", ")}. Or pass --sql.`);
    process.exit(2);
  }
  sql = `select * from ${view}`;
  label = view;
}

let raw;
try {
  raw = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DATABASE,
      "--remote",
      "--json",
      "--config",
      CONFIG,
      "--command",
      sql,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 },
  );
} catch (err) {
  const detail = String(err.stderr ?? err.message ?? err);
  if (/not authenticated|login/i.test(detail)) {
    console.error("Not logged in to Cloudflare. Run `npx wrangler login` once, then retry.");
  } else {
    console.error(detail.slice(0, 2000));
  }
  process.exit(1);
}

// wrangler --json returns an array of statement results, each with a `results` array.
const parsed = JSON.parse(raw);
const rows = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r.results ?? []);

mkdirSync("dataset", { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const out = join("dataset", `${label}-${stamp}.jsonl`);
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

console.log(`${rows.length} row(s) -> ${out}`);
if (rows.length > 0 && label === "site_prevalence") {
  const sites = new Set(rows.map((r) => r.site)).size;
  const patterns = new Set(rows.map((r) => r.pattern_id)).size;
  console.log(`  ${sites} shop(s), ${patterns} technique(s)`);
}
