/**
 * Build a copy that can actually send, into a directory the ordinary build never touches.
 *
 * `npm run build` compiles the send path OUT (no TELEMETRY_ENDPOINT), which is what the
 * zero-egress tests need and what makes the default honest. The cost showed up in practice:
 * the unpacked extension loaded from `.output/chrome-mv3` was silently a build that could
 * never report, so sharing was switched on for days and the dataset stayed empty. Every test
 * run rebuilt that folder underneath it.
 *
 * So the live build gets its own directory. Load `.output/chrome-mv3-live` at
 * chrome://extensions and it stays valid no matter how often the test suite rebuilds.
 *
 *   npm run build:live
 */
import { cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ENDPOINT =
  process.env.TELEMETRY_ENDPOINT ?? "https://pensa-counts.viditchhajed.workers.dev/counts";
const OUT = resolve(".output/chrome-mv3");
const LIVE = resolve(".output/chrome-mv3-live");

execFileSync("npx", ["wxt", "build"], {
  stdio: "inherit",
  env: { ...process.env, TELEMETRY_ENDPOINT: ENDPOINT },
});

rmSync(LIVE, { recursive: true, force: true });
cpSync(OUT, LIVE, { recursive: true });

// Leave .output/chrome-mv3 as the endpoint-free build the tests assert against, so running
// this never changes what `npm test` or `npm run test:e2e` measure.
execFileSync("npx", ["wxt", "build"], {
  stdio: "inherit",
  env: { ...process.env, TELEMETRY_ENDPOINT: "" },
});

console.log(`\n  Live build: ${LIVE}`);
console.log(`  Reports go to: ${ENDPOINT}`);
console.log("  Load THAT folder at chrome://extensions. It survives every test rebuild.\n");
